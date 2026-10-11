// Appending to and reading an election's board (docs/spec/board.md). The
// entry hash and chain link are computed by @abolishus/crypto, never here, so
// the board the server writes is the board the verifier recomputes (T-23,
// T-36). The table's triggers check order and chaining again on insert.

import { type BoardEntry, boardEntryHash, chainLink, encodeBoardEntry } from "@abolishus/crypto";
import { asc, desc, eq, sql as q } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { boardEntries } from "./db/schema/index.ts";

const SPOILED_BALLOT_OPENING = 0x0003;
const MAX_SEGMENT = 2 ** 32 - 1;

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
 * envelope's rules.
 */
export async function appendEntry(
  client: Sql,
  electionId: Uint8Array,
  segment: number,
  payload: Uint8Array,
): Promise<AppendedEntry> {
  if (!Number.isInteger(segment) || segment < 0 || segment > MAX_SEGMENT)
    throw new AppendError("invalid-entry");
  const id = Uint8Array.from(electionId);
  const body = Uint8Array.from(payload);
  return drizzle({ client }).transaction(async (tx) => {
    // The lock key is the first 8 bytes of the election ID, a hash output, so
    // two elections rarely share one; sharing only serialises their appends.
    await tx.execute(
      q`SELECT pg_advisory_xact_lock(('x' || encode(substring(${id}::bytea FROM 1 FOR 8), 'hex'))::bit(64)::bigint)`,
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
  });
}

/**
 * The election's board as encoded entries, in index order: the input
 * `checkBoard` and the verifier take. Postgres isn't authoritative; a reader
 * recomputes hashes and links from these bytes rather than trusting the
 * stored columns.
 */
export async function readBoard(client: Sql, electionId: Uint8Array): Promise<Uint8Array[]> {
  const id = Uint8Array.from(electionId);
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
      payload: Uint8Array.from(r.payload),
    }),
  );
}
