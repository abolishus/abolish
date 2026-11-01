import {
  accumulatorUnderRoot,
  type ClaimedOutputRoot,
  respectedOutputRoots,
  type Rpc,
  RpcError,
} from "@abolishus/node";
import { OutputRootError } from "@abolishus/verifier";
import { describe, expect, test, vi } from "vite-plus/test";
import { registry } from "../../../packages/verifier/tests/registry-logs.ts";
import { l1OutputRootAccumulators, type ProvenRegistryAccumulator } from "../src/output-root.ts";

// The registries' accumulators under an output root the seat's L1 node shows
// (P2-13 parts 3c and 3d). The games' read and the proof are apps/node's,
// tested there (tests/output-root.test.ts) and stood in for here, so what is
// tested is the choice of claim; tests/cli.test.ts runs both over Anvil and
// a scripted L1.

vi.mock(import("@abolishus/node"), async (original) => ({
  ...(await original()),
  respectedOutputRoots: vi.fn(),
  accumulatorUnderRoot: vi.fn(),
}));

const L1_CHAIN = 11_155_111n;
const other = new Uint8Array(20).fill(0x77);
const node = (chain: bigint): Rpc => ({
  call: async (method) => {
    if (method === "eth_chainId") return `0x${chain.toString(16)}`;
    throw new Error(`unexpected ${method}`);
  },
});
const accumulators = (l1Chain = L1_CHAIN) =>
  l1OutputRootAccumulators({
    l1: node(l1Chain),
    l1ChainId: L1_CHAIN,
    portal: new Uint8Array(20).fill(0x90),
    l2: node(1n),
  });
const claim = (l2Block: bigint): ClaimedOutputRoot => ({
  outputRoot: new Uint8Array(32).fill(Number(l2Block)),
  l2Block,
});
const provenAt = (block: bigint, contract: Uint8Array): ProvenRegistryAccumulator => ({
  block,
  // Any timestamp: these checks read the block, not its time.
  timestamp: block,
  accumulator: Uint8Array.of(contract[0] as number),
  count: block,
});

/** Claims, highest first, and the registries each one's block proves. */
function script(claims: readonly (readonly [bigint, readonly Uint8Array[]])[]) {
  vi.mocked(respectedOutputRoots).mockResolvedValue(claims.map(([b]) => claim(b)));
  vi.mocked(accumulatorUnderRoot).mockImplementation(async (_, root, contract) => {
    const proves = claims.find(([b]) => b === root.l2Block)?.[1] ?? [];
    if (!proves.includes(contract)) throw new OutputRootError("output-root");
    return provenAt(root.l2Block, contract);
  });
}

describe("l1OutputRootAccumulators", () => {
  test("takes the highest claim under which every registry proves, passing over one that proves only some", async () => {
    script([
      [50n, [registry]],
      [40n, [registry, other]],
      [30n, [registry, other]],
    ]);
    expect(await accumulators()([registry, other], 0n)).toEqual([
      provenAt(40n, registry),
      provenAt(40n, other),
    ]);
    expect(await accumulators()([registry], 0n)).toEqual([provenAt(50n, registry)]);
  });

  test("gives nothing when no claim at or after the block proves", async () => {
    script([
      [50n, [registry]],
      [40n, [registry, other]],
    ]);
    expect(await accumulators()([registry, other], 41n)).toBeUndefined();
    script([]);
    expect(await accumulators()([registry], 0n)).toBeUndefined();
  });

  test("refuses an L1 node of another chain, reading no game", async () => {
    vi.mocked(respectedOutputRoots).mockClear();
    await expect(accumulators(1n)([registry], 0n)).rejects.toThrow(RpcError);
    expect(respectedOutputRoots).not.toHaveBeenCalled();
  });

  test("rethrows anything but a claim that doesn't prove", async () => {
    script([[50n, [registry]]]);
    vi.mocked(accumulatorUnderRoot).mockRejectedValue(new TypeError("bug"));
    await expect(accumulators()([registry], 0n)).rejects.toThrow(TypeError);
  });
});
