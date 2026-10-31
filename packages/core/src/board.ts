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
  boardBallotHashes,
  boardBallotKeys,
  boardCheckpoints,
  boardDestructionStatements,
  boardEntries,
  boardShareReceipts,
  boardSubtrees,
  boardTallyOpenings,
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
  | "repeat"
  /**
   * The payload is to be the board's first entry, and the board already
   * starts with another (admission reads only entry 0 for the transcript).
   */
  | "not-first"
  /**
   * A share receipt for a seat of a ballot hash whose receipt the board path
   * already carries in other bytes (docs/spec/delivery.md, Boarding, rule
   * 5): `existing` is that entry.
   */
  | "receipt-present"
  /**
   * A tally opening for a cell and seat whose opening the board already
   * carries in other bytes (docs/spec/tally.md, Opening record, Boarding):
   * `existing` is that entry.
   */
  | "opening-present"
  /**
   * A destruction statement for a seat whose statement the board already
   * carries in other bytes (docs/spec/tally.md, Destruction, Boarding):
   * `existing` is that entry.
   */
  | "destruction-present"
  /** The entry would land in a segment after the latest the caller allows. */
  | "segment-late";

export class AppendError extends Error {
  override readonly name = "AppendError";
  readonly code: AppendErrorCode;
  /**
   * Under `receipt-present`, `opening-present` or `destruction-present`: the
   * entry that carries the earlier receipt, opening or statement, with its
   * payload.
   */
  readonly existing?: AppendedEntry & { readonly payload: Uint8Array };
  constructor(
    code: AppendErrorCode,
    options?: { cause?: unknown; existing?: AppendedEntry & { readonly payload: Uint8Array } },
  ) {
    super(`board append refused: ${code}`, options);
    this.code = code;
    if (options?.existing !== undefined) this.existing = options.existing;
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
  /**
   * The ballot hash admission recomputed from the payload: not part of the
   * key (a ballot cast again after a reorganisation has another `M` and the
   * same hash), but stored with it, so a share receipt finds its ballot
   * (docs/spec/delivery.md, Boarding, rule 2).
   */
  readonly ballotHash: Uint8Array;
}

/**
 * What a share receipt receipts (docs/spec/delivery.md, Boarding, rule 5):
 * the ballot hash, the seat's panel (1, the default; 2, an author panel)
 * and the seat, as the verifier's check read them from the record.
 */
export interface ReceiptKey {
  readonly ballotHash: Uint8Array;
  readonly panel: number;
  readonly seat: number;
}

/**
 * What a tally opening opens (docs/spec/tally.md, Opening record, Boarding):
 * the cell, by its position in the registered partition, and the registered
 * seat whose signature attributes the opening, as the Boarding judge read
 * them from the record.
 */
export interface OpeningKey {
  readonly cell: number;
  readonly seat: number;
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

/** A stored entry as `appendEntry` returns it, with its payload. */
function boardedAt(
  id: Uint8Array,
  version: BoardEntryVersion,
  row: {
    readonly idx: bigint;
    readonly segment: bigint;
    readonly payload: Uint8Array;
    readonly entryHash: Uint8Array;
    readonly link: Uint8Array;
  },
): AppendedEntry & { readonly payload: Uint8Array } {
  const payload = new Uint8Array(row.payload);
  return {
    entry: encodeBoardEntry(
      { election_id: id, index: row.idx, segment: Number(row.segment), payload },
      version,
    ),
    index: row.idx,
    entryHash: new Uint8Array(row.entryHash),
    link: new Uint8Array(row.link),
    payload,
  };
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
    /**
     * The payload must be the board's first entry: the ceremony transcript,
     * which admission reads only at entry 0 (src/admission.ts). On a board
     * whose entry 0 carries the same bytes, that entry is returned, so a
     * rerun after a crash appends nothing; on one that starts with anything
     * else it is refused as `not-first`, never appended after it.
     */
    readonly first?: boolean;
    /**
     * The payload is a share receipt the caller checked against a ballot
     * the board carries under this key's ballot hash (docs/spec/delivery.md,
     * Boarding, rules 2 and 4): the key is stored with the entry, and the
     * board path carries one receipt per ballot hash, panel and seat (rule
     * 5; T-17, T-52). The same bytes return the entry that carries them, so
     * a retry gets its entry; other bytes are refused as `receipt-present`,
     * naming the entry that does (Client rules 3). Only for a receipt the
     * caller judged: the key is what makes the board path refuse every
     * later receipt for that seat, and the table can't tell a passing
     * receipt from a failing one.
     */
    readonly receipt?: ReceiptKey;
    /**
     * The payload is a tally opening the caller's Boarding judge passed
     * under this key (docs/spec/tally.md, Opening record, Boarding): the key
     * is stored with the entry, and the board carries one opening per cell
     * and seat (T-17, T-52). The same bytes return the entry that carries
     * them, so a seat's resend gets its entry; other bytes are refused as
     * `opening-present`, naming the entry that does, which the caller
     * judges as a repeat or a second. Only for an opening the caller judged:
     * the table can't tell a passing opening from a failing one.
     */
    readonly opening?: OpeningKey;
    /**
     * The payload is a destruction statement the caller's Boarding judge
     * passed, attributed to this seat (docs/spec/tally.md, Destruction,
     * Boarding): the seat is stored with the entry, and the board carries
     * one statement per seat (T-17, T-52). The same bytes return the entry
     * that carries them; other bytes are refused as `destruction-present`,
     * naming the entry that does, which the caller judges as a repeat. Only
     * for a statement the caller judged: the table can't tell an attributed
     * statement from one that isn't. A destruction statement is boarded only
     * with this key.
     */
    readonly destruction?: { readonly seat: number };
    /** The latest segment the entry may land in, else `segment-late` (rule 3's `s_D`). */
    readonly lastSegment?: number;
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
  let ballotHash: Uint8Array | undefined;
  if (options.ballot !== undefined) {
    const { tier, nullifier, message } = options.ballot;
    if (
      recordTypeOf(body) !== RECORD_TYPES.ballot ||
      !Number.isInteger(tier) ||
      tier < 0 ||
      tier > 255 ||
      !isBytes(message) ||
      message.length !== 32 ||
      !isBytes(options.ballot.ballotHash) ||
      options.ballot.ballotHash.length !== 32
    )
      throw new AppendError("invalid-entry");
    key = { tier, nullifier: nullifierBytes(nullifier), message: new Uint8Array(message) };
    ballotHash = new Uint8Array(options.ballot.ballotHash);
  }
  let receipt: { ballotHash: Uint8Array; panel: number; seat: number } | undefined;
  if (options.receipt !== undefined) {
    const { ballotHash: hash, panel, seat } = options.receipt;
    if (
      recordTypeOf(body) !== RECORD_TYPES.shareReceipt ||
      !isBytes(hash) ||
      hash.length !== 32 ||
      (panel !== 1 && panel !== 2) ||
      !Number.isInteger(seat) ||
      seat < 1 ||
      seat > 255
    )
      throw new AppendError("invalid-entry");
    receipt = { ballotHash: new Uint8Array(hash), panel, seat };
  }
  let opening: OpeningKey | undefined;
  if (options.opening !== undefined) {
    const { cell, seat } = options.opening;
    if (
      recordTypeOf(body) !== RECORD_TYPES.tallyOpening ||
      !Number.isInteger(cell) ||
      cell < 0 ||
      cell > 255 ||
      !Number.isInteger(seat) ||
      seat < 1 ||
      seat > 255
    )
      throw new AppendError("invalid-entry");
    opening = { cell, seat };
  }
  let destruction: { seat: number } | undefined;
  // A statement boarded without its seat's key would be missed by the next
  // statement's judge, which would then board the seat's second, a breach
  // 8.5 lists against the operator (T-17).
  if (options.destruction === undefined && recordTypeOf(body) === RECORD_TYPES.destructionStatement)
    throw new AppendError("invalid-entry");
  if (options.destruction !== undefined) {
    const { seat } = options.destruction;
    if (
      recordTypeOf(body) !== RECORD_TYPES.destructionStatement ||
      !Number.isInteger(seat) ||
      seat < 1 ||
      seat > 255
    )
      throw new AppendError("invalid-entry");
    destruction = { seat };
  }
  const { lastSegment } = options;
  if (
    lastSegment !== undefined &&
    (!Number.isInteger(lastSegment) || lastSegment < 0 || lastSegment > MAX_SEGMENT)
  )
    throw new AppendError("invalid-entry");
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
      if (receipt !== undefined) {
        // Read under the lock, so two receipts racing in can't both be boarded.
        const [seen] = await tx
          .select({
            idx: boardEntries.idx,
            segment: boardEntries.segment,
            payload: boardEntries.payload,
            entryHash: boardEntries.entryHash,
            link: boardEntries.link,
          })
          .from(boardShareReceipts)
          .innerJoin(
            boardEntries,
            and(
              eq(boardEntries.electionId, boardShareReceipts.electionId),
              eq(boardEntries.idx, boardShareReceipts.idx),
            ),
          )
          .where(
            and(
              eq(boardShareReceipts.electionId, id),
              eq(boardShareReceipts.ballotHash, receipt.ballotHash),
              eq(boardShareReceipts.panel, receipt.panel),
              eq(boardShareReceipts.seat, receipt.seat),
            ),
          );
        if (seen !== undefined) {
          const existing = boardedAt(id, version, seen);
          const { payload, ...entry } = existing;
          if (equalBytes(payload, body)) return entry;
          throw new AppendError("receipt-present", { existing });
        }
      }
      if (opening !== undefined) {
        // Read under the lock, so two openings racing in can't both be boarded.
        const [seen] = await tx
          .select({
            idx: boardEntries.idx,
            segment: boardEntries.segment,
            payload: boardEntries.payload,
            entryHash: boardEntries.entryHash,
            link: boardEntries.link,
          })
          .from(boardTallyOpenings)
          .innerJoin(
            boardEntries,
            and(
              eq(boardEntries.electionId, boardTallyOpenings.electionId),
              eq(boardEntries.idx, boardTallyOpenings.idx),
            ),
          )
          .where(
            and(
              eq(boardTallyOpenings.electionId, id),
              eq(boardTallyOpenings.cell, opening.cell),
              eq(boardTallyOpenings.seat, opening.seat),
            ),
          );
        if (seen !== undefined) {
          const existing = boardedAt(id, version, seen);
          const { payload, ...entry } = existing;
          if (equalBytes(payload, body)) return entry;
          throw new AppendError("opening-present", { existing });
        }
      }
      if (destruction !== undefined) {
        // Read under the lock, so two statements racing in can't both be boarded.
        const [seen] = await tx
          .select({
            idx: boardEntries.idx,
            segment: boardEntries.segment,
            payload: boardEntries.payload,
            entryHash: boardEntries.entryHash,
            link: boardEntries.link,
          })
          .from(boardDestructionStatements)
          .innerJoin(
            boardEntries,
            and(
              eq(boardEntries.electionId, boardDestructionStatements.electionId),
              eq(boardEntries.idx, boardDestructionStatements.idx),
            ),
          )
          .where(
            and(
              eq(boardDestructionStatements.electionId, id),
              eq(boardDestructionStatements.seat, destruction.seat),
            ),
          );
        if (seen !== undefined) {
          const existing = boardedAt(id, version, seen);
          const { payload, ...entry } = existing;
          if (equalBytes(payload, body)) return entry;
          throw new AppendError("destruction-present", { existing });
        }
      }
      if (options.first === true) {
        // Read under the lock, so two callers racing can't both append it.
        const [start] = await tx
          .select()
          .from(boardEntries)
          .where(and(eq(boardEntries.electionId, id), eq(boardEntries.idx, 0n)));
        if (start !== undefined) {
          if (!equalBytes(start.payload, body)) throw new AppendError("not-first");
          const entry: BoardEntry = {
            election_id: id,
            index: 0n,
            segment: Number(start.segment),
            payload: body,
          };
          return {
            entry: encodeBoardEntry(entry, version),
            index: 0n,
            entryHash: new Uint8Array(start.entryHash),
            link: new Uint8Array(start.link),
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
      if (lastSegment !== undefined && segment > lastSegment) throw new AppendError("segment-late");
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
      if (ballotHash !== undefined)
        await tx.insert(boardBallotHashes).values({ electionId: id, idx: index, ballotHash });
      if (receipt !== undefined)
        await tx.insert(boardShareReceipts).values({ electionId: id, idx: index, ...receipt });
      if (opening !== undefined)
        await tx.insert(boardTallyOpenings).values({ electionId: id, idx: index, ...opening });
      if (destruction !== undefined)
        await tx
          .insert(boardDestructionStatements)
          .values({ electionId: id, idx: index, ...destruction });
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
 * The election's encoded entries from index `first` up to `end`, in order:
 * the run a segment object holds (docs/spec/board.md, Segments and
 * checkpoints). Throws unless the board holds every one of them.
 */
export async function readBoardRange(
  client: Sql,
  electionId: Uint8Array,
  first: bigint,
  end: bigint,
): Promise<Uint8Array[]> {
  const id = checkId(electionId);
  if (!isU64(first) || !isU64(end) || end < first)
    throw new RangeError("first and end must be u64s, first at most end");
  const rows = await drizzle({ client })
    .select({ idx: boardEntries.idx, segment: boardEntries.segment, payload: boardEntries.payload })
    .from(boardEntries)
    .where(
      and(eq(boardEntries.electionId, id), gte(boardEntries.idx, first), lt(boardEntries.idx, end)),
    )
    .orderBy(asc(boardEntries.idx));
  if (BigInt(rows.length) !== end - first) throw new BoardReadError("beyond-board");
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
  if (!isBytes(payload)) throw new TypeError("payload must be bytes");
  const boarded = await readEntryAt(client, electionId, index);
  if (boarded === undefined || !equalBytes(boarded.payload, payload)) return undefined;
  const { payload: _, ...appended } = boarded;
  return appended;
}

/**
 * The entry at `index`, the chain link after it and the payload it carries,
 * if the board has that entry. For a caller told by another process that an
 * entry it can't name by its bytes stands in for what it sent (an earlier
 * share receipt for the same seat, rule 5 of docs/spec/delivery.md,
 * Boarding): the answer is the board's, and the sender checks the payload
 * itself.
 */
export async function readEntryAt(
  client: Sql,
  electionId: Uint8Array,
  index: bigint,
): Promise<(AppendedEntry & { readonly payload: Uint8Array }) | undefined> {
  const id = checkId(electionId);
  if (!isU64(index)) throw new RangeError("index must be a u64");
  const [row] = await drizzle({ client })
    .select({
      segment: boardEntries.segment,
      payload: boardEntries.payload,
      entryHash: boardEntries.entryHash,
      link: boardEntries.link,
    })
    .from(boardEntries)
    .where(and(eq(boardEntries.electionId, id), eq(boardEntries.idx, index)));
  if (row === undefined) return undefined;
  const payload = new Uint8Array(row.payload);
  const entry = encodeBoardEntry(
    { election_id: id, index, segment: Number(row.segment), payload: new Uint8Array(payload) },
    await storedBoardVersion(client, id),
  );
  return {
    entry,
    index,
    entryHash: new Uint8Array(row.entryHash),
    link: new Uint8Array(row.link),
    payload,
  };
}

/**
 * The entry that carries the board path's receipt for `key`, if it is
 * exactly `payload`; otherwise `undefined`. One indexed read, so a receipt
 * replayed from the public board is answered before it costs a ballot read
 * and a signature check (T-52).
 */
export async function readBoardedReceipt(
  client: Sql,
  electionId: Uint8Array,
  key: ReceiptKey,
  payload: Uint8Array,
): Promise<AppendedEntry | undefined> {
  const id = checkId(electionId);
  if (!isBytes(payload)) throw new TypeError("payload must be bytes");
  const [row] = await drizzle({ client })
    .select({ idx: boardShareReceipts.idx })
    .from(boardShareReceipts)
    .where(
      and(
        eq(boardShareReceipts.electionId, id),
        eq(boardShareReceipts.ballotHash, new Uint8Array(key.ballotHash)),
        eq(boardShareReceipts.panel, key.panel),
        eq(boardShareReceipts.seat, key.seat),
      ),
    );
  return row === undefined ? undefined : readBoardedEntry(client, id, row.idx, payload);
}

/**
 * Every tally opening boarded through `appendEntry`'s `opening` key, with its
 * entry, in board order: the openings the Boarding judge reads as already on
 * the board (docs/spec/tally.md, Opening record, Boarding). One indexed read
 * of at most one opening per cell and seat (T-52).
 */
export async function readBoardedOpenings(
  client: Sql,
  electionId: Uint8Array,
): Promise<(AppendedEntry & { readonly payload: Uint8Array })[]> {
  const id = checkId(electionId);
  const rows = await drizzle({ client })
    .select({
      idx: boardEntries.idx,
      segment: boardEntries.segment,
      payload: boardEntries.payload,
      entryHash: boardEntries.entryHash,
      link: boardEntries.link,
    })
    .from(boardTallyOpenings)
    .innerJoin(
      boardEntries,
      and(
        eq(boardEntries.electionId, boardTallyOpenings.electionId),
        eq(boardEntries.idx, boardTallyOpenings.idx),
      ),
    )
    .where(eq(boardTallyOpenings.electionId, id))
    .orderBy(asc(boardTallyOpenings.idx));
  if (rows.length === 0) return [];
  const version = await storedBoardVersion(client, id);
  return rows.map((r) => boardedAt(id, version, r));
}

/**
 * Every destruction statement boarded through `appendEntry`'s `destruction`
 * key, with its entry, in board order: the statements the Boarding judge
 * reads as already on the board (docs/spec/tally.md, Destruction, Boarding).
 * One indexed read of at most one statement per seat (T-52).
 */
export async function readBoardedDestructions(
  client: Sql,
  electionId: Uint8Array,
): Promise<(AppendedEntry & { readonly payload: Uint8Array })[]> {
  const id = checkId(electionId);
  const rows = await drizzle({ client })
    .select({
      idx: boardEntries.idx,
      segment: boardEntries.segment,
      payload: boardEntries.payload,
      entryHash: boardEntries.entryHash,
      link: boardEntries.link,
    })
    .from(boardDestructionStatements)
    .innerJoin(
      boardEntries,
      and(
        eq(boardEntries.electionId, boardDestructionStatements.electionId),
        eq(boardEntries.idx, boardDestructionStatements.idx),
      ),
    )
    .where(eq(boardDestructionStatements.electionId, id))
    .orderBy(asc(boardDestructionStatements.idx));
  if (rows.length === 0) return [];
  const version = await storedBoardVersion(client, id);
  return rows.map((r) => boardedAt(id, version, r));
}

/**
 * The payload of the first ballot boarded under `ballotHash` (as admission
 * recomputed it, stored by `appendEntry`), if any: the ballot a share
 * receipt naming that hash is checked against (docs/spec/delivery.md,
 * Boarding, rule 2). One read, whatever the board holds (T-52); every ballot
 * of one ballot hash has the same share hashes, since the hash binds them.
 */
export async function readBallotByHash(
  client: Sql,
  electionId: Uint8Array,
  ballotHash: Uint8Array,
): Promise<Uint8Array | undefined> {
  const id = checkId(electionId);
  if (!isBytes(ballotHash) || ballotHash.length !== 32)
    throw new TypeError("ballotHash must be 32 bytes");
  const [row] = await drizzle({ client })
    .select({ payload: boardEntries.payload })
    .from(boardBallotHashes)
    .innerJoin(
      boardEntries,
      and(
        eq(boardEntries.electionId, boardBallotHashes.electionId),
        eq(boardEntries.idx, boardBallotHashes.idx),
      ),
    )
    .where(
      and(
        eq(boardBallotHashes.electionId, id),
        eq(boardBallotHashes.ballotHash, new Uint8Array(ballotHash)),
      ),
    )
    .orderBy(asc(boardBallotHashes.idx))
    .limit(1);
  return row === undefined ? undefined : new Uint8Array(row.payload);
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
