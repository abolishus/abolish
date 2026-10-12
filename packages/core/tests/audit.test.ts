import { boardEntryHash, chainLink, encodeBoardEntry } from "@abolishus/crypto";
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
} from "../src/index.ts";
import { type TestDb, testDb } from "./db.ts";

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
 * the row.
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
    boardEntryHash(encodeBoardEntry({ election_id: id, index: idx, segment, payload }));
  const link = override.link ?? chainLink(prevLink, entryHash);
  await insertRow(id, idx, segment, payload, entryHash, prevLink, link);
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
          const id = b32();
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
  });

  test("passes rows stored without appendEntry when their columns are right", async () => {
    const id = b32();
    await appendEntry(app, id, 0, ballot(0));
    await appendRaw(id, ballot(1));
    expect(await auditBoard(app, id)).toBe(2);
  });

  test("fails a row whose entry hash isn't its entry's, at that row", async () => {
    const id = b32();
    await appendEntry(app, id, 0, ballot(0));
    await appendEntry(app, id, 0, ballot(1));
    await appendRaw(id, ballot(2), { entryHash: b32() });
    await appendEntry(app, id, 0, ballot(3));
    expect(await auditFailure(id)).toEqual(["entry-hash-mismatch", 2]);
  });

  test("fails a row whose link isn't chained from its entry hash", async () => {
    const id = b32();
    await appendEntry(app, id, 0, ballot(0));
    await appendRaw(id, ballot(1), { link: b32() });
    // Later rows chain on the stored link, so the triggers keep accepting them.
    await appendRaw(id, ballot(2));
    expect(await auditFailure(id)).toEqual(["link-mismatch", 1]);
  });

  test("fails a board the verifier's checkBoard rejects, at the first bad entry", async () => {
    const id = b32();
    await appendEntry(app, id, 2, ballot(0));
    // The table checks segments are non-decreasing too, so the rejection here
    // is an opening followed by a ballot in its segment (T-42, T-47).
    await appendRaw(id, Uint8Array.of(0x00, 0x03, 1, 7), {}, 2);
    await appendRaw(id, ballot(1), {}, 2);
    expect(await auditFailure(id)).toEqual(["board-invalid", 2]);
  });

  test("refuses an election ID that isn't 32 bytes", async () => {
    await expect(auditBoard(app, new Uint8Array(31))).rejects.toThrow(TypeError);
  });
});

describe("listBoards", () => {
  test("lists every election with entries, once, in byte order", async () => {
    const ids = [b32(), b32(), b32()];
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
