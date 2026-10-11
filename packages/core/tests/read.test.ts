import {
  BOARD_TREE,
  checkBoard,
  encodeBoardEntry,
  merkleRoot,
  UNPINNED,
  verifyConsistency,
  verifyInclusion,
} from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  appendEntry,
  BOARD_ENTRY_OVERHEAD,
  BoardReadError,
  type BoardReadErrorCode,
  readBoard,
  readConsistencyProof,
  readEntries,
  readHead,
  readInclusionProof,
} from "../src/index.ts";
import { type TestDb, testDb } from "./db.ts";

// Reading the board as the API serves it (src/board.ts): heads, pages and
// proofs computed from the stored board are the ones the verifier's own
// checkBoard, verifyInclusion and verifyConsistency accept, so a client can
// check everything it is served (T-23, T-24), and pages stay bounded (T-52).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const b32 = () => new Uint8Array(randomBytes(32));
const ballot = (n: number, size = 4) => {
  const r = new Uint8Array(Math.max(size, 4));
  r.set([0, 2, 1, n & 0xff]);
  return r;
};

let db: TestDb;
let app: Sql;
beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
});
afterAll(() => db?.close());

/** A board of `n` ballots, `sizes[i]` bytes each (4 by default), one segment per 3 entries. */
async function board(n: number, sizes: number[] = []) {
  const id = b32();
  for (let i = 0; i < n; i++) await appendEntry(app, id, Math.floor(i / 3), ballot(i, sizes[i]));
  const checked = checkBoard(id, await readBoard(app, id), UNPINNED);
  const root = (m: number) => merkleRoot(BOARD_TREE, checked.entryHashes.slice(0, m));
  return { id, checked, root };
}

async function refusedWith(p: Promise<unknown>): Promise<BoardReadErrorCode> {
  try {
    await p;
  } catch (e) {
    if (e instanceof BoardReadError) return e.code;
    throw e;
  }
  throw new Error("read succeeded");
}

test("BOARD_ENTRY_OVERHEAD is what encodeBoardEntry adds to a payload", () => {
  for (const len of [4, 100, 70_000]) {
    const payload = ballot(0, len);
    const encoded = encodeBoardEntry({ election_id: b32(), index: 7n, segment: 1, payload });
    expect(encoded.length - len).toBe(BOARD_ENTRY_OVERHEAD);
  }
});

describe("readHead", () => {
  test("an empty board has size 0 and neither head nor root", async () => {
    expect(await readHead(app, b32())).toEqual({ size: 0n, head: undefined, root: undefined });
  });

  test("is the size, last link and tree root the verifier recomputes", async () => {
    for (const n of [1, 2, 3, 7, 8, 9]) {
      const { id, checked, root } = await board(n);
      expect(await readHead(app, id)).toEqual({
        size: BigInt(n),
        head: checked.links.at(-1),
        root: root(n),
      });
    }
  });
});

describe("readEntries", () => {
  test("pages, read in turn, are the board readBoard returns", async () => {
    const { id } = await board(10);
    const all = await readBoard(app, id);
    for (const limit of [1, 3, 4, 10, 256]) {
      const pages: Uint8Array[] = [];
      for (let start = 0n; ;) {
        const page = await readEntries(app, id, start, limit, 1 << 20);
        if (page.length === 0) break;
        expect(page.length).toBeLessThanOrEqual(limit);
        pages.push(...page);
        start += BigInt(page.length);
      }
      expect(pages).toEqual(all);
    }
  });

  test("an empty page at the board's size; beyond it is refused", async () => {
    const { id } = await board(3);
    expect(await readEntries(app, id, 3n, 10, 1 << 20)).toEqual([]);
    expect(await refusedWith(readEntries(app, id, 4n, 10, 1 << 20))).toBe("beyond-board");
    expect(await refusedWith(readEntries(app, b32(), 1n, 10, 1 << 20))).toBe("beyond-board");
    expect(await readEntries(app, b32(), 0n, 10, 1 << 20)).toEqual([]);
  });

  test("stops before the byte budget, but always returns at least one entry", async () => {
    const sizes = [1000, 1000, 5000, 10, 10];
    const { id } = await board(5, sizes);
    const enc = (i: number) => sizes[i]! + BOARD_ENTRY_OVERHEAD;
    const lengths = async (start: bigint, budget: number) =>
      (await readEntries(app, id, start, 256, budget)).map((e) => e.length);
    expect(await lengths(0n, enc(0) + enc(1))).toEqual([enc(0), enc(1)]);
    expect(await lengths(0n, enc(0) + enc(1) - 1)).toEqual([enc(0)]);
    expect(await lengths(2n, 10)).toEqual([enc(2)]);
    expect(await lengths(3n, 1 << 20)).toEqual([enc(3), enc(4)]);
  });

  test("never exceeds the budget with more than one entry, for any board and budget", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 4, max: 3000 }), { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 0, max: 8000 }),
        fc.integer({ min: 1, max: 8 }),
        async (sizes, budget, limit) => {
          const { id } = await board(sizes.length, sizes);
          const page = await readEntries(app, id, 0n, limit, budget);
          const total = page.reduce((n, e) => n + e.length, 0);
          expect(page.length).toBeGreaterThanOrEqual(1);
          expect(page.length).toBeLessThanOrEqual(limit);
          if (page.length > 1) expect(total).toBeLessThanOrEqual(budget);
          // Maximal: the next entry, if any and allowed by the limit, wouldn't fit.
          const next = sizes[page.length];
          if (next !== undefined && page.length < limit)
            expect(total + next + BOARD_ENTRY_OVERHEAD).toBeGreaterThan(budget);
        },
      ),
      { numRuns: Math.min(numRuns, 50) },
    );
  });
});

describe("proofs", () => {
  test("every inclusion and consistency proof of a board verifies", async () => {
    const n = 11;
    const { id, checked, root } = await board(n);
    for (let size = 1; size <= n; size++) {
      for (let i = 0; i < size; i++) {
        const proof = await readInclusionProof(app, id, BigInt(i), BigInt(size));
        expect(
          verifyInclusion(
            BOARD_TREE,
            BigInt(i),
            BigInt(size),
            checked.entryHashes[i]!,
            proof,
            root(size),
          ),
        ).toBe(true);
      }
      for (let m = 1; m <= size; m++) {
        const proof = await readConsistencyProof(app, id, BigInt(m), BigInt(size));
        expect(
          verifyConsistency(BOARD_TREE, BigInt(m), BigInt(size), root(m), root(size), proof),
        ).toBe(true);
      }
    }
  });

  test("a proof for one entry doesn't verify another", async () => {
    const { id, checked, root } = await board(5);
    const proof = await readInclusionProof(app, id, 1n, 5n);
    expect(verifyInclusion(BOARD_TREE, 2n, 5n, checked.entryHashes[2]!, proof, root(5))).toBe(
      false,
    );
  });

  test("refuses positions no tree has, and trees beyond the board", async () => {
    const { id } = await board(4);
    expect(await refusedWith(readInclusionProof(app, id, 0n, 0n))).toBe("invalid-range");
    expect(await refusedWith(readInclusionProof(app, id, 4n, 4n))).toBe("invalid-range");
    expect(await refusedWith(readInclusionProof(app, id, 0n, 5n))).toBe("beyond-board");
    expect(await refusedWith(readConsistencyProof(app, id, 0n, 4n))).toBe("invalid-range");
    expect(await refusedWith(readConsistencyProof(app, id, 3n, 2n))).toBe("invalid-range");
    expect(await refusedWith(readConsistencyProof(app, id, 1n, 5n))).toBe("beyond-board");
    expect(await refusedWith(readConsistencyProof(app, id, 2n ** 63n, 2n ** 64n - 1n))).toBe(
      "beyond-board",
    );
  });

  test("refuses arguments that aren't u64s or 32-byte IDs", async () => {
    const id = b32();
    await expect(readInclusionProof(app, id, -1n, 1n)).rejects.toThrow(RangeError);
    await expect(readConsistencyProof(app, id, 1n, 2n ** 64n)).rejects.toThrow(RangeError);
    await expect(readEntries(app, id, 0n, 0, 10)).rejects.toThrow(RangeError);
    await expect(readHead(app, id.subarray(1))).rejects.toThrow(TypeError);
  });
});
