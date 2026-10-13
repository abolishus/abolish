// Ballot submission: a ballot is boarded only once @abolishus/verifier's
// admission (5.1 to 5.4, under the definition checks and the transcript
// check it rests on) admits it, so the server boards only what the verifier
// admits by those rows and never reimplements them (AGENTS.md, The
// verifier's trust base; docs/spec/board.md, Envelope: the operator MUST
// append only payloads that decode strictly under the profile; T-17, T-52).
// Nothing here sees who submitted: no account, session or address reaches
// this module (T-10).

import { MAX_BOARD_PAYLOAD, type Panel, panelId, type PeriodClock } from "@abolishus/crypto";
import { type AdmissionCode, type ElectionAdmission, electionAdmission } from "@abolishus/verifier";
import type { Sql } from "postgres";
import { appendEntry, type AppendedEntry, BOARD_ENTRY_OVERHEAD, readEntries } from "./board.ts";
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
  /** The ballot doesn't decode strictly, or an admission check rejects it. */
  | "rejected";

export class SubmitError extends Error {
  override readonly name = "SubmitError";
  readonly code: SubmitErrorCode;
  /** Under `rejected`: the verifier's code (`decode` for strict decoding). */
  readonly admission?: AdmissionCode | "decode";
  constructor(code: SubmitErrorCode, admission?: AdmissionCode | "decode") {
    super(`ballot refused: ${code}${admission === undefined ? "" : ` (${admission})`}`);
    this.code = code;
    if (admission !== undefined) this.admission = admission;
  }
}

export interface BallotAdmissionOptions {
  /**
   * The trustee panels this release pins (docs/spec/verifier.md, Inputs):
   * an election is judged under the one its definition names, and takes no
   * ballots if none is (T-37).
   */
  readonly panels: readonly Panel[];
  /** The anchoring clock of the anchor contract our definitions name: it labels each entry's segment. */
  readonly clock: PeriodClock;
  /** Elections whose admission is kept in memory at once (default 1,024). */
  readonly cacheSize?: number;
}

/** What an election's ballots are judged by, once it can be decided. */
type Decided = ElectionAdmission | { readonly ok: false };

/**
 * Admits and boards ballots. One per process: it keeps each election's
 * admission (its definition decoded, its transcript checked, its registered
 * key set) once decided, so a ballot costs its own checks, never the
 * ceremony's. That is sound because the definition is write-once and so is
 * the board's first entry, where the operator boards the transcript.
 */
export class BallotAdmissions {
  readonly #panels: readonly Panel[];
  readonly #clock: PeriodClock;
  readonly #cacheSize: number;
  readonly #decided = new Map<string, Decided>();

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
   * refusal, with nothing written.
   */
  async submit(
    client: Sql,
    electionId: Uint8Array,
    ballot: Uint8Array,
    now: bigint,
  ): Promise<AppendedEntry> {
    if (!isBytes(electionId) || electionId.length !== 32 || !isBytes(ballot))
      throw new TypeError("electionId must be 32 bytes and ballot bytes");
    if (typeof now !== "bigint" || now < 0n) throw new TypeError("now must be a bigint ≥ 0");
    const id = new Uint8Array(electionId);
    const admission = await this.#admission(client, id);
    if (!admission.ok) throw new SubmitError("not-open");
    // By our clock. A ballot cast at close but boarded a moment later is
    // refused here and can still be submitted directly (T-25); the close
    // rule (verifier 5.5) decides what counts, never this check.
    if (now < admission.opensAt || now > admission.closesAt || now < this.#clock.epoch)
      throw new SubmitError("not-open");
    const verdict = admission.admit(new Uint8Array(ballot));
    if (!verdict.ok) throw new SubmitError("rejected", verdict.code);
    const segment = (now - this.#clock.epoch) / this.#clock.period;
    if (segment > 0xffffffffn) throw new SubmitError("not-open");
    return appendEntry(client, id, Number(segment), ballot);
  }

  async #admission(client: Sql, id: Uint8Array): Promise<Decided> {
    const key = Buffer.from(id).toString("hex");
    const known = this.#decided.get(key);
    if (known !== undefined) return known;
    const definition = await readDefinition(client, id);
    if (definition === undefined) throw new SubmitError("unknown-election");
    // The operator boards the transcript as the board's first entry (as the
    // reference election does), so only that entry is read: a ballot never
    // costs a scan of the board (T-52).
    const first = await readEntries(client, id, 0n, 1, BOARD_ENTRY_OVERHEAD + MAX_BOARD_PAYLOAD);
    let decided: Decided = { ok: false };
    for (const panel of this.#panels) {
      const r = electionAdmission(definition, panel, first);
      if (!r.ok && r.code === "panel-unpinned") continue;
      // An empty board may yet get its transcript: decided only once its
      // first entry exists, which never changes after.
      if (!r.ok && r.code === "ceremony-transcript-missing" && first.length === 0) return r;
      decided = r.ok ? r : { ok: false };
      break;
    }
    if (this.#decided.size >= this.#cacheSize) {
      const oldest = this.#decided.keys().next();
      if (!oldest.done) this.#decided.delete(oldest.value);
    }
    this.#decided.set(key, decided);
    return decided;
  }
}
