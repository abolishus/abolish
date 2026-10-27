import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import { contractSequence, L2Error, l2Finalized, registration } from "../src/l2.ts";
import { type Rpc, RpcError } from "../src/rpc.ts";

// The L2 reader's answers come from a node it doesn't trust for their form:
// whatever an `eth_getLogs` or `eth_getBlockByNumber` answer holds, the
// reader returns or refuses it with its own errors, never another throw
// (T-52, T-53).

const runs = Number(process.env["FC_NUM_RUNS"] ?? 100);
const registry = new Uint8Array(20).fill(7);
const electionId = new Uint8Array(32).fill(9);
const hex = fc.string({
  unit: fc.constantFrom(..."0123456789abcdefABCDEF".split("")),
  maxLength: 80,
});
const log = fc.record(
  {
    address: fc.oneof(fc.constant(`0x${"07".repeat(20)}`), fc.string(), fc.integer()),
    topics: fc.oneof(
      fc.array(
        hex.map((h) => `0x${h}`),
        { maxLength: 5 },
      ),
      fc.anything(),
    ),
    data: fc.oneof(
      hex.map((h) => `0x${h}`),
      fc.anything(),
    ),
    blockNumber: fc.oneof(
      hex.map((h) => `0x${h}`),
      fc.anything(),
    ),
  },
  { requiredKeys: [] },
);
const answer = fc.oneof(fc.array(fc.oneof(log, fc.anything()), { maxLength: 6 }), fc.anything());

describe("the L2 reader", () => {
  test("refuses any logs answer with its own errors, never another throw", async () => {
    await fc.assert(
      fc.asyncProperty(answer, async (logs) => {
        const node: Rpc = { call: async () => logs };
        try {
          await registration(node, registry, electionId, 0n, 100n);
        } catch (e) {
          expect(e instanceof L2Error || e instanceof RpcError).toBe(true);
        }
      }),
      { numRuns: runs },
    );
  });

  test("takes a finalized block number only as a canonical quantity", async () => {
    await fc.assert(
      fc.asyncProperty(fc.anything(), async (block) => {
        const node: Rpc = { call: async () => block };
        const number = (block as { number?: unknown } | null)?.number;
        const canonical =
          typeof number === "string" && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,15})$/u.test(number);
        if (canonical) expect(await l2Finalized(node)).toBe(BigInt(number));
        else await expect(l2Finalized(node)).rejects.toThrow(RpcError);
      }),
      { numRuns: runs },
    );
    expect(await l2Finalized({ call: async () => ({ number: "0x64" }) })).toBe(100n);
    await expect(l2Finalized({ call: async () => ({ number: "0x064" }) })).rejects.toThrow(
      RpcError,
    );
  });

  test("refuses any answers to a sequence read with its own errors, never another throw", async () => {
    await fc.assert(
      fc.asyncProperty(answer, fc.anything(), async (logs, block) => {
        const node: Rpc = {
          call: async (method) => (method === "eth_getLogs" ? logs : block),
        };
        try {
          await contractSequence(node, registry, 0n, 100n);
        } catch (e) {
          expect(e).toBeInstanceOf(RpcError);
        }
      }),
      { numRuns: runs },
    );
  });
});

describe("contractSequence", () => {
  const word = (b: number) => `0x${b.toString(16).padStart(2, "0").repeat(32)}`;
  const at = (block: number, topic: number, extra: Record<string, unknown> = {}) => ({
    address: `0x${"07".repeat(20)}`,
    topics: [word(topic)],
    data: "0x",
    blockNumber: `0x${block.toString(16)}`,
    ...extra,
  });
  const node = (logs: unknown[]) => {
    const asked: unknown[][] = [];
    const rpc: Rpc = {
      call: async (method, params) => {
        asked.push([method, ...params]);
        if (method === "eth_getLogs") return logs;
        const n = BigInt(params[0] as string);
        return { number: params[0], timestamp: `0x${(1000n + n).toString(16)}` };
      },
    };
    return { rpc, asked };
  };

  test("numbers every log of the contract from 0, each with its block's time", async () => {
    const { rpc, asked } = node([
      at(5, 1),
      at(5, 2),
      at(7, 3, { blockTimestamp: "0x99" }),
      at(9, 4),
      // Not the contract's, or with no topic: dropped.
      { ...at(9, 5), address: `0x${"08".repeat(20)}` },
      { ...at(9, 6), topics: [] },
    ]);
    const records = await contractSequence(rpc, registry, 2n, 10n);
    expect(records.map((r) => [r.n, r.l2_block, r.l2_timestamp, r.topics[0]?.[0]])).toEqual([
      [0n, 5n, 1005n, 1],
      [1n, 5n, 1005n, 2],
      [2n, 7n, 0x99n, 3],
      [3n, 9n, 1009n, 4],
    ]);
    // Every event, one header a block whose logs carry no time.
    expect(asked).toEqual([
      [
        "eth_getLogs",
        { address: `0x${"07".repeat(20)}`, fromBlock: "0x2", toBlock: "0xa", topics: [] },
      ],
      ["eth_getBlockByNumber", "0x5", false],
      ["eth_getBlockByNumber", "0x9", false],
    ]);
  });

  test("refuses a block answer of another number or without a u64 time", async () => {
    for (const block of [
      { number: "0x6", timestamp: "0x1" },
      { number: "0x5", timestamp: `0x1${"0".repeat(16)}` },
      { number: "0x5" },
      null,
    ]) {
      const rpc: Rpc = {
        call: async (method) => (method === "eth_getLogs" ? [at(5, 1)] : block),
      };
      await expect(contractSequence(rpc, registry, 0n, 10n)).rejects.toThrow(RpcError);
    }
  });
});
