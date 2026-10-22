// Ballot submission: a ballot is boarded only once @abolishus/verifier's
// admission (5.1 to 5.4, under the definition checks and the transcript
// check it rests on) admits it, so the server boards only what the verifier
// admits by those rows and never reimplements them (AGENTS.md, The
// verifier's trust base; docs/spec/board.md, Envelope: the operator MUST
// append only payloads that decode strictly under the profile; T-17, T-52).
// A repeat of a boarded ballot (5.7), keyed by the (tier, ν, M) that
// admission returns, is never boarded again (T-38), and with an L1 node, a
// ballot whose L1 reference 5.8 already rejects isn't boarded at all.
// Nothing here sees who submitted: no account, session or address reaches
// this module (T-10).
//
// Share receipts take the board path here too (docs/spec/delivery.md,
// Boarding): the verifier's admission judges rules 1 and 4 against the
// ballot the receipt names, found among the boarded ballots by the ballot
// hash admission stored with each (rule 2), in a segment no later than
// `s_D` (rule 3), and the board carries at most one passing receipt per
// seat of a ballot hash (rule 5), so a receipt adds no chosen bytes beyond a
// registered trustee's signature nonce (T-17, T-52). A seat's node and the
// voter's client both send it, so a receipted ballot is delivered whichever
// of them the operator hears from (Client rules 3; T-25).

import {
  deliverySegments,
  MAX_BOARD_PAYLOAD,
  type Panel,
  panelId,
  type PeriodClock,
} from "@abolishus/crypto";
import {
  type AdmissionCode,
  type ElectionAdmission,
  electionAdmission,
  type L1RefCode,
  type ReceiptAdmissionCode,
} from "@abolishus/verifier";
import type { Sql } from "postgres";
import {
  appendEntry,
  type AppendedEntry,
  AppendError,
  BOARD_ENTRY_OVERHEAD,
  readBallotByHash,
  readBoardedReceipt,
  readEntries,
} from "./board.ts";
import { isBytes } from "./bytes.ts";
import { readDefinition } from "./definitions.ts";
import type { L1References } from "./l1-references.ts";

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
   * The ballot doesn't decode strictly, an admission check rejects it (its
   * L1 reference among them, 5.8, once the finalized chain decides it), or
   * it repeats a boarded ballot in other bytes (`repeat`, verifier 5.7).
   */
  | "rejected";

/** Why a ballot was rejected: the verifier's code for the check it failed. */
export type RejectionCode = AdmissionCode | L1RefCode | "decode" | "repeat";

export class SubmitError extends Error {
  override readonly name = "SubmitError";
  readonly code: SubmitErrorCode;
  /** Under `rejected`: the verifier's code (`decode` for strict decoding, `repeat` for 5.7, 5.8's `l1-ref-*`). */
  readonly admission?: RejectionCode;
  constructor(code: SubmitErrorCode, admission?: RejectionCode) {
    super(`ballot refused: ${code}${admission === undefined ? "" : ` (${admission})`}`);
    this.code = code;
    if (admission !== undefined) this.admission = admission;
  }
}

/**
 * How a boarded ballot's L1 reference stood (5.8): `admitted` by the
 * finalized chain, `pending` until L1 finalizes its block, `unchecked`
 * because the node couldn't be read or is on another chain than the
 * definition names, or `off` with no node configured. The verifier decides
 * all but the first later; nothing here changes what counts.
 */
export type L1Check = "admitted" | "pending" | "unchecked" | "off";

/**
 * Why a share receipt was refused: the verifier's code for rule 1 (`decode`
 * with its decoding error, `receipt-definition`, `receipt-seat`, or
 * `unsupported-version` for a definition version whose receipts this
 * release doesn't board yet), `receipt-ballot` when no boarded ballot has
 * the ballot hash it names (rule 2), and `share-receipt` when it doesn't
 * pass against that ballot (rule 4).
 */
export type ReceiptRejectionCode = ReceiptAdmissionCode | "receipt-ballot" | "share-receipt";

export class ReceiptError extends Error {
  override readonly name = "ReceiptError";
  /** As for ballots; `not-open` also once rule 3's last segment, `s_D`, has passed. */
  readonly code: SubmitErrorCode;
  /** Under `rejected`: why. */
  readonly rejection?: ReceiptRejectionCode;
  constructor(code: SubmitErrorCode, rejection?: ReceiptRejectionCode) {
    super(`share receipt refused: ${code}${rejection === undefined ? "" : ` (${rejection})`}`);
    this.code = code;
    if (rejection !== undefined) this.rejection = rejection;
  }
}

/**
 * A share receipt's outcome from `BallotAdmissions.submitReceipt`: the entry
 * that carries it, or, when the board path already carries a passing
 * receipt for that seat of that ballot hash in other bytes (rule 5), that
 * receipt's entry, which the sender checks and keeps instead (Client rules 3).
 */
export interface ReceiptOutcome {
  readonly boarded: AppendedEntry;
  /** True when `boarded` carries an earlier receipt, not the one submitted. */
  readonly earlier: boolean;
}

/** One ballot's outcome from `BallotAdmissions.submitAll`. */
export type SubmitOutcome =
  | { readonly ok: true; readonly boarded: AppendedEntry; readonly l1: L1Check }
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
  /**
   * Finalized L1 blocks to judge references by (5.8), for elections whose
   * definition names this node's chain. Without it, or when it can't be
   * read, every reference is left to the verifier, as before.
   */
  readonly l1?: L1References;
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
  readonly #l1: L1References | undefined;
  readonly #admitted = new Map<string, Decided>();
  readonly #refused = new Map<string, Decided>();

  constructor({ panels, clock, cacheSize = 1024, l1 }: BallotAdmissionOptions) {
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
    this.#l1 = l1;
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
    // One budget for the whole batch: ballots naming many distinct blocks,
    // or a slow node, delay it by one budget at most, then go unchecked (T-52).
    const l1Deadline = this.#l1?.deadline();
    const outcomes: SubmitOutcome[] = [];
    for (const [i, verdict] of verdicts.entries()) {
      const ballot = own[i] as Uint8Array;
      if (!verdict.ok) {
        outcomes.push({ ok: false, error: new SubmitError("rejected", verdict.code) });
        continue;
      }
      const l1 = await this.#l1Check(admission, verdict, l1Deadline);
      if (typeof l1 !== "string") {
        outcomes.push({ ok: false, error: new SubmitError("rejected", l1.rejected) });
        continue;
      }
      // Labelled before the proofs ran, so a later-labelled ballot may have
      // been boarded meanwhile: this one then takes that segment, never a
      // lower one (a ballot boarded under a segment whose checkpoint may
      // already be taken would fail it, checkpoint-boundary).
      try {
        const boarded = await appendEntry(client, id, Number(segment), ballot, {
          raiseToPrevious: true,
          ballot: {
            tier: verdict.tier,
            nullifier: verdict.nullifier,
            message: verdict.message,
            ballotHash: verdict.ballotHash,
          },
        });
        outcomes.push({ ok: true, boarded, l1 });
      } catch (e) {
        if (!(e instanceof AppendError && e.code === "repeat")) throw e;
        outcomes.push({ ok: false, error: new SubmitError("rejected", "repeat") });
      }
    }
    return outcomes;
  }

  /**
   * Judges `receipt` (a share receipt record's bytes) for `electionId` at
   * UNIX time `now` by the board path's rules (docs/spec/delivery.md,
   * Boarding) and, if it passes, appends it to the board in the segment
   * current at `now`, never after `s_D`. Throws `ReceiptError` for a
   * refusal, with nothing written. The same bytes again return the entry
   * that carries them; a passing receipt in other bytes for a seat whose
   * receipt the board path already carries returns that entry instead, as
   * `earlier`, writing nothing.
   */
  async submitReceipt(
    client: Sql,
    electionId: Uint8Array,
    receipt: Uint8Array,
    now: bigint,
  ): Promise<ReceiptOutcome> {
    if (!isBytes(electionId) || electionId.length !== 32)
      throw new TypeError("electionId must be 32 bytes");
    if (!isBytes(receipt)) throw new TypeError("receipt must be bytes");
    if (typeof now !== "bigint" || now < 0n) throw new TypeError("now must be a bigint ≥ 0");
    const id = new Uint8Array(electionId);
    const own = new Uint8Array(receipt);
    let admission;
    try {
      admission = await this.#admission(client, id);
    } catch (e) {
      if (e instanceof SubmitError) throw new ReceiptError(e.code);
      throw e;
    }
    if (!admission.ok) throw new ReceiptError("not-open");
    const { epoch, period } = this.#clock;
    // 2.6 fails a definition opening before the clock's epoch, and a
    // receipt needs a boarded ballot, so before it nothing is in time.
    if (now < epoch || admission.closesAt + admission.l1InclusionBound < epoch)
      throw new ReceiptError("not-open");
    const last = deliverySegments(
      this.#clock,
      admission.closesAt,
      admission.l1InclusionBound,
    ).delivery;
    const segment = (now - epoch) / period;
    // Rule 3: a board-path receipt boarded after `s_D` is outside its window
    // and delivers nothing, so it isn't boarded at all.
    if (segment > last || segment > 0xffffffffn) throw new ReceiptError("not-open");
    const verdict = admission.receipt(own);
    if (!verdict.ok) throw new ReceiptError("rejected", verdict.code);
    // Version-1 delivery records, the only ones judged yet, name no panel:
    // their seats are the default panel's.
    const key = { ballotHash: verdict.ballotHash, panel: 1, seat: verdict.seat };
    // A receipt the board path already carries, replayed byte for byte from
    // the public board, gets its entry before any ballot is read (T-52).
    const boarded = await readBoardedReceipt(client, id, key, own);
    if (boarded !== undefined) return { boarded, earlier: false };
    const ballot = await readBallotByHash(client, id, verdict.ballotHash);
    if (ballot === undefined) throw new ReceiptError("rejected", "receipt-ballot");
    if (!verdict.check(ballot)) throw new ReceiptError("rejected", "share-receipt");
    try {
      const boarded = await appendEntry(client, id, Number(segment), own, {
        raiseToPrevious: true,
        lastSegment: Number(last > 0xffffffffn ? 0xffffffffn : last),
        receipt: key,
      });
      return { boarded, earlier: false };
    } catch (e) {
      if (!(e instanceof AppendError)) throw e;
      if (e.code === "receipt-present" && e.existing !== undefined)
        return { boarded: e.existing, earlier: true };
      if (e.code === "segment-late") throw new ReceiptError("not-open");
      throw e;
    }
  }

  /**
   * 5.8 for one admitted ballot, as far as the finalized chain decides it: a
   * rejection, or how it stands. Only the node's own chain is judged: a
   * definition naming another L1 is left to the verifier.
   */
  async #l1Check(
    admission: ElectionAdmission,
    ballot: { readonly l1RefNumber: bigint; readonly l1RefHash: Uint8Array },
    deadline: number | undefined,
  ): Promise<L1Check | { readonly rejected: L1RefCode }> {
    const l1 = this.#l1;
    if (l1 === undefined) return "off";
    if (admission.l1ChainId !== l1.chainId) return "unchecked";
    let verdict;
    try {
      verdict = await l1.judge(admission, ballot, deadline);
    } catch {
      // An unreachable or inconsistent node never refuses a ballot: 5.8 is
      // the verifier's to decide, and refusing here would let the node's
      // outage turn voters away (T-25). The outcome says it went unchecked.
      return "unchecked";
    }
    return verdict === "admitted" || verdict === "pending" ? verdict : { rejected: verdict };
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
