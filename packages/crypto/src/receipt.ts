// Ballot receipts (docs/spec/receipts.md, record type 0x0004): the operator's
// signature on the board it showed a voter, with the voter's entry last, and
// the check a client runs when it gets one (T-25, T-26, T-23, T-24). The
// signature suite is the trustees' (docs/spec/trustee-identity.md); the
// proofs are the board's. The later checks are P1-13b's.

import { boardEntryHash, type BoardEntryVersion, encodeBoardEntry } from "./board.ts";
import {
  bytesFixed,
  type CodecValue,
  DecodeError,
  type DecodeErrorCode,
  EncodeError,
  encode,
  list,
  struct,
  u32,
  u64,
} from "./codec.ts";
import { BOARD_TREE, verifyInclusion } from "./merkle.ts";
import { RECORD_TYPES, RecordSchema, recordType } from "./record.ts";
import { identityKey, p256Key, p256Sig, signStatement, verifyStatement } from "./trustee.ts";

const TAG = "abolish/v1/sig/receipt";

/** The most hashes in an audit path of a tree of at most 2⁶⁴ − 1 entries (T-52). */
const MAX_PATH = 64;

const statementFields = [
  ["election_id", bytesFixed(32)],
  ["index", u64],
  ["segment", u32],
  ["entry_hash", bytesFixed(32)],
  ["link", bytesFixed(32)],
  ["root", bytesFixed(32)],
  ["operator_key", p256Key],
] as const;

const statementV1 = struct(statementFields);

const receiptV1 = struct([
  ...statementFields,
  ["signature", p256Sig],
  ["inclusion", list(bytesFixed(32), MAX_PATH)],
] as const);

/** What the operator signs: the first seven fields of a receipt. */
export type ReceiptStatement = CodecValue<typeof statementV1>;

/** Receipt, version 1 (docs/spec/receipts.md). */
export type Receipt = CodecValue<typeof receiptV1>;

/** Record type `0x0004`: what a voter keeps. Never on the board, the chain or the archive. */
export const RECEIPT = recordType(RECORD_TYPES.receipt, { 1: receiptV1 });

const SCHEMA = new RecordSchema([RECEIPT]);

/** Encodes a receipt under version 1, the only version. */
export function encodeReceipt(receipt: Receipt): Uint8Array {
  return SCHEMA.encode(RECEIPT, 1, receipt);
}

/**
 * Strictly decodes a receipt. A receipt belongs to no election's data, so the
 * version is the one this release pins, not an election profile's.
 */
export function decodeReceipt(bytes: Uint8Array): Receipt {
  return SCHEMA.decode(RECEIPT, bytes, 1).value;
}

/** `m`, the 173-byte signed statement: the first seven fields, with no record header. */
export function receiptStatement(statement: ReceiptStatement): Uint8Array {
  // Through the struct, so only the seven fields are read even from a whole receipt.
  return encode(statementV1, {
    election_id: statement.election_id,
    index: statement.index,
    segment: statement.segment,
    entry_hash: statement.entry_hash,
    link: statement.link,
    root: statement.root,
    operator_key: statement.operator_key,
  });
}

/** The fields an operator fills in after appending entry `index`; it adds its key and signature. */
export type UnsignedReceipt = Omit<Receipt, "operator_key" | "signature">;

/**
 * Signs a receipt for entry `index`, right after appending it: `link` and
 * `root` are the board's head and root at `index + 1` entries, and
 * `inclusion` is the entry's audit path there. For the board operator and
 * tests; the key is a 32-byte big-endian P-256 secret.
 */
export function signReceipt(secretKey: Uint8Array, unsigned: UnsignedReceipt): Receipt {
  const statement = { ...unsigned, operator_key: identityKey(secretKey) };
  const signature = signStatement(secretKey, TAG, receiptStatement(statement));
  // Round-tripped, so only an encodable receipt with its own copies leaves here.
  return decodeReceipt(encodeReceipt({ ...statement, signature, inclusion: unsigned.inclusion }));
}

const equalBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const copyBytes = (b: unknown, what: string) => {
  if (!(b instanceof Uint8Array) || !ArrayBuffer.isView(b))
    throw new TypeError(`${what} must be a Uint8Array`);
  return new Uint8Array(b);
};

function pinnedKeys(keys: readonly Uint8Array[]): Uint8Array[] {
  if (!Array.isArray(keys)) throw new TypeError("receiptKeys must be an array");
  return keys.map((k, i) => copyBytes(k, `receiptKeys[${i}]`));
}

/** The failures of the checks at cast (docs/spec/receipts.md), in the order they run. */
export type ReceiptCastErrorCode =
  | "decode"
  | "receipt-key"
  | "receipt-signature"
  | "receipt-election"
  | "receipt-segment"
  | "receipt-entry"
  | "receipt-inclusion";

/** What the client knows when it gets a receipt. */
export interface CastExpectation {
  readonly electionId: Uint8Array;
  /** The complete record the client submitted, header included. */
  readonly payload: Uint8Array;
  /**
   * The board-entry version the election's profile pins: the entry is rebuilt
   * under it, so a receipt for an entry under any other version can't pass.
   */
  readonly boardEntryVersion: BoardEntryVersion;
  /** The receipt keys the ballot client's release pins. */
  readonly receiptKeys: readonly Uint8Array[];
  /**
   * The segments the client accepts under docs/spec/board.md's client rule 1,
   * inclusive, capped at the election's `lastSegment`: rule 1's one-period
   * tolerance never reaches past the seal, since no later segment is anchored.
   */
  readonly segments: { readonly min: number; readonly max: number };
}

export type ReceiptCastCheck =
  | { readonly ok: true; readonly receipt: Receipt }
  | {
      readonly ok: false;
      readonly code: ReceiptCastErrorCode;
      /** With `decode`: the decode error code and its offset. */
      readonly decodeError?: { readonly code: DecodeErrorCode; readonly offset: number };
    };

// Checks 2 and 3: whether a pinned receipt key signed the statement.
function signedBy(
  r: Receipt,
  keys: readonly Uint8Array[],
): "receipt-key" | "receipt-signature" | undefined {
  if (!keys.some((k) => equalBytes(k, r.operator_key))) return "receipt-key";
  if (!verifyStatement(r.operator_key, TAG, receiptStatement(r), r.signature))
    return "receipt-signature";
  return undefined;
}

// Check 7: the audit path puts entry_hash at index in the signed root. An
// index of 2⁶⁴ − 1 gives a size past u64, which verifyInclusion rejects.
const included = (r: Receipt) =>
  verifyInclusion(BOARD_TREE, r.index, r.index + 1n, r.entry_hash, r.inclusion, r.root);

/**
 * The checks at cast, before the client tells the voter the ballot was
 * received. A failure isn't an alarm: nothing in it is evidence a third
 * party can check, so the client keeps the ballot and resubmits it, or
 * submits it directly (T-25).
 */
export function checkReceiptAtCast(bytes: Uint8Array, expected: CastExpectation): ReceiptCastCheck {
  const electionId = copyBytes(expected.electionId, "electionId");
  if (electionId.length !== 32) throw new RangeError("electionId must be 32 bytes");
  const payload = copyBytes(expected.payload, "payload");
  const keys = pinnedKeys(expected.receiptKeys);
  const { min, max } = expected.segments;
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max > 0xffffffff || min > max)
    throw new RangeError("segments must be a u32 range with min ≤ max");
  let r: Receipt;
  try {
    r = decodeReceipt(copyBytes(bytes, "bytes"));
  } catch (e) {
    if (!(e instanceof DecodeError)) throw e;
    return { ok: false, code: "decode", decodeError: { code: e.code, offset: e.offset } };
  }
  const unsigned = signedBy(r, keys);
  if (unsigned !== undefined) return { ok: false, code: unsigned };
  if (!equalBytes(r.election_id, electionId)) return { ok: false, code: "receipt-election" };
  if (r.segment < min || r.segment > max) return { ok: false, code: "receipt-segment" };
  // The entry is rebuilt from what the client sent, so a receipt for any
  // other payload, election, index or segment can't pass (T-38).
  let entry: Uint8Array;
  try {
    entry = encodeBoardEntry(
      {
        election_id: electionId,
        index: r.index,
        segment: r.segment,
        payload,
      },
      expected.boardEntryVersion,
    );
  } catch (e) {
    // A payload no board entry can carry: no receipt can be for it.
    if (!(e instanceof EncodeError)) throw e;
    return { ok: false, code: "receipt-entry" };
  }
  if (!equalBytes(boardEntryHash(entry), r.entry_hash)) return { ok: false, code: "receipt-entry" };
  if (!included(r)) return { ok: false, code: "receipt-inclusion" };
  return { ok: true, receipt: r };
}
