// Ballot submission: a ballot is boarded only once @abolishus/verifier's
// admission (5.1 to 5.4, under the definition checks and the transcript
// check it rests on) admits it, so the server boards only what the verifier
// admits by those rows and never reimplements them (AGENTS.md, The
// verifier's trust base; docs/spec/board.md, Envelope: the operator MUST
// append only payloads that decode strictly under the profile; T-17, T-52).
// A repeat of a boarded ballot (5.7), keyed by the (tier, ν, M) that
// admission returns, is never boarded again (T-38).
// Nothing here sees who submitted: no account, session or address reaches
// this module (T-10).

import { MAX_BOARD_PAYLOAD, type Panel, panelId, type PeriodClock } from "@abolishus/crypto";
import { type AdmissionCode, type ElectionAdmission, electionAdmission } from "@abolishus/verifier";
import type { Sql } from "postgres";
import {
  appendEntry,
  type AppendedEntry,
  AppendError,
  BOARD_ENTRY_OVERHEAD,
  readEntries,
} from "./board.ts";
import { isBytes } from "./bytes.ts";
import { readDefinition } from "./definitions.ts";

export type SubmitErrorCode =
  /** No definition is stored for the election. */
  | "unknown-election"
  /**
   * The election takes no ballots now: before `opens_at` or after
   * `closes_at` by this server's clock, or no ballot of it can be admitted
   * (no pinned panel, no transcript at the board's start, a ceremony or
   * definition the verifier refuses).
   */
  | "not-open"
  /**
   * The ballot doesn't decode strictly, an admission check rejects it, or it
   * repeats a boarded ballot in other bytes (`repeat`, verifier 5.7).
   */
  | "rejected";

export class SubmitError extends Error {
  override readonly name = "SubmitError";
  readonly code: SubmitErrorCode;
  /** Under `rejected`: the verifier's code (`decode` for strict decoding, `repeat` for 5.7). */
  readonly admission?: AdmissionCode | "decode" | "repeat";
  constructor(code: SubmitErrorCode, admission?: AdmissionCode | "decode" | "repeat") {
    super(`ballot refused: ${code}${admission === undefined ? "" : ` (${admission})`}`);
    this.code = code;
    if (admission !== undefined) this.admission = admission;
  }
}

/** One ballot's outcome from `BallotAdmissions.submitAll`. */
export type SubmitOutcome =
  | { readonly ok: true; readonly boarded: AppendedEntry }
  | { readonly ok: false; readonly error: SubmitError };

export interface BallotAdmissionOptions {
  /**
   * The trustee panels this release pins (docs/spec/verifier.md, Inputs):
   * an election is judged under the one its definition names, and takes no
   * ballots if none is (T-37).
   */
  readonly panels: readonly Panel[];
  /** The anchoring clock of the anchor contract our definitions name: it labels each entry's segment. */
  readonly clock: PeriodClock;
  /** Elections whose admission, and others whose refusal, are kept in memory at once (default 1,024 each). */
  readonly cacheSize?: number;
}

/** What an election's ballots are judged by, once it can be decided. */
type Decided = ElectionAdmission | { readonly ok: false };

/**
 * Admits and boards ballots. One per process: it keeps each election's
 * admission (its definition decoded, its transcript checked, its registered
 * key set) once decided, so a ballot costs its own checks, never the
 * ceremony's. That is sound because the definition is write-once and binds
 * the transcript by its hash, and the board's first entry, where the operator
 * boards the transcript, is write-once too.
 */
export class BallotAdmissions {
  readonly #panels: readonly Panel[];
  readonly #clock: PeriodClock;
  readonly #cacheSize: number;
  readonly #admitted = new Map<string, Decided>();
  readonly #refused = new Map<string, Decided>();

  constructor({ panels, clock, cacheSize = 1024 }: BallotAdmissionOptions) {
    if (panels.length === 0) throw new RangeError("panels must name at least one panel");
    // A malformed panel throws PanelError here, at start, not on a ballot.
    for (const panel of panels) panelId(panel);
    if (typeof clock.epoch !== "bigint" || clock.epoch < 0n)
      throw new RangeError("clock.epoch must be a bigint ≥ 0");
    if (typeof clock.period !== "bigint" || clock.period < 1n)
      throw new RangeError("clock.period must be a bigint ≥ 1");
    if (!Number.isSafeInteger(cacheSize) || cacheSize < 1)
      throw new RangeError("cacheSize must be at least 1");
    this.#panels = [...panels];
    this.#clock = { epoch: clock.epoch, period: clock.period };
    this.#cacheSize = cacheSize;
  }

  /**
   * Judges `ballot` (a ballot record's bytes) for `electionId` at UNIX time
   * `now` (seconds, from the caller's clock) and, if admitted, appends it to
   * the board in the segment current at `now`. Throws `SubmitError` for a
   * refusal, with nothing written. A byte-identical resubmission of a boarded
   * ballot returns the entry that carries it, writing nothing, so a client
   * that lost the answer can retry.
   */
  async submit(
    client: Sql,
    electionId: Uint8Array,
    ballot: Uint8Array,
    now: bigint,
  ): Promise<AppendedEntry> {
    const [outcome] = await this.submitAll(client, electionId, [ballot], now);
    if (outcome === undefined) throw new Error("submitAll answered no ballot");
    if (!outcome.ok) throw outcome.error;
    return outcome.boarded;
  }

  /**
   * `submit` for many ballots of one election at once: their membership
   * proofs are verified together (the verifier's `admitAll`), then the
   * admitted ones are appended in the order given, so each gets the verdict
   * and the entry `submit` would give it on its own, called in that order
   * (T-52). A refusal is that ballot's outcome; a database error throws, and
   * the ballots before it may be boarded already, so a caller retries the
   * same bytes, which return their entries.
   */
  async submitAll(
    client: Sql,
    electionId: Uint8Array,
    ballots: readonly Uint8Array[],
    now: bigint,
  ): Promise<SubmitOutcome[]> {
    if (!isBytes(electionId) || electionId.length !== 32)
      throw new TypeError("electionId must be 32 bytes");
    if (!Array.isArray(ballots) || !ballots.every(isBytes))
      throw new TypeError("ballots must be an array of bytes");
    if (typeof now !== "bigint" || now < 0n) throw new TypeError("now must be a bigint ≥ 0");
    const id = new Uint8Array(electionId);
    const own = ballots.map((b) => new Uint8Array(b));
    const refuseAll = (error: SubmitError) => own.map(() => ({ ok: false, error }) as const);
    if (own.length === 0) return [];
    let admission;
    try {
      admission = await this.#admission(client, id);
    } catch (e) {
      if (e instanceof SubmitError) return refuseAll(e);
      throw e;
    }
    if (!admission.ok) return refuseAll(new SubmitError("not-open"));
    // By our clock. A ballot cast at close but boarded a moment later is
    // refused here and can still be submitted directly (T-25); the close
    // rule (verifier 5.5) decides what counts, never this check.
    if (now < admission.opensAt || now > admission.closesAt || now < this.#clock.epoch)
      return refuseAll(new SubmitError("not-open"));
    const segment = (now - this.#clock.epoch) / this.#clock.period;
    if (segment > 0xffffffffn) return refuseAll(new SubmitError("not-open"));
    const verdicts = admission.admitAll(own);
    const outcomes: SubmitOutcome[] = [];
    for (const [i, verdict] of verdicts.entries()) {
      const ballot = own[i] as Uint8Array;
      if (!verdict.ok) {
        outcomes.push({ ok: false, error: new SubmitError("rejected", verdict.code) });
        continue;
      }
      // Labelled before the proofs ran, so a later-labelled ballot may have
      // been boarded meanwhile: this one then takes that segment, never a
      // lower one (a ballot boarded under a segment whose checkpoint may
      // already be taken would fail it, checkpoint-boundary).
      try {
        const boarded = await appendEntry(client, id, Number(segment), ballot, {
          raiseToPrevious: true,
          ballot: { tier: verdict.tier, nullifier: verdict.nullifier, message: verdict.message },
        });
        outcomes.push({ ok: true, boarded });
      } catch (e) {
        if (!(e instanceof AppendError && e.code === "repeat")) throw e;
        outcomes.push({ ok: false, error: new SubmitError("rejected", "repeat") });
      }
    }
    return outcomes;
  }

  async #admission(client: Sql, id: Uint8Array): Promise<Decided> {
    const key = Buffer.from(id).toString("hex");
    for (const cache of [this.#admitted, this.#refused]) {
      const known = cache.get(key);
      if (known === undefined) continue;
      // Least recently used goes first: a hit moves the election to the end.
      cache.delete(key);
      cache.set(key, known);
      return known;
    }
    const definition = await readDefinition(client, id);
    if (definition === undefined) throw new SubmitError("unknown-election");
    // The operator boards the transcript as the board's first entry (as the
    // reference election does), so only that entry is read: a ballot never
    // costs a scan of the board (T-52).
    const first = await readEntries(client, id, 0n, 1, BOARD_ENTRY_OVERHEAD + MAX_BOARD_PAYLOAD);
    for (const panel of this.#panels) {
      const r = electionAdmission(definition, panel, first);
      if (!r.ok && r.code === "panel-unpinned") continue;
      // A missing transcript is never kept: costing only the definition, the
      // first entry and its hash, it is decided again on the next ballot.
      if (!r.ok && r.code === "ceremony-transcript-missing") return r;
      // Admissions and refusals are kept apart, so refusals (cheap to cause
      // with definitions naming no pinned panel) never evict an admission.
      if (r.ok) remember(this.#admitted, key, r, this.#cacheSize);
      else remember(this.#refused, key, r, this.#cacheSize);
      return r;
    }
    const refused: Decided = { ok: false };
    remember(this.#refused, key, refused, this.#cacheSize);
    return refused;
  }
}

/** Keeps `value` under `key`, dropping the least recently used beyond `size`. */
function remember(cache: Map<string, Decided>, key: string, value: Decided, size: number) {
  if (cache.size >= size) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, value);
}
