// The worker's side of the `{ballot-submit}` queue: the jobs being handled at
// once are gathered into batches, and each batch's ballots of one election
// are judged together by core's `BallotAdmissions.submitAll`, which verifies
// their membership proofs in one batch and boards the admitted ones in the
// order the jobs arrived (docs/spec/ballot-validity.md, Batched admission;
// T-52).
//
// Its `{receipt-submit}` side judges each share receipt on its own by core's
// `BallotAdmissions.submitReceipt` (docs/spec/delivery.md, Boarding): one
// signature check against one stored ballot, so there is nothing to batch.
//
// Its `{opening-submit}` side judges each tally opening on its own by core's
// `OpeningBoardings.submitOpening` (docs/spec/tally.md, Opening record,
// Boarding), against each election's counted tally, computed once.
//
// Its `{destruction-submit}` side judges each destruction statement on its
// own by core's `DestructionBoardings.submitDestruction` (docs/spec/tally.md,
// Destruction, Boarding): one signature check against the seats' statements
// already boarded, at most one each.
//
// Its `{results-read}` side reads a poll's results by core's
// `OpeningBoardings.readResults` (docs/spec/verifier.md, Results from the
// counted tally), with the boardings `{opening-submit}` judges openings by,
// so a read reuses the counted tally they keep.

import {
  type BallotAdmissions,
  type DestructionBoardings,
  DestructionError,
  type OpeningBoardings,
  OpeningError,
  type PollResults,
  ReceiptError,
  type SubmitOutcome,
} from "@abolishus/core";
import type { Sql } from "postgres";
import type {
  BallotOutcome,
  DestructionOutcome,
  OpeningOutcome,
  ReceiptOutcome,
  ResultsOutcome,
} from "./ballot-queue.ts";
import type { Log } from "./log.ts";

/** Ballots judged in one batch at most, and the queue's concurrency: `finishBallotSteps`' own batch. */
export const BALLOT_BATCH = 64;

/**
 * How long the first ballot of a batch waits for others. Short against a
 * proof's verification, so a lone ballot is barely delayed.
 */
export const BALLOT_BATCH_WAIT_MS = 10;

export interface BallotBatchOptions {
  readonly sql: Sql;
  readonly admissions: BallotAdmissions;
  /** UNIX time in seconds: the clock a batch's window and segment are judged by. */
  readonly now: () => bigint;
  readonly batch?: number;
  readonly waitMs?: number;
  /** Where a ballot boarded with its L1 reference unchecked is reported. */
  readonly log?: Log;
}

interface Waiting {
  readonly electionId: string;
  readonly ballot: Uint8Array;
  readonly resolve: (outcome: BallotOutcome) => void;
  readonly reject: (error: unknown) => void;
}

const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));

function outcomeOf(o: SubmitOutcome): BallotOutcome {
  if (o.ok) return { ok: true, index: o.boarded.index.toString() };
  return {
    ok: false,
    code: o.error.code,
    ...(o.error.admission === undefined ? {} : { admission: o.error.admission }),
  };
}

/**
 * Gathers ballots into batches, one batch running at a time: a ballot that
 * arrives while one runs goes into the next, which starts as soon as it ends,
 * so appends to a board stay in arrival order.
 */
export class BallotBatches {
  readonly #sql: Sql;
  readonly #admissions: BallotAdmissions;
  readonly #now: () => bigint;
  readonly #batch: number;
  readonly #waitMs: number;
  readonly #log: Log | undefined;
  #waiting: Waiting[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running = false;

  constructor({
    sql,
    admissions,
    now,
    batch = BALLOT_BATCH,
    waitMs = BALLOT_BATCH_WAIT_MS,
    log,
  }: BallotBatchOptions) {
    if (!Number.isSafeInteger(batch) || batch < 1) throw new RangeError("batch must be at least 1");
    if (!Number.isSafeInteger(waitMs) || waitMs < 0) throw new RangeError("waitMs must be ≥ 0");
    this.#sql = sql;
    this.#admissions = admissions;
    this.#now = now;
    this.#batch = batch;
    this.#waitMs = waitMs;
    this.#log = log;
  }

  /**
   * The outcome for `ballot` (hex) in `electionId` (hex), once its batch has
   * run. Rejects only when the batch's database work fails, and then every
   * ballot of its election in that batch fails with it.
   */
  submit(electionId: string, ballot: string): Promise<BallotOutcome> {
    return new Promise((resolve, reject) => {
      this.#waiting.push({ electionId, ballot: bytes(ballot), resolve, reject });
      this.#schedule();
    });
  }

  #schedule() {
    if (this.#running || this.#waiting.length === 0) return;
    if (this.#waiting.length >= this.#batch) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
      void this.#run();
    } else
      this.#timer ??= setTimeout(() => {
        this.#timer = undefined;
        void this.#run();
      }, this.#waitMs);
  }

  async #run() {
    if (this.#running) return;
    this.#running = true;
    const batch = this.#waiting.splice(0, this.#batch);
    const settled = new Set<Waiting>();
    try {
      const elections = new Map<string, Waiting[]>();
      for (const w of batch) {
        const same = elections.get(w.electionId);
        if (same === undefined) elections.set(w.electionId, [w]);
        else same.push(w);
      }
      const now = this.#now();
      for (const [id, ballots] of elections) {
        try {
          const outcomes = await this.#admissions.submitAll(
            this.#sql,
            bytes(id),
            ballots.map((w) => w.ballot),
            now,
          );
          for (const [i, w] of ballots.entries()) {
            const o = outcomes[i];
            if (o === undefined) w.reject(new Error("submitAll answered fewer ballots"));
            else {
              if (o.ok && o.l1 === "unchecked")
                this.#log?.({ queue: "{ballot-submit}", finding: "l1-unchecked" });
              w.resolve(outcomeOf(o));
            }
            settled.add(w);
          }
        } catch (e) {
          for (const w of ballots) if (!settled.has(w)) w.reject(e);
          for (const w of ballots) settled.add(w);
        }
      }
    } catch (e) {
      // Whatever failed outside an election's call, no job of the batch is
      // left holding a slot of the queue's concurrency.
      for (const w of batch) if (!settled.has(w)) w.reject(e);
    } finally {
      this.#running = false;
      // Whatever arrived meanwhile has waited a whole batch already.
      if (this.#waiting.length > 0) void this.#run();
    }
  }
}

/**
 * Judges and boards share receipts with the ballots' admissions, by the
 * same clock. A refusal is an outcome; a database error throws, and the
 * sender's retry of the same bytes returns the entry if it was boarded.
 */
export class ReceiptSubmissions {
  readonly #sql: Sql;
  readonly #admissions: BallotAdmissions;
  readonly #now: () => bigint;

  constructor({ sql, admissions, now }: Pick<BallotBatchOptions, "sql" | "admissions" | "now">) {
    this.#sql = sql;
    this.#admissions = admissions;
    this.#now = now;
  }

  /** The outcome for `record` (hex) in `electionId` (hex). */
  async submit(electionId: string, record: string): Promise<ReceiptOutcome> {
    try {
      const { boarded, earlier } = await this.#admissions.submitReceipt(
        this.#sql,
        bytes(electionId),
        bytes(record),
        this.#now(),
      );
      return { ok: true, index: boarded.index.toString(), earlier };
    } catch (e) {
      if (!(e instanceof ReceiptError)) throw e;
      return {
        ok: false,
        code: e.code,
        ...(e.rejection === undefined ? {} : { rejection: e.rejection }),
      };
    }
  }
}

/**
 * Judges and boards tally openings by the ballots' clock. A refusal is an
 * outcome; a database, anchor or L1 node error throws, and the seat's
 * resend of the same bytes returns the entry if it was boarded.
 */
export class OpeningSubmissions {
  readonly #sql: Sql;
  readonly #boardings: OpeningBoardings;
  readonly #now: () => bigint;

  constructor({
    sql,
    boardings,
    now,
  }: Pick<BallotBatchOptions, "sql" | "now"> & { readonly boardings: OpeningBoardings }) {
    this.#sql = sql;
    this.#boardings = boardings;
    this.#now = now;
  }

  /** The outcome for `opening` (hex) in `electionId` (hex). */
  async submit(electionId: string, opening: string): Promise<OpeningOutcome> {
    try {
      const boarded = await this.#boardings.submitOpening(
        this.#sql,
        bytes(electionId),
        bytes(opening),
        this.#now(),
      );
      return { ok: true, index: boarded.index.toString() };
    } catch (e) {
      if (!(e instanceof OpeningError)) throw e;
      return {
        ok: false,
        code: e.code,
        ...(e.rejection === undefined ? {} : { rejection: e.rejection }),
      };
    }
  }
}

/**
 * Judges and boards destruction statements by the ballots' clock. A refusal
 * is an outcome; a database error throws, and the seat's resend of the same
 * bytes returns the entry if it was boarded.
 */
export class DestructionSubmissions {
  readonly #sql: Sql;
  readonly #boardings: DestructionBoardings;
  readonly #now: () => bigint;

  constructor({
    sql,
    boardings,
    now,
  }: Pick<BallotBatchOptions, "sql" | "now"> & { readonly boardings: DestructionBoardings }) {
    this.#sql = sql;
    this.#boardings = boardings;
    this.#now = now;
  }

  /** The outcome for `statement` (hex) in `electionId` (hex). */
  async submit(electionId: string, statement: string): Promise<DestructionOutcome> {
    try {
      const boarded = await this.#boardings.submitDestruction(
        this.#sql,
        bytes(electionId),
        bytes(statement),
        this.#now(),
      );
      return { ok: true, index: boarded.index.toString() };
    } catch (e) {
      if (!(e instanceof DestructionError)) throw e;
      return {
        ok: false,
        code: e.code,
        ...(e.rejection === undefined ? {} : { rejection: e.rejection }),
      };
    }
  }
}

/** `results` as the queue carries it: each report's fields named, so nothing else rides along. */
export function resultsOutcomeOf(results: PollResults): ResultsOutcome {
  if (results.state === "unopened") return { ok: true, state: "unopened" };
  const { ok, failure, cells, tiers, questions } = results.results;
  const slices = (r: {
    readonly counts?: readonly string[];
    readonly byQuestion?: readonly (readonly string[])[];
  }) => ({
    ...(r.counts !== undefined && { counts: [...r.counts] }),
    ...(r.byQuestion !== undefined && { byQuestion: r.byQuestion.map((q) => [...q]) }),
  });
  return {
    ok: true,
    state: "read",
    openings: results.openings,
    passed: ok,
    ...(failure !== undefined && {
      failure: { cell: failure.cell, code: failure.code },
    }),
    cells: cells.map((c) => ({
      cell: c.cell,
      tier: c.tier,
      counted: c.counted,
      ...slices(c),
      ...(c.code !== undefined && { code: c.code }),
      signers: [...c.signers],
    })),
    tiers: tiers.map((t) => ({
      tier: t.tier,
      counted: t.counted,
      ...slices(t),
      // The two figures a rolling tier's results state, with the verifier's
      // small-count flag on who could answer (8.2, T-16); its growth by
      // period and its steps' sizes are the verifier's report to give.
      ...(t.electorate !== undefined && {
        electorate: {
          opening: t.electorate.opening.members,
          eligible: t.electorate.eligible,
          flagged: { eligible: t.electorate.flagged.eligible },
        },
      }),
    })),
    ...(questions !== undefined && {
      questions: questions.map((q) => ({
        question: q.question,
        size: q.options,
        atLeast: q.minSelections,
        atMost: q.maxSelections,
        method: q.method,
      })),
    }),
  };
}

/**
 * Reads a poll's results from the openings boarded so far, with the
 * boardings that judge them, so a read uses the counted tally they keep. A
 * refusal is an outcome; a database, anchor or L1 node error throws, and the
 * reader asks again.
 */
export class ResultsReads {
  readonly #sql: Sql;
  readonly #boardings: OpeningBoardings;

  constructor({
    sql,
    boardings,
  }: Pick<BallotBatchOptions, "sql"> & { readonly boardings: OpeningBoardings }) {
    this.#sql = sql;
    this.#boardings = boardings;
  }

  /** The outcome for `electionId` (hex). */
  async read(electionId: string): Promise<ResultsOutcome> {
    try {
      return resultsOutcomeOf(await this.#boardings.readResults(this.#sql, bytes(electionId)));
    } catch (e) {
      // `rejected` is a submitted opening's; a read never gets it.
      if (!(e instanceof OpeningError) || e.code === "rejected") throw e;
      return { ok: false, code: e.code };
    }
  }
}
