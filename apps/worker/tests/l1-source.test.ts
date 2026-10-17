import { createPublicClient, custom, toHex } from "viem";
import { describe, expect, test } from "vite-plus/test";
import { ViemL1Source } from "../src/index.ts";

// The ballot L1 check's node adapter (src/l1-source.ts): it refuses a node
// on another chain, reads the finalized head by tag and each block by
// number, and fails a read the node answers for another block or without a
// hash, so a ballot is never judged by a block it didn't ask for (T-34).

const CHAIN = 11_155_111n;
const hashOf = (n: bigint) => toHex(n, { size: 32 });

interface Node {
  readonly chainId?: bigint;
  readonly finalized?: bigint;
  /** What the node answers for block `n`: another number, say, or no hash. */
  readonly answer?: (n: bigint) => { number: bigint | null; hash: string | null };
}

function clientOf({ chainId = CHAIN, finalized = 1_000n, answer }: Node = {}) {
  const calls: { method: string; params: unknown }[] = [];
  const block = (n: bigint) => {
    const a = answer?.(n) ?? { number: n, hash: hashOf(n) };
    return {
      number: a.number === null ? null : toHex(a.number),
      hash: a.hash,
      timestamp: toHex(1_700_000_000n + 12n * n),
      parentHash: hashOf(n === 0n ? 0n : n - 1n),
      transactions: [],
      logsBloom: null,
      nonce: null,
    };
  };
  const client = createPublicClient({
    transport: custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        calls.push({ method, params });
        if (method === "eth_chainId") return toHex(chainId);
        if (method === "eth_getBlockByNumber") {
          const [tag] = params as [string, boolean];
          return block(tag === "finalized" ? finalized : BigInt(tag));
        }
        throw new Error(`unexpected ${method}`);
      },
    }),
  });
  return { client, calls };
}

describe("reads the node's finalized chain", () => {
  test("the finalized head by tag, and each block by its number", async () => {
    const { client, calls } = clientOf();
    const source = await ViemL1Source.connect(client, CHAIN);
    expect(source.chainId).toBe(CHAIN);
    expect(await source.finalizedHead()).toBe(1_000n);
    const b = await source.block(42n);
    expect(b.hash).toEqual(Uint8Array.from(Buffer.from(hashOf(42n).slice(2), "hex")));
    expect(b.timestamp).toBe(1_700_000_000n + 12n * 42n);
    expect(calls.filter((c) => c.method === "eth_getBlockByNumber").map((c) => c.params)).toEqual([
      ["finalized", false],
      [toHex(42n), false],
    ]);
  });
});

describe("refuses what it didn't ask for", () => {
  test("a node on another chain", async () => {
    const { client } = clientOf({ chainId: 1n });
    await expect(ViemL1Source.connect(client, CHAIN)).rejects.toThrow("another chain");
  });

  test("an answer for another block, or one without a hash", async () => {
    const other = await ViemL1Source.connect(
      clientOf({ answer: (n) => ({ number: n + 1n, hash: hashOf(n) }) }).client,
      CHAIN,
    );
    await expect(other.block(42n)).rejects.toThrow("another block");
    const pending = await ViemL1Source.connect(
      clientOf({ answer: (n) => ({ number: n, hash: null }) }).client,
      CHAIN,
    );
    await expect(pending.block(42n)).rejects.toThrow("another block");
  });
});
