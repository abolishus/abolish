// Share delivery on the board (docs/spec/delivery.md): share receipts
// (0x000c), postings (0x000d) and complaints (0x000e) as records, the
// delivery deadline and complaint window, and the delivery check that decides
// which selected ballots stay in the counted set. A ballot counts only if every
// qualified seat has a receipt or a passing contract-path posting in time, and
// no proven complaint excludes it (ADR 0002, Deadline, Complaints and the
// owner's 2026-10-12 decision; T-41, T-29, T-25, T-54).

import { ballotHash, type BallotLabel, type CommittedVote, labelOf } from "./ballot-validity.ts";
import {
  bytesFixed,
  type CodecValue,
  DecodeError,
  type DecodeErrorCode,
  encode,
  struct,
  u8,
} from "./codec.ts";
import type { RegisteredKeys } from "./ceremony.ts";
import { PARAMETERS } from "./parameters.ts";
import { RECORD_TYPES, RecordSchema, recordType } from "./record.ts";
import { checkL1Reference, type FinalizedL1, selectBallots } from "./revoting.ts";
import {
  checkComplaint,
  checkPosting,
  COMPLAINT_PROOF,
  type PostingCode,
  SHARE_CIPHERTEXT,
} from "./share-encryption.ts";
import { checkReceiptStatement } from "./share-receipt.ts";
import { MAX_TRUSTEES, p256Sig, signStatement, verifyStatement } from "./trustee.ts";

const COMPLAINT_TAG = "abolish/v1/sig/share-complaint";

/** `DELIVERY_WINDOW`: seconds after `closes_at + l1_inclusion_bound` by which receipts and postings are sent. */
export const DELIVERY_WINDOW = BigInt(PARAMETERS.DELIVERY_WINDOW);

/** `COMPLAINT_WINDOW`: seconds after `closes_at + l1_inclusion_bound` by which complaints are sent. */
export const COMPLAINT_WINDOW = BigInt(PARAMETERS.COMPLAINT_WINDOW);

const receiptV1 = struct([
  ["definition_hash", bytesFixed(32)],
  ["ballot_hash", bytesFixed(32)],
  ["seat", u8],
  ["share_hash", bytesFixed(32)],
  ["signature", p256Sig],
] as const);

const postingV1 = struct([
  ["definition_hash", bytesFixed(32)],
  ["ballot_hash", bytesFixed(32)],
  ["seat", u8],
  ["m", bytesFixed(32)],
  ["ciphertext", SHARE_CIPHERTEXT],
] as const);

const complaintFields = [
  ["definition_hash", bytesFixed(32)],
  ["ballot_hash", bytesFixed(32)],
  ["seat", u8],
  ["proof", COMPLAINT_PROOF],
] as const;

const complaintStatementV1 = struct(complaintFields);

const complaintV1 = struct([...complaintFields, ["signature", p256Sig]] as const);

/** Share receipt record, version 1: the 97-byte receipt statement and its signature. */
export type ShareReceiptRecord = CodecValue<typeof receiptV1>;

/** Share posting record, version 1: a ciphertext with its ML-KEM message, unsigned. */
export type SharePostingRecord = CodecValue<typeof postingV1>;

/** What a complaint's signature is over: every field but the signature. */
export type ShareComplaintStatement = CodecValue<typeof complaintStatementV1>;

/** Share complaint record, version 1. */
export type ShareComplaintRecord = CodecValue<typeof complaintV1>;

/** Record type `0x000c`. Ballot version 1 fixes it at version 1; it is never pinned. */
export const SHARE_RECEIPT = recordType(RECORD_TYPES.shareReceipt, { 1: receiptV1 });

/** Record type `0x000d`. Ballot version 1 fixes it at version 1; it is never pinned. */
export const SHARE_POSTING = recordType(RECORD_TYPES.sharePosting, { 1: postingV1 });

/** Record type `0x000e`. Ballot version 1 fixes it at version 1; it is never pinned. */
export const SHARE_COMPLAINT = recordType(RECORD_TYPES.shareComplaint, { 1: complaintV1 });

const SCHEMA = new RecordSchema([SHARE_RECEIPT, SHARE_POSTING, SHARE_COMPLAINT]);

export function encodeShareReceipt(record: ShareReceiptRecord): Uint8Array {
  return SCHEMA.encode(SHARE_RECEIPT, 1, record);
}

/** Strictly decodes a share receipt record against the version the ballot version fixes. */
export function decodeShareReceipt(bytes: Uint8Array, pinned: 1): ShareReceiptRecord {
  return SCHEMA.decode(SHARE_RECEIPT, bytes, pinned).value;
}

export function encodeSharePosting(record: SharePostingRecord): Uint8Array {
  return SCHEMA.encode(SHARE_POSTING, 1, record);
}

/** Strictly decodes a posting record; a ciphertext that doesn't decode fails the whole record. */
export function decodeSharePosting(bytes: Uint8Array, pinned: 1): SharePostingRecord {
  return SCHEMA.decode(SHARE_POSTING, bytes, pinned).value;
}

export function encodeShareComplaint(record: ShareComplaintRecord): Uint8Array {
  return SCHEMA.encode(SHARE_COMPLAINT, 1, record);
}

/** Strictly decodes a complaint record against the version the ballot version fixes. */
export function decodeShareComplaint(bytes: Uint8Array, pinned: 1): ShareComplaintRecord {
  return SCHEMA.decode(SHARE_COMPLAINT, bytes, pinned).value;
}

/** `m = definition_hash ‖ ballot_hash ‖ u8(seat) ‖ encode(proof)`: 161 bytes. */
export function shareComplaintStatement(statement: ShareComplaintStatement): Uint8Array {
  // Through the struct, so only these fields are read even from a whole record.
  return encode(complaintStatementV1, {
    definition_hash: statement.definition_hash,
    ballot_hash: statement.ballot_hash,
    seat: statement.seat,
    proof: statement.proof,
  });
}

/**
 * Signs a complaint with the seat's per-election signing key. A node makes
 * the proof with `proveComplaint`, which refuses unless the posting passes
 * and its own intake fails at decryption or the share check.
 */
export function signShareComplaint(
  signingSecret: Uint8Array,
  statement: ShareComplaintStatement,
): ShareComplaintRecord {
  const m = shareComplaintStatement(statement);
  const { dh, c, z } = statement.proof;
  return {
    definition_hash: Uint8Array.from(statement.definition_hash),
    ballot_hash: Uint8Array.from(statement.ballot_hash),
    seat: statement.seat,
    proof: { dh, c, z },
    signature: signStatement(signingSecret, COMPLAINT_TAG, m),
  };
}

/** The anchoring clock's period arithmetic (docs/spec/board.md, Timing). */
export interface PeriodClock {
  readonly epoch: bigint;
  readonly period: bigint;
}

/** `s_D` and `s_K`: the last segments in which a board-path receipt or complaint is in time. */
export interface DeliverySegments {
  readonly delivery: bigint;
  readonly complaint: bigint;
}

/**
 * `s_D = period(closes_at + l1_inclusion_bound + DELIVERY_WINDOW)` and
 * `s_K` likewise with `COMPLAINT_WINDOW` (docs/spec/delivery.md, Windows).
 * Verifier 2.6 has already required `opens_at ≥ epoch`.
 */
export function deliverySegments(
  clock: PeriodClock,
  closesAt: bigint,
  l1InclusionBound: bigint,
): DeliverySegments {
  const { epoch, period } = clock;
  if (typeof epoch !== "bigint" || epoch < 0n) throw new RangeError("epoch must be a bigint ≥ 0");
  if (typeof period !== "bigint" || period < 1n)
    throw new RangeError("period must be a bigint ≥ 1");
  if (typeof closesAt !== "bigint" || typeof l1InclusionBound !== "bigint" || l1InclusionBound < 0n)
    throw new RangeError("closesAt and l1InclusionBound must be bigints, the bound ≥ 0");
  const end = closesAt + l1InclusionBound;
  if (end < epoch) throw new RangeError("the close is before the anchoring clock's epoch");
  return {
    delivery: (end + DELIVERY_WINDOW - epoch) / period,
    complaint: (end + COMPLAINT_WINDOW - epoch) / period,
  };
}

/**
 * The delivery deadline and the end of the complaint window, in seconds:
 * `closes_at + l1_inclusion_bound + DELIVERY_WINDOW` and likewise with
 * `COMPLAINT_WINDOW`. A contract-path record is in time if its submission time
 * is at or before them (docs/spec/delivery.md, Windows).
 */
export interface DeliveryDeadlines {
  readonly delivery: bigint;
  readonly complaint: bigint;
}

/** The deadlines a contract-path record's submission time is compared with. */
export function deliveryDeadlines(closesAt: bigint, l1InclusionBound: bigint): DeliveryDeadlines {
  if (typeof closesAt !== "bigint" || typeof l1InclusionBound !== "bigint" || l1InclusionBound < 0n)
    throw new RangeError("closesAt and l1InclusionBound must be bigints, the bound ≥ 0");
  const end = closesAt + l1InclusionBound;
  return { delivery: end + DELIVERY_WINDOW, complaint: end + COMPLAINT_WINDOW };
}

/**
 * The intake cutoff `c_I = t_D − F − R` (docs/spec/delivery.md, What a node
 * owes): every trustee node keeps intake open until it, decides once at it
 * what it owes through the contract path, and refuses intake from it on, so
 * its obligation is one decision's, never the union of several over a
 * changing view. `forcedInclusion` (`F`) and `margin` (`R`) are the release's,
 * the values `deliveryWindowFits` checks, so every node and client agrees.
 */
export function intakeCutoff(
  closesAt: bigint,
  l1InclusionBound: bigint,
  constants: { readonly forcedInclusion: bigint; readonly margin: bigint },
): bigint {
  const { forcedInclusion, margin } = constants;
  for (const v of [forcedInclusion, margin])
    if (typeof v !== "bigint" || v < 0n)
      throw new RangeError("forcedInclusion and margin must be bigints ≥ 0");
  return deliveryDeadlines(closesAt, l1InclusionBound).delivery - forcedInclusion - margin;
}

/**
 * The bounds P4-1's anchoring clock and P1-18's contract-event window must
 * keep (docs/spec/delivery.md, Direct submit), in seconds as bigints:
 * `DELIVERY_WINDOW ≥ max(2 · period + deadline, W_C) + R + F`, so every
 * counted ballot's anchoring or contract recording is confirmable on finalized
 * L1 by the intake cutoff `c_I = t_D − F − R`, where a trustee node decides
 * what it owes, with `R` left to send its receipts through the contract path,
 * even forced through L1; and `COMPLAINT_WINDOW − DELIVERY_WINDOW ≥ W_C
 * + F + R`, so a trustee can read the last posting and still send a complaint.
 * `margin` is `R`, for L1 finality and the node's own reaction.
 */
export function deliveryWindowFits(constants: {
  readonly period: bigint;
  readonly deadline: bigint;
  readonly contractEventWindow: bigint;
  readonly forcedInclusion: bigint;
  readonly margin: bigint;
}): boolean {
  const { period, deadline, contractEventWindow, forcedInclusion, margin } = constants;
  for (const v of [period, deadline, contractEventWindow, forcedInclusion, margin])
    if (typeof v !== "bigint" || v < 0n)
      throw new RangeError("every constant must be a bigint ≥ 0");
  const anchored = 2n * period + deadline;
  const seen = anchored > contractEventWindow ? anchored : contractEventWindow;
  return (
    seen + margin + forcedInclusion <= DELIVERY_WINDOW &&
    contractEventWindow + forcedInclusion + margin <= COMPLAINT_WINDOW - DELIVERY_WINDOW
  );
}

/**
 * One ballot of a trustee node's view (docs/spec/delivery.md, What a node
 * owes): a ballot it receipted and can't show absent, or one it holds from
 * the anchored board or the contract's records. Each passed the admission
 * checks (verifier 5.1 to 5.4, at intake or as the node checked it), and
 * `message` is `M` recomputed from its record, never a decoded field.
 */
export interface ViewBallot {
  readonly ballotHash: Uint8Array;
  readonly tier: number;
  readonly nullifier: bigint;
  readonly message: Uint8Array;
  readonly l1RefNumber: bigint;
  readonly l1RefHash: Uint8Array;
  /** Whether this node receipted it. */
  readonly receipted: boolean;
}

/**
 * The ballot hashes whose receipts a trustee node owes through the contract
 * path (docs/spec/delivery.md, What a node owes). For each tier and nullifier:
 * the ballot [[revoting]]'s selection picks from the node's view, among those
 * whose L1 reference is admitted, if the node receipted its ballot hash (under
 * any L1 reference: a receipt covers the public part), and nothing on a tie or
 * when the pick is a ballot it didn't receipt; and, since the view may lack
 * the copy that counts, the ballot hash of its newest receipted ballot whose
 * reference isn't admitted (a block reorganised away, whose core the client
 * cast again, revoting Client rule 4). At most two per tier and nullifier, so
 * with membership-checked intake at most two per member of each tier,
 * however many ballots anyone delivers or an operator withholds (ADR 0002,
 * Decision, 2026-10-12; T-52, T-25, T-54). `l1` must have finalized a block
 * after `closesAt`, so no reference is pending and every node reaches the
 * same verdicts; the function throws otherwise. A node calls it once, at the
 * intake cutoff (`intakeCutoff`), and refuses intake afterwards: the union of
 * several calls over a changing view isn't bounded. Sorted by ballot hash.
 */
export function owedReceipts(
  view: Iterable<ViewBallot>,
  l1: FinalizedL1,
  window: { readonly l1RefMin: bigint; readonly closesAt: bigint },
): Uint8Array[] {
  const receipted = new Set<string>();
  const hashOf = new Map<string, Uint8Array>();
  // Per tier and nullifier, the newest receipted ballot whose reference isn't
  // admitted (ties broken by the smaller ballot hash, so every node agrees).
  const unadmitted = new Map<string, { l1RefNumber: bigint; hash: Uint8Array }>();
  const admitted: {
    tier: number;
    nullifier: bigint;
    message: Uint8Array;
    l1RefNumber: bigint;
    index: bigint;
  }[] = [];
  for (const b of view) {
    const verdict = checkL1Reference(b, l1, window);
    if (verdict === "pending")
      throw new RangeError("owedReceipts: L1 hasn't finalized a block after close");
    // Before the L1 filter: a receipt for a ballot whose reference was
    // reorganised away still covers its public part cast again.
    if (b.receipted) receipted.add(hex(b.ballotHash));
    if (verdict !== "admitted") {
      if (b.receipted) {
        const key = `${b.tier}:${b.nullifier}`;
        const prev = unadmitted.get(key);
        if (
          prev === undefined ||
          b.l1RefNumber > prev.l1RefNumber ||
          (b.l1RefNumber === prev.l1RefNumber && hex(b.ballotHash) < hex(prev.hash))
        )
          unadmitted.set(key, { l1RefNumber: b.l1RefNumber, hash: Uint8Array.from(b.ballotHash) });
      }
      continue;
    }
    const m = hex(b.message);
    const h = hashOf.get(m);
    // M binds the ballot hash, so two copies with one message are one ballot.
    if (h !== undefined && hex(h) !== hex(b.ballotHash))
      throw new RangeError("owedReceipts: one message names two ballot hashes");
    hashOf.set(m, Uint8Array.from(b.ballotHash));
    admitted.push({
      tier: b.tier,
      nullifier: b.nullifier,
      message: b.message,
      l1RefNumber: b.l1RefNumber,
      index: BigInt(admitted.length),
    });
  }
  const owed: Uint8Array[] = [];
  for (const b of selectBallots(admitted).selected) {
    const m = hex(b.message);
    const hash = hashOf.get(m) as Uint8Array;
    // A receipt is for a ballot hash, so it covers the same public part cast
    // again under another L1 reference (a new M), as the delivery check reads
    // it (T-25).
    if (receipted.has(hex(hash))) owed.push(hash);
  }
  // Without the board's data the node can't see the copy cast again after a
  // reorganisation; its receipt for the first copy delivers that one (T-25).
  for (const { hash } of unadmitted.values())
    if (!owed.some((h) => hex(h) === hex(hash))) owed.push(hash);
  return owed.sort((a, b) => (hex(a) < hex(b) ? -1 : hex(a) > hex(b) ? 1 : 0));
}

/** What the delivery check runs against, all from data the verifier has already checked. */
export interface DeliveryElection {
  readonly definitionHash: Uint8Array;
  /** `n`: every ballot carries `n` share hashes. */
  readonly panelSize: number;
  /** The registered key set ([[ceremony]], Transcript check): the qualified seats. */
  readonly registered: readonly RegisteredKeys[];
  readonly segments: DeliverySegments;
  readonly deadlines: DeliveryDeadlines;
}

/**
 * A ballot [[revoting]] selected, decoded, with its tier (ballot version 2:
 * its cell) and nullifier; it passed `validity-shape`.
 */
export type DeliveryBallot = BallotLabel & {
  readonly nullifier: bigint;
  readonly vote: CommittedVote;
};

/**
 * A delivery record in the counted extent: through the board path, with the
 * segment of the board entry that carries it, or through the contract path,
 * with its L2 submission time, read from its contract event (P1-18). Only the
 * contract path carries postings: L2 data is available to every trustee, so
 * no operator can withhold a posting through the complaint window.
 */
export type DeliveryEntry =
  | { readonly path: "board"; readonly segment: number; readonly payload: Uint8Array }
  | { readonly path: "contract"; readonly submittedAt: bigint; readonly payload: Uint8Array };

export type DeliveryRecordCode =
  | "delivery-stray"
  | "delivery-seat"
  | "delivery-late"
  | "share-receipt"
  | PostingCode
  | "complaint-void"
  | "complaint-proof"
  | "complaint-unfounded"
  | "receipt-contradicted";

/** A record the check ignored or attributed, by its position in the entries checked. */
export interface DeliveryRecordReport {
  readonly at: number;
  readonly code: DeliveryRecordCode;
  /**
   * The seat its signature attributes it to, or `null`, for the attributable
   * codes (`share-receipt`, `complaint-unfounded`, `receipt-contradicted`).
   */
  readonly signer?: number | null;
}

/** A proven complaint, by its position, with the seat its signature attributes it to, or `null`. */
export interface ProvenComplaint {
  readonly at: number;
  readonly seat: number;
  readonly signer: number | null;
}

/** One selected ballot's delivery, in the order the ballots were given. */
export interface BallotDelivery {
  readonly ballotHash: Uint8Array;
  /** True only if it is delivered and no complaint about it is proven: it stays in the counted set. */
  readonly counted: boolean;
  readonly delivered: boolean;
  /** Qualified seats with no receipt or passing posting in time, ascending. */
  readonly missing: readonly number[];
  readonly excludedBy: readonly ProvenComplaint[];
}

export interface DeliveryCheck {
  readonly ballots: readonly BallotDelivery[];
  readonly records: readonly DeliveryRecordReport[];
  /** Payloads that don't decode under the fixed version: rejected entries, never an election failure. */
  readonly rejected: readonly { readonly at: number; readonly error: DecodeErrorCode }[];
}

type Decoded =
  | { readonly kind: "receipt"; readonly record: ShareReceiptRecord }
  | { readonly kind: "posting"; readonly record: SharePostingRecord }
  | { readonly kind: "complaint"; readonly record: ShareComplaintRecord };

function decodeDelivery(payload: Uint8Array, pinned: 1, path: DeliveryEntry["path"]): Decoded {
  if (payload.length < 3) throw new DecodeError("truncated", 0);
  const type = ((payload[0] as number) << 8) | (payload[1] as number);
  switch (type) {
    case RECORD_TYPES.shareReceipt:
      return { kind: "receipt", record: decodeShareReceipt(payload, pinned) };
    case RECORD_TYPES.sharePosting:
      // Board-entry version 3 doesn't allow a posting, so one here through the
      // board path is rejected like the entry that would carry it.
      if (path !== "contract") throw new DecodeError("unexpected-record-type", 0);
      return { kind: "posting", record: decodeSharePosting(payload, pinned) };
    case RECORD_TYPES.shareComplaint:
      return { kind: "complaint", record: decodeShareComplaint(payload, pinned) };
    default:
      // Another record type, which the caller shouldn't have passed: rejected
      // like any undecodable entry, so board content can't stop the check.
      throw new DecodeError("unexpected-record-type", 0);
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** The seat a complaint's signature attributes it to, or `null` (T-29). */
function complaintSigner(
  registered: readonly RegisteredKeys[],
  c: ShareComplaintRecord,
): number | null {
  const seat = registered.find((k) => k.index === c.seat);
  if (seat === undefined) return null;
  return verifyStatement(seat.signingKey, COMPLAINT_TAG, shareComplaintStatement(c), c.signature)
    ? c.seat
    : null;
}

/**
 * The delivery check (docs/spec/delivery.md, Delivery check; verifier 5.9).
 * `ballots` are the ballots selected for every cell from the counted extent;
 * `entries` every share-receipt, posting and complaint in the counted extent,
 * by either path, in board order, and `at` in every report is a position in
 * it. A board-path record is in time by its segment, a contract-path one by
 * its submission time, and a posting delivers only through the contract path.
 * A ballot stays in the counted set only if every qualified seat has a
 * receipt or a passing posting in time and no complaint about it is proven.
 * Neither depends on the records' order, duplicates or records for other
 * ballots (R3).
 */
export function checkDelivery(
  election: DeliveryElection,
  ballots: readonly DeliveryBallot[],
  entries: readonly DeliveryEntry[],
  pinned: 1,
): DeliveryCheck {
  const { definitionHash, panelSize, registered, segments, deadlines } = election;
  if (!(definitionHash instanceof Uint8Array) || definitionHash.length !== 32)
    throw new RangeError("checkDelivery: definitionHash must be 32 bytes");
  if (!Number.isSafeInteger(panelSize) || panelSize < 2 || panelSize > MAX_TRUSTEES)
    throw new RangeError("checkDelivery: panelSize must be from 2 to 16");
  for (const k of registered)
    if (!Number.isSafeInteger(k.index) || k.index < 1 || k.index > panelSize)
      throw new RangeError("checkDelivery: every registered seat must be from 1 to n");
  // A malformed window would fail open (every record in time) or closed, so
  // both pairs are checked, and each pair in order.
  for (const pair of [segments, deadlines])
    if (
      typeof pair?.delivery !== "bigint" ||
      typeof pair.complaint !== "bigint" ||
      pair.delivery < 0n ||
      pair.complaint < pair.delivery
    )
      throw new RangeError(
        "checkDelivery: segments and deadlines must be bigints, delivery ≤ complaint",
      );
  for (const e of entries)
    if (
      e.path === "board"
        ? !Number.isSafeInteger(e.segment) || e.segment < 0
        : e.path !== "contract" || typeof e.submittedAt !== "bigint"
    )
      throw new RangeError("checkDelivery: every entry is a board-path or contract-path record");
  const keyOf = new Map(registered.map((k) => [k.index, k]));
  if (keyOf.size !== registered.length)
    throw new RangeError("checkDelivery: a registered seat is listed twice");

  const hashes = ballots.map((b) => {
    if (b.vote.share_hashes.length !== panelSize)
      throw new RangeError("checkDelivery: every ballot must have passed validity-shape");
    const { version, label } = labelOf(b);
    const named: BallotLabel = version === 1 ? { tier: label } : { ballotVersion: 2, cell: label };
    return ballotHash({ definitionHash, ...named, nullifier: b.nullifier }, b.vote);
  });
  // A ballot hash binds the tier or cell and the nullifier, so selected ballots never share one.
  const byHash = new Map(hashes.map((h, i) => [hex(h), i]));

  const delivered = ballots.map(() => new Set<number>());
  const records: DeliveryRecordReport[] = [];
  const rejected: { at: number; error: DecodeErrorCode }[] = [];
  // Passing receipts and complaints to check once every posting is known, by ballot.
  const receipts: { at: number; ballot: number; seat: number }[] = [];
  const complaints: { at: number; ballot: number; record: ShareComplaintRecord }[] = [];
  const postings = ballots.map(() => new Map<number, SharePostingRecord>());

  entries.forEach((entry, at) => {
    let d: Decoded;
    try {
      d = decodeDelivery(entry.payload, pinned, entry.path);
    } catch (e) {
      if (!(e instanceof DecodeError)) throw e;
      rejected.push({ at, error: e.code });
      return;
    }
    const r = d.record;
    if (!sameBytes(r.definition_hash, definitionHash)) {
      records.push({ at, code: "delivery-stray" });
      return;
    }
    const ballot = byHash.get(hex(r.ballot_hash));
    // A record for a ballot that isn't selected decides nothing.
    if (ballot === undefined) return;
    const key = keyOf.get(r.seat);
    if (key === undefined) {
      records.push({ at, code: "delivery-seat" });
      return;
    }
    const late =
      entry.path === "board"
        ? BigInt(entry.segment) > (d.kind === "complaint" ? segments.complaint : segments.delivery)
        : entry.submittedAt > (d.kind === "complaint" ? deadlines.complaint : deadlines.delivery);
    if (late) {
      records.push({ at, code: "delivery-late" });
      return;
    }
    const b = ballots[ballot] as DeliveryBallot;
    const shareHash = b.vote.share_hashes[r.seat - 1] as Uint8Array;
    if (d.kind === "receipt") {
      const ok =
        sameBytes(d.record.share_hash, shareHash) &&
        checkReceiptStatement(
          registered,
          {
            definition_hash: definitionHash,
            ballot_hash: hashes[ballot] as Uint8Array,
            seat: r.seat,
            share_hash: shareHash,
          },
          d.record.signature,
        );
      if (!ok) {
        // T-29: a seat whose signature verifies over the record's own fields
        // signed a share hash other than the ballot's for this ballot.
        const signer = checkReceiptStatement(registered, d.record, d.record.signature)
          ? r.seat
          : null;
        records.push({ at, code: "share-receipt", signer });
        return;
      }
      (delivered[ballot] as Set<number>).add(r.seat);
      receipts.push({ at, ballot, seat: r.seat });
    } else if (d.kind === "posting") {
      const p = checkPosting(
        { definitionHash },
        r.seat,
        key.kemKey,
        b.vote.vss,
        b.vote.share_hashes,
        {
          ciphertext: encode(SHARE_CIPHERTEXT, d.record.ciphertext),
          m: d.record.m,
        },
      );
      if (!p.ok) {
        records.push({ at, code: p.code });
        return;
      }
      (delivered[ballot] as Set<number>).add(r.seat);
      postings[ballot]?.set(r.seat, d.record);
    } else {
      complaints.push({ at, ballot, record: d.record });
    }
  });

  // Complaints, once every posting is known: the passing posting needn't come
  // before the complaint on the board.
  const excluded = ballots.map(() => [] as ProvenComplaint[]);
  for (const { at, ballot, record } of complaints) {
    const b = ballots[ballot] as DeliveryBallot;
    const posting = postings[ballot]?.get(record.seat);
    if (posting === undefined) {
      records.push({ at, code: "complaint-void" });
      continue;
    }
    const key = keyOf.get(record.seat) as RegisteredKeys;
    const result = checkComplaint(
      { definitionHash },
      record.seat,
      key.kemKey,
      b.vote.vss,
      b.vote.share_hashes,
      { ciphertext: encode(SHARE_CIPHERTEXT, posting.ciphertext), m: posting.m },
      record.proof,
    );
    const signer = complaintSigner(registered, record);
    if (result.ok) excluded[ballot]?.push({ at, seat: record.seat, signer });
    else if (result.code === "complaint-unfounded")
      records.push({ at, code: "complaint-unfounded", signer });
    else records.push({ at, code: "complaint-proof" });
  }
  // A passing receipt for a seat whose complaint is proven: the seat signed
  // that shares passed which a public proof shows don't (T-29).
  for (const { at, ballot, seat } of receipts)
    if (excluded[ballot]?.some((c) => c.seat === seat))
      records.push({ at, code: "receipt-contradicted", signer: seat });

  records.sort((a, b) => a.at - b.at);
  const result = ballots.map((_, i) => {
    const got = delivered[i] as Set<number>;
    const missing = registered
      .map((k) => k.index)
      .filter((s) => !got.has(s))
      .sort((a, b) => a - b);
    const excludedBy = (excluded[i] as ProvenComplaint[]).sort((a, b) => a.at - b.at);
    return {
      ballotHash: hashes[i] as Uint8Array,
      counted: missing.length === 0 && excludedBy.length === 0,
      delivered: missing.length === 0,
      missing,
      excludedBy,
    };
  });
  return { ballots: result, records, rejected };
}

/** Builds a share receipt record from an intake result, for the client and the node to board. */
export function shareReceiptRecord(
  definitionHash: Uint8Array,
  seat: number,
  receipt: {
    readonly ballotHash: Uint8Array;
    readonly shareHash: Uint8Array;
    readonly receipt: Uint8Array;
  },
): ShareReceiptRecord {
  return {
    definition_hash: Uint8Array.from(definitionHash),
    ballot_hash: Uint8Array.from(receipt.ballotHash),
    seat,
    share_hash: Uint8Array.from(receipt.shareHash),
    signature: Uint8Array.from(receipt.receipt),
  };
}
