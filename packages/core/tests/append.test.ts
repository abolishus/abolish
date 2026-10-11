import { checkBoard, UNPINNED } from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { appendEntry, AppendError, type AppendErrorCode, readBoard } from "../src/index.ts";
import { type TestDb, testDb } from "./db.ts";

// appendEntry and readBoard (src/board.ts): every entry's hash and link come
// from @abolishus/crypto, so the stored board passes the verifier's own
// checkBoard, and concurrent appends still produce one contiguous chain (T-23).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const b32 = () => new Uint8Array(randomBytes(32));
/** A record of `type` with a 1-byte version and `body`: only the header matters here. */
const record = (type: number, ...body: number[]) =>
  Uint8Array.of(type >> 8, type & 0xff, 1, ...body);
const ballot = (...body: number[]) => record(0x0002, ...body);
const opening = (...body: number[]) => record(0x0003, ...body);

let db: TestDb;
let app: Sql;

beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
});
afterAll(() => db?.close());

async function refusedWith(p: Promise<unknown>): Promise<AppendErrorCode> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AppendError) return e.code;
    throw e;
  }
  throw new Error("append succeeded");
}

/** The stored rows' hash columns, in index order. */
async function stored(electionId: Uint8Array) {
  return app`SELECT idx, entry_hash, prev_link, link FROM board_entries
    WHERE election_id = ${electionId} ORDER BY idx`;
}

/** The board read back passes checkBoard, and the stored hashes are the ones it recomputes. */
async function assertVerifiable(electionId: Uint8Array, expectedSize: number) {
  const board = checkBoard(electionId, await readBoard(app, electionId), UNPINNED);
  expect(board.entries).toHaveLength(expectedSize);
  const rows = await stored(electionId);
  expect(rows.map((r) => Uint8Array.from(r["entry_hash"]))).toEqual(board.entryHashes);
  expect(rows.map((r) => Uint8Array.from(r["link"]))).toEqual(board.links);
  return board;
}

describe("appendEntry", () => {
  test("appends a chain the verifier's checkBoard accepts, from 32 zero bytes", async () => {
    const id = b32();
    const results = [];
    for (const [segment, payload] of [
      [0, ballot(1)],
      [0, ballot(2)],
      [0, opening(1)],
      [0, opening(2)],
      [3, ballot(3)],
    ] as const)
      results.push(await appendEntry(app, id, segment, payload));
    expect(results.map((r) => r.index)).toEqual([0n, 1n, 2n, 3n, 4n]);
    const board = await assertVerifiable(id, 5);
    expect(results.map((r) => r.entryHash)).toEqual(board.entryHashes);
    expect(results.map((r) => r.link)).toEqual(board.links);
    const rows = await stored(id);
    expect(Uint8Array.from(rows[0]!["prev_link"])).toEqual(new Uint8Array(32));
  });

  test("keeps each election's board separate", async () => {
    const a = b32();
    const b = b32();
    await appendEntry(app, a, 0, ballot(1));
    await appendEntry(app, b, 0, ballot(1));
    await appendEntry(app, a, 0, ballot(2));
    expect((await appendEntry(app, b, 0, ballot(2))).index).toBe(1n);
    await assertVerifiable(a, 2);
    await assertVerifiable(b, 2);
  });

  test("concurrent appends from several connections form one contiguous chain", async () => {
    const id = b32();
    const clients = await Promise.all([0, 1, 2, 3].map(() => db.as("abolish_app")));
    const results = await Promise.all(
      clients.flatMap((c, k) =>
        Array.from({ length: 10 }, (_, i) => appendEntry(c, id, 0, ballot(k, i))),
      ),
    );
    expect(results.map((r) => r.index).sort((x, y) => (x < y ? -1 : 1))).toEqual(
      Array.from({ length: 40 }, (_, i) => BigInt(i)),
    );
    await assertVerifiable(id, 40);
  });

  test("refuses a segment below the previous entry's", async () => {
    const id = b32();
    await appendEntry(app, id, 5, ballot());
    expect(await refusedWith(appendEntry(app, id, 4, ballot()))).toBe("segment-decreased");
    await assertVerifiable(id, 1);
  });

  test("keeps openings last in a segment, in increasing byte order (T-42, T-47)", async () => {
    const id = b32();
    await appendEntry(app, id, 0, ballot());
    await appendEntry(app, id, 0, opening(5));
    expect(await refusedWith(appendEntry(app, id, 0, ballot()))).toBe("opening-order");
    expect(await refusedWith(appendEntry(app, id, 0, opening(5)))).toBe("opening-order");
    expect(await refusedWith(appendEntry(app, id, 0, opening(4)))).toBe("opening-order");
    await appendEntry(app, id, 0, opening(6));
    // A new segment starts a new run.
    await appendEntry(app, id, 1, ballot());
    await assertVerifiable(id, 4);
  });

  test("refuses entries that don't encode", async () => {
    const id = b32();
    // Display text is never on the board (T-17); nor is a definition or a board entry.
    for (const type of [0x0001, 0x0007, 0x0009, 0x0004])
      expect(await refusedWith(appendEntry(app, id, 0, record(type)))).toBe("invalid-entry");
    expect(await refusedWith(appendEntry(app, id, 0, Uint8Array.of(0, 2)))).toBe("invalid-entry");
    expect(await refusedWith(appendEntry(app, new Uint8Array(31), 0, ballot()))).toBe(
      "invalid-entry",
    );
    for (const segment of [-1, 2 ** 32, 0.5])
      expect(await refusedWith(appendEntry(app, id, segment, ballot()))).toBe("invalid-entry");
    expect(await readBoard(app, id)).toEqual([]);
  });

  test("any sequence of appends leaves exactly the accepted ones, verifiable", async () => {
    const op = fc.record({
      segmentStep: fc.constantFrom(-1, 0, 0, 0, 1),
      isOpening: fc.boolean(),
      body: fc.uint8Array({ maxLength: 4 }),
    });
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 12 }), async (ops) => {
        const id = b32();
        let segment = 1;
        let accepted = 0;
        // The model: the spec's envelope rules, independently of src/board.ts.
        let last: { segment: number; payload: Uint8Array } | undefined;
        for (const o of ops) {
          segment = Math.max(0, segment + o.segmentStep);
          const payload = o.isOpening ? opening(...o.body) : ballot(...o.body);
          const lastIsOpening = last !== undefined && last.payload[1] === 0x03;
          const ok =
            last === undefined ||
            segment > last.segment ||
            (segment === last.segment &&
              (!lastIsOpening ||
                (o.isOpening &&
                  Buffer.compare(Buffer.from(last.payload), Buffer.from(payload)) < 0)));
          try {
            await appendEntry(app, id, segment, payload);
            expect(ok).toBe(true);
            accepted++;
            last = { segment, payload };
          } catch (e) {
            expect(e).toBeInstanceOf(AppendError);
            expect(ok).toBe(false);
          }
        }
        await assertVerifiable(id, accepted);
      }),
      // Each run is a round trip per append against a live database, so CI's
      // 1000 is capped as in board.test.ts; the cap still covers every rule.
      { numRuns: Math.min(numRuns, 200) },
    );
  }, 120_000);
});
