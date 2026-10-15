// Share delivery on the board (docs/spec/delivery.md): share receipts
// (0x000c), postings (0x000d) and complaints (0x000e) as records, the
// delivery deadline and complaint window, and the delivery check that decides
// which selected ballots stay in the counted set. A ballot counts only if every
// qualified seat has a receipt or a passing contract-path posting in time, and
// no proven complaint excludes it (ADR 0002, Deadline, Complaints and the
// owner's 2026-10-12 decision; T-41, T-29, T-25, T-54).

import {
  ballotHash,
  ballotHashV4,
  type BallotHashContextV3,
  type BallotLabel,
  type CommittedVote,
  type CommittedVoteV4,
  labelOf,
} from "./ballot-validity.ts";
import { SEAT_PANELS, type SeatPanel } from "./ballot.ts";
import {
  BN254_R,
  bytesFixed,
  type CodecValue,
  DecodeError,
  type DecodeErrorCode,
  encode,
  enum8,
  struct,
  u8,
} from "./codec.ts";
import type { RegisteredKeys } from "./ceremony.ts";
import { PARAMETERS } from "./parameters.ts";
import { RECORD_TYPES, RecordSchema, recordType } from "./record.ts";
import { checkL1Reference, type FinalizedL1, selectBallots } from "./revoting.ts";
import { type BallotPath, ballotWindow } from "./close-statement.ts";
import {
  checkComplaint,
  checkComplaintV4,
  checkPosting,
  checkPostingV4,
  COMPLAINT_PROOF,
  type ComplaintProof,
  type ComplaintResult,
  type Posting,
  type PostingCode,
  type PostingResult,
  SHARE_CIPHERTEXT,
} from "./share-encryption.ts";
import {
  checkReceiptStatement,
  checkReceiptStatementV4,
  type PanelReceiptSigners,
} from "./share-receipt.ts";
import {
  MAX_TRUSTEES,
  p256Sig,
  type SignatureTag,
  signStatement,
  verifyStatement,
} from "./trustee.ts";

const COMPLAINT_TAG = "abolish/v1/sig/share-complaint";

// A new tag for version 2's 162-byte statement, which names no version: under
// one tag it and version 1's 161 bytes would be two layouts
// (docs/spec/delivery.md, Records (version 2); domain-separation.md).
const COMPLAINT_TAG_V2 = "abolish/v1/sig/share-complaint-2";

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

// Version 2, which ballot version 4 fixes: version 1's fields with the seat's
// panel before the seat, so a record for one panel's seat `i` never reads as
// the other's (docs/spec/delivery.md, Version 2; T-37).
const SEAT_PANEL = enum8([SEAT_PANELS.default, SEAT_PANELS.author]);

const receiptV2 = struct([
  ["definition_hash", bytesFixed(32)],
  ["ballot_hash", bytesFixed(32)],
  ["panel", SEAT_PANEL],
  ["seat", u8],
  ["share_hash", bytesFixed(32)],
  ["signature", p256Sig],
] as const);

const postingV2 = struct([
  ["definition_hash", bytesFixed(32)],
  ["ballot_hash", bytesFixed(32)],
  ["panel", SEAT_PANEL],
  ["seat", u8],
  ["m", bytesFixed(32)],
  ["ciphertext", SHARE_CIPHERTEXT],
] as const);

const complaintFieldsV2 = [
  ["definition_hash", bytesFixed(32)],
  ["ballot_hash", bytesFixed(32)],
  ["panel", SEAT_PANEL],
  ["seat", u8],
  ["proof", COMPLAINT_PROOF],
] as const;

const complaintStatementV2 = struct(complaintFieldsV2);

const complaintV2 = struct([...complaintFieldsV2, ["signature", p256Sig]] as const);

/** Share receipt record, version 1: the 97-byte receipt statement and its signature. */
export type ShareReceiptRecord = CodecValue<typeof receiptV1>;

/** Share posting record, version 1: a ciphertext with its ML-KEM message, unsigned. */
export type SharePostingRecord = CodecValue<typeof postingV1>;

/** What a complaint's signature is over: every field but the signature. */
export type ShareComplaintStatement = CodecValue<typeof complaintStatementV1>;

/** Share complaint record, version 1. */
export type ShareComplaintRecord = CodecValue<typeof complaintV1>;

/** Share receipt record, version 2: the 98-byte version-4 receipt statement and its signature. */
export type ShareReceiptRecordV2 = CodecValue<typeof receiptV2>;

/** Share posting record, version 2: version 1's, naming the seat's panel. */
export type SharePostingRecordV2 = CodecValue<typeof postingV2>;

/** What a version-2 complaint's signature is over: every field but the signature. */
export type ShareComplaintStatementV2 = CodecValue<typeof complaintStatementV2>;

/** Share complaint record, version 2: version 1's, naming the seat's panel. */
export type ShareComplaintRecordV2 = CodecValue<typeof complaintV2>;

/** Record type `0x000c`. Ballot versions 1 to 3 fix it at version 1, version 4 at version 2; it is never pinned. */
export const SHARE_RECEIPT = recordType(RECORD_TYPES.shareReceipt, { 1: receiptV1, 2: receiptV2 });

/** Record type `0x000d`. Ballot versions 1 to 3 fix it at version 1, version 4 at version 2; it is never pinned. */
export const SHARE_POSTING = recordType(RECORD_TYPES.sharePosting, { 1: postingV1, 2: postingV2 });

/** Record type `0x000e`. Ballot versions 1 to 3 fix it at version 1, version 4 at version 2; it is never pinned. */
export const SHARE_COMPLAINT = recordType(RECORD_TYPES.shareComplaint, {
  1: complaintV1,
  2: complaintV2,
});

const SCHEMA = new RecordSchema([SHARE_RECEIPT, SHARE_POSTING, SHARE_COMPLAINT]);

export function encodeShareReceipt(record: ShareReceiptRecord): Uint8Array {
  return SCHEMA.encode(SHARE_RECEIPT, 1, record);
}

export function encodeShareReceiptV2(record: ShareReceiptRecordV2): Uint8Array {
  return SCHEMA.encode(SHARE_RECEIPT, 2, record);
}

/** Strictly decodes a share receipt record against the version the ballot version fixes. */
export function decodeShareReceipt(bytes: Uint8Array, pinned: 1): ShareReceiptRecord;
export function decodeShareReceipt(bytes: Uint8Array, pinned: 2): ShareReceiptRecordV2;
export function decodeShareReceipt(
  bytes: Uint8Array,
  pinned: 1 | 2,
): ShareReceiptRecord | ShareReceiptRecordV2 {
  return SCHEMA.decode(SHARE_RECEIPT, bytes, pinned).value;
}

export function encodeSharePosting(record: SharePostingRecord): Uint8Array {
  return SCHEMA.encode(SHARE_POSTING, 1, record);
}

export function encodeSharePostingV2(record: SharePostingRecordV2): Uint8Array {
  return SCHEMA.encode(SHARE_POSTING, 2, record);
}

/** Strictly decodes a posting record; a ciphertext that doesn't decode fails the whole record. */
export function decodeSharePosting(bytes: Uint8Array, pinned: 1): SharePostingRecord;
export function decodeSharePosting(bytes: Uint8Array, pinned: 2): SharePostingRecordV2;
export function decodeSharePosting(
  bytes: Uint8Array,
  pinned: 1 | 2,
): SharePostingRecord | SharePostingRecordV2 {
  return SCHEMA.decode(SHARE_POSTING, bytes, pinned).value;
}

export function encodeShareComplaint(record: ShareComplaintRecord): Uint8Array {
  return SCHEMA.encode(SHARE_COMPLAINT, 1, record);
}

export function encodeShareComplaintV2(record: ShareComplaintRecordV2): Uint8Array {
  return SCHEMA.encode(SHARE_COMPLAINT, 2, record);
}

/** Strictly decodes a complaint record against the version the ballot version fixes. */
export function decodeShareComplaint(bytes: Uint8Array, pinned: 1): ShareComplaintRecord;
export function decodeShareComplaint(bytes: Uint8Array, pinned: 2): ShareComplaintRecordV2;
export function decodeShareComplaint(
  bytes: Uint8Array,
  pinned: 1 | 2,
): ShareComplaintRecord | ShareComplaintRecordV2 {
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

/** `m = definition_hash ‖ ballot_hash ‖ u8(panel) ‖ u8(seat) ‖ encode(proof)`: 162 bytes. */
export function shareComplaintStatementV2(statement: ShareComplaintStatementV2): Uint8Array {
  return encode(complaintStatementV2, {
    definition_hash: statement.definition_hash,
    ballot_hash: statement.ballot_hash,
    panel: statement.panel,
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

/**
 * Signs a version-2 complaint with the seat's per-election signing key from
 * its own panel's key set, under `abolish/v1/sig/share-complaint-2`. A node
 * makes the proof with `proveComplaintV4`.
 */
export function signShareComplaintV2(
  signingSecret: Uint8Array,
  statement: ShareComplaintStatementV2,
): ShareComplaintRecordV2 {
  const m = shareComplaintStatementV2(statement);
  const { dh, c, z } = statement.proof;
  return {
    definition_hash: Uint8Array.from(statement.definition_hash),
    ballot_hash: Uint8Array.from(statement.ballot_hash),
    panel: statement.panel,
    seat: statement.seat,
    proof: { dh, c, z },
    signature: signStatement(signingSecret, COMPLAINT_TAG_V2, m),
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
  // A cutoff at or before `closes_at + l1_inclusion_bound` would decide before
  // any ballot can be confirmed; only `deliveryWindowFits` shows that every
  // counted one can be by `c_I`.
  if (forcedInclusion + margin >= DELIVERY_WINDOW)
    throw new RangeError("forcedInclusion + margin must be less than DELIVERY_WINDOW");
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
 * the anchored board or the contract's records. Whether the node receipted
 * it is decided by its ballot hash against the node's receipts, never by the
 * copy (`owedReceipts`). Each passed the admission
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
  /**
   * The entry that carries a copy the node holds from the anchored board or
   * the contract's records, judged by the close rule (verifier 5.5,
   * `ballotWindow`): its path, and the L2 block's timestamp, the relay's
   * stamp or the segment; `null` only for a ballot the node holds from its
   * own intake and can't show absent, which has no entry the node has seen.
   * Required, so a board or contract copy can't be passed without the entry
   * the close rule judges.
   */
  readonly entry: { readonly path: BallotPath; readonly value: bigint } | null;
}

/** What the node's view is judged against: the L1 reference's window and the close rule's. */
export interface ViewWindow {
  readonly l1RefMin: bigint;
  readonly closesAt: bigint;
  /** `opens_at`, for an ordinary or relayed copy's window; needed only when a copy carries its entry. */
  readonly opensAt?: bigint;
  /** `s_A = period(closes_at) + 1` (`boardBallotSegment`); needed only when a copy carries its entry. */
  readonly boardSegment?: bigint;
}

/**
 * The ballot hashes whose receipts a trustee node owes through the contract
 * path (docs/spec/delivery.md, What a node owes). For each tier and nullifier:
 * the ballot [[revoting]]'s selection picks from the node's view, among those
 * whose L1 reference is admitted, if `receipts` holds its ballot hash (under
 * any L1 reference: a receipt covers the public part, and a copy the node
 * showed absent leaves its receipt in `receipts`), and nothing on a tie or
 * when the pick is a ballot it didn't receipt; and, since the view may lack
 * the copy that counts, the ballot hash of its newest view ballot with a
 * receipt whose reference isn't admitted (a block reorganised away, whose core the client
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
  /** The ballot hash of every receipt the node issued, never reduced by absence. */
  receipts: Iterable<Uint8Array>,
  l1: FinalizedL1,
  window: ViewWindow,
): Uint8Array[] {
  const receipted = new Set<string>();
  for (const h of receipts) receipted.add(hex(h));
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
    // Checked before either branch, as selectBallots checks the admitted, so a
    // non-canonical ν can't start a group of its own.
    if (b.tier !== 0 && b.tier !== 1 && b.tier !== 2)
      throw new RangeError("owedReceipts: tier must be 0, 1 or 2");
    if (typeof b.nullifier !== "bigint" || b.nullifier < 0n || b.nullifier >= BN254_R)
      throw new RangeError("owedReceipts: nullifier is not a canonical field<bn254> value");
    // The close rule (5.5) runs before the L1 check and selection: a copy
    // whose entry is outside the poll's window never counts or displaces
    // another, so a ballot boarded late can't take the counted one's place in
    // the node's selection while the verifier still counts it (T-35, T-54).
    if (b.entry !== null) {
      const { opensAt, boardSegment } = window;
      if (opensAt === undefined || boardSegment === undefined)
        throw new RangeError("owedReceipts: a copy with its entry needs opensAt and boardSegment");
      if (
        ballotWindow(b.entry.path, b.entry.value, {
          opensAt,
          closesAt: window.closesAt,
          boardSegment,
        }) !== "admitted"
      )
        continue;
    }
    const verdict = checkL1Reference(b, l1, window);
    if (verdict === "pending")
      throw new RangeError("owedReceipts: L1 hasn't finalized a block after close");
    if (verdict !== "admitted") {
      if (receipted.has(hex(b.ballotHash))) {
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
  // Keyed by hex, so the union is no longer quadratic in what is owed.
  const owed = new Map<string, Uint8Array>();
  for (const b of selectBallots(admitted).selected) {
    const hash = hashOf.get(hex(b.message)) as Uint8Array;
    // A receipt is for a ballot hash, so it covers the same public part cast
    // again under another L1 reference (a new M), as the delivery check reads
    // it (T-25).
    const key = hex(hash);
    if (receipted.has(key)) owed.set(key, hash);
  }
  // Without the board's data the node can't see the copy cast again after a
  // reorganisation; its receipt for the first copy delivers that one (T-25).
  for (const { hash } of unadmitted.values()) owed.set(hex(hash), hash);
  return [...owed.keys()].sort().map((k) => owed.get(k) as Uint8Array);
}

/**
 * A trustee node's complaint scope (docs/spec/delivery.md, What a node owes):
 * the ballot hashes whose failing postings it owes complaints about. It is
 * `owedReceipts` with every ballot of the view counted as receipted: for each
 * tier and nullifier, the ballot the selection picks and the newest ballot
 * whose L1 reference isn't admitted, whoever receipted them. A complaint can
 * change a counted set only for the ballot the delivery check selects, so the
 * scope comes from the ballots the node holds and never from postings, which
 * anyone who has a member's proof can make up: at most two per tier and
 * nullifier, the bound its receipts have (T-52, T-54). Decided once, at the
 * intake cutoff, over the view the node then holds. Sorted by ballot hash.
 */
export function complaintScope(
  view: Iterable<ViewBallot>,
  l1: FinalizedL1,
  window: ViewWindow,
): Uint8Array[] {
  const ballots = [...view];
  return owedReceipts(
    ballots,
    ballots.map((b) => b.ballotHash),
    l1,
    window,
  );
}

/**
 * The forced path's figures a release pins (docs/spec/delivery.md,
 * Capacity): what every seat of every election together can send through
 * L1 deposits when the sequencer refuses their transactions, and what a
 * receipt call and a complaint call cost there. The board's tests bind the
 * two call figures to measured gas, with `P256VERIFY` (T-25, T-52, T-54).
 */
export const FORCED_PATH = Object.freeze({
  /** Deposit gas per L1 block: the portal's target, `maxResourceLimit / elasticityMultiplier`. */
  depositGasTarget: 2_000_000n,
  /** Seconds per L1 block: 12-second slots, at most one in 13 missed, as `F` assumes. */
  l1BlockSeconds: 13n,
  /** Receipts in one `submitReceipts` call. */
  receiptsPerCall: 256n,
  /** Gas of one receipt call of up to `receiptsPerCall`, intrinsic gas included. */
  receiptCallGas: 18_500_000n,
  /** Gas of one `submitComplaint` call, intrinsic gas included. */
  complaintCallGas: 180_000n,
} as const);

/** The windows the forced path's intervals are read from: `W_C`, `F` and `R`, the values `deliveryWindowFits` checks. */
export interface ForcedPathWindows {
  readonly contractEventWindow: bigint;
  readonly forcedInclusion: bigint;
  readonly margin: bigint;
}

/** One election as the capacity check reads it. */
export interface ForcedPathElection {
  /** `M`: the definition's members, as [[verifier]] 2.4 recomputes them (`definitionMembers`). */
  readonly members: bigint;
  /** `s`: every seat that may force records, the default panel's and an author panel's. */
  readonly seats: number;
  readonly closesAt: bigint;
  readonly l1InclusionBound: bigint;
}

/** Gas a seat set may have to force through L1 between `start` (inclusive) and `end` (exclusive). */
export interface ForcedPathInterval {
  readonly start: bigint;
  readonly end: bigint;
  readonly gas: bigint;
}

function forcedPathLengths(w: ForcedPathWindows): { receipts: bigint; complaints: bigint } {
  for (const v of [w.contractEventWindow, w.forcedInclusion, w.margin])
    if (typeof v !== "bigint" || v < 0n) throw new RangeError("every window must be a bigint ≥ 0");
  const complaints = COMPLAINT_WINDOW - DELIVERY_WINDOW - w.contractEventWindow - w.forcedInclusion;
  // An empty interval would leave no time to force anything; deliveryWindowFits
  // makes both at least R, and R at least 1 second.
  if (w.margin < 1n || complaints < 1n)
    throw new RangeError("the receipts' and complaints' intervals must be at least 1 second");
  return { receipts: w.margin, complaints };
}

/**
 * The forced path's demand of one election (docs/spec/delivery.md, Capacity):
 * every seat's receipts, `s · ⌈2M / RECEIPTS_PER_CALL⌉` receipt calls between
 * the intake cutoff `c_I` and `c_D = t_D − F`, and every seat's complaints,
 * `s · 2M` complaint calls between `t_D + W_C`, when the last posting in time
 * is recorded, and `c_K = t_K − F`.
 */
export function forcedPathDemand(
  election: ForcedPathElection,
  windows: ForcedPathWindows,
): { readonly receipts: ForcedPathInterval; readonly complaints: ForcedPathInterval } {
  const { members, seats, closesAt, l1InclusionBound } = election;
  if (typeof members !== "bigint" || members < 0n)
    throw new RangeError("members must be a bigint ≥ 0");
  // At most MAX_TRUSTEES seats in each of the two panels.
  if (!Number.isInteger(seats) || seats < 1 || seats > 2 * MAX_TRUSTEES)
    throw new RangeError("seats must be an integer from 1 to 2 · MAX_TRUSTEES");
  forcedPathLengths(windows);
  const { delivery, complaint } = deliveryDeadlines(closesAt, l1InclusionBound);
  const s = BigInt(seats);
  const owed = 2n * members;
  const calls = (owed + FORCED_PATH.receiptsPerCall - 1n) / FORCED_PATH.receiptsPerCall;
  const cD = delivery - windows.forcedInclusion;
  return {
    receipts: { start: cD - windows.margin, end: cD, gas: s * calls * FORCED_PATH.receiptCallGas },
    complaints: {
      start: delivery + windows.contractEventWindow,
      end: complaint - windows.forcedInclusion,
      gas: s * owed * FORCED_PATH.complaintCallGas,
    },
  };
}

/**
 * Whether a set of elections fits the forced path (docs/spec/delivery.md,
 * Capacity): each election's receipts and complaints spread evenly over their
 * intervals, the rates of every interval containing any moment sum to at most
 * `DEPOSIT_GAS_TARGET / L1_BLOCK_SECONDS` gas per second. The sum only rises at
 * an interval's start, so the starts are the moments checked. A trustee node
 * runs it over a stub with every election its seat approved, and refuses the
 * stub if it doesn't fit, so it never owes more than L1 can carry in time
 * (T-25, T-52, T-54).
 */
export function forcedPathFits(
  elections: Iterable<ForcedPathElection>,
  windows: ForcedPathWindows,
): boolean {
  const lengths = forcedPathLengths(windows);
  const demands = [...elections].map((e) => forcedPathDemand(e, windows));
  const receipts = demands.map((d) => d.receipts);
  const complaints = demands.map((d) => d.complaints);
  const at = (xs: ForcedPathInterval[], t: bigint) =>
    xs.reduce((sum, x) => (x.start <= t && t < x.end ? sum + x.gas : sum), 0n);
  // (G_R / R + G_K / L_K) · L1_BLOCK_SECONDS ≤ DEPOSIT_GAS_TARGET, in integers.
  const limit = FORCED_PATH.depositGasTarget * lengths.receipts * lengths.complaints;
  for (const { start: t } of [...receipts, ...complaints]) {
    const rate =
      (at(receipts, t) * lengths.complaints + at(complaints, t) * lengths.receipts) *
      FORCED_PATH.l1BlockSeconds;
    if (rate > limit) return false;
  }
  return true;
}

/**
 * The most members one election with `seats` seats can have and still fit
 * the forced path alone (`forcedPathFits`), for a node or creator to state
 * the cap: a lone election's two intervals never overlap.
 */
export function forcedPathMembersLimit(seats: number, windows: ForcedPathWindows): bigint {
  const fits = (members: bigint) =>
    forcedPathFits([{ members, seats, closesAt: 0n, l1InclusionBound: 0n }], windows);
  // No members owe nothing, so 0 always fits; then doubling, and bisection
  // over [ok, bad).
  let ok = 0n;
  let bad = 1n;
  while (fits(bad)) {
    ok = bad;
    bad *= 2n;
  }
  while (bad - ok > 1n) {
    const mid = (ok + bad) / 2n;
    if (fits(mid)) ok = mid;
    else bad = mid;
  }
  return ok;
}

/**
 * `M`, a definition's members: the sum over its tiers of `group_size`
 * (version 1) or of the tier's `regions` (versions 3 to 6, whose cells' members
 * sum to the same), the counts [[verifier]] 2.4 recomputes from the group
 * registry. A rolling tier's members over the poll aren't known when it opens
 * (docs/spec/delivery.md, Capacity), so it throws for a rolling definition
 * (`electorate_mode` 2, or any `rolling_electorate`), and for an empty
 * electorate, which no well-formed definition has and which is a rolling
 * one's `electorate`: counting it as no members would let a node approve an
 * election whose obligation it never sized.
 */
export function definitionMembers(definition: {
  readonly electorate: readonly (
    | { readonly group_size: bigint }
    | { readonly regions: readonly bigint[] }
  )[];
  readonly electorate_mode?: number;
  readonly rolling_electorate?: readonly unknown[];
}): bigint {
  const { electorate, electorate_mode, rolling_electorate } = definition;
  if (
    electorate.length === 0 ||
    (electorate_mode !== undefined && electorate_mode !== 1) ||
    (rolling_electorate !== undefined && rolling_electorate.length > 0)
  )
    throw new RangeError("definitionMembers: a rolling or empty electorate has no fixed count");
  let members = 0n;
  for (const tier of electorate)
    members +=
      "group_size" in tier ? tier.group_size : tier.regions.reduce((sum, n) => sum + n, 0n);
  return members;
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

/** A seat of either panel: version 1's records and ballots name only default seats. */
export interface PanelSeat {
  readonly panel: SeatPanel;
  readonly seat: number;
}

/**
 * One decoded delivery record of either version, as the check reads it:
 * version 1's name the default panel.
 */
type DeliveryItem = PanelSeat & {
  readonly definitionHash: Uint8Array;
  readonly ballotHash: Uint8Array;
} & (
    | {
        readonly kind: "receipt";
        readonly shareHash: Uint8Array;
        readonly signature: Uint8Array;
      }
    | { readonly kind: "posting"; readonly posting: Posting }
    | {
        readonly kind: "complaint";
        readonly proof: ComplaintProof;
        /** What its signature is over: the record's fields but the signature. */
        readonly statement: Uint8Array;
        readonly signature: Uint8Array;
      }
  );

/** What differs between the versions: decoding, each panel's keys, and the per-seat checks. */
interface DeliveryRules {
  /** Strictly decodes a payload of `kind` under the version the ballot version fixes; throws `DecodeError`. */
  decode(kind: DeliveryItem["kind"], payload: Uint8Array): DeliveryItem;
  /** The tag a complaint's signature is under. */
  readonly complaintTag: SignatureTag;
  /** The seat's registered keys in its own panel's key set. */
  keys(seat: PanelSeat): RegisteredKeys | undefined;
  /** The selected ballot's share hash for the seat, from its own panel's list. */
  shareHash(ballot: number, seat: PanelSeat): Uint8Array;
  /** `share-receipt` over a statement: the seat's registered signing key signed it. */
  receiptSigned(
    statement: PanelSeat & { readonly ballotHash: Uint8Array; readonly shareHash: Uint8Array },
    signature: Uint8Array,
  ): boolean;
  posting(ballot: number, seat: PanelSeat, key: RegisteredKeys, posting: Posting): PostingResult;
  complaint(
    ballot: number,
    seat: PanelSeat,
    key: RegisteredKeys,
    posting: Posting,
    proof: ComplaintProof,
  ): ComplaintResult;
}

interface SeatDelivery {
  readonly ballotHash: Uint8Array;
  readonly counted: boolean;
  readonly delivered: boolean;
  readonly missing: readonly PanelSeat[];
  readonly excludedBy: readonly (ProvenComplaint & { readonly panel: SeatPanel })[];
}

type SeatReport = DeliveryRecordReport & PanelSeat;

interface SeatCheck {
  readonly ballots: readonly SeatDelivery[];
  readonly records: readonly SeatReport[];
  readonly rejected: readonly { readonly at: number; readonly error: DecodeErrorCode }[];
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const seatKey = (s: PanelSeat) => `${s.panel}:${s.seat}`;

const bySeat = (a: PanelSeat, b: PanelSeat) => a.panel - b.panel || a.seat - b.seat;

// The record type, read before decoding: board-entry versions 3 and 4 don't
// allow a posting, so one here through the board path is rejected like the
// entry that would carry it, and another record type, which the caller
// shouldn't have passed, is rejected like any undecodable entry, so board
// content can't stop the check.
function deliveryKind(payload: Uint8Array, path: DeliveryEntry["path"]): DeliveryItem["kind"] {
  if (payload.length < 3) throw new DecodeError("truncated", 0);
  const type = ((payload[0] as number) << 8) | (payload[1] as number);
  if (type === RECORD_TYPES.shareReceipt) return "receipt";
  if (type === RECORD_TYPES.sharePosting && path === "contract") return "posting";
  if (type === RECORD_TYPES.shareComplaint) return "complaint";
  throw new DecodeError("unexpected-record-type", 0);
}

function checkWindows(segments: DeliverySegments, deadlines: DeliveryDeadlines, name: string) {
  // A malformed window would fail open (every record in time) or closed, so
  // both pairs are checked, and each pair in order.
  for (const pair of [segments, deadlines])
    if (
      typeof pair?.delivery !== "bigint" ||
      typeof pair.complaint !== "bigint" ||
      pair.delivery < 0n ||
      pair.complaint < pair.delivery
    )
      throw new RangeError(`${name}: segments and deadlines must be bigints, delivery ≤ complaint`);
}

function checkEntries(entries: readonly DeliveryEntry[], name: string) {
  for (const e of entries)
    if (
      e.path === "board"
        ? !Number.isSafeInteger(e.segment) || e.segment < 0
        : e.path !== "contract" || typeof e.submittedAt !== "bigint"
    )
      throw new RangeError(`${name}: every entry is a board-path or contract-path record`);
}

// A panel's registered key set, by seat: each seat from 1 to the panel's size, once.
function keySet(registered: readonly RegisteredKeys[], size: number, name: string) {
  for (const k of registered)
    if (!Number.isSafeInteger(k.index) || k.index < 1 || k.index > size)
      throw new RangeError(`${name}: every registered seat must be from 1 to its panel's size`);
  const keyOf = new Map(registered.map((k) => [k.index, k]));
  if (keyOf.size !== registered.length)
    throw new RangeError(`${name}: a registered seat is listed twice`);
  return keyOf;
}

/**
 * The delivery check over seats of either panel (docs/spec/delivery.md,
 * Delivery check; Version 2), for `checkDelivery` and `checkDeliveryV2`:
 * `hashes` are the selected ballots' recomputed ballot hashes, `qualified`
 * every seat of each panel's registered key set. A record for one panel never
 * delivers, excludes or contradicts a seat of the other.
 */
function deliveryCheck(
  election: {
    readonly definitionHash: Uint8Array;
    readonly segments: DeliverySegments;
    readonly deadlines: DeliveryDeadlines;
  },
  hashes: readonly Uint8Array[],
  qualified: readonly PanelSeat[],
  entries: readonly DeliveryEntry[],
  rules: DeliveryRules,
): SeatCheck {
  const { definitionHash, segments, deadlines } = election;
  // A ballot hash binds the tier or cell and the nullifier, so selected ballots never share one.
  const byHash = new Map(hashes.map((h, i) => [hex(h), i]));

  const delivered = hashes.map(() => new Set<string>());
  const records: SeatReport[] = [];
  const rejected: { at: number; error: DecodeErrorCode }[] = [];
  // Passing receipts and complaints to check once every posting is known, by ballot.
  const receipts: { at: number; ballot: number; seat: PanelSeat }[] = [];
  const complaints: {
    at: number;
    ballot: number;
    item: DeliveryItem & { readonly kind: "complaint" };
  }[] = [];
  const postings = hashes.map(() => new Map<string, Posting>());

  entries.forEach((entry, at) => {
    let d: DeliveryItem;
    try {
      d = rules.decode(deliveryKind(entry.payload, entry.path), entry.payload);
    } catch (e) {
      if (!(e instanceof DecodeError)) throw e;
      rejected.push({ at, error: e.code });
      return;
    }
    const seat: PanelSeat = { panel: d.panel, seat: d.seat };
    if (!sameBytes(d.definitionHash, definitionHash)) {
      records.push({ at, code: "delivery-stray", ...seat });
      return;
    }
    const ballot = byHash.get(hex(d.ballotHash));
    // A record for a ballot that isn't selected decides nothing.
    if (ballot === undefined) return;
    const key = rules.keys(seat);
    if (key === undefined) {
      records.push({ at, code: "delivery-seat", ...seat });
      return;
    }
    const late =
      entry.path === "board"
        ? BigInt(entry.segment) > (d.kind === "complaint" ? segments.complaint : segments.delivery)
        : entry.submittedAt > (d.kind === "complaint" ? deadlines.complaint : deadlines.delivery);
    if (late) {
      records.push({ at, code: "delivery-late", ...seat });
      return;
    }
    const shareHash = rules.shareHash(ballot, seat);
    if (d.kind === "receipt") {
      const ok =
        sameBytes(d.shareHash, shareHash) &&
        rules.receiptSigned(
          { ...seat, ballotHash: hashes[ballot] as Uint8Array, shareHash },
          d.signature,
        );
      if (!ok) {
        // T-29: a seat whose signature verifies over the record's own fields
        // signed a share hash other than the ballot's for this ballot.
        const signer = rules.receiptSigned(
          { ...seat, ballotHash: d.ballotHash, shareHash: d.shareHash },
          d.signature,
        )
          ? d.seat
          : null;
        records.push({ at, code: "share-receipt", signer, ...seat });
        return;
      }
      (delivered[ballot] as Set<string>).add(seatKey(seat));
      receipts.push({ at, ballot, seat });
    } else if (d.kind === "posting") {
      const p = rules.posting(ballot, seat, key, d.posting);
      if (!p.ok) {
        records.push({ at, code: p.code, ...seat });
        return;
      }
      (delivered[ballot] as Set<string>).add(seatKey(seat));
      postings[ballot]?.set(seatKey(seat), d.posting);
    } else {
      complaints.push({ at, ballot, item: d });
    }
  });

  // Complaints, once every posting is known: the passing posting needn't come
  // before the complaint on the board.
  const excluded = hashes.map(() => [] as (ProvenComplaint & { readonly panel: SeatPanel })[]);
  for (const { at, ballot, item } of complaints) {
    const seat: PanelSeat = { panel: item.panel, seat: item.seat };
    const posting = postings[ballot]?.get(seatKey(seat));
    if (posting === undefined) {
      records.push({ at, code: "complaint-void", ...seat });
      continue;
    }
    const key = rules.keys(seat) as RegisteredKeys;
    const result = rules.complaint(ballot, seat, key, posting, item.proof);
    // T-29: attributed only under the seat's registered signing key, never its identity key.
    const signer = verifyStatement(
      key.signingKey,
      rules.complaintTag,
      item.statement,
      item.signature,
    )
      ? item.seat
      : null;
    if (result.ok) excluded[ballot]?.push({ at, ...seat, signer });
    else if (result.code === "complaint-unfounded")
      records.push({ at, code: "complaint-unfounded", signer, ...seat });
    else records.push({ at, code: "complaint-proof", ...seat });
  }
  // A passing receipt for a seat whose complaint about the same ballot, in the
  // same panel, is proven: the seat signed that shares passed which a public
  // proof shows don't (T-29).
  for (const { at, ballot, seat } of receipts)
    if (excluded[ballot]?.some((c) => c.panel === seat.panel && c.seat === seat.seat))
      records.push({ at, code: "receipt-contradicted", signer: seat.seat, ...seat });

  records.sort((a, b) => a.at - b.at);
  const ballots = hashes.map((ballotHash, i) => {
    const got = delivered[i] as Set<string>;
    const missing = qualified.filter((s) => !got.has(seatKey(s))).sort(bySeat);
    const excludedBy = (excluded[i] as (ProvenComplaint & { panel: SeatPanel })[]).sort(
      (a, b) => a.at - b.at,
    );
    return {
      ballotHash,
      counted: missing.length === 0 && excludedBy.length === 0,
      delivered: missing.length === 0,
      missing,
      excludedBy,
    };
  });
  return { ballots, records, rejected };
}

/**
 * The delivery check (docs/spec/delivery.md, Delivery check; verifier 5.9)
 * for ballot versions 1 and 2, with delivery records of version 1.
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
  const keyOf = keySet(registered, panelSize, "checkDelivery");
  checkWindows(segments, deadlines, "checkDelivery");
  checkEntries(entries, "checkDelivery");

  const hashes = ballots.map((b) => {
    if (b.vote.share_hashes.length !== panelSize)
      throw new RangeError("checkDelivery: every ballot must have passed validity-shape");
    const { version, label } = labelOf(b);
    const named: BallotLabel = version === 1 ? { tier: label } : { ballotVersion: 2, cell: label };
    return ballotHash({ definitionHash, ...named, nullifier: b.nullifier }, b.vote);
  });
  const vote = (ballot: number) => (ballots[ballot] as DeliveryBallot).vote;
  const ctx = { definitionHash };
  const rules: DeliveryRules = {
    complaintTag: COMPLAINT_TAG,
    decode(kind, payload) {
      const panel = SEAT_PANELS.default;
      if (kind === "receipt") {
        const r = decodeShareReceipt(payload, pinned);
        const { definition_hash, ballot_hash, seat, share_hash, signature } = r;
        return {
          kind,
          definitionHash: definition_hash,
          ballotHash: ballot_hash,
          panel,
          seat,
          shareHash: share_hash,
          signature,
        };
      }
      if (kind === "posting") {
        const r = decodeSharePosting(payload, pinned);
        return {
          kind,
          definitionHash: r.definition_hash,
          ballotHash: r.ballot_hash,
          panel,
          seat: r.seat,
          posting: { ciphertext: encode(SHARE_CIPHERTEXT, r.ciphertext), m: r.m },
        };
      }
      const r = decodeShareComplaint(payload, pinned);
      return {
        kind,
        definitionHash: r.definition_hash,
        ballotHash: r.ballot_hash,
        panel,
        seat: r.seat,
        proof: r.proof,
        statement: shareComplaintStatement(r),
        signature: r.signature,
      };
    },
    keys: ({ panel, seat }) => (panel === SEAT_PANELS.default ? keyOf.get(seat) : undefined),
    shareHash: (ballot, { seat }) => vote(ballot).share_hashes[seat - 1] as Uint8Array,
    receiptSigned: (s, signature) =>
      checkReceiptStatement(
        registered,
        {
          definition_hash: definitionHash,
          ballot_hash: s.ballotHash,
          seat: s.seat,
          share_hash: s.shareHash,
        },
        signature,
      ),
    posting: (ballot, { seat }, key, posting) =>
      checkPosting(ctx, seat, key.kemKey, vote(ballot).vss, vote(ballot).share_hashes, posting),
    complaint: (ballot, { seat }, key, posting, proof) =>
      checkComplaint(
        ctx,
        seat,
        key.kemKey,
        vote(ballot).vss,
        vote(ballot).share_hashes,
        posting,
        proof,
      ),
  };
  const qualified = registered.map((k) => ({ panel: SEAT_PANELS.default, seat: k.index }));
  const r = deliveryCheck(election, hashes, qualified, entries, rules);
  return {
    ballots: r.ballots.map((b) => ({
      ballotHash: b.ballotHash,
      counted: b.counted,
      delivered: b.delivered,
      missing: b.missing.map((s) => s.seat),
      excludedBy: b.excludedBy.map(({ at, seat, signer }) => ({ at, seat, signer })),
    })),
    records: r.records.map(({ at, code, signer }) =>
      signer === undefined ? { at, code } : { at, code, signer },
    ),
    rejected: r.rejected,
  };
}

// --- Version 2 (docs/spec/delivery.md, Version 2) --------------------------------

/**
 * What the version-2 delivery check runs against: each panel's size and
 * registered key set, from the definition and each panel's checked ceremony
 * transcript. `authorPanelSize` is `n_A`, 0 without an author panel.
 */
export interface DeliveryElectionV2 {
  readonly definitionHash: Uint8Array;
  readonly panelSize: number;
  readonly authorPanelSize: number;
  readonly registered: {
    readonly default: readonly RegisteredKeys[];
    readonly author: readonly RegisteredKeys[];
  };
  readonly segments: DeliverySegments;
  readonly deadlines: DeliveryDeadlines;
}

/** A selected version-4 ballot, decoded, with its cell and nullifier; it passed `validity-shape`. */
export interface DeliveryBallotV4 {
  readonly cell: number;
  readonly nullifier: bigint;
  readonly vote: CommittedVoteV4;
}

/** A version-2 record the check ignored or attributed, with the panel and seat the record names. */
export type DeliveryRecordReportV2 = DeliveryRecordReport & PanelSeat;

/** A proven version-2 complaint, with its panel. */
export type ProvenComplaintV2 = ProvenComplaint & { readonly panel: SeatPanel };

/** One selected version-4 ballot's delivery. */
export interface BallotDeliveryV2 {
  readonly ballotHash: Uint8Array;
  readonly counted: boolean;
  readonly delivered: boolean;
  /** Qualified seats of either panel with no receipt or passing posting in time: default seats first, each panel ascending. */
  readonly missing: readonly PanelSeat[];
  readonly excludedBy: readonly ProvenComplaintV2[];
}

export interface DeliveryCheckV2 {
  readonly ballots: readonly BallotDeliveryV2[];
  readonly records: readonly DeliveryRecordReportV2[];
  readonly rejected: readonly { readonly at: number; readonly error: DecodeErrorCode }[];
}

/**
 * The delivery check for ballot version 4 (docs/spec/delivery.md, Delivery
 * check (version 2); verifier 5.9), over delivery records of version 2 and
 * every seat of both panels: each record checked against its own panel's
 * share hashes and registered key set, so a record for one panel's seat `i`
 * never delivers, excludes or contradicts the other's (T-37). Otherwise
 * `checkDelivery`'s. The author panel must be absent (`authorPanelSize` 0,
 * no author keys): its key set comes from its own ceremony's transcript
 * check, which P2-16 part 3 specifies, and until then none is taken on trust,
 * as `panelBallotElection` and `checkShareReceiptV4` refuse one.
 */
export function checkDeliveryV2(
  election: DeliveryElectionV2,
  ballots: readonly DeliveryBallotV4[],
  entries: readonly DeliveryEntry[],
): DeliveryCheckV2 {
  if (election.authorPanelSize !== 0 || election.registered.author.length !== 0)
    throw new RangeError(
      "checkDeliveryV2: an author panel's key set comes from its own ceremony (P2-16 part 3)",
    );
  return checkDeliveryV2With(election, ballots, entries);
}

/**
 * Internal: `checkDeliveryV2` with the author panel's key set taken as given,
 * so author seats' delivery can be tested before P2-16 part 3, which then
 * replaces this. The package entry point doesn't export it. An author seat
 * outside the given key set needs no delivery, as the spec says, so part 3's
 * replacement must take the author key set from the checked transcript, with
 * its quorum, never from the caller (T-37, T-25).
 */
export function checkDeliveryV2With(
  election: DeliveryElectionV2,
  ballots: readonly DeliveryBallotV4[],
  entries: readonly DeliveryEntry[],
): DeliveryCheckV2 {
  const name = "checkDeliveryV2";
  const { definitionHash, panelSize, authorPanelSize, registered, segments, deadlines } = election;
  if (!(definitionHash instanceof Uint8Array) || definitionHash.length !== 32)
    throw new RangeError(`${name}: definitionHash must be 32 bytes`);
  if (!Number.isSafeInteger(panelSize) || panelSize < 2 || panelSize > MAX_TRUSTEES)
    throw new RangeError(`${name}: panelSize must be from 2 to 16`);
  if (
    !Number.isSafeInteger(authorPanelSize) ||
    authorPanelSize < 0 ||
    authorPanelSize > MAX_TRUSTEES
  )
    throw new RangeError(`${name}: authorPanelSize must be from 0 to 16`);
  const keyOf = {
    [SEAT_PANELS.default]: keySet(registered.default, panelSize, name),
    [SEAT_PANELS.author]: keySet(registered.author, authorPanelSize, name),
  };
  checkWindows(segments, deadlines, name);
  checkEntries(entries, name);

  const hashes = ballots.map((b) => {
    const v = b.vote;
    // validity-shape: one share hash per seat of each panel, and an author
    // half exactly when the poll has an author panel.
    if (
      v.share_hashes.length !== panelSize ||
      v.author_share_hashes.length !== authorPanelSize ||
      (v.author_vss.length === 0) !== (authorPanelSize === 0)
    )
      throw new RangeError(`${name}: every ballot must have passed validity-shape`);
    const ctx: BallotHashContextV3 = { definitionHash, cell: b.cell, nullifier: b.nullifier };
    return ballotHashV4(ctx, v);
  });
  const vote = (ballot: number) => (ballots[ballot] as DeliveryBallotV4).vote;
  const ctx = { definitionHash };
  const signers: PanelReceiptSigners = { default: registered.default, author: registered.author };
  const rules: DeliveryRules = {
    complaintTag: COMPLAINT_TAG_V2,
    decode(kind, payload) {
      if (kind === "receipt") {
        const r = decodeShareReceipt(payload, 2);
        return {
          kind,
          definitionHash: r.definition_hash,
          ballotHash: r.ballot_hash,
          panel: r.panel,
          seat: r.seat,
          shareHash: r.share_hash,
          signature: r.signature,
        };
      }
      if (kind === "posting") {
        const r = decodeSharePosting(payload, 2);
        return {
          kind,
          definitionHash: r.definition_hash,
          ballotHash: r.ballot_hash,
          panel: r.panel,
          seat: r.seat,
          posting: { ciphertext: encode(SHARE_CIPHERTEXT, r.ciphertext), m: r.m },
        };
      }
      const r = decodeShareComplaint(payload, 2);
      return {
        kind,
        definitionHash: r.definition_hash,
        ballotHash: r.ballot_hash,
        panel: r.panel,
        seat: r.seat,
        proof: r.proof,
        statement: shareComplaintStatementV2(r),
        signature: r.signature,
      };
    },
    keys: ({ panel, seat }) => keyOf[panel].get(seat),
    shareHash: (ballot, { panel, seat }) =>
      (panel === SEAT_PANELS.author ? vote(ballot).author_share_hashes : vote(ballot).share_hashes)[
        seat - 1
      ] as Uint8Array,
    receiptSigned: (s, signature) =>
      checkReceiptStatementV4(
        signers,
        {
          definition_hash: definitionHash,
          ballot_hash: s.ballotHash,
          panel: s.panel,
          seat: s.seat,
          share_hash: s.shareHash,
        },
        signature,
      ),
    posting: (ballot, { panel, seat }, key, posting) =>
      checkPostingV4(ctx, panel, seat, key.kemKey, vote(ballot), posting),
    complaint: (ballot, { panel, seat }, key, posting, proof) =>
      checkComplaintV4(ctx, panel, seat, key.kemKey, vote(ballot), posting, proof),
  };
  const qualified = [
    ...registered.default.map((k) => ({ panel: SEAT_PANELS.default, seat: k.index })),
    ...registered.author.map((k) => ({ panel: SEAT_PANELS.author, seat: k.index })),
  ];
  return deliveryCheck(election, hashes, qualified, entries, rules);
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

/** Builds a version-2 share receipt record from a version-4 intake result, naming the seat's panel. */
export function shareReceiptRecordV2(
  definitionHash: Uint8Array,
  seat: number,
  receipt: {
    readonly panel: SeatPanel;
    readonly ballotHash: Uint8Array;
    readonly shareHash: Uint8Array;
    readonly receipt: Uint8Array;
  },
): ShareReceiptRecordV2 {
  return {
    definition_hash: Uint8Array.from(definitionHash),
    ballot_hash: Uint8Array.from(receipt.ballotHash),
    panel: receipt.panel,
    seat,
    share_hash: Uint8Array.from(receipt.shareHash),
    signature: Uint8Array.from(receipt.receipt),
  };
}
