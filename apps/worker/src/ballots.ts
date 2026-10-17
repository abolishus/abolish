// The worker's side of the `{ballot-submit}` queue: the jobs being handled at
// once are gathered into batches, and each batch's ballots of one election
// are judged together by core's `BallotAdmissions.submitAll`, which verifies
// their membership proofs in one batch and boards the admitted ones in the
// order the jobs arrived (docs/spec/ballot-validity.md, Batched admission;
// T-52).

import type { BallotAdmissions, SubmitOutcome } from "@abolishus/core";
import type { Sql } from "postgres";
import type { BallotOutcome } from "./ballot-queue.ts";

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
  #waiting: Waiting[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running = false;

  constructor({
    sql,
    admissions,
    now,
    batch = BALLOT_BATCH,
    waitMs = BALLOT_BATCH_WAIT_MS,
  }: BallotBatchOptions) {
    if (!Number.isSafeInteger(batch) || batch < 1) throw new RangeError("batch must be at least 1");
    if (!Number.isSafeInteger(waitMs) || waitMs < 0) throw new RangeError("waitMs must be ≥ 0");
    this.#sql = sql;
    this.#admissions = admissions;
    this.#now = now;
    this.#batch = batch;
    this.#waitMs = waitMs;
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
            else w.resolve(outcomeOf(o));
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
