// The bulletin board of docs/spec/board.md: the board-entry envelope (record
// type 0x0007), entry hashes, checkpoints, and the board checks a verifier
// runs (docs/spec/verifier.md 4.1 and 4.2). The operator writes envelopes,
// their order and their segments, so every check here is an election check
// (T-23); the records inside payloads are judged elsewhere, by admission.

import {
  bytesFixed,
  type Codec,
  type CodecValue,
  decode,
  DecodeError,
  type DecodeErrorCode,
  EncodeError,
  encode,
  struct,
  u32,
  u64,
} from "./codec.ts";
import { objectCid } from "./content-addressing.ts";
import { ds } from "./domain-separation.ts";
import { H } from "./group.ts";
import { BOARD_TREE, merkleRoots } from "./merkle.ts";
import { RECORD_TYPES, RecordSchema, type RecordVersion, recordType, UNPINNED } from "./record.ts";

/** `MAX_BOARD_PAYLOAD` (docs/spec/parameters.md): the largest record an entry carries (T-52). */
export const MAX_BOARD_PAYLOAD = 1_048_576;

/**
 * Record types an entry may carry (docs/spec/board.md, Allowed payloads).
 * Display text is never on the board (T-17), receipts stay with their voter,
 * entries never nest, and a definition arrives as the event that registered it.
 */
export const BOARD_PAYLOAD_TYPES: readonly number[] = Object.freeze([
  RECORD_TYPES.ballot,
  RECORD_TYPES.spoiledBallotOpening,
  RECORD_TYPES.ceremonyTranscript,
  RECORD_TYPES.tallyOpening,
  RECORD_TYPES.contractEvent,
]);

/**
 * Record types a version-3 entry may carry: version 1's, and the share
 * receipts and complaints that show a ballot's delivery
 * (docs/spec/delivery.md). Never a share posting: a posting delivers only
 * through the contract path, as a contract event, so the operator can't
 * withhold its data from the trustees. Version 1's set is frozen, so allowing
 * them is a new version (docs/spec/versioning.md); version 2 is never
 * assigned, since board.json's frozen `unknown-version` vector uses it as the
 * unknown one.
 */
export const BOARD_PAYLOAD_TYPES_V3: readonly number[] = Object.freeze([
  ...BOARD_PAYLOAD_TYPES,
  RECORD_TYPES.shareReceipt,
  RECORD_TYPES.shareComplaint,
]);

/**
 * Record types a version-4 entry may carry: version 3's, and the trustees'
 * destruction statements after the tally (docs/spec/tally.md, Destruction).
 * Version 3's set is frozen by its vectors, so allowing them is a new version.
 */
export const BOARD_PAYLOAD_TYPES_V4: readonly number[] = Object.freeze([
  ...BOARD_PAYLOAD_TYPES_V3,
  RECORD_TYPES.destructionStatement,
]);

/**
 * Record types a version-5 entry may carry: version 4's, and the trustees'
 * close statements after close (docs/spec/close.md, Close statement), so a
 * seat can state the close through the board path. Version 5 fixes the
 * close statement's version, 1. Version 4's set is frozen by its vectors, so
 * allowing them is a new version.
 */
export const BOARD_PAYLOAD_TYPES_V5: readonly number[] = Object.freeze([
  ...BOARD_PAYLOAD_TYPES_V4,
  RECORD_TYPES.closeStatement,
]);

/**
 * Record types a version-6 entry may carry: version 5's, and a live poll's
 * running openings (docs/spec/tally.md, Running opening record). Only a
 * profile pinning tally-opening version 2, a live poll's, pins version 6, so
 * a sealed poll's board can't carry a running opening at all (verifier 2.3;
 * T-16, T-31). Version 5's set is frozen by its vectors, so allowing them is
 * a new version.
 */
export const BOARD_PAYLOAD_TYPES_V6: readonly number[] = Object.freeze([
  ...BOARD_PAYLOAD_TYPES_V5,
  RECORD_TYPES.runningOpening,
]);

const PAYLOAD_TYPES_BY_VERSION = {
  1: BOARD_PAYLOAD_TYPES,
  3: BOARD_PAYLOAD_TYPES_V3,
  4: BOARD_PAYLOAD_TYPES_V4,
  5: BOARD_PAYLOAD_TYPES_V5,
  6: BOARD_PAYLOAD_TYPES_V6,
} as const;

/**
 * The record types a board-entry version allows (docs/spec/board.md,
 * Allowed payloads), so a rule about what a version carries asks it rather
 * than naming versions.
 */
export function boardPayloadTypes(version: BoardEntryVersion): readonly number[] {
  // An untyped caller can pass anything; own keys only, never the prototype's.
  if (!Object.hasOwn(PAYLOAD_TYPES_BY_VERSION, version))
    throw new RangeError(`boardPayloadTypes: no board-entry version ${String(version)}`);
  return PAYLOAD_TYPES_BY_VERSION[version];
}

const RECORD_HEADER_LENGTH = 3;

const recordTypeOf = (record: Uint8Array) => ((record[0] as number) << 8) | (record[1] as number);

/**
 * `bytes<MAX_BOARD_PAYLOAD>` holding one record of a type in `allowed`. Only
 * the payload's header is read here; its version and fields are decoded when
 * the record is used.
 */
function payload(allowed: readonly number[]): Codec<Uint8Array> {
  // A private Set for lookups, so callers can't add a type to what the decoder accepts.
  const PAYLOAD_TYPES: ReadonlySet<number> = new Set(allowed);
  return {
    minLength: 4,
    write(w, value) {
      if (!(value instanceof Uint8Array) || !ArrayBuffer.isView(value))
        throw new EncodeError("payload: expected a Uint8Array");
      const b = new Uint8Array(value);
      if (b.length > MAX_BOARD_PAYLOAD)
        throw new EncodeError(`payload: ${b.length} bytes is over ${MAX_BOARD_PAYLOAD}`);
      if (b.length < RECORD_HEADER_LENGTH)
        throw new EncodeError("payload: shorter than a record header");
      if (!PAYLOAD_TYPES.has(recordTypeOf(b)))
        throw new EncodeError(`payload: record type ${recordTypeOf(b)} isn't allowed on the board`);
      w.uint(4, b.length);
      w.bytes(b);
    },
    read(r) {
      const at = r.offset;
      const n = r.uint(4);
      // T-52: checked against the maximum before anything is read.
      if (n > MAX_BOARD_PAYLOAD) throw new DecodeError("length-over-max", at);
      const content = r.take(n).slice();
      if (content.length < RECORD_HEADER_LENGTH) throw new DecodeError("truncated", at + 4);
      if (!PAYLOAD_TYPES.has(recordTypeOf(content)))
        throw new DecodeError("unexpected-record-type", at + 4);
      return content;
    },
  };
}

const entryFields = (allowed: readonly number[]) =>
  struct([
    ["election_id", bytesFixed(32)],
    ["index", u64],
    ["segment", u32],
    ["payload", payload(allowed)],
  ] as const);

const entryV1 = entryFields(BOARD_PAYLOAD_TYPES);

// The same layout: only the allowed payload types differ.
const entryV3 = entryFields(BOARD_PAYLOAD_TYPES_V3);
const entryV4 = entryFields(BOARD_PAYLOAD_TYPES_V4);
const entryV5 = entryFields(BOARD_PAYLOAD_TYPES_V5);
const entryV6 = entryFields(BOARD_PAYLOAD_TYPES_V6);

/** Board entry, version 1, 3, 4, 5 or 6 (docs/spec/board.md). */
export type BoardEntry = CodecValue<typeof entryV1>;

/** Record type `0x0007`: the envelope that places a record on the board. */
export const BOARD_ENTRY = recordType(RECORD_TYPES.boardEntry, {
  1: entryV1,
  3: entryV3,
  4: entryV4,
  5: entryV5,
  6: entryV6,
});

/** A board-entry version this release reads and writes. */
export type BoardEntryVersion = RecordVersion<typeof BOARD_ENTRY.versions>;

const SCHEMA = new RecordSchema([BOARD_ENTRY]);

/**
 * Encodes a board entry under `version`, the one the election's profile pins.
 * It has no default: an entry hashed under the wrong version matches nothing.
 */
export function encodeBoardEntry(entry: BoardEntry, version: BoardEntryVersion): Uint8Array {
  return SCHEMA.encode(BOARD_ENTRY, version, entry);
}

/**
 * Strictly decodes one board entry. `pinned` is the version the election's
 * profile pins for board entries (docs/spec/versioning.md, T-34).
 */
export function decodeBoardEntry(
  bytes: Uint8Array,
  pinned: RecordVersion<typeof BOARD_ENTRY.versions> | typeof UNPINNED,
): BoardEntry {
  return SCHEMA.decode(BOARD_ENTRY, bytes, pinned).value;
}

const copyBytes = (b: Uint8Array, what: string) => {
  if (!(b instanceof Uint8Array) || !ArrayBuffer.isView(b))
    throw new TypeError(`${what} must be a Uint8Array`);
  return new Uint8Array(b);
};

/** `H(DS("abolish/v1/board-entry", encode(entry)))`, over the entry's full encoding. */
export function boardEntryHash(encodedEntry: Uint8Array): Uint8Array {
  return H(ds("abolish/v1/board-entry", copyBytes(encodedEntry, "encodedEntry")));
}

// Version 2 (docs/adr/0029-board-data-availability.md): version 1 had no
// content addresses and was never anchored, so it is gone, and its tag retired.
const checkpointV2 = struct([
  ["election_id", bytesFixed(32)],
  ["segment", u32],
  ["size", u64],
  ["head", bytesFixed(32)],
  ["root", bytesFixed(32)],
  ["object_cid", bytesFixed(36)],
  ["hashes_cid", bytesFixed(36)],
] as const);

/**
 * `link_i = H(DS("abolish/v1/board-chain", link_{i−1} ‖ entry_hash_i))`, from
 * 32 zero bytes: the hash chain over the board (T-23).
 */
export function chainLink(previous: Uint8Array, entryHash: Uint8Array): Uint8Array {
  const prev = copyBytes(previous, "previous");
  const e = copyBytes(entryHash, "entryHash");
  if (prev.length !== 32 || e.length !== 32)
    throw new RangeError("chain inputs are 32-byte hashes");
  const m = new Uint8Array(64);
  m.set(prev);
  m.set(e, 32);
  return H(ds("abolish/v1/board-chain", m));
}

/** A board checkpoint: the board's state after one segment (docs/spec/board.md). */
export type Checkpoint = CodecValue<typeof checkpointV2>;

/** `H(DS("abolish/v1/board-checkpoint-2", encode(checkpoint)))`, the value P4-1 anchors. */
export function checkpointHash(checkpoint: Checkpoint): Uint8Array {
  return H(ds("abolish/v1/board-checkpoint-2", encode(checkpointV2, checkpoint)));
}

/**
 * `encode(checkpoint)`: 180 bytes, `election_id ‖ u32(segment) ‖ u64(size) ‖
 * head ‖ root ‖ object_cid ‖ hashes_cid`.
 */
export function encodeCheckpoint(checkpoint: Checkpoint): Uint8Array {
  return encode(checkpointV2, checkpoint);
}

/** Strictly decodes `encode(checkpoint)`. Throws `DecodeError` on any other length. */
export function decodeCheckpoint(bytes: Uint8Array): Checkpoint {
  return decode(checkpointV2, copyBytes(bytes, "bytes"));
}

/**
 * A checkpoint's `object_cid` and `hashes_cid` (docs/spec/board.md, Segments
 * and checkpoints): the CIDs of the segment object and the entry-hash list of
 * the segment of entry `size − 1`, the last segment at or before the
 * checkpoint's that has entries, so a re-anchor with no new entries carries
 * the CIDs before it. `segments[i]` is entry `i`'s segment field. A board can
 * then be fetched by CID from L1 alone (T-24, T-49, T-51).
 */
function segmentCids(
  encodings: readonly Uint8Array[],
  entryHashes: readonly Uint8Array[],
  segments: readonly number[],
  size: number,
): { object_cid: Uint8Array; hashes_cid: Uint8Array } {
  const last = segments[size - 1];
  let start = size - 1;
  while (start > 0 && segments[start - 1] === last) start--;
  return {
    object_cid: objectCid(concat(encodings.slice(start, size))),
    hashes_cid: objectCid(concat(entryHashes.slice(start, size))),
  };
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// The entry layout of every version: the segment is the u32 after the record header
// (3), election_id (32) and index (8), and the payload's u32 length follows it.
const SEGMENT_AT = 3 + 32 + 8;
const PAYLOAD_AT = SEGMENT_AT + 4 + 4;

/**
 * Splits a segment object (docs/spec/board.md, Segment objects) into its
 * encoded entries by their framing alone: each is fixed-width fields, then a
 * length-prefixed payload, so an object splits in exactly one way. Nothing
 * is decoded or trusted here, and the result is meant only for
 * `verifyBoard`, which authenticates every byte against the anchored heads
 * and roots, then decodes. Throws `DecodeError` on an empty object, a length
 * over `MAX_BOARD_PAYLOAD` (before anything is read: T-52) or a truncated
 * last entry, so a fetched object is never partly used (T-24, T-49).
 */
export function splitSegmentObject(object: Uint8Array): Uint8Array[] {
  const bytes = copyBytes(object, "object");
  // An empty segment has no object, so no checkpoint names one.
  if (bytes.length === 0) throw new DecodeError("truncated", 0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const out: Uint8Array[] = [];
  for (let at = 0; at < bytes.length;) {
    if (bytes.length - at < PAYLOAD_AT) throw new DecodeError("truncated", at);
    const n = view.getUint32(at + PAYLOAD_AT - 4);
    if (n > MAX_BOARD_PAYLOAD) throw new DecodeError("length-over-max", at + PAYLOAD_AT - 4);
    if (bytes.length - at - PAYLOAD_AT < n) throw new DecodeError("truncated", at + PAYLOAD_AT);
    out.push(bytes.slice(at, at + PAYLOAD_AT + n));
    at += PAYLOAD_AT + n;
  }
  return out;
}

/**
 * The checkpoint a board copy gives after each segment in `segments`, from
 * its raw bytes, before anything in it is authenticated or decoded
 * (docs/spec/contracts.md, Board anchor, Verification). After segment `s`
 * the copy's prefix is its entries up to the first whose segment field is
 * over `s`. Nothing here is trusted: a verifier only compares the result's
 * hash with a word proven on L1, and a copy that gives a wrong checkpoint
 * simply matches nothing (T-53). A segment the copy holds no entry for is
 * left out.
 */
export function copyCheckpoints(
  electionId: Uint8Array,
  encodedEntries: readonly Uint8Array[],
  segments: readonly number[],
): Map<number, Checkpoint> {
  if (!Array.isArray(encodedEntries)) throw new TypeError("encodedEntries must be an array");
  if (!Array.isArray(segments)) throw new TypeError("segments must be an array");
  const id = copyBytes(electionId, "electionId");
  if (id.length !== 32) throw new RangeError("electionId must be 32 bytes");
  for (const s of segments)
    if (!Number.isInteger(s) || s < 0 || s > 0xffffffff)
      throw new RangeError("every segment must be a u32");
  // An entry too short to carry a segment field ends every prefix there.
  const fields: number[] = [];
  for (const e of encodedEntries) {
    const b = copyBytes(e, "entry");
    if (b.length < SEGMENT_AT + 4) break;
    fields.push(new DataView(b.buffer, b.byteOffset + SEGMENT_AT, 4).getUint32(0));
  }
  // The first entry past `s` never moves back as `s` grows, even in a copy
  // whose segments decrease, so one pass serves every segment.
  const sizes = new Map<number, number>();
  let i = 0;
  for (const s of [...segments].sort((a, b) => a - b)) {
    while (i < fields.length && (fields[i] as number) <= s) i++;
    sizes.set(s, i);
  }
  // A loop, not a spread: the segment count grows with the election's length.
  let extent = 0;
  for (const size of sizes.values()) extent = Math.max(extent, size);
  const encodings = encodedEntries.slice(0, extent).map((e) => copyBytes(e, "entry"));
  const hashes = encodings.map(boardEntryHash);
  const links: Uint8Array[] = [];
  for (const h of hashes) links.push(chainLink(links.at(-1) ?? new Uint8Array(32), h));
  const roots = merkleRoots(BOARD_TREE, hashes, new Set(sizes.values()));
  const cids = new Map<number, ReturnType<typeof segmentCids>>();
  const out = new Map<number, Checkpoint>();
  for (const [segment, size] of sizes) {
    if (size === 0) continue;
    // Once per size: the runs of distinct sizes are disjoint, so the copy is
    // hashed once however many words name the same extent (T-53).
    let c = cids.get(size);
    if (c === undefined) cids.set(size, (c = segmentCids(encodings, hashes, fields, size)));
    out.set(segment, {
      election_id: id.slice(),
      segment,
      size: BigInt(size),
      head: (links[size - 1] as Uint8Array).slice(),
      root: roots.get(size) as Uint8Array,
      object_cid: c.object_cid.slice(),
      hashes_cid: c.hashes_cid.slice(),
    });
  }
  return out;
}

/** The board-check failures of docs/spec/board.md, Board checks. */
export type BoardErrorCode =
  | "decode"
  | "wrong-election"
  | "wrong-index"
  | "segment-decreased"
  | "opening-order"
  | "checkpoint-equivocation"
  | "checkpoint-size"
  | "checkpoint-inconsistent"
  | "checkpoint-missing"
  | "checkpoint-boundary"
  | "checkpoint-cid"
  | "copy-mismatch"
  | "unanchored"
  | "unsealed";

/** Where a board check failed: an entry, a checkpoint, a segment no checkpoint anchors, or the board (unsealed). */
export type BoardErrorAt =
  | { readonly entry: number; readonly decodeError?: DecodeErrorCode }
  | { readonly checkpoint: number }
  | { readonly segment: number }
  | Record<string, never>;

/** A board that fails an election check (T-23). */
export class BoardError extends Error {
  override readonly name = "BoardError";
  constructor(
    readonly code: BoardErrorCode,
    readonly at: BoardErrorAt,
  ) {
    super(`${code} ${JSON.stringify(at)}`);
  }
}

/** A board whose entries passed every entry check. */
export interface CheckedBoard {
  readonly electionId: Uint8Array;
  readonly entries: readonly BoardEntry[];
  readonly entryHashes: readonly Uint8Array[];
  /** `encodings[i]` is entry `i`'s encoding, the bytes its segment object holds. */
  readonly encodings: readonly Uint8Array[];
  /** `links[i]` is the chain link after entry `i`. */
  readonly links: readonly Uint8Array[];
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Lexicographic byte order: the first differing byte decides; a prefix comes first. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  return a.length - b.length;
}

const isOpening = (entry: BoardEntry) =>
  recordTypeOf(entry.payload) === RECORD_TYPES.spoiledBallotOpening;

/**
 * Checks one election's board, entry by entry, in index order: strict
 * decoding under the pinned version, the election, positions, non-decreasing
 * segments and the order of spoiled-ballot openings (T-23, T-31, T-42).
 * Throws a `BoardError` at the first failure.
 */
export function checkBoard(
  electionId: Uint8Array,
  encodedEntries: readonly Uint8Array[],
  pinned: RecordVersion<typeof BOARD_ENTRY.versions> | typeof UNPINNED,
): CheckedBoard {
  const id = copyBytes(electionId, "electionId");
  if (id.length !== 32) throw new RangeError("electionId must be 32 bytes");
  if (!Array.isArray(encodedEntries)) throw new TypeError("encodedEntries must be an array");
  const entries: BoardEntry[] = [];
  const entryHashes: Uint8Array[] = [];
  const encodings: Uint8Array[] = [];
  const links: Uint8Array[] = [];
  // Read once, by index, so the entries checked are the entries hashed.
  const count = encodedEntries.length;
  for (let i = 0; i < count; i++) {
    const bytes = copyBytes(encodedEntries[i] as Uint8Array, `entry ${i}`);
    let entry: BoardEntry;
    try {
      entry = decodeBoardEntry(bytes, pinned);
    } catch (e) {
      if (e instanceof DecodeError)
        throw new BoardError("decode", { entry: i, decodeError: e.code });
      throw e;
    }
    if (!equalBytes(entry.election_id, id)) throw new BoardError("wrong-election", { entry: i });
    if (entry.index !== BigInt(i)) throw new BoardError("wrong-index", { entry: i });
    const prev = entries.at(-1);
    if (prev !== undefined) {
      if (entry.segment < prev.segment) throw new BoardError("segment-decreased", { entry: i });
      // T-42, T-47: within a segment, openings come last, in strictly
      // increasing byte order, so their position reflects only their content.
      if (
        entry.segment === prev.segment &&
        isOpening(prev) &&
        (!isOpening(entry) || compareBytes(prev.payload, entry.payload) >= 0)
      )
        throw new BoardError("opening-order", { entry: i });
    }
    const hash = boardEntryHash(bytes);
    entries.push(entry);
    entryHashes.push(hash);
    encodings.push(bytes);
    links.push(chainLink(links.at(-1) ?? new Uint8Array(32), hash));
  }
  return { electionId: id, entries, entryHashes, encodings, links };
}

/**
 * The anchoring clock (docs/spec/board.md, Anchoring; P4-1 fixes the values):
 * period `s` covers L1 time `[epoch + s·period, epoch + (s+1)·period)`, an
 * anchor for `s` counts only if its finalized L1 block time is in
 * `[end of s, end of s + deadline]`, and no segment after `lastSegment` (the
 * election's seal) counts at all.
 */
export interface AnchorClock {
  readonly epoch: bigint;
  readonly period: bigint;
  readonly deadline: bigint;
  readonly lastSegment: number;
}

/** A checkpoint as anchored on L1, with the time of the finalized block that holds it. */
export interface Anchor {
  readonly checkpoint: Checkpoint;
  readonly anchoredAt: bigint;
}

function checkClock(clock: AnchorClock): AnchorClock {
  const { epoch, period, deadline, lastSegment } = clock;
  if (typeof epoch !== "bigint" || epoch < 0n)
    throw new RangeError("clock.epoch must be a bigint ≥ 0");
  if (typeof period !== "bigint" || period < 1n)
    throw new RangeError("clock.period must be a bigint ≥ 1");
  if (typeof deadline !== "bigint" || deadline < 0n)
    throw new RangeError("clock.deadline must be a bigint ≥ 0");
  if (!Number.isInteger(lastSegment) || lastSegment < 0 || lastSegment > 0xffffffff)
    throw new RangeError("clock.lastSegment must be a u32");
  return { epoch, period, deadline, lastSegment };
}

/**
 * Whether an anchor for `segment` made at L1 time `anchoredAt` counts: after
 * its period ended, within the deadline, and not after the seal. A late anchor
 * can then neither fail a closed election nor hide a fork (T-24, T-53, T-69).
 */
export function isTimely(clock: AnchorClock, segment: number, anchoredAt: bigint): boolean {
  const c = checkClock(clock);
  if (!Number.isInteger(segment) || segment < 0 || segment > c.lastSegment) return false;
  if (typeof anchoredAt !== "bigint") return false;
  const end = segmentEnd(c, segment);
  return anchoredAt >= end && anchoredAt <= end + c.deadline;
}

const segmentEnd = (c: AnchorClock, segment: number) => c.epoch + (BigInt(segment) + 1n) * c.period;

/**
 * Board checks, steps 1 and 2 (docs/spec/board.md): the anchors that count at
 * `now`, each with its position in `anchors`, after the checks that need no
 * copy of the board. Throws `BoardError` on the first failure, which no copy
 * can cause or mask (T-24).
 */
function countedAnchors(
  id: Uint8Array,
  anchors: readonly Anchor[],
  c: AnchorClock,
  now: bigint,
): [number, Checkpoint][] {
  // Re-encoded and decoded, so every field is well formed and copied; the
  // index of each counted anchor is its position in `anchors`.
  const counted: [number, Checkpoint][] = [];
  for (let j = 0; j < anchors.length; j++) {
    const a = anchors[j] as Anchor;
    const cp = decode(checkpointV2, encode(checkpointV2, a.checkpoint));
    if (isTimely(c, cp.segment, a.anchoredAt) && a.anchoredAt <= now) counted.push([j, cp]);
  }
  const bySegment = new Map<number, Uint8Array>();
  for (const [j, cp] of counted) {
    if (!equalBytes(cp.election_id, id)) throw new BoardError("wrong-election", { checkpoint: j });
    const encoded = encode(checkpointV2, cp);
    const first = bySegment.get(cp.segment);
    if (first === undefined) bySegment.set(cp.segment, encoded);
    else if (!equalBytes(first, encoded))
      throw new BoardError("checkpoint-equivocation", { checkpoint: j });
  }
  // From L1 alone, before any copy is read, so no mirror can mask it: a
  // board only grows, so a later segment's checkpoint is never smaller than
  // an earlier one's, and two of equal size are equal but for the segment,
  // their CIDs included, since both name the segment of entry `size − 1`
  // (T-24).
  for (const [j, cp] of counted) {
    if (cp.size === 0n) throw new BoardError("checkpoint-size", { checkpoint: j });
    for (const [, other] of counted)
      if (
        other.segment < cp.segment &&
        (other.size > cp.size ||
          (other.size === cp.size &&
            !(
              equalBytes(other.head, cp.head) &&
              equalBytes(other.root, cp.root) &&
              equalBytes(other.object_cid, cp.object_cid) &&
              equalBytes(other.hashes_cid, cp.hashes_cid)
            )))
      )
        throw new BoardError("checkpoint-inconsistent", { checkpoint: j });
  }
  return counted;
}

/**
 * The checkpoints counted for an election at the finalized L1 time `now`,
 * after every board check that needs no copy of the board: steps 1 and 2,
 * then `unsealed` once the seal's window has closed (docs/spec/board.md,
 * Board checks). For a judge of receipts, which holds no copy
 * (docs/spec/receipts.md, Verdicts, `board-failed`): a failure here is
 * attributed from L1 alone. Throws `BoardError`.
 */
export function anchoredCheckpoints(
  electionId: Uint8Array,
  anchors: readonly Anchor[],
  clock: AnchorClock,
  now: bigint,
): Checkpoint[] {
  if (!Array.isArray(anchors)) throw new TypeError("anchors must be an array");
  if (typeof now !== "bigint") throw new TypeError("now must be a bigint");
  const c = checkClock(clock);
  const id = copyBytes(electionId, "electionId");
  if (id.length !== 32) throw new RangeError("electionId must be 32 bytes");
  const counted = countedAnchors(id, anchors, c, now).map(([, cp]) => cp);
  if (
    segmentEnd(c, c.lastSegment) + c.deadline < now &&
    !counted.some((cp) => cp.segment === c.lastSegment)
  )
    throw new BoardError("unsealed", {});
  return counted;
}

/** A verified board: its authenticated prefix, and how many entries past it were ignored. */
export interface VerifiedBoard {
  readonly board: CheckedBoard;
  /** Entries after the authenticated prefix: no anchor covers them, so they are no one's claim. */
  readonly unauthenticated: number;
}

/**
 * Verifies one election's board against every anchor for the election, as
 * read from the pinned anchor contract on L1 up to the finalized L1 time
 * `now`: all of them, never a selection, or a fork shown only to some voters
 * would pass (T-24). Untimely anchors are ignored. Entries carry no signature,
 * so only an anchored checkpoint authenticates them: the board checked is the
 * prefix up to the largest anchored size, and anything past it is ignored, so
 * no one can fail an election by appending entries to a copy of its board
 * (T-53). Order (docs/spec/board.md, Board checks): election and equivocation
 * over the anchors; their sizes and their consistency with each other, from
 * L1 alone; whether the copy is long enough; the copy's raw bytes against
 * every anchored head and root, where an anchor no board can match fails the
 * election and only an unmatched copy is the copy's fault; the entry checks
 * over the prefix; each checkpoint's boundary; every segment whose window has
 * closed has a checkpoint; once the seal's window has closed, the seal has
 * one.
 */
export function verifyBoard(
  electionId: Uint8Array,
  encodedEntries: readonly Uint8Array[],
  pinned: RecordVersion<typeof BOARD_ENTRY.versions> | typeof UNPINNED,
  anchors: readonly Anchor[],
  clock: AnchorClock,
  now: bigint,
): VerifiedBoard {
  if (!Array.isArray(anchors)) throw new TypeError("anchors must be an array");
  if (!Array.isArray(encodedEntries)) throw new TypeError("encodedEntries must be an array");
  if (typeof now !== "bigint") throw new TypeError("now must be a bigint");
  const c = checkClock(clock);
  const id = copyBytes(electionId, "electionId");
  if (id.length !== 32) throw new RangeError("electionId must be 32 bytes");
  const counted = countedAnchors(id, anchors, c, now);
  const bySegment = new Set(counted.map(([, cp]) => cp.segment));
  // Authenticate the raw bytes before decoding anything. Entries are
  // unsigned, so a copy that doesn't match the anchored heads and roots is
  // that copy's fault, never the election's: the caller tries another source
  // (T-53, T-23). Anchors the copy is long enough for are compared first, so
  // a checkpoint larger than any copy can't hide one no board matches.
  const held = encodedEntries.length;
  const reach = counted.filter(([, cp]) => cp.size <= BigInt(held));
  // A loop, not a spread: the anchor count is the anchoring authority's to choose.
  const extent = counted.reduce((m, [, cp]) => Math.max(m, Number(cp.size)), 0);
  const prefix = Array.from({ length: Math.min(extent, held) }, (_, i) =>
    copyBytes(encodedEntries[i] as Uint8Array, `entry ${i}`),
  );
  const hashes = prefix.map(boardEntryHash);
  const links: Uint8Array[] = [];
  for (const e of hashes) links.push(chainLink(links.at(-1) ?? new Uint8Array(32), e));
  const roots = merkleRoots(BOARD_TREE, hashes, new Set(reach.map(([, cp]) => Number(cp.size))));
  const checked = reach.map(([j, cp]) => {
    const size = Number(cp.size);
    const head = equalBytes(links[size - 1] as Uint8Array, cp.head);
    const root = equalBytes(roots.get(size) as Uint8Array, cp.root);
    return { j, size, head, root, full: head && root };
  });
  // Head and root are both functions of the same entries, so under collision
  // resistance a checkpoint is the anchoring authority's fault, never the
  // copy's, when the copy matches its head but not its root (or the reverse),
  // or when the copy fully matches another counted checkpoint at least as
  // large: that checkpoint admits only this prefix. No mirror can bring
  // either about, so a mirror still can't fail an election (T-24, T-53).
  for (const m of checked) {
    const split = m.head !== m.root;
    const contradicted = !m.full && checked.some((o) => o.full && o.size >= m.size);
    if (split || contradicted) throw new BoardError("checkpoint-inconsistent", { checkpoint: m.j });
  }
  for (const [j, cp] of counted)
    if (cp.size > BigInt(held)) throw new BoardError("checkpoint-missing", { checkpoint: j });
  for (const m of checked) if (!m.full) throw new BoardError("copy-mismatch", { checkpoint: m.j });
  // The prefix is now the anchored board, so any failure below is the
  // operator's.
  const board = checkBoard(id, prefix, pinned);
  const { entries } = board;
  const segments = entries.map((e) => e.segment);
  const cidsBySize = new Map<number, ReturnType<typeof segmentCids>>();
  for (const [j, cp] of counted) {
    const size = Number(cp.size);
    const last = entries[size - 1] as BoardEntry;
    const next = entries[size];
    if (last.segment > cp.segment || (next !== undefined && next.segment <= cp.segment))
      throw new BoardError("checkpoint-boundary", { checkpoint: j });
    // The prefix is the anchored board, so CIDs that don't name its bytes
    // are the anchoring authority's, never a mirror's: a fetch by CID from
    // L1 would find another object, or none (T-24, T-49).
    // Once per size, so re-anchors don't hash a segment again (T-53).
    let cids = cidsBySize.get(size);
    if (cids === undefined)
      cidsBySize.set(
        size,
        (cids = segmentCids(board.encodings, board.entryHashes, segments, size)),
      );
    if (!equalBytes(cids.object_cid, cp.object_cid) || !equalBytes(cids.hashes_cid, cp.hashes_cid))
      throw new BoardError("checkpoint-cid", { checkpoint: j });
  }
  // A segment counts as unanchored only once its window has closed by
  // finalized L1 time, so a running election isn't failed early.
  for (const e of entries)
    if (!bySegment.has(e.segment) && segmentEnd(c, e.segment) + c.deadline < now)
      throw new BoardError("unanchored", { segment: e.segment });
  // The seal's checkpoint authenticates the board's final extent.
  if (segmentEnd(c, c.lastSegment) + c.deadline < now && !bySegment.has(c.lastSegment))
    throw new BoardError("unsealed", {});
  return { board, unauthenticated: held - extent };
}

/** The checkpoint after segment `segment` of a checked board, or undefined if the board is empty there. */
export function checkpointOf(board: CheckedBoard, segment: number): Checkpoint | undefined {
  if (!Number.isInteger(segment) || segment < 0 || segment > 0xffffffff)
    throw new RangeError("segment must be a u32");
  const size = board.entries.filter((e) => e.segment <= segment).length;
  if (size === 0) return undefined;
  const root = merkleRoots(BOARD_TREE, board.entryHashes.slice(0, size), new Set([size])).get(size);
  return {
    election_id: board.electionId.slice(),
    segment,
    size: BigInt(size),
    head: (board.links[size - 1] as Uint8Array).slice(),
    root: root as Uint8Array,
    ...segmentCids(
      board.encodings,
      board.entryHashes,
      board.entries.map((e) => e.segment),
      size,
    ),
  };
}
