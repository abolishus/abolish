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

const PAYLOAD_TYPES_BY_VERSION = {
  1: BOARD_PAYLOAD_TYPES,
  3: BOARD_PAYLOAD_TYPES_V3,
  4: BOARD_PAYLOAD_TYPES_V4,
} as const;

/**
 * The record types a board-entry version allows (docs/spec/board.md,
 * Allowed payloads), so a rule about what a version carries asks it rather
 * than naming versions.
 */
export function boardPayloadTypes(version: BoardEntryVersion): readonly number[] {
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

/** Board entry, version 1, 3 or 4 (docs/spec/board.md). */
export type BoardEntry = CodecValue<typeof entryV1>;

/** Record type `0x0007`: the envelope that places a record on the board. */
export const BOARD_ENTRY = recordType(RECORD_TYPES.boardEntry, {
  1: entryV1,
  3: entryV3,
  4: entryV4,
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

const checkpointV1 = struct([
  ["election_id", bytesFixed(32)],
  ["segment", u32],
  ["size", u64],
  ["head", bytesFixed(32)],
  ["root", bytesFixed(32)],
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
export type Checkpoint = CodecValue<typeof checkpointV1>;

/** `H(DS("abolish/v1/board-checkpoint", encode(checkpoint)))`, the value P4-1 anchors. */
export function checkpointHash(checkpoint: Checkpoint): Uint8Array {
  return H(ds("abolish/v1/board-checkpoint", encode(checkpointV1, checkpoint)));
}

/** `encode(checkpoint)`: 108 bytes, `election_id ‖ u32(segment) ‖ u64(size) ‖ head ‖ root`. */
export function encodeCheckpoint(checkpoint: Checkpoint): Uint8Array {
  return encode(checkpointV1, checkpoint);
}

/** Strictly decodes `encode(checkpoint)`. Throws `DecodeError` on any other length. */
export function decodeCheckpoint(bytes: Uint8Array): Checkpoint {
  return decode(checkpointV1, copyBytes(bytes, "bytes"));
}

// The entry layout of every version: the segment is the u32 after the record header
// (3), election_id (32) and index (8).
const SEGMENT_AT = 3 + 32 + 8;

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
  const hashes = encodedEntries.slice(0, extent).map(boardEntryHash);
  const links: Uint8Array[] = [];
  for (const h of hashes) links.push(chainLink(links.at(-1) ?? new Uint8Array(32), h));
  const roots = merkleRoots(BOARD_TREE, hashes, new Set(sizes.values()));
  const out = new Map<number, Checkpoint>();
  for (const [segment, size] of sizes)
    if (size > 0)
      out.set(segment, {
        election_id: id.slice(),
        segment,
        size: BigInt(size),
        head: (links[size - 1] as Uint8Array).slice(),
        root: roots.get(size) as Uint8Array,
      });
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
    links.push(chainLink(links.at(-1) ?? new Uint8Array(32), hash));
  }
  return { electionId: id, entries, entryHashes, links };
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
  // Re-encoded and decoded, so every field is well formed and copied; the
  // index of each counted anchor is its position in `anchors`.
  const counted: [number, Checkpoint][] = [];
  for (let j = 0; j < anchors.length; j++) {
    const a = anchors[j] as Anchor;
    const cp = decode(checkpointV1, encode(checkpointV1, a.checkpoint));
    if (isTimely(c, cp.segment, a.anchoredAt) && a.anchoredAt <= now) counted.push([j, cp]);
  }
  const bySegment = new Map<number, Uint8Array>();
  for (const [j, cp] of counted) {
    if (!equalBytes(cp.election_id, id)) throw new BoardError("wrong-election", { checkpoint: j });
    const encoded = encode(checkpointV1, cp);
    const first = bySegment.get(cp.segment);
    if (first === undefined) bySegment.set(cp.segment, encoded);
    else if (!equalBytes(first, encoded))
      throw new BoardError("checkpoint-equivocation", { checkpoint: j });
  }
  // From L1 alone, before any copy is read, so no mirror can mask it: a
  // board only grows, so a later segment's checkpoint is never smaller than
  // an earlier one's, and two of equal size are equal (T-24).
  for (const [j, cp] of counted) {
    if (cp.size === 0n) throw new BoardError("checkpoint-size", { checkpoint: j });
    for (const [, other] of counted)
      if (
        other.segment < cp.segment &&
        (other.size > cp.size ||
          (other.size === cp.size &&
            !(equalBytes(other.head, cp.head) && equalBytes(other.root, cp.root))))
      )
        throw new BoardError("checkpoint-inconsistent", { checkpoint: j });
  }
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
  for (const [j, cp] of counted) {
    const size = Number(cp.size);
    const last = entries[size - 1] as BoardEntry;
    const next = entries[size];
    if (last.segment > cp.segment || (next !== undefined && next.segment <= cp.segment))
      throw new BoardError("checkpoint-boundary", { checkpoint: j });
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
  };
}
