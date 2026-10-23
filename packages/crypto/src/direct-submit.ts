// The board contract's stateless framing of the records it accepts
// (docs/spec/contracts.md, Board, Ballots steps 1 and 3 to 5 and the proof's
// points, Delivery records steps 1, 3 and 4), for the contract-event record's
// check of the board's events: versions 2 to 8 frame ballot versions 1 to 3
// and the version-1 delivery records, and version 9 adds ballot version 4 and
// the version-2 delivery records, which name their seat's panel (What the
// board frames (version 9); Ballots (version 4); Delivery records (version
// 2)). It runs the contract's framing, and none of its shape checks (seat
// 0, counts that disagree, a posting's length), and decodes nothing the
// contract doesn't: a ristretto255 element is only checked to be an even
// value below 2²⁵⁵ − 19 and not 0, never decoded, since the board admits a
// member's ballot whose elements aren't points and the verifier rejects it
// later (T-53). Checking more here would let any member fail a deployment's
// events by direct-submitting such a ballot (T-17, T-31).

import {
  bytesFixed,
  type Codec,
  DecodeError,
  decode,
  EncodeError,
  enum8,
  fieldBn254,
  list,
  struct,
  bytesVar,
  u64,
  u8,
  Writer,
} from "./codec.ts";
import { ds } from "./domain-separation.ts";
import { TIERS } from "./election-definition.ts";
import { H, scalar } from "./group.ts";
import { membershipProof } from "./membership-proof.ts";
import { PARAMETERS } from "./parameters.ts";
import { SEAT_PANELS } from "./ballot.ts";
import { COMPLAINT_BATCH_MAX } from "./delivery.ts";
import { RECORD_TYPES } from "./record.ts";
import { MLKEM_CT_LEN, MAX_SEALED } from "./share-encryption.ts";
import { MAX_TRUSTEES, p256Sig } from "./trustee.ts";

const { MAX_OPTIONS, MAX_QUESTIONS } = PARAMETERS;

const FIELD_25519 = 2n ** 255n - 19n;

function frameOf(b: Uint8Array): boolean {
  let s = 0n;
  for (let i = 31; i >= 0; i--) s = (s << 8n) | BigInt(b[i] ?? 0);
  // RFC 9496 §4.3.1's canonical and non-negative checks, and not the
  // identity: what the board checks of an element without a square root.
  return s !== 0n && s < FIELD_25519 && (s & 1n) === 0n;
}

/** An `element` as the board frames it: its 32 bytes, unchecked as a point. */
const framedElement: Codec<Uint8Array> = {
  minLength: 32,
  write(w, value) {
    if (!(value instanceof Uint8Array) || value.length !== 32 || !frameOf(value))
      throw new EncodeError("element: expected an even value from 2 to 2²⁵⁵ − 21");
    w.bytes(value);
  },
  read(r) {
    const at = r.offset;
    const b = new Uint8Array(r.take(32));
    if (!frameOf(b)) throw new DecodeError("non-canonical", at);
    return b;
  },
};

const bitProof = struct([
  ["c0", scalar],
  ["z0", scalar],
  ["c1", scalar],
  ["z1", scalar],
]);
const branch = struct([
  ["c", scalar],
  ["z", scalar],
]);

const voteHead = [
  ["vss", list(list(framedElement, MAX_TRUSTEES), MAX_OPTIONS)],
  ["share_hashes", list(bytesFixed(32), MAX_TRUSTEES)],
  ["option_proofs", list(bitProof, MAX_OPTIONS)],
] as const;

// Ballot versions 1 and 2: one sum proof; version 3: one range proof per question.
const VOTE = struct([...voteHead, ["sum_proof", list(branch, MAX_OPTIONS + 1)]] as const);
const sumProofs = ["sum_proofs", list(list(branch, MAX_OPTIONS + 1), MAX_QUESTIONS)] as const;
const VOTE_V3 = struct([...voteHead, sumProofs] as const);
// Version 4: the author half after the default half, framed as it is
// (Ballots (version 4), step 5), so an author element is never decoded either.
const VOTE_V4 = struct([
  ["vss", list(list(framedElement, MAX_TRUSTEES), MAX_OPTIONS)],
  ["share_hashes", list(bytesFixed(32), MAX_TRUSTEES)],
  ["author_vss", list(list(framedElement, MAX_TRUSTEES), MAX_OPTIONS)],
  ["author_share_hashes", list(bytesFixed(32), MAX_TRUSTEES)],
  ["option_proofs", list(bitProof, MAX_OPTIONS)],
  sumProofs,
] as const);

const ballotFields = (label: Codec<number>, vote: Codec<unknown>) =>
  struct([
    ["definition_hash", bytesFixed(32)],
    ["label", label],
    ["nullifier", fieldBn254],
    ["l1_ref_number", u64],
    ["l1_ref_hash", bytesFixed(32)],
    // Decoded whole, B's subgroup included: the board's pairing refuses a B
    // outside it, so every proof the board emits passes (membership.md).
    ["membership_proof", membershipProof],
    ["committed_vote", vote],
  ] as const);

const BALLOT_BODY: Readonly<Record<1 | 2 | 3 | 4, Codec<unknown>>> = {
  1: ballotFields(enum8(TIERS), VOTE),
  2: ballotFields(u8, VOTE),
  3: ballotFields(u8, VOTE_V3),
  4: ballotFields(u8, VOTE_V4),
};

/**
 * Whose framing to apply: the contract-event version's (What the board
 * frames). Version 8's, which versions 2 to 7 share, takes ballot versions 1
 * to 3 and the version-1 delivery records; version 9's adds ballot version 4
 * and the version-2 delivery records. A board deployed with the earlier
 * framing refuses the records only the later one takes, so a record version
 * 8 refuses is never one such a board emitted (T-53).
 */
export type BoardFraming = 8 | 9;

// The fields' offsets in a ballot record of any version (docs/spec/ballot-validity.md).
const DEFINITION_AT = 3;
const LABEL_AT = 35;
const L1_REF_AT = 68;
const VOTE_AT = 364;

const typeOf = (b: Uint8Array) => ((b[0] ?? 0) << 8) | (b[1] ?? 0);

/** What a framed record names: its election and its ballot. */
export interface FramedRecord {
  readonly definitionHash: Uint8Array;
  readonly ballotHash: Uint8Array;
}

/**
 * Frames a ballot record (`0x0002`) as the board does before reading its
 * election: a version from 1 to 3 (or 4, under `framing` 9), the fixed
 * fields, the committed vote under that version, nothing after it, and the
 * membership proof's points. Returns its `definition_hash` and its
 * `ballot_hash`, computed from the record's bytes with the one formula every
 * version shares (docs/spec/ballot-validity.md, Ballot hash; Hashes (version
 * 3); Hashes (version 4)), or undefined for any record the board refuses
 * whatever its election.
 */
export function frameBallot(
  record: Uint8Array,
  framing: BoardFraming = 8,
): (FramedRecord & { version: 1 | 2 | 3 | 4 }) | undefined {
  const version = record[2];
  if (
    typeOf(record) !== RECORD_TYPES.ballot ||
    (version !== 1 && version !== 2 && version !== 3 && (version !== 4 || framing !== 9))
  )
    return undefined;
  try {
    decode(BALLOT_BODY[version], record.subarray(3));
  } catch (e) {
    if (e instanceof DecodeError) return undefined;
    throw e;
  }
  // definition_hash ‖ u16(0x0002) ‖ u8(version) ‖ u8(tier or cell) ‖
  // encode(nullifier) ‖ encode(committed_vote): the same for every version.
  const w = new Writer();
  w.bytes(record.subarray(DEFINITION_AT, LABEL_AT));
  w.bytes(record.subarray(0, DEFINITION_AT));
  w.bytes(record.subarray(LABEL_AT, L1_REF_AT));
  w.bytes(record.subarray(VOTE_AT));
  return {
    version,
    definitionHash: record.slice(DEFINITION_AT, LABEL_AT),
    ballotHash: H(ds("abolish/v1/ballot", w.finish())),
  };
}

// A version-2 record's panel, before its seat: the default panel or the author panel.
const panel = enum8([SEAT_PANELS.default, SEAT_PANELS.author]);

const deliveryHead = [
  ["definition_hash", bytesFixed(32)],
  ["ballot_hash", bytesFixed(32)],
  ["seat", u8],
] as const;

// Version 2: `panel` at 67, before the seat, and every later field one byte
// further on (docs/spec/delivery.md, Records (version 2), Decoding).
const deliveryHeadV2 = [
  ["definition_hash", bytesFixed(32)],
  ["ballot_hash", bytesFixed(32)],
  ["panel", panel],
  ["seat", u8],
] as const;

function deliveryBodies(
  head: typeof deliveryHead | typeof deliveryHeadV2,
): ReadonlyMap<number, Codec<unknown>> {
  return new Map<number, Codec<unknown>>([
    [
      RECORD_TYPES.shareReceipt,
      struct([...head, ["share_hash", bytesFixed(32)], ["signature", p256Sig]] as const),
    ],
    [
      RECORD_TYPES.sharePosting,
      struct([
        ...head,
        ["m", bytesFixed(32)],
        ["ct_mlkem", bytesFixed(MLKEM_CT_LEN)],
        ["ct_dh", framedElement],
        ["pok_c", scalar],
        ["pok_z", scalar],
        ["sealed", bytesVar(MAX_SEALED)],
      ] as const),
    ],
    [
      RECORD_TYPES.shareComplaint,
      struct([
        ...head,
        ["dh", framedElement],
        ["c", scalar],
        ["z", scalar],
        ["signature", p256Sig],
      ] as const),
    ],
  ]);
}

const DELIVERY_BODY: Readonly<Record<1 | 2, ReadonlyMap<number, Codec<unknown>>>> = {
  1: deliveryBodies(deliveryHead),
  2: deliveryBodies(deliveryHeadV2),
};

/**
 * Frames a share receipt (`0x000c`), posting (`0x000d`) or complaint
 * (`0x000e`) of record type `type` as the board does (Delivery records, step
 * 4): version 1 (or 2, under `framing` 9), every field framed, nothing after
 * the last. Returns the `definition_hash` and `ballot_hash` it names, at the
 * same offsets under either version, or undefined.
 */
export function frameDelivery(
  type: number,
  record: Uint8Array,
  framing: BoardFraming = 8,
): FramedRecord | undefined {
  const version = record[2];
  if (version !== 1 && (version !== 2 || framing !== 9)) return undefined;
  const body = DELIVERY_BODY[version].get(type);
  if (body === undefined || typeOf(record) !== type) return undefined;
  try {
    decode(body, record.subarray(3));
  } catch (e) {
    if (e instanceof DecodeError) return undefined;
    throw e;
  }
  return { definitionHash: record.slice(3, 35), ballotHash: record.slice(35, 67) };
}

const before = (a: Uint8Array, b: Uint8Array) => {
  for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return (a[i] as number) < (b[i] as number);
  return false;
};

// The entries as the board frames them: 1 to COMPLAINT_BATCH_MAX, strictly
// ascending by ballot hash, each `D` framed, never decoded, and `c` and `z`
// below ℓ (Delivery records, step 4).
const framedComplaintEntries: Codec<number> = {
  minLength: 4 + 128,
  write() {
    throw new EncodeError("framing only");
  },
  read(r) {
    const at = r.offset;
    const count = r.uint(4);
    if (count > COMPLAINT_BATCH_MAX) throw new DecodeError("length-over-max", at);
    if (count === 0) throw new DecodeError("non-canonical", at);
    let last: Uint8Array | undefined;
    for (let i = 0; i < count; i++) {
      const eAt = r.offset;
      const ballotHash = new Uint8Array(r.take(32));
      if (last !== undefined && !before(last, ballotHash))
        throw new DecodeError("non-canonical", eAt);
      last = ballotHash;
      framedElement.read(r);
      scalar.read(r);
      scalar.read(r);
    }
    return count;
  },
};

const COMPLAINT_BATCH_BODY: Readonly<Record<1 | 2, Codec<unknown>>> = {
  1: struct([
    ["definition_hash", bytesFixed(32)],
    ["seat", u8],
    ["complaints", framedComplaintEntries],
    ["signature", p256Sig],
  ] as const),
  // Version 2: `panel` at 35 and `seat` at 36.
  2: struct([
    ["definition_hash", bytesFixed(32)],
    ["panel", panel],
    ["seat", u8],
    ["complaints", framedComplaintEntries],
    ["signature", p256Sig],
  ] as const),
};

/**
 * Frames a share-complaint batch (`0x0017`) as the board does (Delivery
 * records, step 4): version 1 (or 2, under `framing` 9), its entries
 * ascending with each `D` framed, never decoded, so a seat's batch the board
 * emits always passes the event check (T-53). Returns the `definition_hash`
 * and `seat` it names, the seat read where its version puts it, or
 * undefined.
 */
export function frameComplaintBatch(
  record: Uint8Array,
  framing: BoardFraming = 8,
): { readonly definitionHash: Uint8Array; readonly seat: number } | undefined {
  const version = record[2];
  if (
    typeOf(record) !== RECORD_TYPES.shareComplaintBatch ||
    (version !== 1 && (version !== 2 || framing !== 9))
  )
    return undefined;
  try {
    decode(COMPLAINT_BATCH_BODY[version], record.subarray(3));
  } catch (e) {
    if (e instanceof DecodeError) return undefined;
    throw e;
  }
  return { definitionHash: record.slice(3, 35), seat: record[version === 1 ? 35 : 36] as number };
}
