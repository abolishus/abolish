import { decodeHeader } from "@abolishus/verifier";
import { bytesToHex } from "@noble/hashes/utils.js";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { finalizedBlock, type HeaderBlock, headerRun } from "../src/l1.ts";
import { type Rpc, RpcError } from "../src/rpc.ts";
import { type Chain, startChain } from "./anvil.ts";

// The run of finalized L1 headers a format-5 bundle carries (P4-5 part 3b):
// on Anvil, with blocks 1,000 seconds apart, every run must be the slice a
// linear scan of the chain gives, from the last block before the window to
// the first after it, linked by parent hashes, and a node that answers
// another block, or a block of another history, is refused (T-36, T-52).

const numRuns = Math.min(Number(process.env["FC_NUM_RUNS"] ?? 100), 200);
const GAP = 1000n;

interface Block {
  readonly number: string;
  readonly hash: string;
  readonly timestamp: string;
}

let chain: Chain;
let head: HeaderBlock;
// Every block up to the finalized one, as the node answers them.
let blocks: { readonly number: bigint; readonly hash: string; readonly timestamp: bigint }[];
beforeAll(async () => {
  chain = await startChain();
  await chain.rpc.call("anvil_mine", ["0x1e", `0x${GAP.toString(16)}`]);
  head = await finalizedBlock(chain.rpc);
  blocks = [];
  for (let n = 0n; n <= head.header.number; n++) {
    const b = (await chain.rpc.call("eth_getBlockByNumber", [
      `0x${n.toString(16)}`,
      false,
    ])) as Block;
    blocks.push({ number: n, hash: b.hash.slice(2), timestamp: BigInt(b.timestamp) });
  }
}, 120_000);
afterAll(async () => {
  await chain?.stop();
});

// The run by its definition, by scanning every block.
function expected(before: bigint, after: bigint): bigint[] {
  let start = 0;
  blocks.forEach((b, i) => {
    if (b.timestamp < before) start = i;
  });
  let end = blocks.length - 1;
  for (let i = blocks.length - 1; i >= start; i--) if (blocks[i]!.timestamp > after) end = i;
  return blocks.slice(start, end + 1).map((b) => b.number);
}

const read = (run: readonly Uint8Array[]) => run.map(decodeHeader);

function expectRun(run: readonly Uint8Array[], numbers: readonly bigint[]) {
  const headers = read(run);
  expect(headers.map((h) => h.number)).toEqual(numbers);
  for (const h of headers) expect(bytesToHex(h.hash)).toBe(blocks[Number(h.number)]!.hash);
}

const time = (n: number) => blocks[n]!.timestamp;

describe("headerRun", () => {
  test("is the chain's slice from the last block before the window to the first after it", async () => {
    // Before 5's time and after 12's: from 4 to 13.
    const run = await headerRun(chain.rpc, head, { before: time(5), after: time(12) });
    expectRun(run, [4n, 5n, 6n, 7n, 8n, 9n, 10n, 11n, 12n, 13n]);
  });

  test("starts at block 0 with no block before the window, and ends in the finalized header with none after it", async () => {
    const run = await headerRun(chain.rpc, head, { before: 0n, after: time(blocks.length - 1) });
    expectRun(
      run,
      blocks.map((b) => b.number),
    );
    expect(bytesToHex(run.at(-1)!)).toBe(bytesToHex(head.rlp));
  });

  test("is the finalized header alone before the window opens, and block 0 alone after a window before the chain", async () => {
    const late = await headerRun(chain.rpc, head, {
      before: head.header.timestamp + 1n,
      after: head.header.timestamp + 10n * GAP,
    });
    expect(late.map(bytesToHex)).toEqual([bytesToHex(head.rlp)]);
    const early = await headerRun(chain.rpc, head, { before: 0n, after: time(0) - 1n });
    expectRun(early, [0n]);
  });

  // Up to 200 runs, each a handful of calls to Anvil: past vitest's 5 s default
  // on a loaded runner (seen on #717).
  test("any window gives the slice a scan of the chain gives", async () => {
    const last = blocks.at(-1)!.timestamp;
    const instant = fc.bigInt({ min: time(0) - 2n * GAP, max: last + 2n * GAP });
    await fc.assert(
      fc.asyncProperty(instant, instant, async (a, b) => {
        const [before, after] = a <= b ? [a, b] : [b, a];
        const run = await headerRun(chain.rpc, head, { before, after });
        expectRun(run, expected(before, after));
      }),
      { numRuns },
    );
  }, 60_000);

  test("past its byte budget keeps the latest blocks and starts later", async () => {
    const full = await headerRun(chain.rpc, head, { before: time(5), after: time(12) });
    const budget = full.slice(-3).reduce((n, h) => n + h.length, 0);
    const cut = await headerRun(chain.rpc, head, { before: time(5), after: time(12) }, budget);
    expectRun(cut, [11n, 12n, 13n]);
    const none = await headerRun(chain.rpc, head, { before: time(5), after: time(12) }, budget - 1);
    expectRun(none, [12n, 13n]);
  });

  test("refuses a node answering another block's header for a number", async () => {
    const shifted: Rpc = {
      call: async (method, params) => {
        if (method === "eth_getBlockByNumber" && params[0] === "0x7")
          return chain.rpc.call(method, ["0x8", false]);
        return chain.rpc.call(method, params);
      },
    };
    await expect(headerRun(shifted, head, { before: time(5), after: time(12) })).rejects.toThrow(
      new RpcError("block 7: another block's header"),
    );
  });

  test("refuses a block of another history between the ends", async () => {
    // A block 9 of a fork: mined, recorded, then reverted and mined again at
    // another time, so it is a well-formed block 9 that block 10 doesn't name.
    const fork = await startChain();
    try {
      await fork.rpc.call("anvil_mine", ["0x1e", `0x${(GAP + 1n).toString(16)}`]);
      const other = await fork.rpc.call("eth_getBlockByNumber", ["0x9", false]);
      const forked: Rpc = {
        call: async (method, params) =>
          method === "eth_getBlockByNumber" && params[0] === "0x9"
            ? other
            : chain.rpc.call(method, params),
      };
      await expect(headerRun(forked, head, { before: time(5), after: time(12) })).rejects.toThrow(
        new RpcError("block 10: its parent isn't block 9"),
      );
    } finally {
      await fork.stop();
    }
  }, 60_000);

  test("refuses an answer that isn't a block", async () => {
    const broken: Rpc = {
      call: async (method, params) =>
        method === "eth_getBlockByNumber" && params[0] !== "finalized"
          ? null
          : chain.rpc.call(method, params),
    };
    await expect(headerRun(broken, head, { before: time(5), after: time(12) })).rejects.toThrow(
      RpcError,
    );
  });
});
