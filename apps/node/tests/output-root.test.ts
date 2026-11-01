import { ACCUMULATOR_SLOT, OutputRootError } from "@abolishus/verifier";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  accumulatorUnderRoot,
  type ClaimedOutputRoot,
  GameBlockError,
  MAX_GAMES_SCANNED,
  MESSAGE_PASSER,
  respectedOutputRoots,
} from "../src/output-root.ts";
import { type Rpc, RpcError } from "../src/rpc.ts";
import { type Chain, hex, startChain, word } from "./anvil.ts";

// A contract's accumulator proven under the newest output root a respected
// dispute game claims (src/output-root.ts; P2-13 part 3c). Anvil stands in
// for the L2 node, so blocks, headers and trie proofs are its own; each
// output root is computed here from the block's state root and hash, as a
// proposer posts it. The L1 side is Anvil's finalized head with the portal,
// factory and games scripted over `eth_call` (T-71, T-34).

let chain: Chain;
const REGISTRY = hexToBytes("00000000000000000000000000000000000e1ec7");
const NO_CODE = hexToBytes("00000000000000000000000000000000000b0a0d");
const ACC_1 = keccak_256(Uint8Array.of(1));
const ACC_2 = keccak_256(Uint8Array.of(2));
let b1: bigint;
let b2: bigint;

const quantity = (n: bigint) => `0x${n.toString(16)}`;

beforeAll(async () => {
  chain = await startChain();
  // Code that stores its calldata's second word at its first (PUSH1 0x20
  // CALLDATALOAD PUSH1 0 CALLDATALOAD SSTORE STOP), written to by
  // transactions: anvil_setStorageAt rewrites past blocks' storage too,
  // which would leave b1's proofs b2's.
  await chain.rpc.call("anvil_setCode", [hex(REGISTRY), "0x602035600035550000"]);
  const [from] = (await chain.rpc.call("eth_accounts", [])) as [string];
  const write = async (key: bigint, value: Uint8Array) => {
    const hash = await chain.rpc.call("eth_sendTransaction", [
      { from, to: hex(REGISTRY), data: hex(concatBytes(word(key), value)) },
    ]);
    for (;;) {
      const receipt = (await chain.rpc.call("eth_getTransactionReceipt", [hash])) as {
        blockNumber: string;
      } | null;
      if (receipt !== null) return BigInt(receipt.blockNumber);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  await write(ACCUMULATOR_SLOT, ACC_1);
  b1 = await write(ACCUMULATOR_SLOT + 1n, word(3n));
  await write(ACCUMULATOR_SLOT, ACC_2);
  b2 = await write(ACCUMULATOR_SLOT + 1n, word(4n));
  await chain.mine(4);
}, 60_000);

afterAll(() => chain?.stop());

/** The version-0 output root of Anvil's block `n`, written out from the OP Stack's definition. */
async function rootOf(n: bigint): Promise<Uint8Array> {
  const block = (await chain.rpc.call("eth_getBlockByNumber", [quantity(n), false])) as {
    stateRoot: string;
    hash: string;
  };
  const passer = (await chain.rpc.call("eth_getProof", [hex(MESSAGE_PASSER), [], quantity(n)])) as {
    storageHash: string;
  };
  return keccak_256(
    concatBytes(
      new Uint8Array(32),
      hexToBytes(block.stateRoot.slice(2)),
      hexToBytes(passer.storageHash.slice(2)),
      hexToBytes(block.hash.slice(2)),
    ),
  );
}

const timestampOf = async (n: bigint): Promise<bigint> =>
  BigInt(
    ((await chain.rpc.call("eth_getBlockByNumber", [quantity(n), false])) as { timestamp: string })
      .timestamp,
  );

const claim = async (rootBlock: bigint, l2Block = rootBlock): Promise<ClaimedOutputRoot> => ({
  outputRoot: await rootOf(rootBlock),
  l2Block,
});

/** Anvil behind a node answering requests about block `asked` with block `served`'s answers, for `methods`. */
const lyingNode = (asked: bigint, served: bigint, methods: readonly string[]): Rpc => ({
  call: (method, params) =>
    chain.rpc.call(
      method,
      params.map((p) => (methods.includes(method) && p === quantity(asked) ? quantity(served) : p)),
    ),
});

describe("accumulatorUnderRoot", () => {
  test("proves the contract's accumulator and count at the root's block, with its timestamp", async () => {
    expect(await accumulatorUnderRoot(chain.rpc, await claim(b1), REGISTRY)).toEqual({
      block: b1,
      timestamp: await timestampOf(b1),
      accumulator: ACC_1,
      count: 3n,
    });
    expect(await accumulatorUnderRoot(chain.rpc, await claim(b2), REGISTRY)).toEqual({
      block: b2,
      timestamp: await timestampOf(b2),
      accumulator: ACC_2,
      count: 4n,
    });
  });

  test("refuses a root of another block than the one the node proves", async () => {
    await expect(
      accumulatorUnderRoot(chain.rpc, { ...(await claim(b2)), l2Block: b1 }, REGISTRY),
    ).rejects.toMatchObject({ name: "OutputRootError", code: "output-root" });
  });

  test("refuses a node that serves another block's header or another block's proofs", async () => {
    const root = await claim(b1);
    await expect(
      accumulatorUnderRoot(lyingNode(b1, b2, ["eth_getBlockByNumber"]), root, REGISTRY),
    ).rejects.toMatchObject({ code: "output-root" });
    // The newer storage, as a node lying about the contract would serve it.
    const refused = await accumulatorUnderRoot(
      lyingNode(b1, b2, ["eth_getProof"]),
      root,
      REGISTRY,
    ).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(OutputRootError);
    expect(["output-root", "l2-proof-missing"]).toContain((refused as OutputRootError).code);
  });

  test("refuses a root that proves another block than the one its game claims", async () => {
    // The game claims b2 with b1's root, and the node answers b1 for b2.
    await expect(
      accumulatorUnderRoot(
        lyingNode(b2, b1, ["eth_getBlockByNumber", "eth_getProof"]),
        await claim(b1, b2),
        REGISTRY,
      ),
    ).rejects.toThrow(GameBlockError);
  });

  test("refuses answers that can't be read as the node's error", async () => {
    const garbled = (
      method: string,
      change: (answer: Record<string, unknown>) => unknown,
    ): Rpc => ({
      call: async (m, params) => {
        const answer = (await chain.rpc.call(m, params)) as Record<string, unknown>;
        return m === method ? change(answer) : answer;
      },
    });
    const root = await claim(b1);
    for (const node of [
      garbled("eth_getProof", (p) => ({ ...p, accountProof: ["0xzz"] })),
      garbled("eth_getProof", (p) => ({ ...p, storageHash: "0x01" })),
      garbled("eth_getBlockByNumber", (b) => ({ ...b, timestamp: "0x" })),
      garbled("eth_getBlockByNumber", () => null),
    ])
      await expect(accumulatorUnderRoot(node, root, REGISTRY)).rejects.toThrow(RpcError);
  });

  test("refuses an address without code", async () => {
    await expect(accumulatorUnderRoot(chain.rpc, await claim(b1), NO_CODE)).rejects.toMatchObject({
      code: "l2-contract-absent",
    });
  });
});

// The L1 side: Anvil's finalized head, with a portal and its factory's
// games answering `eth_call` as scripted.

const PORTAL = hexToBytes("000000000000000000000000000000000000b047");
const FACTORY = hexToBytes("00000000000000000000000000000000000fac70");
const PINNED = 621n;

interface Game {
  readonly type: bigint;
  readonly root: Uint8Array;
  readonly l2: bigint;
  readonly status: bigint;
}

const proxyOf = (i: number) => word(0x9a3e0000n + BigInt(i)).slice(12);
const selector = (s: string) => hex(keccak_256(new TextEncoder().encode(s)).slice(0, 4));

function l1Of(games: readonly Game[], respected = PINNED, answer?: (fn: string) => unknown) {
  const calls: { fn: string; block: unknown }[] = [];
  const rpc: Rpc = {
    call: async (method, params) => {
      if (method !== "eth_call") return chain.rpc.call(method, params);
      const [{ to, data }, block] = params as [{ to: string; data: string }, unknown];
      const fn = [
        "disputeGameFactory()",
        "respectedGameType()",
        "gameCount()",
        "gameAtIndex(uint256)",
        "rootClaim()",
        "l2SequenceNumber()",
        "status()",
      ].find((s) => data.startsWith(selector(s)));
      if (fn === undefined) throw new Error(`unexpected call ${data}`);
      calls.push({ fn, block });
      const scripted = answer?.(fn);
      if (scripted !== undefined) return scripted;
      const words = (...w: Uint8Array[]) => hex(concatBytes(...w));
      if (to === hex(PORTAL) && fn === "disputeGameFactory()")
        return words(word(BigInt(hex(FACTORY))));
      if (to === hex(PORTAL) && fn === "respectedGameType()") return words(word(respected));
      if (to === hex(FACTORY) && fn === "gameCount()") return words(word(BigInt(games.length)));
      if (to === hex(FACTORY) && fn === "gameAtIndex(uint256)") {
        const i = Number(BigInt(`0x${data.slice(10)}`));
        const g = games[i] as Game;
        return words(word(g.type), word(1_700_000_000n + BigInt(i)), word(BigInt(hex(proxyOf(i)))));
      }
      const g = games[games.findIndex((_, j) => hex(proxyOf(j)) === to)] as Game;
      if (fn === "rootClaim()") return words(g.root);
      if (fn === "l2SequenceNumber()") return words(word(g.l2));
      if (fn === "status()") return words(word(g.status));
      throw new Error(`unexpected ${fn} at ${to}`);
    },
  };
  return { rpc, calls };
}

const game = (type: bigint, n: number, status = 0n): Game => ({
  type,
  root: word(BigInt(n) * 1_000_003n),
  l2: BigInt(n) * 100n,
  status,
});

const blocks = (claims: readonly ClaimedOutputRoot[]) => claims.map((c) => c.l2Block);

describe("respectedOutputRoots", () => {
  test("names the portal's type's games not shown false, every read at the finalized head", async () => {
    const { rpc, calls } = l1Of([
      game(PINNED, 1, 2n),
      game(PINNED, 2, 0n),
      game(1n, 3),
      // CHALLENGER_WINS
      game(PINNED, 4, 1n),
      game(0n, 5),
    ]);
    expect(await respectedOutputRoots(rpc, PORTAL)).toEqual([
      { outputRoot: game(PINNED, 2).root, l2Block: 200n },
      { outputRoot: game(PINNED, 1).root, l2Block: 100n },
    ]);
    const finalized = (await chain.rpc.call("eth_getBlockByNumber", ["finalized", false])) as {
      number: string;
    };
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.block).toBe(finalized.number);
  });

  test("lists the highest claimed block first, not the newest game, so old roots can't move it back", async () => {
    const { rpc } = l1Of([game(PINNED, 1), game(PINNED, 5), game(PINNED, 2), game(PINNED, 3)]);
    expect(blocks(await respectedOutputRoots(rpc, PORTAL))).toEqual([500n, 300n, 200n, 100n]);
  });

  test("follows the type the portal respects, never another", async () => {
    const games = [game(PINNED, 1), game(1n, 2), game(PINNED, 3)];
    expect(blocks(await respectedOutputRoots(l1Of(games, 1n).rpc, PORTAL))).toEqual([200n]);
    expect(await respectedOutputRoots(l1Of(games, 0n).rpc, PORTAL)).toEqual([]);
  });

  test("passes over a claim of a block past a u64, which no proof can reach", async () => {
    const far = { ...game(PINNED, 2), l2: 1n << 64n };
    expect(blocks(await respectedOutputRoots(l1Of([game(PINNED, 1), far]).rpc, PORTAL))).toEqual([
      100n,
    ]);
  });

  test("reads back at most MAX_GAMES_SCANNED games", async () => {
    const games = [
      game(PINNED, 1),
      ...Array.from({ length: Number(MAX_GAMES_SCANNED) }, (_, i) => game(7n, i + 2)),
    ];
    const { rpc, calls } = l1Of(games);
    expect(await respectedOutputRoots(rpc, PORTAL)).toEqual([]);
    expect(calls.filter((c) => c.fn === "gameAtIndex(uint256)")).toHaveLength(
      Number(MAX_GAMES_SCANNED),
    );
    // One fewer game puts the first among those read back.
    expect(blocks(await respectedOutputRoots(l1Of(games.slice(0, -1)).rpc, PORTAL))).toEqual([
      100n,
    ]);
  });

  test("an empty factory names no root", async () => {
    expect(await respectedOutputRoots(l1Of([]).rpc, PORTAL)).toEqual([]);
  });

  test("passes over a game whose own reads fail, so one can't stop the read", async () => {
    const games = [game(PINNED, 1), game(PINNED, 2)];
    for (const [fn, bad] of [
      ["status()", hex(word(256n))],
      ["rootClaim()", "0x01"],
      ["l2SequenceNumber()", "0x"],
    ] as const)
      expect(
        await respectedOutputRoots(
          l1Of(games, PINNED, (f) => (f === fn ? bad : undefined)).rpc,
          PORTAL,
        ),
        fn,
      ).toEqual([]);
  });

  test("refuses an answer about the portal or factory no contract of that interface returns", async () => {
    const games = [game(PINNED, 1)];
    for (const [fn, bad] of [
      ["respectedGameType()", hex(word(1n << 32n))],
      ["disputeGameFactory()", hex(word(1n << 160n))],
      ["gameAtIndex(uint256)", hex(word(PINNED))],
      ["gameCount()", 7],
    ] as const)
      await expect(
        respectedOutputRoots(l1Of(games, PINNED, (f) => (f === fn ? bad : undefined)).rpc, PORTAL),
        fn,
      ).rejects.toThrow(RpcError);
  });
});
