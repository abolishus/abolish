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
export const BOARD_PAYLOAD_TYPES: ReadonlySet<number> = new Set([
  RECORD_TYPES.ballot,
  RECORD_TYPES.spoiledBallotOpening,
  RECORD_TYPES.ceremonyTranscript,
  RECORD_TYPES.tallyTranscript,
  RECORD_TYPES.contractEvent,
]);

const RECORD_HEADER_LENGTH = 3;

const recordTypeOf = (record: Uint8Array) => ((record[0] as number) << 8) | (record[1] as number);

/**
 * `bytes<MAX_BOARD_PAYLOAD>` holding one record of an allowed type. Only the
 * payload's header is read here; its version and fields are decoded when the
 * record is used.
 */
const payload: Codec<Uint8Array> = {
  minLength: 4,
  write(w, value) {
    if (!(value instanceof Uint8Array) || !ArrayBuffer.isView(value))
      throw new EncodeError("payload: expected a Uint8Array");
    const b = new Uint8Array(value);
    if (b.length > MAX_BOARD_PAYLOAD)
      throw new EncodeError(`payload: ${b.length} bytes is over ${MAX_BOARD_PAYLOAD}`);
    if (b.length < RECORD_HEADER_LENGTH)
      throw new EncodeError("payload: shorter than a record header");
    if (!BOARD_PAYLOAD_TYPES.has(recordTypeOf(b)))
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
    if (!BOARD_PAYLOAD_TYPES.has(recordTypeOf(content)))
      throw new DecodeError("unexpected-record-type", at + 4);
    return content;
  },
};

const entryV1 = struct([
  ["election_id", bytesFixed(32)],
  ["index", u64],
  ["segment", u32],
  ["payload", payload],
] as const);

/** Board entry, version 1 (docs/spec/board.md). */
export type BoardEntry = CodecValue<typeof entryV1>;

/** Record type `0x0007`: the envelope that places a record on the board. */
export const BOARD_ENTRY = recordType(RECORD_TYPES.boardEntry, { 1: entryV1 });

const SCHEMA = new RecordSchema([BOARD_ENTRY]);

/** Encodes a board entry under version 1, the only version. */
export function encodeBoardEntry(entry: BoardEntry): Uint8Array {
  return SCHEMA.encode(BOARD_ENTRY, 1, entry);
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

/** The board-check failures of docs/spec/board.md, Board checks. */
export type BoardErrorCode =
  | "decode"
  | "wrong-election"
  | "wrong-index"
  | "segment-decreased"
  | "opening-order"
  | "checkpoint-size"
  | "checkpoint-missing"
  | "checkpoint-boundary"
  | "checkpoint-head"
  | "checkpoint-root"
  | "unanchored";

/** Where a board check failed: an entry, a checkpoint, or a segment no checkpoint anchors. */
export type BoardErrorAt =
  | { readonly entry: number; readonly decodeError?: DecodeErrorCode }
  | { readonly checkpoint: number }
  | { readonly segment: number };

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
 * Checks the checkpoints anchored for the board's election against it, one
 * at a time and in order: each ends at its segment's boundary, with the chain
 * head and tree root of that prefix. Then every segment holding entries must
 * have one, so nothing stays unanchored past its period (docs/spec/verifier.md
 * 4.2; T-23, T-24). Each checkpoint's hash must already have been checked
 * against its L1 anchor.
 */
export function checkCheckpoints(board: CheckedBoard, checkpoints: readonly Checkpoint[]): void {
  if (!Array.isArray(checkpoints)) throw new TypeError("checkpoints must be an array");
  const { entries } = board;
  // Re-encoded and decoded, so every field is well formed and copied.
  const read = Array.from({ length: checkpoints.length }, (_, j) =>
    decode(checkpointV1, encode(checkpointV1, checkpoints[j] as Checkpoint)),
  );
  // Roots for every size in range, in one pass, so each checkpoint can then
  // be checked in full before the next.
  const sizes = new Set(
    read
      .filter((cp) => cp.size >= 1n && cp.size <= BigInt(entries.length))
      .map((cp) => Number(cp.size)),
  );
  const roots = merkleRoots(BOARD_TREE, board.entryHashes, sizes);
  const anchored = new Set<number>();
  read.forEach((cp, j) => {
    if (!equalBytes(cp.election_id, board.electionId))
      throw new BoardError("wrong-election", { checkpoint: j });
    if (cp.size === 0n) throw new BoardError("checkpoint-size", { checkpoint: j });
    if (cp.size > BigInt(entries.length))
      throw new BoardError("checkpoint-missing", { checkpoint: j });
    const size = Number(cp.size);
    const last = entries[size - 1] as BoardEntry;
    const next = entries[size];
    if (last.segment > cp.segment || (next !== undefined && next.segment <= cp.segment))
      throw new BoardError("checkpoint-boundary", { checkpoint: j });
    if (!equalBytes(board.links[size - 1] as Uint8Array, cp.head))
      throw new BoardError("checkpoint-head", { checkpoint: j });
    if (!equalBytes(roots.get(size) as Uint8Array, cp.root))
      throw new BoardError("checkpoint-root", { checkpoint: j });
    anchored.add(cp.segment);
  });
  for (const e of entries)
    if (!anchored.has(e.segment)) throw new BoardError("unanchored", { segment: e.segment });
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
