import {
  appendSubtrees,
  BOARD_TREE,
  boardEntryHash,
  chainLink,
  encodeBoardEntry,
  rootSubtrees,
} from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  appendEntry,
  auditBoard,
  BoardAuditError,
  type BoardAuditCode,
  listBoards,
  readBoard,
} from "../src/index.ts";
import { newElection, type TestDb, testDb } from "./db.ts";

// auditBoard (src/audit.ts): a board appended through appendEntry passes, and
// rows a writer stored without it (the triggers check order and chaining, not
// hashes) fail at the first wrong entry, with the reason (T-23, T-66).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const b32 = () => new Uint8Array(randomBytes(32));
const ballot = (...body: number[]) => Uint8Array.of(0x00, 0x02, 1, ...body);

let db: TestDb;
let app: Sql;

beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
});
afterAll(() => db?.close());

async function auditFailure(id: Uint8Array): Promise<[BoardAuditCode, number]> {
  try {
    await auditBoard(app, id);
  } catch (e) {
    if (e instanceof BoardAuditError) return [e.code, e.index];
    throw e;
  }
  throw new Error("audit passed");
}

/**
 * Appends to `id`'s board through the table directly, as a writer bypassing
 * appendEntry could: the entry hash and link are correct unless overridden,
 * and `prev_link` is always the stored previous link, so the triggers accept
 * the row. It stores no subtrees; `storeSubtrees` adds them.
 */
async function appendRaw(
  id: Uint8Array,
  payload: Uint8Array,
  override: { entryHash?: Uint8Array; link?: Uint8Array } = {},
  segment = 0,
) {
  const [prev] = await app`SELECT idx, link FROM board_entries
    WHERE election_id = ${id} ORDER BY idx DESC LIMIT 1`;
  const idx = prev === undefined ? 0n : BigInt(prev["idx"]) + 1n;
  const prevLink = prev === undefined ? new Uint8Array(32) : Uint8Array.from(prev["link"]);
  const entryHash =
    override.entryHash ??
    boardEntryHash(encodeBoardEntry({ election_id: id, index: idx, segment, payload }, 1));
  const link = override.link ?? chainLink(prevLink, entryHash);
  await insertRow(id, idx, segment, payload, entryHash, prevLink, link);
  return { idx, entryHash };
}

/**
 * Stores the subtrees entry `idx` completes, from `leaf` (its stored entry
 * hash unless overridden) and the stored frontier, as appendEntry would.
 */
async function storeSubtrees(id: Uint8Array, idx: bigint, leaf: Uint8Array, level0?: Uint8Array) {
  const size = Number(idx);
  const frontier: Uint8Array[] = [];
  for (const t of size === 0 ? [] : rootSubtrees(size)) {
    const [row] = await app`SELECT hash FROM board_subtrees
      WHERE election_id = ${id} AND level = ${t.level} AND idx = ${t.index}`;
    frontier.push(Uint8Array.from(row?.["hash"]));
  }
  for (const t of appendSubtrees(BOARD_TREE, frontier, size, leaf))
    await app`INSERT INTO board_subtrees (election_id, level, idx, hash)
      VALUES (${id}, ${t.level}, ${t.index}, ${t.level === 0 ? (level0 ?? t.hash) : t.hash})`;
}

async function insertRow(
  id: Uint8Array,
  idx: bigint,
  segment: number,
  payload: Uint8Array,
  entryHash: Uint8Array,
  prevLink: Uint8Array,
  link: Uint8Array,
) {
  await app`INSERT INTO board_entries (election_id, idx, segment, payload, entry_hash, prev_link, link)
    VALUES (${id}, ${idx.toString()}, ${segment}, ${payload}, ${entryHash}, ${prevLink}, ${link})`;
}

describe("auditBoard", () => {
  test("passes an empty board with size 0", async () => {
    expect(await auditBoard(app, b32())).toBe(0);
  });

  test("passes every board appendEntry builds", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.nat(3), fc.uint8Array({ maxLength: 8 })), { maxLength: 6 }),
        async (steps) => {
          const id = await newElection(app);
          let segment = 0;
          for (const [gap, body] of steps) {
            segment += gap;
            await appendEntry(app, id, segment, ballot(...body));
          }
          expect(await auditBoard(app, id)).toBe(steps.length);
        },
      ),
      { numRuns: Math.min(numRuns, 50) },
    );
    // Fifty runs of database writes can outlast the default timeout on a CI
    // runner shared with the other test files.
  }, 60_000);

  test("passes rows stored without appendEntry when their columns are right", async () => {
    const id = await newElection(app);
    await appendEntry(app, id, 0, ballot(0));
    const { idx, entryHash } = await appendRaw(id, ballot(1));
    await storeSubtrees(id, idx, entryHash);
    // appendEntry continues from subtrees stored by hand.
    await appendEntry(app, id, 0, ballot(2));
    expect(await auditBoard(app, id)).toBe(3);
  });

  test("fails a row whose entry hash isn't its entry's, at that row", async () => {
    const id = await newElection(app);
    await appendEntry(app, id, 0, ballot(0));
    await appendEntry(app, id, 0, ballot(1));
    const row = await appendRaw(id, ballot(2), { entryHash: b32() });
    // Subtrees agreeing with the wrong entry hash don't hide it.
    await storeSubtrees(id, row.idx, row.entryHash);
    await appendEntry(app, id, 0, ballot(3));
    expect(await auditFailure(id)).toEqual(["entry-hash-mismatch", 2]);
  });

  test("fails an entry stored without its subtrees, at that entry", async () => {
    const id = await newElection(app);
    await appendEntry(app, id, 0, ballot(0));
    await appendRaw(id, ballot(1));
    expect(await auditFailure(id)).toEqual(["subtree-missing", 1]);
    // And nothing can be appended after it.
    await expect(appendEntry(app, id, 0, ballot(2))).rejects.toThrow(/subtree/);
  });

  test("fails a stored subtree that isn't its entries', at the entry that completes it", async () => {
    const id = await newElection(app);
    await appendEntry(app, id, 0, ballot(0));
    await appendEntry(app, id, 0, ballot(1));
    const row = await appendRaw(id, ballot(2));
    // The leaf is wrong; its parent, (1, 1) at entry 3, is never written.
    await storeSubtrees(id, row.idx, row.entryHash, b32());
    expect(await auditFailure(id)).toEqual(["subtree-mismatch", 2]);
  });

  test("fails a row whose link isn't chained from its entry hash", async () => {
    const id = await newElection(app);
    await appendEntry(app, id, 0, ballot(0));
    await appendRaw(id, ballot(1), { link: b32() });
    // Later rows chain on the stored link, so the triggers keep accepting them.
    await appendRaw(id, ballot(2));
    expect(await auditFailure(id)).toEqual(["link-mismatch", 1]);
  });

  test("fails a board the verifier's checkBoard rejects, at the first bad entry", async () => {
    const id = await newElection(app);
    await appendEntry(app, id, 2, ballot(0));
    // The table checks segments are non-decreasing too, so the rejection here
    // is an opening followed by a ballot in its segment (T-42, T-47).
    await appendRaw(id, Uint8Array.of(0x00, 0x03, 1, 7), {}, 2);
    await appendRaw(id, ballot(1), {}, 2);
    expect(await auditFailure(id)).toEqual(["board-invalid", 2]);
  });

  test("hashes entries under the board-entry version the definition pins", async () => {
    const id = await newElection(app, 4);
    await appendEntry(app, id, 0, ballot(0));
    await appendEntry(app, id, 0, ballot(1));
    expect(await auditBoard(app, id)).toBe(2);
    // appendRaw hashes under version 1: right for a version-1 board, wrong here.
    const row = await appendRaw(id, ballot(2));
    await storeSubtrees(id, row.idx, row.entryHash);
    expect(await auditFailure(id)).toEqual(["entry-hash-mismatch", 2]);
  });

  test("fails a board stored without a definition that pins its version", async () => {
    const id = b32();
    await appendRaw(id, ballot(0));
    expect(await auditFailure(id)).toEqual(["board-unpinned", 0]);
    await expect(readBoard(app, id)).rejects.toThrow(/no-definition/);
    const unsupported = await newElection(app, 2);
    await appendRaw(unsupported, ballot(0));
    expect(await auditFailure(unsupported)).toEqual(["board-unpinned", 0]);
  });

  test("refuses an election ID that isn't 32 bytes", async () => {
    await expect(auditBoard(app, new Uint8Array(31))).rejects.toThrow(TypeError);
  });
});

describe("listBoards", () => {
  test("lists every election with entries, once, in byte order", async () => {
    const ids = [await newElection(app), await newElection(app), await newElection(app)];
    for (const id of ids) {
      await appendEntry(app, id, 0, ballot(0));
      await appendEntry(app, id, 0, ballot(1));
    }
    const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
    const listed = (await listBoards(app)).map(hex);
    const want = ids.map(hex);
    expect(listed.filter((h) => want.includes(h))).toEqual([...want].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });
});
