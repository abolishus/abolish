import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { ACCUMULATOR_SLOT, OutputRootError } from "@abolishus/verifier";
import {
  type Address,
  concat,
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  type Hex,
  hexToBytes,
  http,
  keccak256,
  parseAbi,
  type PublicClient,
  toHex,
} from "viem";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  type ClaimedOutputRoot,
  DisputeGameRoots,
  GameBlockError,
  MAX_GAMES_SCANNED,
  MESSAGE_PASSER,
  ProvenRegistryAccumulator,
} from "../src/index.ts";

// The registry's accumulator proven under an output root (src/output-roots.ts;
// P3-5 part 3b). Anvil stands in for the L2 node, so blocks, headers and
// trie proofs are its own; each output root is computed here from the
// block's state root and hash, as a proposer would post it. The L1 side is
// a scripted node serving a dispute game factory's games (T-71, T-34).

const CHAIN = 84_532n;
const L1_CHAIN = 11_155_111n;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

async function until<T>(what: string, ms: number, probe: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    let last: unknown;
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`, { cause: last });
    await new Promise((r) => setTimeout(r, 50));
  }
}

let anvil: ChildProcess;
let rpcUrl: string;
let l2: PublicClient;
const REGISTRY: Address = "0x00000000000000000000000000000000000e1ec7";
const NO_CODE: Address = "0x00000000000000000000000000000000000b0a0d";
const ACC_1 = keccak256("0x01");
const ACC_2 = keccak256("0x02");
let b1: bigint;
let b2: bigint;

const slot = (n: bigint) => toHex(n, { size: 32 });
const rpc = (method: string, params: unknown[]) =>
  l2.request({ method: method as "eth_chainId", params: params as never });

beforeAll(async () => {
  const port = await freePort();
  rpcUrl = `http://127.0.0.1:${port}`;
  anvil = spawn(
    "anvil",
    ["--host", "127.0.0.1", "--port", String(port), "--chain-id", String(CHAIN), "--silent"],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  l2 = createPublicClient({ transport: http(rpcUrl) }) as PublicClient;
  await until("anvil", 20_000, async () => {
    if (anvil.exitCode !== null) throw new Error("anvil exited (is the toolchain installed?)");
    return l2.getChainId();
  });
  // The registry is an address given code that stores its calldata's second
  // word at its first (PUSH1 0x20 CALLDATALOAD PUSH1 0 CALLDATALOAD SSTORE
  // STOP), written to by transactions: Anvil's anvil_setStorageAt rewrites
  // past blocks' storage too, which would leave b1's proofs b2's.
  await rpc("anvil_setCode", [REGISTRY, "0x602035600035550000"]);
  const [from] = (await rpc("eth_accounts", [])) as unknown as Hex[];
  // Each write's block, from its receipt: viem caches getBlockNumber.
  const write = async (key: Hex, value: Hex) => {
    const hash = await rpc("eth_sendTransaction", [
      { from, to: REGISTRY, data: concat([key, value]) },
    ]);
    return (await l2.waitForTransactionReceipt({ hash: hash as unknown as Hex })).blockNumber;
  };
  await write(slot(ACCUMULATOR_SLOT), ACC_1);
  b1 = await write(slot(ACCUMULATOR_SLOT + 1n), slot(3n));
  await write(slot(ACCUMULATOR_SLOT), ACC_2);
  b2 = await write(slot(ACCUMULATOR_SLOT + 1n), slot(4n));
}, 60_000);

afterAll(async () => {
  if (anvil !== undefined && anvil.exitCode === null) {
    const exited = new Promise((r) => anvil.once("exit", r));
    anvil.kill("SIGTERM");
    await exited;
  }
});

/** The version-0 output root of Anvil's block `n`, written out from the OP Stack's definition. */
async function rootOf(n: bigint): Promise<Uint8Array> {
  const block = (await rpc("eth_getBlockByNumber", [toHex(n), false])) as unknown as {
    stateRoot: Hex;
    hash: Hex;
  };
  const passer = await l2.getProof({ address: MESSAGE_PASSER, storageKeys: [], blockNumber: n });
  return hexToBytes(keccak256(concat([slot(0n), block.stateRoot, passer.storageHash, block.hash])));
}

const source = (claim: () => Promise<ClaimedOutputRoot>) => ({ latest: claim });

/**
 * Anvil behind a node that answers requests about block `asked` with block
 * `served`'s answers, for the methods in `methods`.
 */
function lyingNode(asked: bigint, served: bigint, methods: readonly string[]) {
  return createPublicClient({
    transport: custom({
      async request({ method, params }: { method: string; params?: unknown[] }) {
        const p = (params ?? []).map((x) =>
          methods.includes(method) && x === toHex(asked) ? toHex(served) : x,
        );
        return rpc(method, p);
      },
    }),
  }) as PublicClient;
}

describe("the L2 node's proven adapter", () => {
  test("proves the registry's accumulator and count at the root's block", async () => {
    const at = async (n: bigint) =>
      (
        await ProvenRegistryAccumulator.connect(
          l2,
          CHAIN,
          source(async () => ({ outputRoot: await rootOf(n), l2Block: n })),
        )
      ).proven(REGISTRY);
    expect(await at(b1)).toEqual({
      block: b1,
      accumulator: hexToBytes(ACC_1),
      count: 3n,
    });
    expect(await at(b2)).toEqual({
      block: b2,
      accumulator: hexToBytes(ACC_2),
      count: 4n,
    });
  });

  test("refuses a root of another block than the one the node proves", async () => {
    const node = await ProvenRegistryAccumulator.connect(
      l2,
      CHAIN,
      source(async () => ({ outputRoot: await rootOf(b2), l2Block: b1 })),
    );
    await expect(node.proven(REGISTRY)).rejects.toThrow(OutputRootError);
    await expect(node.proven(REGISTRY)).rejects.toMatchObject({ code: "output-root" });
  });

  test("refuses a node that serves another block's header or another block's proofs", async () => {
    const claim = source(async () => ({ outputRoot: await rootOf(b1), l2Block: b1 }));
    const header = await ProvenRegistryAccumulator.connect(
      lyingNode(b1, b2, ["eth_getBlockByNumber"]),
      CHAIN,
      claim,
    );
    await expect(header.proven(REGISTRY)).rejects.toMatchObject({ code: "output-root" });
    // The newer storage, as a node that lies about the registry would serve it.
    const proofs = await ProvenRegistryAccumulator.connect(
      lyingNode(b1, b2, ["eth_getProof"]),
      CHAIN,
      claim,
    );
    const refused = await proofs.proven(REGISTRY).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(OutputRootError);
    expect(["output-root", "l2-proof-missing"]).toContain((refused as OutputRootError).code);
  });

  test("refuses a root that proves a block other than the one the game claims", async () => {
    // The game claims b2 with b1's root, and the node answers b1 for b2.
    const node = await ProvenRegistryAccumulator.connect(
      lyingNode(b2, b1, ["eth_getBlockByNumber", "eth_getProof"]),
      CHAIN,
      source(async () => ({ outputRoot: await rootOf(b1), l2Block: b2 })),
    );
    await expect(node.proven(REGISTRY)).rejects.toThrow(GameBlockError);
  });

  test("refuses a node answer that isn't hex as malformed, not as an internal failure", async () => {
    const garbled = createPublicClient({
      transport: custom({
        async request({ method, params }: { method: string; params?: unknown[] }) {
          const answer = (await rpc(method, params ?? [])) as unknown;
          if (method !== "eth_getProof") return answer;
          const proof = answer as { accountProof: string[] };
          return { ...proof, accountProof: ["0xzz", ...proof.accountProof.slice(1)] };
        },
      }),
    }) as PublicClient;
    const node = await ProvenRegistryAccumulator.connect(
      garbled,
      CHAIN,
      source(async () => ({ outputRoot: await rootOf(b1), l2Block: b1 })),
    );
    await expect(node.proven(REGISTRY)).rejects.toMatchObject({ code: "l2-proof-malformed" });
  });

  test("refuses a block field that isn't hex as a header the root can't commit to", async () => {
    const garbled = createPublicClient({
      transport: custom({
        async request({ method, params }: { method: string; params?: unknown[] }) {
          const answer = (await rpc(method, params ?? [])) as unknown;
          if (method !== "eth_getBlockByNumber") return answer;
          return { ...(answer as object), timestamp: "0x" };
        },
      }),
    }) as PublicClient;
    const node = await ProvenRegistryAccumulator.connect(
      garbled,
      CHAIN,
      source(async () => ({ outputRoot: await rootOf(b1), l2Block: b1 })),
    );
    await expect(node.proven(REGISTRY)).rejects.toMatchObject({ code: "l2-header" });
  });

  test("refuses an address without code", async () => {
    const node = await ProvenRegistryAccumulator.connect(
      l2,
      CHAIN,
      source(async () => ({ outputRoot: await rootOf(b1), l2Block: b1 })),
    );
    await expect(node.proven(NO_CODE)).rejects.toMatchObject({ code: "l2-contract-absent" });
  });

  test("refuses a node on another chain", async () => {
    await expect(
      ProvenRegistryAccumulator.connect(
        l2,
        1n,
        source(async () => {
          throw new Error("unreachable");
        }),
      ),
    ).rejects.toThrow("another chain");
  });
});

// The L1 side: a scripted node holding a portal and its factory's games at
// its finalized head.

const abi = parseAbi([
  "function disputeGameFactory() view returns (address)",
  "function respectedGameType() view returns (uint32)",
  "function gameCount() view returns (uint256)",
  "function gameAtIndex(uint256 index) view returns (uint32 gameType, uint64 timestamp, address proxy)",
  "function rootClaim() view returns (bytes32)",
  "function l2SequenceNumber() view returns (uint256)",
  "function status() view returns (uint8)",
]);

const PORTAL: Address = "0x000000000000000000000000000000000000b047";
const FACTORY: Address = "0x00000000000000000000000000000000000fac70";
const FINALIZED = 9_000n;
const PINNED = 621;

interface Game {
  readonly type: number;
  readonly root: Hex;
  readonly l2: bigint;
  readonly status: number;
}

const proxyOf = (i: number): Address => toHex(0x9a3e0000n + BigInt(i), { size: 20 });

function l1Of(games: readonly Game[], options: { chainId?: bigint; respected?: number } = {}) {
  const calls: { fn: string; block: unknown }[] = [];
  const client = createPublicClient({
    transport: custom({
      async request({ method, params }: { method: string; params?: unknown[] }) {
        if (method === "eth_chainId") return toHex(options.chainId ?? L1_CHAIN);
        if (method === "eth_getBlockByNumber") {
          expect(params?.[0]).toBe("finalized");
          return {
            number: toHex(FINALIZED),
            hash: slot(FINALIZED),
            parentHash: slot(FINALIZED - 1n),
            timestamp: toHex(1_800_000_000n),
            transactions: [],
            logsBloom: null,
            nonce: null,
          };
        }
        if (method === "eth_call") {
          const [{ to, data }, block] = params as [{ to: Address; data: Hex }, unknown];
          const { functionName, args } = decodeFunctionData({ abi, data });
          calls.push({ fn: functionName, block });
          const result = (): unknown => {
            if (to.toLowerCase() === PORTAL) {
              if (functionName === "disputeGameFactory") return FACTORY;
              if (functionName === "respectedGameType") return options.respected ?? PINNED;
            }
            if (to.toLowerCase() === FACTORY) {
              if (functionName === "gameCount") return BigInt(games.length);
              if (functionName === "gameAtIndex") {
                const i = Number(args?.[0]);
                return [games[i]!.type, 1_700_000_000n + BigInt(i), proxyOf(i)];
              }
            }
            const i = games.findIndex((_, j) => proxyOf(j).toLowerCase() === to.toLowerCase());
            const g = games[i]!;
            if (functionName === "rootClaim") return g.root;
            if (functionName === "l2SequenceNumber") return g.l2;
            if (functionName === "status") return g.status;
            throw new Error(`unexpected ${functionName}`);
          };
          return encodeFunctionResult({ abi, functionName, result: result() } as never);
        }
        throw new Error(`unexpected ${method}`);
      },
    }),
  }) as PublicClient;
  return { client, calls };
}

const game = (type: number, n: number, status = 0): Game => ({
  type,
  root: slot(BigInt(n) * 1_000_003n),
  l2: BigInt(n) * 100n,
  status,
});

describe("the L1 node's dispute games", () => {
  test("names the portal's type's game not shown false, read at the finalized head", async () => {
    const { client, calls } = l1Of([
      game(PINNED, 1, 2),
      game(PINNED, 2, 0),
      game(1, 3),
      // CHALLENGER_WINS
      game(PINNED, 4, 1),
      game(0, 5),
    ]);
    const roots = await DisputeGameRoots.connect(client, L1_CHAIN, PORTAL);
    expect(await roots.latest()).toEqual({
      outputRoot: hexToBytes(game(PINNED, 2).root),
      l2Block: 200n,
    });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.block).toBe(toHex(FINALIZED));
  });

  test("takes the game claiming the highest block, not the newest, so old roots can't move it back", async () => {
    const { client } = l1Of([game(PINNED, 1), game(PINNED, 5), game(PINNED, 2), game(PINNED, 3)]);
    const roots = await DisputeGameRoots.connect(client, L1_CHAIN, PORTAL);
    expect(await roots.latest()).toEqual({
      outputRoot: hexToBytes(game(PINNED, 5).root),
      l2Block: 500n,
    });
  });

  test("follows the type the portal respects, never another", async () => {
    const games = [game(PINNED, 1), game(1, 2), game(PINNED, 3)];
    const respected = await DisputeGameRoots.connect(
      l1Of(games, { respected: 1 }).client,
      L1_CHAIN,
      PORTAL,
    );
    expect((await respected.latest()).l2Block).toBe(200n);
    const none = await DisputeGameRoots.connect(
      l1Of(games, { respected: 0 }).client,
      L1_CHAIN,
      PORTAL,
    );
    await expect(none.latest()).rejects.toThrow("no output root");
  });

  test("a resolved game in its claim's favour counts as one in progress does", async () => {
    const { client } = l1Of([game(PINNED, 1, 0), game(PINNED, 2, 2)]);
    const roots = await DisputeGameRoots.connect(client, L1_CHAIN, PORTAL);
    expect((await roots.latest()).l2Block).toBe(200n);
  });

  test("reads back at most MAX_GAMES_SCANNED games", async () => {
    const games = [
      game(PINNED, 1),
      ...Array.from({ length: Number(MAX_GAMES_SCANNED) }, (_, i) => game(7, i + 2)),
    ];
    const { client, calls } = l1Of(games);
    const roots = await DisputeGameRoots.connect(client, L1_CHAIN, PORTAL);
    await expect(roots.latest()).rejects.toThrow("no output root");
    expect(calls.filter((c) => c.fn === "gameAtIndex")).toHaveLength(Number(MAX_GAMES_SCANNED));
    // One more game read back finds it.
    const { client: wider } = l1Of(games.slice(0, -1));
    const found = await DisputeGameRoots.connect(wider, L1_CHAIN, PORTAL);
    expect((await found.latest()).l2Block).toBe(100n);
  });

  test("an empty factory names no root", async () => {
    const { client } = l1Of([]);
    const roots = await DisputeGameRoots.connect(client, L1_CHAIN, PORTAL);
    await expect(roots.latest()).rejects.toThrow("no output root");
  });

  test("refuses a node on another chain", async () => {
    const { client } = l1Of([], { chainId: 1n });
    await expect(DisputeGameRoots.connect(client, L1_CHAIN, PORTAL)).rejects.toThrow(
      "another chain",
    );
  });
});
