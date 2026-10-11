// Appending to and reading an election's board (docs/spec/board.md). The
// entry hash and chain link are computed by @abolishus/crypto, never here, so
// the board the server writes is the board the verifier recomputes (T-23,
// T-36). The table's triggers check order and chaining again on insert.

import {
  BOARD_TREE,
  type BoardEntry,
  boardEntryHash,
  chainLink,
  consistencyProof,
  encodeBoardEntry,
  inclusionProof,
  merkleRoot,
} from "@abolishus/crypto";
import { and, asc, desc, eq, gte, lt, sql as q } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { isBytes } from "./bytes.ts";
import { boardEntries } from "./db/schema/index.ts";

const SPOILED_BALLOT_OPENING = 0x0003;
const MAX_SEGMENT = 2 ** 32 - 1;
/**
 * The class half of the two-key advisory lock on a board. The two-key form is
 * a separate keyspace from the one-bigint locks migrations take, so a board
 * lock never collides with them.
 */
const BOARD_LOCK_CLASS = 0x0b0a4d;

export type AppendErrorCode =
  /** The entry doesn't encode: a payload type not allowed on the board, a bad length or election ID. */
  | "invalid-entry"
  /** The segment is below the previous entry's. */
  | "segment-decreased"
  /** Within a segment, openings come last, in strictly increasing byte order (T-42, T-47). */
  | "opening-order";

export class AppendError extends Error {
  override readonly name = "AppendError";
  constructor(
    readonly code: AppendErrorCode,
    options?: { cause?: unknown },
  ) {
    super(`board append refused: ${code}`, options);
  }
}

export interface AppendedEntry {
  readonly index: bigint;
  readonly entryHash: Uint8Array;
  readonly link: Uint8Array;
}

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
 * concurrent callers get consecutive indexes. The caller decides whether the
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
  return drizzle({ client }).transaction(
    async (tx) => {
      // The lock's second key is the election ID's first 4 bytes, from a hash
      // output, so two elections rarely share one; sharing only serialises
      // their appends.
      await tx.execute(
        q`SELECT pg_advisory_xact_lock(${BOARD_LOCK_CLASS}::int, ('x' || encode(substring(${id}::bytea FROM 1 FOR 4), 'hex'))::bit(32)::int)`,
      );
      const [prev] = await tx
        .select()
        .from(boardEntries)
        .where(eq(boardEntries.electionId, id))
        .orderBy(desc(boardEntries.idx))
        .limit(1);
      if (prev !== undefined) {
        const prevSegment = Number(prev.segment);
        if (segment < prevSegment) throw new AppendError("segment-decreased");
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
        encoded = encodeBoardEntry(entry);
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
      return { index, entryHash, link };
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
  return rows.map((r) =>
    encodeBoardEntry({
      election_id: id,
      index: r.idx,
      segment: Number(r.segment),
      payload: new Uint8Array(r.payload),
    }),
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
  constructor(readonly code: BoardReadErrorCode) {
    super(`board read refused: ${code}`);
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

/** The number of entries on the board. */
async function boardSize(client: Sql, id: Uint8Array): Promise<bigint> {
  const [row] = await drizzle({ client })
    .select({ n: q<string>`count(*)` })
    .from(boardEntries)
    .where(eq(boardEntries.electionId, id));
  return BigInt(row?.n ?? 0);
}

/**
 * The stored entry hashes of the first `size` entries, which the caller has
 * checked the board holds. Rows are never changed or removed, so this prefix
 * is the one that was counted.
 */
async function entryHashes(client: Sql, id: Uint8Array, size: bigint): Promise<Uint8Array[]> {
  const rows = await drizzle({ client })
    .select({ entryHash: boardEntries.entryHash })
    .from(boardEntries)
    .where(and(eq(boardEntries.electionId, id), lt(boardEntries.idx, size)))
    .orderBy(asc(boardEntries.idx));
  return rows.map((r) => new Uint8Array(r.entryHash));
}

/**
 * The board's size, chain head and tree root. The root is computed over the
 * stored entry hashes with @abolishus/crypto's tree, so it is the root a
 * checkpoint of this board carries. Nothing here is trusted by a reader: a
 * client checks the head against its own receipt and later checkpoints with a
 * consistency proof (docs/spec/board.md; T-24).
 */
export async function readHead(client: Sql, electionId: Uint8Array): Promise<BoardHead> {
  const id = checkId(electionId);
  const rows = await drizzle({ client })
    .select({ entryHash: boardEntries.entryHash, link: boardEntries.link })
    .from(boardEntries)
    .where(eq(boardEntries.electionId, id))
    .orderBy(asc(boardEntries.idx));
  const last = rows.at(-1);
  if (last === undefined) return { size: 0n, head: undefined, root: undefined };
  return {
    size: BigInt(rows.length),
    head: new Uint8Array(last.link),
    root: merkleRoot(
      BOARD_TREE,
      rows.map((r) => new Uint8Array(r.entryHash)),
    ),
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
  return rows.map((r) =>
    encodeBoardEntry({
      election_id: id,
      index: r.idx,
      segment: Number(r.segment),
      payload: new Uint8Array(r.payload),
    }),
  );
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
  const hashes = await entryHashes(client, id, treeSize);
  return inclusionProof(BOARD_TREE, hashes, Number(index));
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
  const hashes = await entryHashes(client, id, secondSize);
  return consistencyProof(BOARD_TREE, hashes, Number(firstSize));
}
