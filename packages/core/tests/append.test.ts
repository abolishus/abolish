import { boardEntryHash, checkBoard, encodeBoardEntry, UNPINNED } from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { appendEntry, AppendError, type AppendErrorCode, readBoard } from "../src/index.ts";
import { newElection, type TestDb, testDb } from "./db.ts";

// appendEntry and readBoard (src/board.ts): every entry's hash and link come
// from @abolishus/crypto, so the stored board passes the verifier's own
// checkBoard, and concurrent appends still produce one contiguous chain (T-23).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const equalBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);
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
    const id = await newElection(app);
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
    const a = await newElection(app);
    const b = await newElection(app);
    await appendEntry(app, a, 0, ballot(1));
    await appendEntry(app, b, 0, ballot(1));
    await appendEntry(app, a, 0, ballot(2));
    expect((await appendEntry(app, b, 0, ballot(2))).index).toBe(1n);
    await assertVerifiable(a, 2);
    await assertVerifiable(b, 2);
  });

  test("concurrent appends from several connections form one contiguous chain", async () => {
    const id = await newElection(app);
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

  test("still forms one chain when the connection defaults to repeatable read", async () => {
    // appendEntry sets READ COMMITTED itself: under a snapshot level the
    // previous entry would be read from a snapshot taken before the lock.
    const id = await newElection(app);
    const clients = await Promise.all([0, 1, 2, 3].map(() => db.as("abolish_app")));
    for (const c of clients)
      await c.unsafe("SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await Promise.all(
      clients.flatMap((c, k) =>
        Array.from({ length: 10 }, (_, i) => appendEntry(c, id, 0, ballot(k, i))),
      ),
    );
    await assertVerifiable(id, 40);
  });

  test("refuses a segment below the previous entry's", async () => {
    const id = await newElection(app);
    await appendEntry(app, id, 5, ballot());
    expect(await refusedWith(appendEntry(app, id, 4, ballot()))).toBe("segment-decreased");
    await assertVerifiable(id, 1);
  });

  test("keeps openings last in a segment, in increasing byte order (T-42, T-47)", async () => {
    const id = await newElection(app);
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
    const id = await newElection(app);
    // Display text is never on the board (T-17); nor is a definition or a board entry.
    for (const type of [0x0001, 0x0007, 0x0009, 0x0004])
      expect(await refusedWith(appendEntry(app, id, 0, record(type)))).toBe("invalid-entry");
    expect(await refusedWith(appendEntry(app, id, 0, Uint8Array.of(0, 2)))).toBe("invalid-entry");
    expect(await refusedWith(appendEntry(app, new Uint8Array(31), 0, ballot()))).toBe(
      "invalid-entry",
    );
    // Values a transport decoder might hand over are refused, never coerced.
    for (const bad of ["a".repeat(32), Array(32).fill(1), new Uint8Array(0), new Uint8Array(33)])
      expect(await refusedWith(appendEntry(app, bad as unknown as Uint8Array, 0, ballot()))).toBe(
        "invalid-entry",
      );
    expect(await refusedWith(appendEntry(app, id, 0, [0, 2, 1] as unknown as Uint8Array))).toBe(
      "invalid-entry",
    );
    expect(await readBoard(app, new Uint8Array(32))).toEqual([]);
    for (const segment of [-1, 2 ** 32, 0.5])
      expect(await refusedWith(appendEntry(app, id, segment, ballot()))).toBe("invalid-entry");
    expect(await readBoard(app, id)).toEqual([]);
  });

  test("encodes each board under the board-entry version its definition pins", async () => {
    const v4 = await newElection(app, 4);
    const v1 = await newElection(app);
    const payloads = [ballot(1), opening(1)];
    for (const id of [v4, v1]) for (const p of payloads) await appendEntry(app, id, 0, p);
    const board = checkBoard(v4, await readBoard(app, v4), 4);
    const rows = await stored(v4);
    expect(rows.map((r) => Uint8Array.from(r["entry_hash"]))).toEqual(board.entryHashes);
    expect(rows.map((r) => Uint8Array.from(r["link"]))).toEqual(board.links);
    // The version byte is in every entry hashed, so a board read under another
    // version matches nothing stored (T-23, T-34).
    const asV1 = payloads.map((payload, i) =>
      boardEntryHash(
        encodeBoardEntry({ election_id: v4, index: BigInt(i), segment: 0, payload }, 1),
      ),
    );
    expect(board.entryHashes.some((h, i) => equalBytes(h, asV1[i]!))).toBe(false);
    const entries = await readBoard(app, v4);
    expect(() => checkBoard(v4, entries, 1)).toThrow(/profile-mismatch/);
    expect(checkBoard(v1, await readBoard(app, v1), 1).entries).toHaveLength(2);
  });

  test("refuses to start a board without a stored definition, or under a version it can't write", async () => {
    const none = new Uint8Array(randomBytes(32));
    expect(await refusedWith(appendEntry(app, none, 0, ballot()))).toBe("no-definition");
    // Version 2 is never assigned, and 9 isn't one yet (T-36).
    for (const version of [2, 9]) {
      const id = await newElection(app, version);
      expect(await refusedWith(appendEntry(app, id, 0, ballot()))).toBe("unsupported-version");
      expect(await readBoard(app, id)).toEqual([]);
    }
    expect(await readBoard(app, none)).toEqual([]);
    expect(
      (await app`SELECT count(*)::int AS n FROM board_subtrees WHERE election_id = ${none}`)[0]![
        "n"
      ],
    ).toBe(0);
  });

  test("takes only the payload types its board-entry version allows", async () => {
    // docs/spec/board.md, Allowed payloads: share receipts and complaints from
    // version 3, destruction statements from version 4.
    const allowed: [number, number[]][] = [
      [1, []],
      [3, [0x000c, 0x000e]],
      [4, [0x000c, 0x000e, 0x000f]],
    ];
    for (const [version, types] of allowed) {
      const id = await newElection(app, version);
      for (const type of [0x000c, 0x000e, 0x000f]) {
        const append = appendEntry(app, id, 0, record(type));
        if (types.includes(type))
          // The table's CHECK still lists version 1's types only (Known-weak).
          await expect(append).rejects.toMatchObject({ cause: { code: "23514" } });
        else expect(await refusedWith(append)).toBe("invalid-entry");
      }
    }
  });

  test("any sequence of appends leaves exactly the accepted ones, verifiable", async () => {
    const op = fc.record({
      segmentStep: fc.constantFrom(-1, 0, 0, 0, 1),
      isOpening: fc.boolean(),
      body: fc.uint8Array({ maxLength: 4 }),
    });
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 12 }), async (ops) => {
        const id = await newElection(app);
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
