// Auditing the stored boards against their own bytes. Every row's entry hash
// and links were computed by @abolishus/crypto when it was appended, but the
// table's triggers check only order and chaining, not hashes: a writer that
// bypassed appendEntry, or a corrupted or restored database, could store
// columns the payloads don't produce. The API then serves heads and proofs
// that no client can reconcile with the entries. An audit recomputes every
// row with the verifier's own checkBoard, so the operator hears of it before
// a voter's client or the verifier does (T-23, T-66). It detects; it repairs
// nothing, since Postgres isn't authoritative and a board is rebuilt from
// chain and IPFS (P4-6).

import { BoardError, checkBoard, encodeBoardEntry, UNPINNED } from "@abolishus/crypto";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { isBytes } from "./bytes.ts";
import { boardEntries } from "./db/schema/index.ts";

export type BoardAuditCode =
  /** The stored entries fail the verifier's checkBoard (its `BoardError` is the cause). */
  | "board-invalid"
  /** A row's `entry_hash` isn't the hash of its encoded entry. */
  | "entry-hash-mismatch"
  /** A row's `prev_link` or `link` isn't the chain link checkBoard recomputes. */
  | "link-mismatch";

export class BoardAuditError extends Error {
  override readonly name = "BoardAuditError";
  readonly code: BoardAuditCode;
  /** The first entry found wrong. */
  readonly index: number;
  constructor(code: BoardAuditCode, index: number, options?: { cause?: BoardError }) {
    super(`board audit failed: ${code} at entry ${index}`, options);
    this.code = code;
    this.index = index;
  }
}

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** The election IDs of every board with at least one entry, in byte order. */
export async function listBoards(client: Sql): Promise<Uint8Array[]> {
  const rows = await drizzle({ client })
    .selectDistinct({ electionId: boardEntries.electionId })
    .from(boardEntries)
    .orderBy(asc(boardEntries.electionId));
  return rows.map((r) => new Uint8Array(r.electionId));
}

/**
 * Recomputes `electionId`'s board from its stored payloads, positions and
 * segments, and checks every row's stored hash and links against it. Returns
 * the number of entries checked; throws `BoardAuditError` at the first wrong
 * entry. The rows are read in one query, so the audit sees one snapshot
 * however many appends run meanwhile. An election with no entries passes
 * with size 0.
 */
export async function auditBoard(client: Sql, electionId: Uint8Array): Promise<number> {
  if (!isBytes(electionId) || electionId.length !== 32)
    throw new TypeError("electionId must be 32 bytes");
  const id = new Uint8Array(electionId);
  const rows = await drizzle({ client })
    .select()
    .from(boardEntries)
    .where(eq(boardEntries.electionId, id))
    .orderBy(asc(boardEntries.idx));
  // The table's CHECKs take only payloads the entry envelope encodes.
  const encoded = rows.map((r) =>
    encodeBoardEntry({
      election_id: id,
      index: r.idx,
      segment: Number(r.segment),
      payload: new Uint8Array(r.payload),
    }),
  );
  let board;
  try {
    // Unpinned: this checks storage, not admission. The verifier pins the
    // version the election's definition names.
    board = checkBoard(id, encoded, UNPINNED);
  } catch (e) {
    if (e instanceof BoardError && "entry" in e.at)
      throw new BoardAuditError("board-invalid", e.at.entry, { cause: e });
    throw e;
  }
  const zero = new Uint8Array(32);
  for (const [i, r] of rows.entries()) {
    if (!equal(r.entryHash, board.entryHashes[i] as Uint8Array))
      throw new BoardAuditError("entry-hash-mismatch", i);
    // The triggers already hold prev_link to the stored previous link, so a
    // wrong one shows first as that row's link-mismatch; this catches rows
    // written while the owner had the triggers off.
    if (
      !equal(r.prevLink, i === 0 ? zero : (board.links[i - 1] as Uint8Array)) ||
      !equal(r.link, board.links[i] as Uint8Array)
    )
      throw new BoardAuditError("link-mismatch", i);
  }
  return rows.length;
}
