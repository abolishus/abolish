import {
  checkL1Reference,
  type FinalizedL1,
  type FinalizedL1Block,
  l1RefMin,
} from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import { type FinalizedL1Source, L1References } from "../src/index.ts";

// L1References (src/l1-references.ts): its verdict is always the crypto
// package's `checkL1Reference`, with `l1_ref_min` from `l1RefMin`, over the
// whole finalized chain the node reports, though it reads only the blocks
// those functions ask for (verifier 5.8; T-17, T-52).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

/** A chain of `length` blocks from `start`, with strictly increasing timestamps. */
const chainArb = fc
  .record({
    start: fc.bigInt({ min: 0n, max: 10n ** 9n }),
    gaps: fc.array(fc.integer({ min: 1, max: 40 }), { minLength: 1, maxLength: 400 }),
    salt: fc.nat(),
  })
  .map(({ start, gaps, salt }) => {
    const blocks: FinalizedL1Block[] = [];
    let t = start;
    for (const [i, g] of gaps.entries()) {
      t += BigInt(g);
      const hash = new Uint8Array(32);
      new DataView(hash.buffer).setUint32(0, i);
      new DataView(hash.buffer).setUint32(4, salt);
      blocks.push({ hash, timestamp: t });
    }
    return blocks;
  });

function sourceOf(blocks: readonly FinalizedL1Block[], chainId = 1n) {
  const reads: bigint[] = [];
  let head = BigInt(blocks.length - 1);
  let heads = 0;
  const s: FinalizedL1Source = {
    chainId,
    async finalizedHead() {
      heads++;
      return head;
    },
    async block(n) {
      reads.push(n);
      const b = blocks[Number(n)];
      if (b === undefined) throw new Error(`no block ${n}`);
      return b;
    },
  };
  return {
    s,
    reads,
    heads: () => heads,
    setHead: (n: bigint) => {
      head = n;
    },
  };
}

/** The verdict over the whole chain, as the verifier computes it from a run. */
function expected(
  blocks: readonly FinalizedL1Block[],
  window: { opensAt: bigint; closesAt: bigint },
  ref: { l1RefNumber: bigint; l1RefHash: Uint8Array },
) {
  const l1: FinalizedL1 = {
    head: BigInt(blocks.length - 1),
    block: (n) => blocks[Number(n)] as FinalizedL1Block,
  };
  const min = l1RefMin(l1, 0n, window.opensAt);
  if (min === undefined) return "pending";
  return checkL1Reference(ref, l1, { l1RefMin: min, closesAt: window.closesAt });
}

describe("gives the crypto package's verdict over the node's finalized chain", () => {
  test("any chain, window and reference", async () => {
    await fc.assert(
      fc.asyncProperty(
        chainArb,
        fc.nat(),
        fc.nat(),
        fc.integer({ min: -5, max: 405 }),
        fc.boolean(),
        async (blocks, o, len, at, honest) => {
          const last = blocks.at(-1)!.timestamp;
          const opensAt = BigInt(o) % (last + 7_200n);
          const closesAt = opensAt + 1n + (BigInt(len) % (last + 1n));
          const l1RefNumber = BigInt(Math.max(0, at));
          const named = blocks[Number(l1RefNumber)];
          const l1RefHash = honest && named !== undefined ? named.hash : new Uint8Array(32).fill(9);
          const window = { opensAt, closesAt };
          const ref = { l1RefNumber, l1RefHash };
          const l1 = new L1References({ source: sourceOf(blocks).s });
          expect(await l1.judge(window, ref)).toBe(expected(blocks, window, ref));
        },
      ),
      { numRuns },
    );
  });

  test("every verdict is reached", async () => {
    // Blocks every 12 s from t = 100,000.
    const blocks = Array.from({ length: 1_000 }, (_, i) => ({
      hash: new Uint8Array(32).fill(i % 251),
      timestamp: 100_000n + 12n * BigInt(i),
    }));
    const window = { opensAt: 100_000n + 12n * 500n, closesAt: 100_000n + 12n * 800n };
    const judge = (n: bigint, hash = blocks[Number(n)]?.hash ?? new Uint8Array(32)) =>
      new L1References({ source: sourceOf(blocks).s }).judge(window, {
        l1RefNumber: n,
        l1RefHash: hash,
      });
    expect(await judge(600n)).toBe("admitted");
    // An hour before opening is 300 blocks back: block 200 is the first allowed.
    expect(await judge(200n)).toBe("admitted");
    expect(await judge(199n)).toBe("l1-ref-before-open");
    expect(await judge(801n)).toBe("l1-ref-after-close");
    expect(await judge(600n, new Uint8Array(32).fill(250))).toBe("l1-ref-unknown");
    // Beyond the head, which is before close.
    const short = sourceOf(blocks);
    short.setHead(700n);
    expect(
      await new L1References({ source: short.s }).judge(window, {
        l1RefNumber: 750n,
        l1RefHash: new Uint8Array(32),
      }),
    ).toBe("pending");
  });
});

test("one instance, its head moving up the chain, gives each judgement the verdict over that prefix", async () => {
  await fc.assert(
    fc.asyncProperty(
      chainArb,
      fc.array(
        fc.record({
          grow: fc.nat(60),
          o: fc.nat(),
          len: fc.nat(),
          at: fc.nat(450),
          honest: fc.boolean(),
        }),
        { minLength: 1, maxLength: 12 },
      ),
      async (blocks, steps) => {
        const src = sourceOf(blocks);
        const last = blocks.at(-1)!.timestamp;
        // Two windows, so cached starts are shared and kept apart.
        const opens = [
          BigInt(steps[0]!.o) % (last + 7_200n),
          BigInt(steps.at(-1)!.o) % (last + 7_200n),
        ];
        const l1 = new L1References({ source: src.s, headTtlMs: 0 });
        let head = 0;
        for (const [i, { grow, len, at, honest }] of steps.entries()) {
          head = Math.min(blocks.length - 1, head + grow);
          src.setHead(BigInt(head));
          const opensAt = opens[i % 2]!;
          const window = { opensAt, closesAt: opensAt + 1n + (BigInt(len) % (last + 1n)) };
          const named = blocks[at];
          const ref = {
            l1RefNumber: BigInt(at),
            l1RefHash: honest && named !== undefined ? named.hash : new Uint8Array(32).fill(9),
          };
          expect(await l1.judge(window, ref)).toBe(
            expected(blocks.slice(0, head + 1), window, ref),
          );
        }
      },
    ),
    { numRuns },
  );
});

describe("reads only what it needs, and keeps what can't change", () => {
  const blocks = Array.from({ length: 4_000 }, (_, i) => ({
    hash: new Uint8Array(32).fill(i % 251),
    timestamp: 1_000n + 12n * BigInt(i),
  }));
  const window = { opensAt: 1_000n + 12n * 2_000n, closesAt: 1_000n + 12n * 3_900n };
  const ref = (n: number) => ({ l1RefNumber: BigInt(n), l1RefHash: blocks[n]!.hash });

  test("the window's start once per opens_at, then one block per new reference", async () => {
    const src = sourceOf(blocks);
    const l1 = new L1References({ source: src.s });
    expect(await l1.judge(window, ref(2_500))).toBe("admitted");
    // A binary search over 4,000 blocks, plus block 0 and the reference.
    expect(src.reads.length).toBeLessThanOrEqual(16);
    const before = src.reads.length;
    expect(await l1.judge(window, ref(2_600))).toBe("admitted");
    expect(await l1.judge(window, ref(2_600))).toBe("admitted");
    expect(src.reads.length - before).toBe(1);
  });

  test("the head is read once per lifetime, and only blocks up to it are asked for", async () => {
    let now = 0;
    const src = sourceOf(blocks);
    src.setHead(2_500n);
    const l1 = new L1References({ source: src.s, headTtlMs: 12_000, now: () => now });
    expect(await l1.judge(window, ref(2_600))).toBe("pending");
    src.setHead(3_000n);
    now = 11_999;
    expect(await l1.judge(window, ref(2_600))).toBe("pending");
    expect(src.heads()).toBe(1);
    now = 12_000;
    expect(await l1.judge(window, ref(2_600))).toBe("admitted");
    // A node (a load balancer's other one, say) behind the head already
    // seen: its own head bounds what it is asked for.
    src.setHead(2_500n);
    now = 24_000;
    const before = src.reads.length;
    expect(await l1.judge(window, ref(2_550))).toBe("pending");
    expect(src.heads()).toBe(3);
    expect(src.reads.slice(before).every((n) => n <= 2_500n)).toBe(true);
  });

  test("a window L1 hasn't reached is never kept", async () => {
    const src = sourceOf(blocks);
    src.setHead(1_000n);
    let now = 0;
    const l1 = new L1References({ source: src.s, headTtlMs: 1, now: () => now });
    expect(await l1.judge(window, ref(1_500))).toBe("pending");
    src.setHead(3_000n);
    now = 10;
    expect(await l1.judge(window, ref(1_500))).toBe("l1-ref-before-open");
  });

  test("a node's failure, a head that isn't a u64 or a block that breaks the rules throws", async () => {
    const failing: FinalizedL1Source = {
      chainId: 1n,
      finalizedHead: async () => 10n,
      block: async () => {
        throw new Error("down");
      },
    };
    await expect(new L1References({ source: failing }).judge(window, ref(5))).rejects.toThrow(
      "down",
    );
    const wild: FinalizedL1Source = { ...failing, finalizedHead: async () => -1n };
    await expect(new L1References({ source: wild }).judge(window, ref(5))).rejects.toThrow(
      RangeError,
    );
    const badHash: FinalizedL1Source = {
      ...failing,
      block: async () => ({ hash: new Uint8Array(31), timestamp: 10n ** 12n }),
    };
    await expect(new L1References({ source: badHash }).judge(window, ref(5))).rejects.toThrow();
  });

  test("a node that runs past the budget fails the judgement, and isn't asked again for a while", async () => {
    let now = 0;
    let asked = 0;
    const hanging: FinalizedL1Source = {
      chainId: 1n,
      finalizedHead: () => {
        asked++;
        return new Promise(() => {});
      },
      block: () => new Promise(() => {}),
    };
    const l1 = new L1References({
      source: hanging,
      budgetMs: 20,
      headTtlMs: 1_000,
      now: () => now,
    });
    await expect(l1.judge(window, ref(5))).rejects.toThrow("took too long");
    // Within the head's lifetime the node isn't asked: a batch of ballots
    // waits on a slow node once.
    now = 999;
    await expect(l1.judge(window, ref(5))).rejects.toThrow("a moment ago");
    expect(asked).toBe(1);
    now = 1_000;
    await expect(l1.judge(window, ref(5))).rejects.toThrow("took too long");
    expect(asked).toBe(2);
  });

  test("judgements sharing a deadline wait on the node one budget in all", async () => {
    let now = 0;
    const src = sourceOf(blocks);
    const slow: FinalizedL1Source = {
      chainId: 1n,
      finalizedHead: () => src.s.finalizedHead(),
      block: async (n) => {
        now += 400;
        return src.s.block(n);
      },
    };
    const l1 = new L1References({ source: slow, budgetMs: 1_000, now: () => now });
    const deadline = l1.deadline();
    // The window's search alone outlasts the budget.
    await expect(l1.judge(window, ref(2_500), deadline)).rejects.toThrow();
    now = 100_000;
    const fresh = new L1References({ source: src.s, now: () => now });
    const spent = fresh.deadline() - 2_001;
    const heads = src.heads();
    await expect(fresh.judge(window, ref(2_500), spent)).rejects.toThrow("spent");
    expect(src.heads()).toBe(heads);
  });

  test("refuses options out of range", () => {
    const { s } = sourceOf(blocks);
    expect(() => new L1References({ source: s, headTtlMs: -1 })).toThrow(RangeError);
    expect(() => new L1References({ source: s, cacheSize: 63 })).toThrow(RangeError);
    expect(() => new L1References({ source: s, budgetMs: 0 })).toThrow(RangeError);
  });
});
