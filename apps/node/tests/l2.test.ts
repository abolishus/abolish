import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import { L2Error, l2Finalized, registration } from "../src/l2.ts";
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
});
