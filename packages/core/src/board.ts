// Appending to and reading an election's board (docs/spec/board.md). The
// entry hash and chain link are computed by @abolishus/crypto, never here, so
// the board the server writes is the board the verifier recomputes (T-23,
// T-36). The table's triggers check order and chaining again on insert.

import {
  appendSubtrees,
  BOARD_ENTRY,
  BOARD_TREE,
  type BoardEntry,
  boardEntryHash,
  type BoardEntryVersion,
  BN254_R,
  chainLink,
  consistencyProofSubtrees,
  DecodeError,
  encodeBoardEntry,
  foldSubtrees,
  inclusionProofSubtrees,
  pinnedVersion,
  RECORD_TYPES,
  rootSubtrees,
  type SubtreeId,
} from "@abolishus/crypto";
import { and, asc, desc, eq, gte, lt, or, sql as q } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { isBytes } from "./bytes.ts";
import { decodeStoredDefinition } from "./definitions.ts";
import {
  boardBallotKeys,
  boardCheckpoints,
  boardEntries,
  boardSubtrees,
  electionDefinitions,
} from "./db/schema/index.ts";

const SPOILED_BALLOT_OPENING = 0x0003;
const MAX_SEGMENT = 2 ** 32 - 1;
/**
 * The class half of the two-key advisory lock on a board. The two-key form is
 * a separate keyspace from the one-bigint locks migrations take, so a board
 * lock never collides with them.
 */
const BOARD_LOCK_CLASS = 0x0b0a4d; // 723533, as migrations/0009 takes it in its triggers

export type AppendErrorCode =
  /** No definition is stored for the election, so its board-entry version is unknown. */
  | "no-definition"
  /** The stored definition pins no board-entry version this release writes (T-36). */
  | "unsupported-version"
  /** The entry doesn't encode: a payload type not allowed on the board, a bad length or election ID. */
  | "invalid-entry"
  /** The segment is below the previous entry's. */
  | "segment-decreased"
  /**
   * The segment's checkpoint, or a later one's, is already taken: an entry
   * there would make it invalid for the board once anchored (T-24).
   */
  | "segment-checkpointed"
  /** Within a segment, openings come last, in strictly increasing byte order (T-42, T-47). */
  | "opening-order"
  /**
   * A ballot with the key of one already boarded, in other bytes: a repeat
   * (verifier 5.7), such as a copy with a re-randomised proof (T-38).
   */
  | "repeat";

export class AppendError extends Error {
  override readonly name = "AppendError";
  readonly code: AppendErrorCode;
  constructor(code: AppendErrorCode, options?: { cause?: unknown }) {
    super(`board append refused: ${code}`, options);
    this.code = code;
  }
}

/**
 * The stored hashes of the subtrees `ids`, in order. Subtrees are written
 * with their entries, in one transaction, so every subtree within a board's
 * size is there; a missing one means a board written around `appendEntry`,
 * which is refused rather than recomputed.
 */
async function subtreeHashes(
  db: Pick<ReturnType<typeof drizzle>, "select">,
  id: Uint8Array,
  ids: readonly SubtreeId[],
): Promise<Uint8Array[]> {
  if (ids.length === 0) return [];
  const key = (level: number, index: bigint | number) => `${level}/${index}`;
  const wanted = new Map(ids.map((s) => [key(s.level, s.index), s]));
  const rows = await db
    .select({ level: boardSubtrees.level, idx: boardSubtrees.idx, hash: boardSubtrees.hash })
    .from(boardSubtrees)
    .where(
      and(
        eq(boardSubtrees.electionId, id),
        or(
          ...[...wanted.values()].map((s) =>
            and(eq(boardSubtrees.level, s.level), eq(boardSubtrees.idx, BigInt(s.index))),
          ),
        ),
      ),
    );
  const found = new Map(rows.map((r) => [key(r.level, r.idx), new Uint8Array(r.hash)]));
  return ids.map((s) => {
    const hash = found.get(key(s.level, s.index));
    if (hash === undefined) throw new Error(`board subtree (${s.level}, ${s.index}) is missing`);
    return hash;
  });
}

/** Why an election's board has no version to encode its entries under. */
export type BoardVersionCode = Extract<AppendErrorCode, "no-definition" | "unsupported-version">;

const isBoardEntryVersion = (v: number | undefined): v is BoardEntryVersion =>
  v !== undefined && Object.hasOwn(BOARD_ENTRY.versions, v);

/**
 * The board-entry version `id`'s stored definition pins, which every entry of
 * its board is encoded, hashed and chained under: never a default, since an
 * entry hashed under another version matches nothing the verifier recomputes
 * and fails 2.3's `profile-mismatch` (docs/spec/board.md; T-23, T-34). A
 * definition is write-once, so the answer never changes for a board.
 */
export async function pinnedBoardVersion(
  db: Pick<ReturnType<typeof drizzle>, "select">,
  id: Uint8Array,
): Promise<BoardEntryVersion | BoardVersionCode> {
  const [row] = await db
    .select({ definition: electionDefinitions.definition })
    .from(electionDefinitions)
    .where(eq(electionDefinitions.electionId, id));
  if (row === undefined) return "no-definition";
  // storeDefinition decodes before storing, but the app role may insert
  // around it: bytes this release can't decode pin nothing it can write.
  let version;
  try {
    const { value } = decodeStoredDefinition(new Uint8Array(row.definition));
    version = pinnedVersion(value, RECORD_TYPES.boardEntry);
  } catch (e) {
    if (e instanceof DecodeError) return "unsupported-version";
    throw e;
  }
  return isBoardEntryVersion(version) ? version : "unsupported-version";
}

/**
 * Takes the transaction-scoped advisory lock that serialises writes to one
 * board: appends, and the checkpoints that fence them. Its second key is the
 * election ID's first 4 bytes, from a hash output, so two elections rarely
 * share one; sharing only serialises their writes.
 */
export async function lockBoard(
  tx: Pick<ReturnType<typeof drizzle>, "execute">,
  id: Uint8Array,
): Promise<void> {
  await tx.execute(
    q`SELECT pg_advisory_xact_lock(${BOARD_LOCK_CLASS}::int, ('x' || encode(substring(${id}::bytea FROM 1 FOR 4), 'hex'))::bit(32)::int)`,
  );
}

/** `pinnedBoardVersion`, for readers outside an append's transaction. */
export function boardVersion(
  client: Sql,
  id: Uint8Array,
): Promise<BoardEntryVersion | BoardVersionCode> {
  return pinnedBoardVersion(drizzle({ client }), id);
}

/**
 * The version a board with entries is read under. Only `appendEntry` writes
 * entries, under that version, so a board without one was written around it.
 */
async function storedBoardVersion(client: Sql, id: Uint8Array): Promise<BoardEntryVersion> {
  const version = await boardVersion(client, id);
  if (typeof version === "string") throw new Error(`a stored board has ${version}`);
  return version;
}

export interface AppendedEntry {
  /** The entry as encoded under the board's version: what a receipt is checked against. */
  readonly entry: Uint8Array;
  readonly index: bigint;
  readonly entryHash: Uint8Array;
  readonly link: Uint8Array;
}

/**
 * What makes two ballots one (docs/spec/revoting.md, Selection step 1): the
 * tier (a cell's tier under ballot versions 2 and 3), the nullifier `ν` and
 * the message `M`, as the verifier's admission returns them for the payload.
 * Never compared as bytes of the record: anyone can re-randomise a Groth16
 * proof without the witness, which keeps all three (T-38).
 */
export interface BallotKey {
  readonly tier: number;
  readonly nullifier: bigint;
  readonly message: Uint8Array;
}

/** `ν` as 32 big-endian bytes; a field<bn254> element, below `r`. */
function nullifierBytes(nullifier: bigint): Uint8Array {
  if (typeof nullifier !== "bigint" || nullifier < 0n || nullifier >= BN254_R)
    throw new AppendError("invalid-entry");
  return Uint8Array.from(Buffer.from(nullifier.toString(16).padStart(64, "0"), "hex"));
}

const equalBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const recordTypeOf = (payload: Uint8Array) =>
  payload.length < 2 ? -1 : ((payload[0] as number) << 8) | (payload[1] as number);

/** Lexicographic byte order, as docs/spec/board.md orders openings. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  return a.length - b.length;
}

/**
 * Appends `payload` to `electionId`'s board in `segment`, as the next entry,
 * and returns its index, entry hash and chain link. Appends to one board are
 * serialised by a transaction-scoped advisory lock on the election, so
 * concurrent callers get consecutive indexes. The entry is encoded under the
 * board-entry version the election's stored definition pins, so a board can
 * start only once its definition is stored. The caller decides whether the
 * payload may be boarded at all: it MUST decode strictly under the election's
 * profile (docs/spec/board.md, Allowed payloads); this checks only the
 * envelope's rules. `AppendError` covers those refusals; a database error
 * (a writer that bypassed this function, say) propagates as is, and nothing
 * is written.
 */
export async function appendEntry(
  client: Sql,
  electionId: Uint8Array,
  segment: number,
  payload: Uint8Array,
  options: {
    /**
     * Label the entry with the previous entry's segment when that is later
     * than `segment`, rather than refuse it: for a caller that labels by its
     * clock before slow work, so two appends racing across a period boundary
     * both land (the later-labelled one first), never `segment-decreased`.
     * Likewise, label it with the segment after the last checkpoint taken
     * when `segment` is at or below it, never `segment-checkpointed`.
     */
    readonly raiseToPrevious?: boolean;
    /**
     * The payload is a ballot the caller admitted, with this key: it is
     * stored with the entry, and a ballot whose key is already stored is
     * never boarded again. The same bytes return the entry that carries them,
     * so a client's retry gets its entry, as the board contract's no-op
     * repeat does (docs/spec/contracts.md, Board, Repeats); other bytes are refused as
     * `repeat`. The earlier copy is a board-path ballot boarded in the
     * window, so it stands under the close rule, and the refused copy would
     * be rejected by 5.7 (docs/spec/close.md; T-38, T-52, T-17).
     */
    readonly ballot?: BallotKey;
  } = {},
): Promise<AppendedEntry> {
  if (!Number.isInteger(segment) || segment < 0 || segment > MAX_SEGMENT)
    throw new AppendError("invalid-entry");
  // Inputs will come from transport decoding (P2-3): anything but real bytes
  // is refused, never coerced (a string would become zero bytes and land on
  // another election's board, for good).
  if (!isBytes(electionId) || electionId.length !== 32 || !isBytes(payload))
    throw new AppendError("invalid-entry");
  const id = new Uint8Array(electionId);
  const body = new Uint8Array(payload);
  let key: { tier: number; nullifier: Uint8Array; message: Uint8Array } | undefined;
  if (options.ballot !== undefined) {
    const { tier, nullifier, message } = options.ballot;
    if (
      recordTypeOf(body) !== RECORD_TYPES.ballot ||
      !Number.isInteger(tier) ||
      tier < 0 ||
      tier > 255 ||
      !isBytes(message) ||
      message.length !== 32
    )
      throw new AppendError("invalid-entry");
    key = { tier, nullifier: nullifierBytes(nullifier), message: new Uint8Array(message) };
  }
  return drizzle({ client }).transaction(
    async (tx) => {
      await lockBoard(tx, id);
      const version = await pinnedBoardVersion(tx, id);
      if (typeof version === "string") throw new AppendError(version);
      if (key !== undefined) {
        // Read under the lock, so two copies racing in can't both be boarded.
        const [seen] = await tx
          .select({
            idx: boardEntries.idx,
            segment: boardEntries.segment,
            payload: boardEntries.payload,
            entryHash: boardEntries.entryHash,
            link: boardEntries.link,
          })
          .from(boardBallotKeys)
          .innerJoin(
            boardEntries,
            and(
              eq(boardEntries.electionId, boardBallotKeys.electionId),
              eq(boardEntries.idx, boardBallotKeys.idx),
            ),
          )
          .where(
            and(
              eq(boardBallotKeys.electionId, id),
              eq(boardBallotKeys.tier, key.tier),
              eq(boardBallotKeys.nullifier, key.nullifier),
              eq(boardBallotKeys.message, key.message),
            ),
          );
        if (seen !== undefined) {
          if (!equalBytes(seen.payload, body)) throw new AppendError("repeat");
          const entry: BoardEntry = {
            election_id: id,
            index: seen.idx,
            segment: Number(seen.segment),
            payload: body,
          };
          return {
            entry: encodeBoardEntry(entry, version),
            index: seen.idx,
            entryHash: new Uint8Array(seen.entryHash),
            link: new Uint8Array(seen.link),
          };
        }
      }
      // Read under the lock, so no checkpoint is taken between this and the
      // insert.
      const [fence] = await tx
        .select({ segment: boardCheckpoints.segment })
        .from(boardCheckpoints)
        .where(eq(boardCheckpoints.electionId, id))
        .orderBy(desc(boardCheckpoints.segment))
        .limit(1);
      if (fence !== undefined && segment <= Number(fence.segment)) {
        if (options.raiseToPrevious !== true || Number(fence.segment) === MAX_SEGMENT)
          throw new AppendError("segment-checkpointed");
        segment = Number(fence.segment) + 1;
      }
      const [prev] = await tx
        .select()
        .from(boardEntries)
        .where(eq(boardEntries.electionId, id))
        .orderBy(desc(boardEntries.idx))
        .limit(1);
      if (prev !== undefined) {
        const prevSegment = Number(prev.segment);
        if (segment < prevSegment) {
          if (options.raiseToPrevious !== true) throw new AppendError("segment-decreased");
          segment = prevSegment;
        }
        if (
          segment === prevSegment &&
          recordTypeOf(prev.payload) === SPOILED_BALLOT_OPENING &&
          (recordTypeOf(body) !== SPOILED_BALLOT_OPENING || compareBytes(prev.payload, body) >= 0)
        )
          throw new AppendError("opening-order");
      }
      const index = prev === undefined ? 0n : prev.idx + 1n;
      const entry: BoardEntry = { election_id: id, index, segment, payload: body };
      let encoded: Uint8Array;
      try {
        // Refuses a payload type the version doesn't allow.
        encoded = encodeBoardEntry(entry, version);
      } catch (e) {
        throw new AppendError("invalid-entry", { cause: e });
      }
      const entryHash = boardEntryHash(encoded);
      const prevLink = prev?.link ?? new Uint8Array(32);
      const link = chainLink(prevLink, entryHash);
      await tx.insert(boardEntries).values({
        electionId: id,
        idx: index,
        segment: BigInt(segment),
        payload: body,
        entryHash,
        prevLink,
        link,
      });
      if (key !== undefined)
        await tx.insert(boardBallotKeys).values({ electionId: id, idx: index, ...key });
      // The subtrees this entry completes, from the ones covering the board
      // before it, in the same transaction: heads and proofs then never read
      // more than O(log n) of them (T-52).
      const size = Number(index);
      const frontier = size === 0 ? [] : await subtreeHashes(tx, id, rootSubtrees(size));
      await tx.insert(boardSubtrees).values(
        appendSubtrees(BOARD_TREE, frontier, size, entryHash).map((t) => ({
          electionId: id,
          level: t.level,
          idx: BigInt(t.index),
          hash: t.hash,
        })),
      );
      return { entry: encoded, index, entryHash, link };
    },
    // The previous entry must be read after the lock is taken. Under a
    // snapshot isolation level the snapshot would predate the lock, and
    // concurrent appends would collide (T-23).
    { isolationLevel: "read committed" },
  );
}

/**
 * The election's board as encoded entries, in index order: the input
 * `checkBoard` and the verifier take. Postgres isn't authoritative; a reader
 * recomputes hashes and links from these bytes rather than trusting the
 * stored columns.
 */
export async function readBoard(client: Sql, electionId: Uint8Array): Promise<Uint8Array[]> {
  if (!isBytes(electionId) || electionId.length !== 32)
    throw new TypeError("electionId must be 32 bytes");
  const id = new Uint8Array(electionId);
  const rows = await drizzle({ client })
    .select({
      idx: boardEntries.idx,
      segment: boardEntries.segment,
      payload: boardEntries.payload,
    })
    .from(boardEntries)
    .where(eq(boardEntries.electionId, id))
    .orderBy(asc(boardEntries.idx));
  if (rows.length === 0) return [];
  const version = await storedBoardVersion(client, id);
  return rows.map((r) =>
    encodeBoardEntry(
      {
        election_id: id,
        index: r.idx,
        segment: Number(r.segment),
        payload: new Uint8Array(r.payload),
      },
      version,
    ),
  );
}

/**
 * What an encoded board entry adds around its payload (record 0x0007 v1,
 * docs/spec/board.md): the record header (3), `election_id` (32), `index`
 * (8), `segment` (4) and the payload's length prefix (4). A test ties it to
 * `encodeBoardEntry`.
 */
export const BOARD_ENTRY_OVERHEAD = 51;

export type BoardReadErrorCode =
  /** A position or size beyond the board this server holds. */
  | "beyond-board"
  /** Positions that no board of any size makes valid: an index outside its tree, a tree of size 0. */
  | "invalid-range";

export class BoardReadError extends Error {
  override readonly name = "BoardReadError";
  readonly code: BoardReadErrorCode;
  constructor(code: BoardReadErrorCode) {
    super(`board read refused: ${code}`);
    this.code = code;
  }
}

export interface BoardHead {
  /** The number of entries. */
  readonly size: bigint;
  /** `link_{size−1}`; `undefined` while the board is empty. */
  readonly head: Uint8Array | undefined;
  /** `root_size`; `undefined` while the board is empty, since an empty tree is never hashed. */
  readonly root: Uint8Array | undefined;
}

function checkId(electionId: Uint8Array): Uint8Array {
  if (!isBytes(electionId) || electionId.length !== 32)
    throw new TypeError("electionId must be 32 bytes");
  return new Uint8Array(electionId);
}

const isU64 = (x: unknown): x is bigint => typeof x === "bigint" && x >= 0n && x < 1n << 64n;

/**
 * The board's last entry, read through the primary key's index: indexes are
 * contiguous from 0, so its position plus one is the board's size.
 */
async function lastEntry(
  client: Sql,
  id: Uint8Array,
): Promise<{ idx: bigint; link: Uint8Array } | undefined> {
  const [row] = await drizzle({ client })
    .select({ idx: boardEntries.idx, link: boardEntries.link })
    .from(boardEntries)
    .where(eq(boardEntries.electionId, id))
    .orderBy(desc(boardEntries.idx))
    .limit(1);
  return row;
}

/** The number of entries on the board. */
async function boardSize(client: Sql, id: Uint8Array): Promise<bigint> {
  const last = await lastEntry(client, id);
  return last === undefined ? 0n : last.idx + 1n;
}

/**
 * Hashes for each range of a proof plan, from the stored subtrees. The caller
 * has checked the board holds the tree; subtrees never change, so a later
 * append can't alter the answer.
 */
async function proofFrom(
  client: Sql,
  id: Uint8Array,
  plan: readonly (readonly SubtreeId[])[],
): Promise<Uint8Array[]> {
  if (plan.length === 0) return [];
  const hashes = await subtreeHashes(drizzle({ client }), id, plan.flat());
  let at = 0;
  return plan.map((range) => foldSubtrees(BOARD_TREE, hashes.slice(at, (at += range.length))));
}

/**
 * The board's size, chain head and tree root. The root is folded from the
 * stored subtrees with @abolishus/crypto's tree, so it is the root a
 * checkpoint of this board carries, from O(log n) rows (T-52). Nothing here
 * is trusted by a reader: a client checks the head against its own receipt
 * and later checkpoints with a consistency proof (docs/spec/board.md; T-24).
 */
export async function readHead(client: Sql, electionId: Uint8Array): Promise<BoardHead> {
  const id = checkId(electionId);
  const last = await lastEntry(client, id);
  if (last === undefined) return { size: 0n, head: undefined, root: undefined };
  const size = last.idx + 1n;
  const subtrees = await subtreeHashes(drizzle({ client }), id, rootSubtrees(Number(size)));
  return {
    size,
    head: new Uint8Array(last.link),
    root: foldSubtrees(BOARD_TREE, subtrees),
  };
}

/**
 * Up to `limit` encoded entries from position `start`, in order, and at most
 * `maxBytes` of them unless the page holds a single entry, so a page stays
 * bounded however large its entries are (T-48, T-52). An empty page means
 * `start` is the board's size; a `start` beyond it is `beyond-board`.
 */
export async function readEntries(
  client: Sql,
  electionId: Uint8Array,
  start: bigint,
  limit: number,
  maxBytes: number,
): Promise<Uint8Array[]> {
  const id = checkId(electionId);
  if (!isU64(start)) throw new RangeError("start must be a u64");
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("limit must be at least 1");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new RangeError("maxBytes must be >= 0");
  // Checked first, so no position beyond the board (or beyond Postgres's
  // bigint) reaches a query.
  if (start > (await boardSize(client, id))) throw new BoardReadError("beyond-board");
  const db = drizzle({ client });
  // Lengths first, so payloads beyond the byte budget are never read.
  const sizes = await db
    .select({ idx: boardEntries.idx, length: q<number>`octet_length(${boardEntries.payload})` })
    .from(boardEntries)
    .where(and(eq(boardEntries.electionId, id), gte(boardEntries.idx, start)))
    .orderBy(asc(boardEntries.idx))
    .limit(limit);
  let take = 0;
  let bytes = 0;
  for (const { length } of sizes) {
    bytes += Number(length) + BOARD_ENTRY_OVERHEAD;
    if (take > 0 && bytes > maxBytes) break;
    take++;
  }
  if (take === 0) return [];
  const rows = await db
    .select({ idx: boardEntries.idx, segment: boardEntries.segment, payload: boardEntries.payload })
    .from(boardEntries)
    .where(
      and(
        eq(boardEntries.electionId, id),
        gte(boardEntries.idx, start),
        lt(boardEntries.idx, start + BigInt(take)),
      ),
    )
    .orderBy(asc(boardEntries.idx));
  const version = await storedBoardVersion(client, id);
  return rows.map((r) =>
    encodeBoardEntry(
      {
        election_id: id,
        index: r.idx,
        segment: Number(r.segment),
        payload: new Uint8Array(r.payload),
      },
      version,
    ),
  );
}

/**
 * The entry at `index` and the chain link after it, as `appendEntry`
 * returned them, if that entry carries exactly `payload`; otherwise
 * `undefined`. For a caller told by another process that `payload` was
 * boarded at `index` (the worker's admission queue): what it answers is then
 * read from the board itself, never taken on that process's word.
 */
export async function readBoardedEntry(
  client: Sql,
  electionId: Uint8Array,
  index: bigint,
  payload: Uint8Array,
): Promise<AppendedEntry | undefined> {
  const id = checkId(electionId);
  if (!isU64(index)) throw new RangeError("index must be a u64");
  if (!isBytes(payload)) throw new TypeError("payload must be bytes");
  const [row] = await drizzle({ client })
    .select({
      segment: boardEntries.segment,
      payload: boardEntries.payload,
      entryHash: boardEntries.entryHash,
      link: boardEntries.link,
    })
    .from(boardEntries)
    .where(and(eq(boardEntries.electionId, id), eq(boardEntries.idx, index)));
  if (row === undefined || !equalBytes(new Uint8Array(row.payload), payload)) return undefined;
  const entry = encodeBoardEntry(
    { election_id: id, index, segment: Number(row.segment), payload: new Uint8Array(payload) },
    await storedBoardVersion(client, id),
  );
  return { entry, index, entryHash: new Uint8Array(row.entryHash), link: new Uint8Array(row.link) };
}

/**
 * The RFC 9162 audit path for entry `index` in the tree of the first
 * `treeSize` entries (docs/spec/board.md, Inclusion proofs).
 */
export async function readInclusionProof(
  client: Sql,
  electionId: Uint8Array,
  index: bigint,
  treeSize: bigint,
): Promise<Uint8Array[]> {
  const id = checkId(electionId);
  if (!isU64(index) || !isU64(treeSize)) throw new RangeError("index and treeSize must be u64s");
  if (treeSize === 0n || index >= treeSize) throw new BoardReadError("invalid-range");
  if (treeSize > (await boardSize(client, id))) throw new BoardReadError("beyond-board");
  return proofFrom(client, id, inclusionProofSubtrees(Number(index), Number(treeSize)));
}

/**
 * The RFC 9162 consistency proof that the tree of the first `firstSize`
 * entries is a prefix of the tree of the first `secondSize`
 * (docs/spec/board.md, Consistency proofs); empty when the sizes are equal.
 */
export async function readConsistencyProof(
  client: Sql,
  electionId: Uint8Array,
  firstSize: bigint,
  secondSize: bigint,
): Promise<Uint8Array[]> {
  const id = checkId(electionId);
  if (!isU64(firstSize) || !isU64(secondSize)) throw new RangeError("sizes must be u64s");
  // The spec's verifier fails on m = 0, so no server answers it.
  if (firstSize === 0n || firstSize > secondSize) throw new BoardReadError("invalid-range");
  if (secondSize > (await boardSize(client, id))) throw new BoardReadError("beyond-board");
  return proofFrom(client, id, consistencyProofSubtrees(Number(firstSize), Number(secondSize)));
}
