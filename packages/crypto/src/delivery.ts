// Share delivery on the board (docs/spec/delivery.md): share receipts
// (0x000c), postings (0x000d), complaints (0x000e), share-receipt and
// share-complaint batches (0x0016, 0x0017) and obligation roots (0x001a) as
// records, the
// delivery deadline and complaint window, and the delivery check that decides
// which selected ballots stay in the counted set. A ballot counts only if every
// qualified seat has a receipt or a passing contract-path posting in time, and
// no proven complaint excludes it (ADR 0002, Deadline, Complaints and the
// owner's 2026-10-12 decision; T-41, T-29, T-25, T-54).

import {
  ballotHash,
  ballotHashV3,
  ballotHashV4,
  type BallotHashContextV3,
  type BallotLabel,
  type CommittedVote,
  type CommittedVoteV3,
  type CommittedVoteV4,
  labelOf,
} from "./ballot-validity.ts";
import { approvedFor, SEAT_PANELS, type SeatPanel } from "./ballot.ts";
import {
  BN254_R,
  bytesFixed,
  type Codec,
  type CodecValue,
  decode,
  DecodeError,
  type DecodeErrorCode,
  encode,
  EncodeError,
  enum8,
  struct,
  u8,
  u32,
} from "./codec.ts";
import { checkedTranscriptHash, type RegisteredKeys } from "./ceremony.ts";
import { objectCid, readObject } from "./content-addressing.ts";
import { ds } from "./domain-separation.ts";
import { type ElectionDefinitionV6, electionDefinitionV6Rule } from "./election-definition.ts";
import { H } from "./group.ts";
import { inclusionProof, merkleRoot, type TreeHash, verifyInclusion } from "./merkle.ts";
import { PARAMETERS } from "./parameters.ts";
import {
  decodeElectionDefinitionV6,
  electionDefinitionV6Hash,
  encodeElectionDefinitionV6,
} from "./protocol.ts";
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

/**
 * `A`, `BALLOT_FETCH_ALLOWANCE`: the least seconds the delivery window leaves
 * trustee seats between the ballot extent's last anchoring deadline and the
 * intake cutoff, by which they attest it (docs/spec/availability.md, Windows).
 */
export const BALLOT_FETCH_ALLOWANCE = BigInt(PARAMETERS.BALLOT_FETCH_ALLOWANCE);

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

// --- Share-receipt batch (docs/spec/delivery.md, Share-receipt batch) ------------

/** `RECEIPT_BATCH_MAX`: the most pairs one share-receipt batch carries. */
export const RECEIPT_BATCH_MAX = 1024;

const BATCH_TAG = "abolish/v1/sig/share-receipt-batch";

/** One receipt in a batch: what a share receipt states, less the definition and seat the batch names once. */
export interface ReceiptPair {
  readonly ballot_hash: Uint8Array;
  readonly share_hash: Uint8Array;
}

const hash32 = bytesFixed(32);

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length && i < b.length; i++)
    if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  return a.length - b.length;
}

// `list<receipt_pair, RECEIPT_BATCH_MAX>` with 1 to RECEIPT_BATCH_MAX pairs,
// strictly ascending by ballot hash, so a set of receipts has one batch
// encoding and no pair repeats (T-31). Each pair's order is checked once its
// ballot hash is read, before its share hash.
const receiptPairs: Codec<readonly ReceiptPair[]> = {
  minLength: 4 + 64,
  write(w, value) {
    if (!Array.isArray(value)) throw new EncodeError("receipts: expected an array");
    const pairs = value as readonly ReceiptPair[];
    const n = pairs.length;
    if (n < 1 || n > RECEIPT_BATCH_MAX)
      throw new EncodeError(`receipts: a batch carries 1 to ${RECEIPT_BATCH_MAX} pairs`);
    w.uint(4, n);
    for (let i = 0; i < n; i++) {
      const p = pairs[i] as ReceiptPair;
      if (i > 0 && compareBytes(p.ballot_hash, (pairs[i - 1] as ReceiptPair).ballot_hash) <= 0)
        throw new EncodeError("receipts: pairs must be strictly ascending by ballot hash");
      hash32.write(w, p.ballot_hash);
      hash32.write(w, p.share_hash);
    }
  },
  read(r) {
    const at = r.offset;
    const count = r.uint(4);
    if (count > RECEIPT_BATCH_MAX) throw new DecodeError("length-over-max", at);
    if (count === 0) throw new DecodeError("non-canonical", at);
    const out: ReceiptPair[] = [];
    for (let i = 0; i < count; i++) {
      const pAt = r.offset;
      const ballot_hash = hash32.read(r);
      const last = out[out.length - 1];
      if (last !== undefined && compareBytes(ballot_hash, last.ballot_hash) <= 0)
        throw new DecodeError("non-canonical", pAt);
      out.push({ ballot_hash, share_hash: hash32.read(r) });
    }
    return out;
  },
};

const batchFields = [
  ["definition_hash", bytesFixed(32)],
  ["seat", u8],
  ["receipts", receiptPairs],
] as const;

const batchStatementV1 = struct(batchFields);

const batchV1 = struct([...batchFields, ["signature", p256Sig]] as const);

/** The batch's signed fields: `definition_hash ‖ u8(seat) ‖ u32(c) ‖ (ballot_hash ‖ share_hash) × c`. */
export type ShareReceiptBatchStatement = CodecValue<typeof batchStatementV1>;

/** A share-receipt batch (`0x0016`, version 1). */
export type ShareReceiptBatchRecord = CodecValue<typeof batchV1>;

// Version 2, which ballot versions 4 and 5 fix: version 1's fields with the
// seat's panel before the seat, under a tag of its own, so a batch for one
// panel's seat `i` never reads as the other's and no version-1 signature
// verifies over it (docs/spec/delivery.md, Records (version 2); T-37, T-31).
const BATCH_TAG_V2 = "abolish/v1/sig/share-receipt-batch-2";

const batchFieldsV2 = [
  ["definition_hash", bytesFixed(32)],
  ["panel", SEAT_PANEL],
  ["seat", u8],
  ["receipts", receiptPairs],
] as const;

const batchStatementV2 = struct(batchFieldsV2);

const batchV2 = struct([...batchFieldsV2, ["signature", p256Sig]] as const);

/** The version-2 batch's signed fields: `definition_hash ‖ u8(panel) ‖ u8(seat) ‖ u32(c) ‖ (ballot_hash ‖ share_hash) × c`. */
export type ShareReceiptBatchStatementV2 = CodecValue<typeof batchStatementV2>;

/** A share-receipt batch (`0x0016`, version 2), naming the seat's panel. */
export type ShareReceiptBatchRecordV2 = CodecValue<typeof batchV2>;

/**
 * Record type `0x0016`. Ballot versions 1 to 3 fix it at version 1, versions
 * 4 and 5 at version 2; it is never pinned, and travels only through the
 * contract path.
 */
export const SHARE_RECEIPT_BATCH = recordType(RECORD_TYPES.shareReceiptBatch, {
  1: batchV1,
  2: batchV2,
});

// --- Share-complaint batch (docs/spec/delivery.md, Share-complaint batch) ----------

/** `COMPLAINT_BATCH_MAX`: the most complaints one share-complaint batch carries. */
export const COMPLAINT_BATCH_MAX = 512;

const COMPLAINT_BATCH_TAG = "abolish/v1/sig/share-complaint-batch";

/** One complaint in a batch: the ballot whose posting it is about, and its proof. */
export interface ComplaintEntry {
  readonly ballot_hash: Uint8Array;
  readonly proof: ComplaintProof;
}

// `list<complaint_entry, COMPLAINT_BATCH_MAX>` with 1 to COMPLAINT_BATCH_MAX
// entries, strictly ascending by ballot hash: one complaint per ballot, and
// one encoding per set (T-31). Each entry's order is checked once its ballot
// hash is read, before its proof.
const complaintEntries: Codec<readonly ComplaintEntry[]> = {
  minLength: 4 + 128,
  write(w, value) {
    if (!Array.isArray(value)) throw new EncodeError("complaints: expected an array");
    const entries = value as readonly ComplaintEntry[];
    const n = entries.length;
    if (n < 1 || n > COMPLAINT_BATCH_MAX)
      throw new EncodeError(`complaints: a batch carries 1 to ${COMPLAINT_BATCH_MAX} entries`);
    w.uint(4, n);
    for (let i = 0; i < n; i++) {
      const e = entries[i] as ComplaintEntry;
      if (i > 0 && compareBytes(e.ballot_hash, (entries[i - 1] as ComplaintEntry).ballot_hash) <= 0)
        throw new EncodeError("complaints: entries must be strictly ascending by ballot hash");
      hash32.write(w, e.ballot_hash);
      COMPLAINT_PROOF.write(w, e.proof);
    }
  },
  read(r) {
    const at = r.offset;
    const count = r.uint(4);
    if (count > COMPLAINT_BATCH_MAX) throw new DecodeError("length-over-max", at);
    if (count === 0) throw new DecodeError("non-canonical", at);
    const out: ComplaintEntry[] = [];
    for (let i = 0; i < count; i++) {
      const eAt = r.offset;
      const ballot_hash = hash32.read(r);
      const last = out[out.length - 1];
      if (last !== undefined && compareBytes(ballot_hash, last.ballot_hash) <= 0)
        throw new DecodeError("non-canonical", eAt);
      out.push({ ballot_hash, proof: COMPLAINT_PROOF.read(r) });
    }
    return out;
  },
};

const complaintBatchFields = [
  ["definition_hash", bytesFixed(32)],
  ["seat", u8],
  ["complaints", complaintEntries],
] as const;

const complaintBatchStatementV1 = struct(complaintBatchFields);

const complaintBatchV1 = struct([...complaintBatchFields, ["signature", p256Sig]] as const);

/** The complaint batch's signed fields: `definition_hash ‖ u8(seat) ‖ u32(c) ‖ (ballot_hash ‖ encode(proof)) × c`. */
export type ShareComplaintBatchStatement = CodecValue<typeof complaintBatchStatementV1>;

/** A share-complaint batch (`0x0017`, version 1). */
export type ShareComplaintBatchRecord = CodecValue<typeof complaintBatchV1>;

// Version 2, as the receipt batch's: the seat's panel before the seat, under
// a tag of its own, each proof under Complaints (ballot version 4).
const COMPLAINT_BATCH_TAG_V2 = "abolish/v1/sig/share-complaint-batch-2";

const complaintBatchFieldsV2 = [
  ["definition_hash", bytesFixed(32)],
  ["panel", SEAT_PANEL],
  ["seat", u8],
  ["complaints", complaintEntries],
] as const;

const complaintBatchStatementV2 = struct(complaintBatchFieldsV2);

const complaintBatchV2 = struct([...complaintBatchFieldsV2, ["signature", p256Sig]] as const);

/** The version-2 complaint batch's signed fields: `definition_hash ‖ u8(panel) ‖ u8(seat) ‖ u32(c) ‖ (ballot_hash ‖ encode(proof)) × c`. */
export type ShareComplaintBatchStatementV2 = CodecValue<typeof complaintBatchStatementV2>;

/** A share-complaint batch (`0x0017`, version 2), naming the seat's panel. */
export type ShareComplaintBatchRecordV2 = CodecValue<typeof complaintBatchV2>;

/**
 * Record type `0x0017`. Ballot versions 1 to 3 fix it at version 1, versions
 * 4 and 5 at version 2; it is never pinned, and travels only through the
 * contract path.
 */
export const SHARE_COMPLAINT_BATCH = recordType(RECORD_TYPES.shareComplaintBatch, {
  1: complaintBatchV1,
  2: complaintBatchV2,
});

// --- Obligation root (docs/spec/delivery.md, Obligation root) ----------------------

/** An obligation root's `kind`: 1 commits receipts, 2 complaints. */
export const OBLIGATION_ROOT_KINDS = { receipts: 1, complaints: 2 } as const;

export type ObligationRootKind = (typeof OBLIGATION_ROOT_KINDS)[keyof typeof OBLIGATION_ROOT_KINDS];

/** One leaf's bytes per kind: a receipt pair, or a complaint entry. */
const ROOT_LEAF_LENGTH: Readonly<Record<ObligationRootKind, number>> = { 1: 64, 2: 128 };

// The largest object one raw block holds (content-addressing.md, Small
// objects); above it the object is a dag-pb tree.
const RAW_BLOCK_MAX = 1_048_576;

/**
 * The first four bytes `leaves_cid` must have for a root of `kind` over
 * `count` leaves: CIDv1, raw (`0x55`) when the leaf object is one block and
 * dag-pb (`0x70`) above, then sha2-256 of 32 bytes. Its signed kind and count
 * fix them, so a root whose CID can never be canonical takes no slot.
 */
function leavesCidPrefix(kind: ObligationRootKind, count: number): readonly number[] {
  return [0x01, ROOT_LEAF_LENGTH[kind] * count <= RAW_BLOCK_MAX ? 0x55 : 0x70, 0x12, 0x20];
}

/** An obligation root's signed fields: `m`, 106 bytes. */
export interface ObligationRootStatement {
  readonly definition_hash: Uint8Array;
  readonly seat: number;
  readonly kind: ObligationRootKind;
  /** `c`, the number of leaves, at least 1. */
  readonly count: number;
  readonly root: Uint8Array;
  /** The binary CID of the leaf object (docs/spec/content-addressing.md). */
  readonly leaves_cid: Uint8Array;
}

/** An obligation root (`0x001a`, version 1). */
export interface ObligationRootRecord extends ObligationRootStatement {
  readonly signature: Uint8Array;
}

const rootKind = enum8<ObligationRootKind>([
  OBLIGATION_ROOT_KINDS.receipts,
  OBLIGATION_ROOT_KINDS.complaints,
]);
const cid36 = bytesFixed(36);

/** An obligation root's version-2 signed fields: version 1's, with the seat's panel, 107 bytes. */
export interface ObligationRootStatementV2 extends ObligationRootStatement {
  readonly panel: SeatPanel;
}

/** An obligation root (`0x001a`, version 2), naming the seat's panel. */
export interface ObligationRootRecordV2 extends ObligationRootStatementV2 {
  readonly signature: Uint8Array;
}

/** An obligation root's length: its header, 106 signed bytes and the signature. */
export const OBLIGATION_ROOT_LENGTH = 173;

/** A version-2 obligation root's length: one byte more, its panel. */
export const OBLIGATION_ROOT_LENGTH_V2 = 174;

// Read in field order, every field present before the CID's framing is
// judged and that before the signature's, so each rejection has one code at
// one offset (delivery-root.json and delivery-batch-v2.json, decode). The
// leaves are never read here. Version 2 reads its panel before the seat,
// every later field one byte on (docs/spec/delivery.md, Records (version 2)).
function obligationRootCodec(panel: false): Codec<ObligationRootRecord>;
function obligationRootCodec(panel: true): Codec<ObligationRootRecordV2>;
function obligationRootCodec(panel: boolean): Codec<ObligationRootRecord | ObligationRootRecordV2> {
  return {
    minLength: panel ? 171 : 170,
    write(w, value) {
      const { count, kind } = value;
      if (!Number.isInteger(count) || count < 1 || count > 0xffffffff)
        throw new EncodeError("obligation root: count is 1 to 2³² − 1");
      hash32.write(w, value.definition_hash);
      if (panel) SEAT_PANEL.write(w, (value as ObligationRootRecordV2).panel);
      u8.write(w, value.seat);
      rootKind.write(w, kind);
      u32.write(w, count);
      hash32.write(w, value.root);
      cid36.write(w, value.leaves_cid);
      if (!leavesCidPrefix(kind, count).every((b, i) => value.leaves_cid[i] === b))
        throw new EncodeError("obligation root: leaves_cid isn't the CID its kind and count frame");
      p256Sig.write(w, value.signature);
    },
    read(r) {
      const definition_hash = hash32.read(r);
      const named = panel ? { panel: SEAT_PANEL.read(r) } : {};
      const seat = u8.read(r);
      const kind = rootKind.read(r);
      const countAt = r.offset;
      const count = u32.read(r);
      if (count === 0) throw new DecodeError("non-canonical", countAt);
      const root = hash32.read(r);
      const cidAt = r.offset;
      const leaves_cid = cid36.read(r);
      if (r.remaining < 64) throw new DecodeError("truncated", r.offset);
      if (!leavesCidPrefix(kind, count).every((b, i) => leaves_cid[i] === b))
        throw new DecodeError("non-canonical", cidAt);
      const signature = p256Sig.read(r);
      return { definition_hash, ...named, seat, kind, count, root, leaves_cid, signature };
    },
  };
}

/**
 * Record type `0x001a`. Ballot versions 1 to 3 fix it at version 1, versions
 * 4 and 5 at version 2; it is never pinned, and travels only through the
 * contract path.
 */
export const OBLIGATION_ROOT = recordType(RECORD_TYPES.obligationRoot, {
  1: obligationRootCodec(false),
  2: obligationRootCodec(true),
});

const SCHEMA = new RecordSchema([
  SHARE_RECEIPT,
  SHARE_POSTING,
  SHARE_COMPLAINT,
  SHARE_RECEIPT_BATCH,
  SHARE_COMPLAINT_BATCH,
  OBLIGATION_ROOT,
]);

export function encodeObligationRoot(record: ObligationRootRecord): Uint8Array {
  return SCHEMA.encode(OBLIGATION_ROOT, 1, record);
}

/**
 * Strictly decodes an obligation root against version 1, the version ballot
 * versions 1 to 3 fix: its kind, a non-zero count and the CID framing they
 * give, and a canonical low-`s` signature. Its leaves are never read.
 */
export function decodeObligationRoot(bytes: Uint8Array, pinned: 1): ObligationRootRecord;
/** Strictly decodes an obligation root against version 2, the version ballot versions 4 and 5 fix. */
export function decodeObligationRoot(bytes: Uint8Array, pinned: 2): ObligationRootRecordV2;
export function decodeObligationRoot(
  bytes: Uint8Array,
  pinned: 1 | 2,
): ObligationRootRecord | ObligationRootRecordV2 {
  return SCHEMA.decode(OBLIGATION_ROOT, bytes, pinned).value;
}

export function encodeObligationRootV2(record: ObligationRootRecordV2): Uint8Array {
  return SCHEMA.encode(OBLIGATION_ROOT, 2, record);
}

const ROOT_TAG = "abolish/v1/sig/obligation-root";

// Version 2's tag: its 107-byte statement names no version, so under one tag
// it and version 1's 106 bytes would be two layouts (T-31).
const ROOT_TAG_V2 = "abolish/v1/sig/obligation-root-2";

const obligationRootStatementV1 = struct([
  ["definition_hash", hash32],
  ["seat", u8],
  ["kind", rootKind],
  ["count", u32],
  ["root", hash32],
  ["leaves_cid", cid36],
] as const);

const obligationRootStatementV2Codec = struct([
  ["definition_hash", hash32],
  ["panel", SEAT_PANEL],
  ["seat", u8],
  ["kind", rootKind],
  ["count", u32],
  ["root", hash32],
  ["leaves_cid", cid36],
] as const);

// A count and CID the decoder would refuse never make a statement either.
function checkRootFraming({ kind, count, leaves_cid }: ObligationRootStatement): void {
  if (!Number.isInteger(count) || count < 1 || count > 0xffffffff)
    throw new EncodeError("obligation root: count is 1 to 2³² − 1");
  if (
    !(leaves_cid instanceof Uint8Array) ||
    !leavesCidPrefix(kind, count).every((b, i) => leaves_cid[i] === b)
  )
    throw new EncodeError("obligation root: leaves_cid isn't the CID its kind and count frame");
}

/** `m`, the root's signed statement: its fields without header or signature, 106 bytes. */
export function obligationRootStatement(statement: ObligationRootStatement): Uint8Array {
  checkRootFraming(statement);
  return encode(obligationRootStatementV1, {
    definition_hash: statement.definition_hash,
    seat: statement.seat,
    kind: statement.kind,
    count: statement.count,
    root: statement.root,
    leaves_cid: statement.leaves_cid,
  });
}

/** `m`, the version-2 root's signed statement: its fields without header or signature, 107 bytes. */
export function obligationRootStatementV2(statement: ObligationRootStatementV2): Uint8Array {
  checkRootFraming(statement);
  return encode(obligationRootStatementV2Codec, {
    definition_hash: statement.definition_hash,
    panel: statement.panel,
    seat: statement.seat,
    kind: statement.kind,
    count: statement.count,
    root: statement.root,
    leaves_cid: statement.leaves_cid,
  });
}

/**
 * The obligation tree's hashes (docs/spec/delivery.md, Obligation tree): RFC
 * 9162 under `abolish/v1/obligation/leaf` and `/node`, tags of its own, so no
 * node of an obligation tree is a node of a board tree and no inclusion proof
 * of one verifies in the other (T-30).
 */
export const OBLIGATION_TREE: TreeHash = Object.freeze({
  leaf: (data: Uint8Array) => H(ds("abolish/v1/obligation/leaf", data)),
  node: (left: Uint8Array, right: Uint8Array) => {
    const both = new Uint8Array(left.length + right.length);
    both.set(left);
    both.set(right, left.length);
    return H(ds("abolish/v1/obligation/node", both));
  },
});

/**
 * `H(DS("abolish/v1/obligation-root", record))` over the whole encoded
 * record, header and signature included: how a counted-extent attestation
 * names a root whose leaf object its seat holds and has checked
 * (docs/spec/delivery.md, Leaf availability).
 */
export function obligationRootHash(encodedRecord: Uint8Array): Uint8Array {
  return H(ds("abolish/v1/obligation-root", encodedRecord));
}

/** One leaf's bytes: a receipt pair (64) or a complaint entry (128). */
function leafBytes(kind: ObligationRootKind, leaf: ReceiptPair | ComplaintEntry): Uint8Array {
  return kind === OBLIGATION_ROOT_KINDS.receipts
    ? encode(receiptPair, leaf as ReceiptPair)
    : encode(complaintEntry, leaf as ComplaintEntry);
}

const receiptPair = struct([
  ["ballot_hash", hash32],
  ["share_hash", hash32],
] as const);

const complaintEntry = struct([
  ["ballot_hash", hash32],
  ["proof", COMPLAINT_PROOF],
] as const);

/**
 * The leaves a leaf object holds for a root of `kind` over `count` leaves, or
 * `undefined` if the object is inconsistent with it (docs/spec/delivery.md,
 * Leaf availability, Consistency): not `count` leaves of the kind's size, not
 * strictly ascending by ballot hash, or a complaint leaf whose proof doesn't
 * decode as a complaint entry's does. The tree isn't compared here.
 */
function readLeafObject(
  kind: ObligationRootKind,
  count: number,
  object: Uint8Array,
): { readonly bytes: Uint8Array[]; readonly leaves: (ReceiptPair | ComplaintEntry)[] } | undefined {
  const size = ROOT_LEAF_LENGTH[kind];
  if (object.length !== size * count) return undefined;
  const bytes: Uint8Array[] = [];
  const leaves: (ReceiptPair | ComplaintEntry)[] = [];
  for (let j = 0; j < count; j++) {
    const b = object.subarray(size * j, size * (j + 1));
    const last = leaves[leaves.length - 1];
    if (last !== undefined && compareBytes(b.subarray(0, 32), last.ballot_hash) <= 0)
      return undefined;
    try {
      leaves.push(
        kind === OBLIGATION_ROOT_KINDS.receipts
          ? decode(receiptPair, b)
          : decode(complaintEntry, b),
      );
    } catch (e) {
      if (!(e instanceof DecodeError)) throw e;
      return undefined;
    }
    bytes.push(b);
  }
  return { bytes, leaves };
}

/** An obligation root as a trustee node submits it, with the leaf object it then serves. */
export interface ObligationRootBuild {
  readonly record: ObligationRootRecord;
  /** The leaves concatenated in ballot-hash order: what `leaves_cid` names. */
  readonly leafObject: Uint8Array;
}

/**
 * A trustee node's obligation root over every receipt (kind 1) or complaint
 * (kind 2) it owes for one election (docs/spec/delivery.md, Obligation root;
 * Elections that commit roots): the leaves sorted by ballot hash, their leaf
 * object, its canonical CID, the tree's root, and the seat's signature with its
 * per-election signing key. A node MUST pass only the receipts it issued at
 * intake, or complaints whose proofs it made; a repeated ballot hash throws.
 */
export function buildObligationRoot(
  signingSecret: Uint8Array,
  definitionHash: Uint8Array,
  seat: number,
  owed: OwedLeaves,
): ObligationRootBuild {
  const { leafObject, ...tree } = owedTree("buildObligationRoot", owed);
  const statement: ObligationRootStatement = {
    definition_hash: Uint8Array.from(definitionHash),
    seat,
    ...tree,
  };
  const m = obligationRootStatement(statement);
  return {
    record: { ...statement, signature: signStatement(signingSecret, ROOT_TAG, m) },
    leafObject,
  };
}

/** A version-2 obligation root as a seat of either panel submits it, with its leaf object. */
export interface ObligationRootBuildV2 {
  readonly record: ObligationRootRecordV2;
  readonly leafObject: Uint8Array;
}

/**
 * `buildObligationRoot` under ballot versions 4 and 5: the same leaves,
 * object and tree, signed as version 2 with the seat's panel named
 * (docs/spec/delivery.md, Records (version 2)).
 */
export function buildObligationRootV2(
  signingSecret: Uint8Array,
  definitionHash: Uint8Array,
  panel: SeatPanel,
  seat: number,
  owed: OwedLeaves,
): ObligationRootBuildV2 {
  const { leafObject, ...tree } = owedTree("buildObligationRootV2", owed);
  const statement: ObligationRootStatementV2 = {
    definition_hash: Uint8Array.from(definitionHash),
    panel,
    seat,
    ...tree,
  };
  const m = obligationRootStatementV2(statement);
  return {
    record: { ...statement, signature: signStatement(signingSecret, ROOT_TAG_V2, m) },
    leafObject,
  };
}

/** What a seat owes as one root: its receipts (kind 1) or its complaints (kind 2). */
export type OwedLeaves =
  | { readonly kind: 1; readonly leaves: readonly ReceiptPair[] }
  | { readonly kind: 2; readonly leaves: readonly ComplaintEntry[] };

// The leaves sorted by ballot hash, their object, its CID and the tree's root,
// the same under either version.
function owedTree(name: string, owed: OwedLeaves) {
  const { kind } = owed;
  const sorted: readonly (ReceiptPair | ComplaintEntry)[] = [...owed.leaves].sort((a, b) =>
    compareBytes(a.ballot_hash, b.ballot_hash),
  );
  if (sorted.length < 1 || sorted.length > 0xffffffff)
    throw new RangeError(`${name}: a root has 1 to 2³² − 1 leaves`);
  for (let i = 1; i < sorted.length; i++)
    if (
      compareBytes(
        (sorted[i] as ReceiptPair).ballot_hash,
        (sorted[i - 1] as ReceiptPair).ballot_hash,
      ) === 0
    )
      throw new RangeError(`${name}: a ballot hash is listed twice`);
  const leaves = sorted.map((l) => leafBytes(kind, l));
  const leafObject = new Uint8Array(ROOT_LEAF_LENGTH[kind] * leaves.length);
  leaves.forEach((l, j) => leafObject.set(l, ROOT_LEAF_LENGTH[kind] * j));
  return {
    kind,
    count: leaves.length,
    root: merkleRoot(OBLIGATION_TREE, leaves),
    leaves_cid: objectCid(leafObject),
    leafObject,
  };
}

/**
 * The audit path proving leaf `index` of a leaf object is in its root, for a
 * client that asks its seat's node for evidence of its receipt
 * (docs/spec/delivery.md, Client rules). Throws if the object isn't
 * consistent with `kind` and its length.
 */
export function obligationInclusionProof(
  kind: ObligationRootKind,
  leafObject: Uint8Array,
  index: number,
): Uint8Array[] {
  const read = readLeafObject(kind, leafObject.length / ROOT_LEAF_LENGTH[kind], leafObject);
  if (read === undefined || read.bytes.length === 0)
    throw new RangeError("obligationInclusionProof: not a leaf object of its kind");
  return inclusionProof(OBLIGATION_TREE, read.bytes, index);
}

/**
 * Verifies that `leaf` (64 or 128 bytes, as the root's kind gives) is leaf
 * `index` of `root`, with RFC 9162's audit path under the obligation tree's
 * tags, the size and root both from the one record (docs/spec/delivery.md,
 * Obligation tree). It doesn't check the record's signature: a client checks a
 * leaf against the root the contract recorded, whose signature the board
 * verified. The client compares the leaf with its own receipt pair first.
 * Evidence only: a leaf counts only once its root is available.
 */
export function verifyObligationInclusion(
  root: ObligationRootRecord,
  index: number,
  leaf: Uint8Array,
  proof: readonly Uint8Array[],
): boolean {
  if (!Number.isSafeInteger(index) || index < 0) return false;
  if (!Number.isSafeInteger(root.count) || root.count < 1) return false;
  if (!(leaf instanceof Uint8Array) || leaf.length !== ROOT_LEAF_LENGTH[root.kind]) return false;
  return verifyInclusion(
    OBLIGATION_TREE,
    BigInt(index),
    BigInt(root.count),
    leaf,
    proof,
    root.root,
  );
}

export function encodeShareComplaintBatch(record: ShareComplaintBatchRecord): Uint8Array {
  return SCHEMA.encode(SHARE_COMPLAINT_BATCH, 1, record);
}

export function encodeShareComplaintBatchV2(record: ShareComplaintBatchRecordV2): Uint8Array {
  return SCHEMA.encode(SHARE_COMPLAINT_BATCH, 2, record);
}

/** Strictly decodes a share-complaint batch against version 1, the version ballot versions 1 to 3 fix. */
export function decodeShareComplaintBatch(bytes: Uint8Array, pinned: 1): ShareComplaintBatchRecord;
/** Strictly decodes a share-complaint batch against version 2, the version ballot versions 4 and 5 fix. */
export function decodeShareComplaintBatch(
  bytes: Uint8Array,
  pinned: 2,
): ShareComplaintBatchRecordV2;
export function decodeShareComplaintBatch(
  bytes: Uint8Array,
  pinned: 1 | 2,
): ShareComplaintBatchRecord | ShareComplaintBatchRecordV2 {
  return SCHEMA.decode(SHARE_COMPLAINT_BATCH, bytes, pinned).value;
}

/** `m`, the complaint batch's signed statement: its fields without header or signature, `37 + 128·c` bytes. */
export function shareComplaintBatchStatement(statement: ShareComplaintBatchStatement): Uint8Array {
  return encode(complaintBatchStatementV1, {
    definition_hash: statement.definition_hash,
    seat: statement.seat,
    complaints: statement.complaints,
  });
}

/** `m`, the version-2 complaint batch's signed statement, `38 + 128·c` bytes. */
export function shareComplaintBatchStatementV2(
  statement: ShareComplaintBatchStatementV2,
): Uint8Array {
  return encode(complaintBatchStatementV2, {
    definition_hash: statement.definition_hash,
    panel: statement.panel,
    seat: statement.seat,
    complaints: statement.complaints,
  });
}

// Copied, sorted by ballot hash and cut into batches of at most `max`, one
// entry per ballot hash: a set of entries has one batching (T-31).
function batchesOf<E extends { readonly ballot_hash: Uint8Array }>(
  name: string,
  entries: readonly E[],
  copy: (e: E) => E,
  max: number,
): E[][] {
  const sorted = entries.map(copy).sort((a, b) => compareBytes(a.ballot_hash, b.ballot_hash));
  for (let i = 1; i < sorted.length; i++)
    if (compareBytes((sorted[i] as E).ballot_hash, (sorted[i - 1] as E).ballot_hash) === 0)
      throw new RangeError(`${name}: a ballot hash is listed twice`);
  const batches: E[][] = [];
  for (let i = 0; i < sorted.length; i += max) batches.push(sorted.slice(i, i + max));
  return batches;
}

const copyEntry = (e: ComplaintEntry): ComplaintEntry => ({
  ballot_hash: Uint8Array.from(e.ballot_hash),
  proof: e.proof,
});

const copyPair = (p: ReceiptPair): ReceiptPair => ({
  ballot_hash: Uint8Array.from(p.ballot_hash),
  share_hash: Uint8Array.from(p.share_hash),
});

/**
 * A trustee node's batches of the complaints it owes for one election, one
 * per ballot hash (one complaint covers every passing posting of a ballot
 * and seat), sorted by ballot hash, cut into batches of at most
 * `COMPLAINT_BATCH_MAX` and each signed with the seat's per-election signing
 * key. Each proof comes from `proveComplaint`; a repeated ballot hash throws.
 */
export function batchShareComplaints(
  signingSecret: Uint8Array,
  definitionHash: Uint8Array,
  seat: number,
  complaints: readonly ComplaintEntry[],
): ShareComplaintBatchRecord[] {
  return batchesOf("batchShareComplaints", complaints, copyEntry, COMPLAINT_BATCH_MAX).map(
    (entries) => {
      const statement = {
        definition_hash: Uint8Array.from(definitionHash),
        seat,
        complaints: entries,
      };
      const m = shareComplaintBatchStatement(statement);
      return { ...statement, signature: signStatement(signingSecret, COMPLAINT_BATCH_TAG, m) };
    },
  );
}

/**
 * `batchShareComplaints` under ballot versions 4 and 5: version-2 batches
 * naming the seat's panel, each proof from `proveComplaintV4`.
 */
export function batchShareComplaintsV2(
  signingSecret: Uint8Array,
  definitionHash: Uint8Array,
  panel: SeatPanel,
  seat: number,
  complaints: readonly ComplaintEntry[],
): ShareComplaintBatchRecordV2[] {
  return batchesOf("batchShareComplaintsV2", complaints, copyEntry, COMPLAINT_BATCH_MAX).map(
    (entries) => {
      const statement = {
        definition_hash: Uint8Array.from(definitionHash),
        panel,
        seat,
        complaints: entries,
      };
      const m = shareComplaintBatchStatementV2(statement);
      return { ...statement, signature: signStatement(signingSecret, COMPLAINT_BATCH_TAG_V2, m) };
    },
  );
}

export function encodeShareReceiptBatch(record: ShareReceiptBatchRecord): Uint8Array {
  return SCHEMA.encode(SHARE_RECEIPT_BATCH, 1, record);
}

export function encodeShareReceiptBatchV2(record: ShareReceiptBatchRecordV2): Uint8Array {
  return SCHEMA.encode(SHARE_RECEIPT_BATCH, 2, record);
}

/** Strictly decodes a share-receipt batch against version 1, the version ballot versions 1 to 3 fix. */
export function decodeShareReceiptBatch(bytes: Uint8Array, pinned: 1): ShareReceiptBatchRecord;
/** Strictly decodes a share-receipt batch against version 2, the version ballot versions 4 and 5 fix. */
export function decodeShareReceiptBatch(bytes: Uint8Array, pinned: 2): ShareReceiptBatchRecordV2;
export function decodeShareReceiptBatch(
  bytes: Uint8Array,
  pinned: 1 | 2,
): ShareReceiptBatchRecord | ShareReceiptBatchRecordV2 {
  return SCHEMA.decode(SHARE_RECEIPT_BATCH, bytes, pinned).value;
}

/** `m`, the batch's signed statement: its fields without header or signature, `37 + 64·c` bytes. */
export function shareReceiptBatchStatement(statement: ShareReceiptBatchStatement): Uint8Array {
  return encode(batchStatementV1, {
    definition_hash: statement.definition_hash,
    seat: statement.seat,
    receipts: statement.receipts,
  });
}

/** `m`, the version-2 batch's signed statement, `38 + 64·c` bytes. */
export function shareReceiptBatchStatementV2(statement: ShareReceiptBatchStatementV2): Uint8Array {
  return encode(batchStatementV2, {
    definition_hash: statement.definition_hash,
    panel: statement.panel,
    seat: statement.seat,
    receipts: statement.receipts,
  });
}

/**
 * A trustee node's batches of the receipts it issued for one election, sorted
 * by ballot hash and cut into batches of at most `RECEIPT_BATCH_MAX`, each
 * signed with the seat's per-election signing key. A node MUST pass only
 * receipts it issued at intake (docs/spec/delivery.md, Share-receipt batch):
 * a batch states each pair's receipt. Two receipts naming one ballot hash
 * can't both be the seat's (a ballot hash fixes its share hash), so a repeat
 * throws.
 */
export function batchShareReceipts(
  signingSecret: Uint8Array,
  definitionHash: Uint8Array,
  seat: number,
  receipts: readonly ReceiptPair[],
): ShareReceiptBatchRecord[] {
  return batchesOf("batchShareReceipts", receipts, copyPair, RECEIPT_BATCH_MAX).map((pairs) => {
    const statement = { definition_hash: Uint8Array.from(definitionHash), seat, receipts: pairs };
    const m = shareReceiptBatchStatement(statement);
    return { ...statement, signature: signStatement(signingSecret, BATCH_TAG, m) };
  });
}

/**
 * `batchShareReceipts` under ballot versions 4 and 5: version-2 batches
 * naming the seat's panel, so a seat of either panel batches what it
 * receipted at intake (docs/spec/delivery.md, Boarding, direct submit and client
 * rules (version 2), What a node owes).
 */
export function batchShareReceiptsV2(
  signingSecret: Uint8Array,
  definitionHash: Uint8Array,
  panel: SeatPanel,
  seat: number,
  receipts: readonly ReceiptPair[],
): ShareReceiptBatchRecordV2[] {
  return batchesOf("batchShareReceiptsV2", receipts, copyPair, RECEIPT_BATCH_MAX).map((pairs) => {
    const statement = {
      definition_hash: Uint8Array.from(definitionHash),
      panel,
      seat,
      receipts: pairs,
    };
    const m = shareReceiptBatchStatementV2(statement);
    return { ...statement, signature: signStatement(signingSecret, BATCH_TAG_V2, m) };
  });
}

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
 * `DELIVERY_WINDOW ≥ max(2 · period + deadline + A, W_C) + R + F`, so every
 * counted ballot's anchoring or contract recording is confirmable on finalized
 * L1 by the intake cutoff `c_I = t_D − F − R`, where a trustee node decides
 * what it owes, with `R` left to send its receipts through the contract path,
 * even forced through L1, and the seats have at least `A` after the ballot
 * extent's last anchoring deadline to fetch it before they attest it at `c_I`
 * (docs/spec/availability.md, Windows; T-24, T-54); and `COMPLAINT_WINDOW − DELIVERY_WINDOW ≥ W_C
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
  const anchored = 2n * period + deadline + BALLOT_FETCH_ALLOWANCE;
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
 * receipt call (one share-receipt batch), a complaint call and an obligation
 * root's call cost there. The board's tests bind the three call figures to
 * measured gas, with `P256VERIFY` (T-25, T-52, T-54).
 */
export const FORCED_PATH = Object.freeze({
  /** Deposit gas per L1 block: the portal's target, `maxResourceLimit / elasticityMultiplier`. */
  depositGasTarget: 2_000_000n,
  /** Seconds per L1 block: 12-second slots, at most one in 13 missed, as `F` assumes. */
  l1BlockSeconds: 13n,
  /** Receipts in one `submitReceiptBatch` call: one batch of `RECEIPT_BATCH_MAX` pairs. */
  receiptsPerCall: 1024n,
  /** Gas of one batch call of up to `receiptsPerCall` receipts, intrinsic gas included. */
  receiptCallGas: 4_500_000n,
  /** Complaints in one `submitComplaintBatch` call: one batch of `COMPLAINT_BATCH_MAX` entries. */
  complaintsPerCall: 512n,
  /** Gas of one complaint-batch call of up to `complaintsPerCall`, intrinsic gas included. */
  complaintCallGas: 5_000_000n,
  /** Gas of one `submitObligationRoot` call, intrinsic gas included, whatever its count. */
  rootCallGas: 200_000n,
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
 * `s · ⌈2M / COMPLAINTS_PER_CALL⌉` complaint-batch calls between `t_D + W_C`,
 * when the last posting in time is recorded, and `c_K = t_K − F`.
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
      gas:
        s *
        ((owed + FORCED_PATH.complaintsPerCall - 1n) / FORCED_PATH.complaintsPerCall) *
        FORCED_PATH.complaintCallGas,
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
  return demandsFit(
    [...elections].map((e) => forcedPathDemand(e, windows)),
    windows,
  );
}

function demandsFit(
  demands: readonly {
    readonly receipts: ForcedPathInterval;
    readonly complaints: ForcedPathInterval;
  }[],
  windows: ForcedPathWindows,
): boolean {
  const lengths = forcedPathLengths(windows);
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
 * Internal: one election's forced-path demand once roots can deliver
 * (docs/spec/delivery.md, Capacity; Elections that commit roots). It commits
 * roots exactly when, alone, its batches don't fit (`forcedPathFits`), and
 * then each of its two intervals carries one root call per seat whatever its
 * members, `s · ROOT_CALL_GAS`; the batch and root figures never mix within
 * one election. The package entry point doesn't export it: until P1-12f part
 * 3 reads a root's leaves and P4-3 part 2c brings the attestation that makes
 * them available, no root can deliver, and nodes keep `forcedPathFits`, which
 * counts every election with batches and so refuses every election that
 * would commit roots (T-25, T-52, T-54).
 */
export function forcedPathDemandWithRoots(
  election: ForcedPathElection,
  windows: ForcedPathWindows,
): {
  readonly commitsRoots: boolean;
  readonly receipts: ForcedPathInterval;
  readonly complaints: ForcedPathInterval;
} {
  const batches = forcedPathDemand(election, windows);
  if (demandsFit([batches], windows)) return { commitsRoots: false, ...batches };
  const gas = BigInt(election.seats) * FORCED_PATH.rootCallGas;
  return {
    commitsRoots: true,
    receipts: { ...batches.receipts, gas },
    complaints: { ...batches.complaints, gas },
  };
}

/** Internal: `forcedPathFits` over `forcedPathDemandWithRoots`, for the same parts to enable. */
export function forcedPathFitsWithRoots(
  elections: Iterable<ForcedPathElection>,
  windows: ForcedPathWindows,
): boolean {
  return demandsFit(
    [...elections].map((e) => forcedPathDemandWithRoots(e, windows)),
    windows,
  );
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
 * A ballot [[revoting]] selected, decoded, with its tier (ballot versions 2
 * and 3: its cell) and nullifier; it passed `validity-shape`. Ballot version
 * 3 keeps version 1's delivery records ([[ballot-validity]], Shares and
 * delivery (version 3)): only its ballot hash, over the question range
 * proofs, differs.
 */
export type DeliveryBallot =
  | (BallotLabel & {
      readonly nullifier: bigint;
      readonly vote: CommittedVote;
    })
  | {
      readonly ballotVersion: 3;
      readonly cell: number;
      readonly nullifier: bigint;
      readonly vote: CommittedVoteV3;
    };

/**
 * The ballot hash a delivery record names for `ballot`, under the ballot's
 * own version, so a receipt for a version-3 ballot binds its question range
 * proofs and no other version's hash (T-38, T-41).
 */
export function deliveryBallotHash(definitionHash: Uint8Array, ballot: DeliveryBallot): Uint8Array {
  if (ballot.ballotVersion === 3) {
    const { cell, nullifier, vote } = ballot;
    return ballotHashV3({ definitionHash, cell, nullifier }, vote);
  }
  const { version, label } = labelOf(ballot);
  const named: BallotLabel = version === 1 ? { tier: label } : { ballotVersion: 2, cell: label };
  return ballotHash({ definitionHash, ...named, nullifier: ballot.nullifier }, ballot.vote);
}

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
  | "receipt-contradicted"
  | "root-signature"
  | "root-repeat"
  | "root-count"
  | "root-withheld"
  | "root-inconsistent";

/** A record the check ignored or attributed, by its position in the entries checked. */
export interface DeliveryRecordReport {
  readonly at: number;
  /** For a share-receipt batch's pair, its index in the batch from 0; a batch is one record. */
  readonly pair?: number;
  /** For an obligation root's leaf, its index in the leaf list from 0; a root is one record. */
  readonly leaf?: number;
  readonly code: DeliveryRecordCode;
  /**
   * The seat its signature attributes it to, or `null`, for the attributable
   * codes (`share-receipt`, `complaint-unfounded`, `receipt-contradicted`,
   * `root-signature` and the root codes reported against its seat).
   */
  readonly signer?: number | null;
  /** For `root-withheld`: the seats that named the root in their counted-extent attestations, ascending. */
  readonly namedBy?: readonly number[];
  /** For `root-withheld`: the seats that attested the counted extent without naming it, ascending. */
  readonly attestedWithout?: readonly number[];
}

/** A proven complaint, by its position, with the seat its signature attributes it to, or `null`. */
export interface ProvenComplaint {
  readonly at: number;
  /** For a share-complaint batch's entry, its index in the batch from 0. */
  readonly pair?: number;
  /** For a complaint root's leaf, its index in the leaf list from 0. */
  readonly leaf?: number;
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
  /**
   * Obligation roots the check couldn't read from what it was given: an
   * available root some block of whose leaf object no source served, or,
   * without `roots`, any root that reaches the bound. When any is listed
   * the counted set isn't decided from these sources, never failed:
   * `ballots` and `records` are then empty (docs/spec/delivery.md, Leaf
   * availability, Fetched; T-53, T-24).
   */
  readonly unverifiable: readonly { readonly at: number }[];
}

/**
 * What the delivery check reads obligation roots against (docs/spec/delivery.md,
 * Delivery check; Leaf availability), all from data the verifier has already
 * checked.
 */
export interface DeliveryRoots {
  /** `2M`, the obligation's bound, from the members [[verifier]] 2.4 recomputes. */
  readonly bound: bigint;
  /** `k`, the default panel's threshold: a root is available with `q − k + 1` of the `q` qualified seats naming it. */
  readonly threshold: number;
  /**
   * Each qualified seat's counted-extent attestation that counts (recorded by
   * `t_A'`, through the contract path), at most one per seat: the record
   * hashes (`obligationRootHash`) of the roots it names.
   */
  readonly attestations: readonly {
    readonly seat: number;
    readonly roots: readonly Uint8Array[];
  }[];
  /**
   * What the sources served for one block of a leaf object, by the block's
   * CID, each source's answer in the order tried, with the most bytes the
   * block can have, where a fetcher stops reading: the first answer within
   * it that hashes to the CID is read, and any other is a failed fetch from
   * that source, never a verdict on the root (`readObject`).
   */
  leafBlocks(cid: Uint8Array, limit: number): readonly Uint8Array[];
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

/** A decoded share-receipt batch: one seat's pairs under one signature over `statement`. */
interface BatchItem extends PanelSeat {
  readonly kind: "batch";
  readonly definitionHash: Uint8Array;
  readonly pairs: readonly ReceiptPair[];
  readonly statement: Uint8Array;
  readonly signature: Uint8Array;
}

/** A decoded share-complaint batch: one seat's complaints under one signature over `statement`. */
interface ComplaintBatchItem extends PanelSeat {
  readonly kind: "complaint-batch";
  readonly definitionHash: Uint8Array;
  readonly entries: readonly ComplaintEntry[];
  readonly statement: Uint8Array;
  readonly signature: Uint8Array;
}

/** A decoded obligation root: one seat's receipts or complaints under one signature over `statement`. */
interface RootItem extends PanelSeat {
  readonly kind: "root";
  readonly definitionHash: Uint8Array;
  readonly record: ObligationRootRecord;
  readonly statement: Uint8Array;
}

/** What differs between the versions: decoding, each panel's keys, and the per-seat checks. */
interface DeliveryRules {
  /** Strictly decodes a payload of `kind` under the version the ballot version fixes; throws `DecodeError`. */
  decode(kind: DeliveryItem["kind"], payload: Uint8Array): DeliveryItem;
  /** Strictly decodes a contract-path batch under the version the ballot version fixes; throws `DecodeError`. */
  decodeBatch(payload: Uint8Array): BatchItem;
  /** The same for a contract-path complaint batch. */
  decodeComplaintBatch(payload: Uint8Array): ComplaintBatchItem;
  /** The same for a contract-path obligation root. */
  decodeRoot(payload: Uint8Array): RootItem;
  /** The tags a complaint's, a receipt batch's, a complaint batch's and a root's signature are under. */
  readonly complaintTag: SignatureTag;
  readonly batchTag: SignatureTag;
  readonly complaintBatchTag: SignatureTag;
  readonly rootTag: SignatureTag;
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
  readonly unverifiable: readonly { readonly at: number }[];
}

/** `DeliveryRoots` once checked against the registered key set. */
interface RootReader {
  readonly bound: bigint;
  /**
   * Who of `panel`'s seats named a root's record hash, who of them attested
   * without naming it, and whether that makes it available: a root is judged
   * by its own panel's attestations only.
   */
  availability(
    recordHash: Uint8Array,
    panel: SeatPanel,
  ): {
    readonly available: boolean;
    readonly namedBy: readonly number[];
    readonly attestedWithout: readonly number[];
  };
  leafBlocks(cid: Uint8Array, limit: number): readonly Uint8Array[];
}

/** Where in a record a report or proven complaint is: a batch's pair or a root's leaf. */
type Part = { readonly pair?: number; readonly leaf?: number };

const partOrder = (p: Part) => p.pair ?? p.leaf ?? -1;

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const seatKey = (s: PanelSeat) => `${s.panel}:${s.seat}`;

const bySeat = (a: PanelSeat, b: PanelSeat) => a.panel - b.panel || a.seat - b.seat;

// The record type, read before decoding: no board-entry version allows a
// posting, a batch or an obligation root, so one here through the board path
// is rejected like the entry that would carry it, and another record type,
// which the caller shouldn't have passed, is rejected like any undecodable
// entry, so board content can't stop the check.
function deliveryKind(
  payload: Uint8Array,
  path: DeliveryEntry["path"],
): DeliveryItem["kind"] | "batch" | "complaint-batch" | "root" {
  if (payload.length < 3) throw new DecodeError("truncated", 0);
  const type = ((payload[0] as number) << 8) | (payload[1] as number);
  if (type === RECORD_TYPES.shareReceipt) return "receipt";
  if (type === RECORD_TYPES.sharePosting && path === "contract") return "posting";
  if (type === RECORD_TYPES.shareComplaint) return "complaint";
  if (type === RECORD_TYPES.shareReceiptBatch && path === "contract") return "batch";
  if (type === RECORD_TYPES.shareComplaintBatch && path === "contract") return "complaint-batch";
  if (type === RECORD_TYPES.obligationRoot && path === "contract") return "root";
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
  roots: RootReader | undefined,
): SeatCheck {
  const { definitionHash, segments, deadlines } = election;
  // A ballot hash binds the tier or cell and the nullifier, so selected ballots never share one.
  const byHash = new Map(hashes.map((h, i) => [hex(h), i]));

  const delivered = hashes.map(() => new Set<string>());
  const records: SeatReport[] = [];
  const rejected: { at: number; error: DecodeErrorCode }[] = [];
  const unverifiable: { at: number }[] = [];
  // Passing receipts and complaints to check once every posting is known, by ballot.
  const receipts: { at: number; part: Part; ballot: number; seat: PanelSeat }[] = [];
  // A batch entry or root leaf carries its record's signature verdict; a
  // single complaint is verified when it is judged.
  const complaints: {
    at: number;
    part: Part;
    ballot: number;
    item: PanelSeat & {
      readonly proof: ComplaintProof;
      readonly statement: Uint8Array;
      readonly signature: Uint8Array;
    };
    signed?: boolean;
  }[] = [];
  const postings = hashes.map(() => new Map<string, Posting>());

  // A contract-path batch: each pair is read as the share receipt it states,
  // all under the batch's one signature (docs/spec/delivery.md, Share-receipt
  // batch). A pair naming a ballot that isn't selected decides nothing.
  const batch = (at: number, submittedAt: bigint, d: BatchItem) => {
    const seat: PanelSeat = { panel: d.panel, seat: d.seat };
    const key = rules.keys(seat);
    // T-29: only the seat's registered signing key, never its identity key.
    const signed =
      key !== undefined &&
      verifyStatement(key.signingKey, rules.batchTag, d.statement, d.signature);
    d.pairs.forEach((p, pair) => {
      const ballot = byHash.get(hex(p.ballot_hash));
      if (ballot === undefined) return;
      if (key === undefined) {
        records.push({ at, pair, code: "delivery-seat", ...seat });
        return;
      }
      if (submittedAt > deadlines.delivery) {
        records.push({ at, pair, code: "delivery-late", ...seat });
        return;
      }
      if (!signed || !sameBytes(p.share_hash, rules.shareHash(ballot, seat))) {
        records.push({ at, pair, code: "share-receipt", signer: signed ? d.seat : null, ...seat });
        return;
      }
      (delivered[ballot] as Set<string>).add(seatKey(seat));
      receipts.push({ at, part: { pair }, ballot, seat });
    });
  };

  // A contract-path complaint batch: each entry is read as the complaint it
  // states, attributed by the batch's one signature (docs/spec/delivery.md,
  // Share-complaint batch).
  const complaintBatch = (at: number, submittedAt: bigint, d: ComplaintBatchItem) => {
    const seat: PanelSeat = { panel: d.panel, seat: d.seat };
    const key = rules.keys(seat);
    // T-29: only the seat's registered signing key, never its identity key.
    const signed =
      key !== undefined &&
      verifyStatement(key.signingKey, rules.complaintBatchTag, d.statement, d.signature);
    d.entries.forEach((e, pair) => {
      const ballot = byHash.get(hex(e.ballot_hash));
      if (ballot === undefined) return;
      if (key === undefined) {
        records.push({ at, pair, code: "delivery-seat", ...seat });
        return;
      }
      if (submittedAt > deadlines.complaint) {
        records.push({ at, pair, code: "delivery-late", ...seat });
        return;
      }
      complaints.push({
        at,
        part: { pair },
        ballot,
        item: { ...seat, proof: e.proof, statement: d.statement, signature: d.signature },
        signed,
      });
    });
  };

  // The slots a root fills: the first of each seat and kind, in board order,
  // whose signature verifies (docs/spec/delivery.md, One per seat and kind).
  // The contract accepts one per slot, so the operator's order decides none
  // (T-52, T-17).
  const filled = new Set<string>();

  // A contract-path obligation root: read once as a record, set aside with
  // its first code in the spec's order, or read leaf by leaf as a batch's
  // pairs or entries are (docs/spec/delivery.md, Delivery check).
  const root = (at: number, submittedAt: bigint, payload: Uint8Array, d: RootItem) => {
    const seat: PanelSeat = { panel: d.panel, seat: d.seat };
    const { record } = d;
    const key = rules.keys(seat);
    if (key === undefined) {
      records.push({ at, code: "delivery-seat", ...seat });
      return;
    }
    // T-29: only the seat's registered signing key, never its identity key;
    // an unsigned root is no one's and fills no slot.
    if (!verifyStatement(key.signingKey, rules.rootTag, d.statement, record.signature)) {
      records.push({ at, code: "root-signature", signer: null, ...seat });
      return;
    }
    const slot = `${seatKey(seat)}:${record.kind}`;
    if (filled.has(slot)) {
      records.push({ at, code: "root-repeat", ...seat });
      return;
    }
    filled.add(slot);
    const receiptRoot = record.kind === OBLIGATION_ROOT_KINDS.receipts;
    if (submittedAt > (receiptRoot ? deadlines.delivery : deadlines.complaint)) {
      records.push({ at, code: "delivery-late", ...seat });
      return;
    }
    // Without the bound, the attestations and the leaf objects, a root that
    // may deliver can't be read: undecided, never a guess either way (T-25, T-53).
    if (roots === undefined) {
      unverifiable.push({ at });
      return;
    }
    // T-52, T-17: before anything is fetched, so no seat makes a verifier
    // read more than it could owe.
    if (BigInt(record.count) > roots.bound) {
      records.push({ at, code: "root-count", signer: d.seat, ...seat });
      return;
    }
    const named = roots.availability(obligationRootHash(payload), d.panel);
    if (!named.available) {
      records.push({
        at,
        code: "root-withheld",
        signer: d.seat,
        namedBy: named.namedBy,
        attestedWithout: named.attestedWithout,
        ...seat,
      });
      return;
    }
    // Block by block, only along the canonical DAG of `count` leaves, so no
    // seat makes a verifier read more than its root's object. A block no
    // source serves leaves the election unverifiable from these sources,
    // never the root inconsistent, so no source changes a root's verdict
    // (T-53, T-24); blocks that hash but don't form that object (another
    // length, chunking or layout) are the seat's, as the CID it signed.
    const fetched = readObject(
      record.leaves_cid,
      ROOT_LEAF_LENGTH[record.kind] * record.count,
      (cid, limit) => roots.leafBlocks(cid, limit),
    );
    if (!fetched.ok && fetched.reason === "unavailable") {
      unverifiable.push({ at });
      return;
    }
    const read = fetched.ok ? readLeafObject(record.kind, record.count, fetched.bytes) : undefined;
    if (read === undefined || !sameBytes(merkleRoot(OBLIGATION_TREE, read.bytes), record.root)) {
      records.push({ at, code: "root-inconsistent", signer: d.seat, ...seat });
      return;
    }
    // The root's signature has verified, so every leaf is the seat's.
    read.leaves.forEach((l, leaf) => {
      const ballot = byHash.get(hex(l.ballot_hash));
      if (ballot === undefined) return;
      if ("share_hash" in l) {
        if (!sameBytes(l.share_hash, rules.shareHash(ballot, seat))) {
          records.push({ at, leaf, code: "share-receipt", signer: d.seat, ...seat });
          return;
        }
        (delivered[ballot] as Set<string>).add(seatKey(seat));
        receipts.push({ at, part: { leaf }, ballot, seat });
      } else
        complaints.push({
          at,
          part: { leaf },
          ballot,
          item: { ...seat, proof: l.proof, statement: d.statement, signature: record.signature },
          signed: true,
        });
    });
  };

  entries.forEach((entry, at) => {
    let d: DeliveryItem | BatchItem | ComplaintBatchItem | RootItem;
    try {
      const kind = deliveryKind(entry.payload, entry.path);
      d =
        kind === "batch"
          ? rules.decodeBatch(entry.payload)
          : kind === "complaint-batch"
            ? rules.decodeComplaintBatch(entry.payload)
            : kind === "root"
              ? rules.decodeRoot(entry.payload)
              : rules.decode(kind, entry.payload);
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
    if (d.kind === "batch" || d.kind === "complaint-batch" || d.kind === "root") {
      // deliveryKind reads a batch or a root only through the contract path.
      if (entry.path === "contract")
        if (d.kind === "batch") batch(at, entry.submittedAt, d);
        else if (d.kind === "complaint-batch") complaintBatch(at, entry.submittedAt, d);
        else root(at, entry.submittedAt, entry.payload, d);
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
      receipts.push({ at, part: {}, ballot, seat });
    } else if (d.kind === "posting") {
      const p = rules.posting(ballot, seat, key, d.posting);
      if (!p.ok) {
        records.push({ at, code: p.code, ...seat });
        return;
      }
      (delivered[ballot] as Set<string>).add(seatKey(seat));
      postings[ballot]?.set(seatKey(seat), d.posting);
    } else {
      complaints.push({ at, part: {}, ballot, item: d });
    }
  });

  // Complaints, once every posting is known: the passing posting needn't come
  // before the complaint on the board.
  const excluded = hashes.map(() => [] as (ProvenComplaint & { readonly panel: SeatPanel })[]);
  for (const { at, part: p, ballot, item, signed } of complaints) {
    const seat: PanelSeat = { panel: item.panel, seat: item.seat };
    const posting = postings[ballot]?.get(seatKey(seat));
    if (posting === undefined) {
      records.push({ at, ...p, code: "complaint-void", ...seat });
      continue;
    }
    const key = rules.keys(seat) as RegisteredKeys;
    const result = rules.complaint(ballot, seat, key, posting, item.proof);
    // T-29: attributed only under the seat's registered signing key, never its identity key.
    const signer =
      (signed ??
      verifyStatement(key.signingKey, rules.complaintTag, item.statement, item.signature))
        ? item.seat
        : null;
    if (result.ok) excluded[ballot]?.push({ at, ...p, ...seat, signer });
    else if (result.code === "complaint-unfounded")
      records.push({ at, ...p, code: "complaint-unfounded", signer, ...seat });
    else records.push({ at, ...p, code: "complaint-proof", ...seat });
  }
  // A passing receipt for a seat whose complaint about the same ballot, in the
  // same panel, is proven: the seat signed that shares passed which a public
  // proof shows don't (T-29).
  for (const { at, part, ballot, seat } of receipts)
    if (excluded[ballot]?.some((c) => c.panel === seat.panel && c.seat === seat.seat))
      records.push({
        at,
        ...part,
        code: "receipt-contradicted",
        signer: seat.seat,
        ...seat,
      });

  records.sort((a, b) => a.at - b.at || partOrder(a) - partOrder(b));
  const ballots = hashes.map((ballotHash, i) => {
    const got = delivered[i] as Set<string>;
    const missing = qualified.filter((s) => !got.has(seatKey(s))).sort(bySeat);
    const excludedBy = (excluded[i] as (ProvenComplaint & { panel: SeatPanel })[]).sort(
      (a, b) => a.at - b.at || partOrder(a) - partOrder(b),
    );
    return {
      ballotHash,
      counted: missing.length === 0 && excludedBy.length === 0,
      delivered: missing.length === 0,
      missing,
      excludedBy,
    };
  });
  // T-53: a counted set decided without a root that may deliver would be a
  // guess, so nothing is decided.
  if (unverifiable.length > 0) return { ballots: [], records: [], rejected, unverifiable };
  return { ballots, records, rejected, unverifiable };
}

/**
 * The delivery check (docs/spec/delivery.md, Delivery check; verifier 5.9)
 * for ballot versions 1 to 3, with delivery records of version 1.
 * `ballots` are the ballots selected for every cell from the counted extent;
 * `entries` every share-receipt, posting and complaint in the counted extent,
 * by either path, in board order, and `at` in every report is a position in
 * it. A board-path record is in time by its segment, a contract-path one by
 * its submission time, and a posting delivers only through the contract path.
 * A ballot stays in the counted set only if every qualified seat has a
 * receipt or a passing posting in time and no complaint about it is proven.
 * Neither depends on the records' order, duplicates or records for other
 * ballots (R3). A contract-path obligation root is read against `roots`, its
 * leaves delivering or excluding only once available and consistent; without
 * `roots`, a root that reaches the bound leaves the counted set undecided
 * (`unverifiable`).
 */
export function checkDelivery(
  election: DeliveryElection,
  ballots: readonly DeliveryBallot[],
  entries: readonly DeliveryEntry[],
  pinned: 1,
  roots?: DeliveryRoots,
): DeliveryCheck {
  const { definitionHash, panelSize, registered, segments, deadlines } = election;
  if (!(definitionHash instanceof Uint8Array) || definitionHash.length !== 32)
    throw new RangeError("checkDelivery: definitionHash must be 32 bytes");
  if (!Number.isSafeInteger(panelSize) || panelSize < 2 || panelSize > MAX_TRUSTEES)
    throw new RangeError("checkDelivery: panelSize must be from 2 to 16");
  const keyOf = keySet(registered, panelSize, "checkDelivery");
  checkWindows(segments, deadlines, "checkDelivery");
  checkEntries(entries, "checkDelivery");
  const reader =
    roots === undefined
      ? undefined
      : rootReader(
          "checkDelivery",
          roots,
          roots.attestations.map((a) => ({
            panel: SEAT_PANELS.default,
            seat: a.seat,
            roots: a.roots,
          })),
          new Map([
            [
              SEAT_PANELS.default,
              { qualified: registered.map((k) => k.index), threshold: roots.threshold },
            ],
          ]),
        );

  const hashes = ballots.map((b) => {
    if (b.vote.share_hashes.length !== panelSize)
      throw new RangeError("checkDelivery: every ballot must have passed validity-shape");
    return deliveryBallotHash(definitionHash, b);
  });
  const vote = (ballot: number) => (ballots[ballot] as DeliveryBallot).vote;
  const ctx = { definitionHash };
  const rules: DeliveryRules = {
    complaintTag: COMPLAINT_TAG,
    batchTag: BATCH_TAG,
    complaintBatchTag: COMPLAINT_BATCH_TAG,
    rootTag: ROOT_TAG,
    decodeRoot(payload) {
      const record = decodeObligationRoot(payload, pinned);
      return {
        kind: "root",
        definitionHash: record.definition_hash,
        panel: SEAT_PANELS.default,
        seat: record.seat,
        record,
        statement: obligationRootStatement(record),
      };
    },
    decodeComplaintBatch(payload) {
      const r = decodeShareComplaintBatch(payload, pinned);
      return {
        kind: "complaint-batch",
        definitionHash: r.definition_hash,
        panel: SEAT_PANELS.default,
        seat: r.seat,
        entries: r.complaints,
        statement: shareComplaintBatchStatement(r),
        signature: r.signature,
      };
    },
    decodeBatch(payload) {
      const r = decodeShareReceiptBatch(payload, pinned);
      return {
        kind: "batch",
        definitionHash: r.definition_hash,
        panel: SEAT_PANELS.default,
        seat: r.seat,
        pairs: r.receipts,
        statement: shareReceiptBatchStatement(r),
        signature: r.signature,
      };
    },
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
  const r = deliveryCheck(election, hashes, qualified, entries, rules, reader);
  return {
    ballots: r.ballots.map((b) => ({
      ballotHash: b.ballotHash,
      counted: b.counted,
      delivered: b.delivered,
      missing: b.missing.map((s) => s.seat),
      excludedBy: b.excludedBy.map(({ at, pair, leaf, seat, signer }) => ({
        at,
        ...(pair === undefined ? {} : { pair }),
        ...(leaf === undefined ? {} : { leaf }),
        seat,
        signer,
      })),
    })),
    records: r.records.map(({ at, pair, leaf, code, signer, namedBy, attestedWithout }) => ({
      at,
      ...(pair === undefined ? {} : { pair }),
      ...(leaf === undefined ? {} : { leaf }),
      code,
      ...(signer === undefined ? {} : { signer }),
      ...(namedBy === undefined ? {} : { namedBy }),
      ...(attestedWithout === undefined ? {} : { attestedWithout }),
    })),
    rejected: r.rejected,
    unverifiable: r.unverifiable,
  };
}

// The attestations checked once against each panel's registered key set:
// each from a qualified seat of its panel, at most one per seat, each naming
// 32-byte record hashes. A root of panel `P` is available with `q_P − k_P +
// 1` of `P`'s `q_P` qualified seats naming it (docs/spec/delivery.md, Leaf
// availability; Leaf availability (version 2)): withholding an honest root
// then takes `k_P` of its own panel's seats, and making one available that
// no honest seat holds takes `q_P − k_P + 1`, and neither panel's
// attestations count for the other's roots (T-25, T-54, T-37).
function rootReader(
  name: string,
  roots: Pick<DeliveryRoots, "bound" | "leafBlocks">,
  attestations: readonly (PanelSeat & { readonly roots: readonly Uint8Array[] })[],
  panels: ReadonlyMap<
    SeatPanel,
    { readonly qualified: readonly number[]; readonly threshold: number }
  >,
): RootReader {
  const { bound } = roots;
  if (typeof bound !== "bigint" || bound < 0n)
    throw new RangeError(`${name}: the roots' bound must be a bigint ≥ 0`);
  for (const { qualified, threshold } of panels.values())
    if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > qualified.length)
      throw new RangeError(`${name}: the threshold must be from 1 to the qualified seats`);
  if (typeof roots.leafBlocks !== "function")
    throw new RangeError(`${name}: leafBlocks must be a function`);
  const named = new Map<string, Set<string>>();
  for (const a of attestations) {
    // Each field read once, so the seat checked is the seat whose roots count.
    const seat: PanelSeat = { panel: a.panel, seat: a.seat };
    const listed = [...a.roots];
    if (panels.get(seat.panel)?.qualified.includes(seat.seat) !== true || named.has(seatKey(seat)))
      throw new RangeError(`${name}: one attestation per qualified seat`);
    if (!listed.every((h) => h instanceof Uint8Array && h.length === 32))
      throw new RangeError(`${name}: an attestation names roots by 32-byte record hashes`);
    named.set(seatKey(seat), new Set(listed.map(hex)));
  }
  return {
    bound,
    availability(recordHash, panel) {
      const h = hex(recordHash);
      const p = panels.get(panel);
      // Only a qualified seat's root is read, so its panel is always here.
      if (p === undefined) throw new Error(`${name}: a root of a panel without qualified seats`);
      const attesting = [...p.qualified]
        .sort((x, y) => x - y)
        .filter((seat) => named.has(seatKey({ panel, seat })));
      const names = (seat: number) => named.get(seatKey({ panel, seat }))?.has(h) === true;
      const namedBy = attesting.filter(names);
      return {
        available: namedBy.length >= p.qualified.length - p.threshold + 1,
        namedBy,
        attestedWithout: attesting.filter((seat) => !names(seat)),
      };
    },
    leafBlocks: (cid, limit) => roots.leafBlocks(Uint8Array.from(cid), limit),
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
  /** As `DeliveryCheck`'s: when any root is listed, `ballots` and `records` are empty. */
  readonly unverifiable: readonly { readonly at: number }[];
}

/**
 * What the version-2 delivery check reads obligation roots against
 * (docs/spec/delivery.md, Leaf availability (version 2)): `DeliveryRoots`
 * per panel, each root judged by its own panel's threshold and attestations.
 */
export interface DeliveryRootsV2 {
  /** `2M`, a seat's bound, of either panel. */
  readonly bound: bigint;
  /** `k` and `k_A`; the author panel's is read only beside an author key set. */
  readonly thresholds: { readonly default: number; readonly author: number };
  /** Each qualified seat's counted-extent attestation that counts, at most one per seat of each panel. */
  readonly attestations: readonly (PanelSeat & { readonly roots: readonly Uint8Array[] })[];
  leafBlocks(cid: Uint8Array, limit: number): readonly Uint8Array[];
}

/**
 * The delivery check for ballot version 4 (docs/spec/delivery.md, Delivery
 * check (version 2); verifier 5.9), over delivery records of version 2 and
 * every seat of both panels: each record checked against its own panel's
 * share hashes and registered key set, so a record for one panel's seat `i`
 * never delivers, excludes or contradicts the other's (T-37). Otherwise
 * `checkDelivery`'s. Given `definition`, a well-formed definition whose hash
 * is `definitionHash`, `registered.default` must be the key set
 * `checkCeremonyTranscript` returned for its default transcript, and
 * `registered.author` the one it returned for the author transcript and
 * `checkAuthorApprovals` then approved under it (empty without an author
 * panel): a seat outside its panel's set needs no delivery, so a set taken
 * on trust could drop a seat that withheld its share, or add one no seat
 * holds (T-37, T-17, T-25). Beside an author panel `definition` is required;
 * without one it may be omitted, the author key set must then be empty, and
 * the default set is the caller's. A contract-path obligation root is read
 * against `roots`, as `checkDelivery`'s are, judged available only by its own
 * panel's threshold and attestations; given `definition`, the thresholds must
 * be its own, since a lower or higher one would let fewer seats withhold or
 * make available a root (T-25, T-54). Without `roots`, a root that reaches
 * the bound leaves the counted set undecided (`unverifiable`).
 */
export function checkDeliveryV2(
  election: DeliveryElectionV2,
  ballots: readonly DeliveryBallotV4[],
  entries: readonly DeliveryEntry[],
  definition?: ElectionDefinitionV6,
  roots?: DeliveryRootsV2,
): DeliveryCheckV2 {
  const name = "checkDeliveryV2";
  // Read and copied once, so the election checked is the one the check runs
  // over, whatever a record's getters change while it reads them.
  const { definitionHash } = election;
  const e: DeliveryElectionV2 = {
    ...election,
    definitionHash:
      definitionHash instanceof Uint8Array ? Uint8Array.from(definitionHash) : definitionHash,
    registered: { default: election.registered.default, author: election.registered.author },
  };
  if (definition === undefined) {
    if (e.authorPanelSize !== 0 || e.registered.author.length !== 0)
      throw new RangeError(`${name}: an author panel's key set needs its definition`);
    return checkDeliveryV2With(e, ballots, entries, roots);
  }
  // One decoded copy of its bytes, so every check below reads the same
  // definition, whatever the caller's object returns on a later read.
  const d = decodeElectionDefinitionV6(encodeElectionDefinitionV6(definition));
  const transcript = checkedTranscriptHash(e.registered.default);
  if (
    !(e.definitionHash instanceof Uint8Array) ||
    hex(electionDefinitionV6Hash(d)) !== hex(e.definitionHash) ||
    d.panel_size !== e.panelSize ||
    d.author_keys.length !== e.authorPanelSize
  )
    throw new RangeError(`${name}: not the definition of this election`);
  if (electionDefinitionV6Rule(d) !== undefined)
    throw new RangeError(`${name}: the definition isn't well-formed`);
  // The default seats too are the key set its own run registered, so no
  // caller can drop a default seat from, or add one to, those a ballot must
  // be delivered to (T-25, T-37).
  if (transcript === undefined || hex(transcript) !== hex(d.ceremony_transcript_hash))
    throw new RangeError(`${name}: not the key set of this definition's ceremony`);
  if (!approvedFor(d, e.registered.author))
    throw new RangeError(
      e.authorPanelSize === 0
        ? `${name}: the definition has no author panel`
        : `${name}: not the author panel's approved key set of this definition`,
    );
  if (
    roots !== undefined &&
    (roots.thresholds.default !== d.threshold ||
      (d.author_keys.length !== 0 && roots.thresholds.author !== d.author_threshold))
  )
    throw new RangeError(`${name}: not the thresholds of this definition`);
  return checkDeliveryV2With(e, ballots, entries, roots);
}

/**
 * Internal: `checkDeliveryV2` with the author panel's key set taken as given,
 * so author seats' delivery can be tested against vectors that carry no
 * author run. The package entry point doesn't export it.
 */
export function checkDeliveryV2With(
  election: DeliveryElectionV2,
  ballots: readonly DeliveryBallotV4[],
  entries: readonly DeliveryEntry[],
  roots?: DeliveryRootsV2,
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
  // A panel with no qualified seat has no root to judge, so its threshold isn't read.
  const panels = new Map<SeatPanel, { qualified: number[]; threshold: number }>();
  if (roots !== undefined)
    for (const [panel, keys, threshold] of [
      [SEAT_PANELS.default, registered.default, roots.thresholds.default],
      [SEAT_PANELS.author, registered.author, roots.thresholds.author],
    ] as const)
      if (keys.length > 0) panels.set(panel, { qualified: keys.map((k) => k.index), threshold });
  const reader =
    roots === undefined ? undefined : rootReader(name, roots, roots.attestations, panels);

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
    batchTag: BATCH_TAG_V2,
    complaintBatchTag: COMPLAINT_BATCH_TAG_V2,
    rootTag: ROOT_TAG_V2,
    // Version 2, with the seat's panel: a version-1 batch or root, which
    // names none, is a rejected entry (profile-mismatch).
    decodeBatch(payload) {
      const r = decodeShareReceiptBatch(payload, 2);
      return {
        kind: "batch",
        definitionHash: r.definition_hash,
        panel: r.panel,
        seat: r.seat,
        pairs: r.receipts,
        statement: shareReceiptBatchStatementV2(r),
        signature: r.signature,
      };
    },
    decodeComplaintBatch(payload) {
      const r = decodeShareComplaintBatch(payload, 2);
      return {
        kind: "complaint-batch",
        definitionHash: r.definition_hash,
        panel: r.panel,
        seat: r.seat,
        entries: r.complaints,
        statement: shareComplaintBatchStatementV2(r),
        signature: r.signature,
      };
    },
    decodeRoot(payload) {
      const record = decodeObligationRoot(payload, 2);
      return {
        kind: "root",
        definitionHash: record.definition_hash,
        panel: record.panel,
        seat: record.seat,
        record,
        statement: obligationRootStatementV2(record),
      };
    },
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
  return deliveryCheck(election, hashes, qualified, entries, rules, reader);
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
