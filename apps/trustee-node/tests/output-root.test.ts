import type { Rpc } from "@abolishus/node";
import { RpcError } from "@abolishus/node";
import { describe, expect, test } from "vite-plus/test";
import { registry } from "../../../packages/verifier/tests/registry-logs.ts";
import { l1OutputRootAccumulators } from "../src/output-root.ts";

// The registries' accumulators under an output root the seat's L1 node shows
// (P2-13 parts 3c and 3d). The games' read and the proof are apps/node's,
// tested there (tests/output-root.test.ts); tests/cli.test.ts runs both
// over Anvil and a scripted L1.

describe("l1OutputRootAccumulators", () => {
  test("refuses an L1 node of another chain, reading nothing else", async () => {
    const asked: string[] = [];
    const node = (chain: string): Rpc => ({
      call: async (method) => {
        asked.push(method);
        if (method === "eth_chainId") return chain;
        throw new Error(`unexpected ${method}`);
      },
    });
    const accumulators = l1OutputRootAccumulators({
      l1: node("0x1"),
      l1ChainId: 11_155_111n,
      portal: new Uint8Array(20).fill(0x90),
      l2: node("0x2"),
    });
    await expect(accumulators([registry], 0n)).rejects.toThrow(RpcError);
    expect(asked).toEqual(["eth_chainId"]);
  });
});
