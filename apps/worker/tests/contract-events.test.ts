import { type TestDb, testDb } from "@abolishus/core/test-db";
import {
  checkEventAccumulatorContinuation,
  decodeContractEventEvidence,
  encodeContractEventEvidence,
  eventAccumulatorGenesis,
  eventAccumulatorStep,
} from "@abolishus/crypto";
import {
  ACCUMULATOR_SLOT,
  accumulatorAtOutputRoot,
  checkContractEventEvidence,
  OutputRootError,
} from "@abolishus/verifier";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import {
  type Address,
  bytesToHex,
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
  ChainContractEvents,
  GAME_LEAD,
  MAX_EVIDENCE_GAMES,
  MESSAGE_PASSER,
} from "../src/index.ts";

// The archive's contract-event source (src/contract-events.ts; P4-3 part
// 4b-3b). Anvil stands in for the L2 node, so blocks, headers and trie
// proofs are its own, and a contract there holds an accumulator and count
// computed here over logs the index claims, as a deployed contract would
// after emitting them. The L1 side is a scripted node serving a portal's
// factory and its games, each output root computed from Anvil's blocks as a
// proposer would post it; the index is `contract_log` as Ponder creates it.
// Every record is judged by the verifier's evidence check and every range
// of events replayed from the record before it, as core's archive run does
// (T-71).

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
let l2: PublicClient;
let db: TestDb;
let index: string;
const REGISTRY: Address = "0x00000000000000000000000000000000000e1ec7";
const OTHER: Address = "0x0000000000000000000000000000000000000b0a";
const NO_CODE: Address = "0x00000000000000000000000000000000000b0a0d";

const slot = (n: bigint) => toHex(n, { size: 32 });
const rpc = (method: string, params: unknown[]) =>
  l2.request({ method: method as "eth_chainId", params: params as never });

interface Logged {
  readonly block: bigint;
  readonly timestamp: bigint;
  readonly topics: readonly Uint8Array[];
  readonly data: Uint8Array;
}

/** Each step's block and timestamp, and the accumulator and count stored there. */
interface Step {
  readonly block: bigint;
  readonly timestamp: bigint;
  readonly accumulator: Uint8Array;
  readonly count: bigint;
}

const logs: Logged[] = [];
const steps: Step[] = [];
let t0: bigint;

beforeAll(async () => {
  const port = await freePort();
  anvil = spawn(
    "anvil",
    ["--host", "127.0.0.1", "--port", String(port), "--chain-id", String(CHAIN), "--silent"],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  l2 = createPublicClient({ transport: http(`http://127.0.0.1:${port}`) }) as PublicClient;
  await until("anvil", 20_000, async () => {
    if (anvil.exitCode !== null) throw new Error("anvil exited (is the toolchain installed?)");
    return l2.getChainId();
  });
  // Code storing its calldata's second word at its first and its fourth at
  // its third (PUSH1 0x20 CALLDATALOAD PUSH1 0 CALLDATALOAD SSTORE PUSH1 0x60
  // CALLDATALOAD PUSH1 0x40 CALLDATALOAD SSTORE STOP), so a block's one
  // transaction sets both the accumulator and the count.
  const code = "0x6020356000355560603560403555" + "00";
  await rpc("anvil_setCode", [REGISTRY, code]);
  await rpc("anvil_setCode", [OTHER, code]);
  const [from] = (await rpc("eth_accounts", [])) as unknown as Hex[];
  const latest = await l2.getBlock({ blockTag: "latest" });
  t0 = latest.timestamp + 1_000n;
  let acc = eventAccumulatorGenesis(CHAIN, hexToBytes(REGISTRY));
  let count = 0n;
  // Three steps, 100 seconds apart, with empty blocks between: one log, then
  // two in one block, then none (the contract untouched, its count the same).
  for (const [i, n] of [1, 2, 0].entries()) {
    await rpc("evm_mine", [Number(t0 + BigInt(i) * 100n - 50n)]);
    const timestamp = t0 + BigInt(i) * 100n;
    await rpc("evm_setNextBlockTimestamp", [Number(timestamp)]);
    const block = (await l2.getBlock({ blockTag: "latest" })).number + 1n;
    for (let k = 0; k < n; k++) {
      const log = {
        block,
        timestamp,
        topics: [randomBytes(32), randomBytes(32)].map((b) => Uint8Array.from(b)),
        data: Uint8Array.from(randomBytes(40 + k)),
      };
      acc = eventAccumulatorStep(acc, count, log);
      count++;
      logs.push(log);
    }
    const hash = await rpc("eth_sendTransaction", [
      {
        from,
        to: REGISTRY,
        data: concat([
          slot(ACCUMULATOR_SLOT),
          bytesToHex(acc),
          slot(ACCUMULATOR_SLOT + 1n),
          slot(count),
        ]),
      },
    ]);
    const receipt = await l2.waitForTransactionReceipt({ hash: hash as unknown as Hex });
    expect(receipt.blockNumber).toBe(block);
    steps.push({ block, timestamp, accumulator: acc, count });
  }
  await rpc("evm_mine", [Number(t0 + 1_000n)]);

  db = await testDb();
  index = `ix_${randomBytes(6).toString("hex")}`;
  await db.admin.unsafe(`CREATE SCHEMA "${index}"`);
  await db.admin.unsafe(`CREATE TABLE "${index}".contract_log (
    id text PRIMARY KEY, contract text NOT NULL, block_number numeric(78) NOT NULL,
    block_timestamp numeric(78) NOT NULL, topics text[] NOT NULL, data text NOT NULL,
    transaction_hash text NOT NULL, log_index integer NOT NULL)`);
  // Another contract's logs interleaved, which no range of REGISTRY's reads.
  for (const [i, l] of logs.entries())
    for (const [contract, id] of [
      [OTHER, `${String(i).padStart(6, "0")}-0`],
      [REGISTRY, `${String(i).padStart(6, "0")}-1`],
    ] as const)
      await db.admin`
        INSERT INTO ${db.admin(index)}.contract_log
        VALUES (${id}, ${contract.toLowerCase()}, ${l.block.toString()},
          ${l.timestamp.toString()}, ${l.topics.map((t) => bytesToHex(t))}, ${bytesToHex(l.data)},
          ${bytesToHex(randomBytes(32))}, ${i})`;
}, 60_000);

afterAll(async () => {
  await db?.admin.unsafe(`DROP SCHEMA IF EXISTS "${index}" CASCADE`);
  await db?.close();
  if (anvil !== undefined && anvil.exitCode === null) {
    const exited = new Promise((r) => anvil.once("exit", r));
    anvil.kill("SIGTERM");
    await exited;
  }
});

/** The version-0 output root of Anvil's block `n`, as a proposer posts it. */
async function rootOf(n: bigint): Promise<Hex> {
  const block = (await rpc("eth_getBlockByNumber", [toHex(n), false])) as unknown as {
    stateRoot: Hex;
    hash: Hex;
  };
  const passer = await l2.getProof({ address: MESSAGE_PASSER, storageKeys: [], blockNumber: n });
  return keccak256(concat([slot(0n), block.stateRoot, passer.storageHash, block.hash]));
}

// The L1 side: a portal, its factory and the factory's games at a finalized
// head the test can move.

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
const PINNED = 621;

interface Game {
  readonly type: number;
  readonly root: Hex;
  readonly l2: bigint;
  readonly status: number;
  /** Its L1 creation time. */
  readonly created: bigint;
}

const proxyOf = (i: number): Address => toHex(0x9a3e0000n + BigInt(i), { size: 20 });

function l1Of(games: readonly Game[], options: { chainId?: bigint } = {}) {
  const calls: { fn: string; block: unknown; index?: number }[] = [];
  const state = { finalized: 9_000n };
  const client = createPublicClient({
    transport: custom({
      async request({ method, params }: { method: string; params?: unknown[] }) {
        if (method === "eth_chainId") return toHex(options.chainId ?? L1_CHAIN);
        if (method === "eth_getBlockByNumber") {
          expect(params?.[0]).toBe("finalized");
          return {
            number: toHex(state.finalized),
            hash: slot(state.finalized),
            parentHash: slot(state.finalized - 1n),
            timestamp: toHex(1_900_000_000n),
            transactions: [],
            logsBloom: null,
            nonce: null,
          };
        }
        if (method === "eth_call") {
          const [{ to, data }, block] = params as [{ to: Address; data: Hex }, unknown];
          const { functionName, args } = decodeFunctionData({ abi, data });
          const result = (): unknown => {
            if (to.toLowerCase() === PORTAL) {
              if (functionName === "disputeGameFactory") return FACTORY;
              if (functionName === "respectedGameType") return PINNED;
            }
            if (to.toLowerCase() === FACTORY) {
              if (functionName === "gameCount") return BigInt(games.length);
              if (functionName === "gameAtIndex") {
                const i = Number(args?.[0]);
                calls.push({ fn: functionName, block, index: i });
                const g = games[i];
                if (g === undefined) throw new Error("no such game");
                return [g.type, g.created, proxyOf(i)];
              }
            }
            const i = games.findIndex((_, j) => proxyOf(j).toLowerCase() === to.toLowerCase());
            const g = games[i];
            if (g === undefined) throw new Error(`unexpected call to ${to}`);
            if (functionName === "rootClaim") return g.root;
            if (functionName === "l2SequenceNumber") return g.l2;
            if (functionName === "status") return g.status;
            throw new Error(`unexpected ${functionName}`);
          };
          if (functionName !== "gameAtIndex") calls.push({ fn: functionName, block });
          return encodeFunctionResult({ abi, functionName, result: result() } as never);
        }
        throw new Error(`unexpected ${method}`);
      },
    }),
  }) as PublicClient;
  return { client, calls, state };
}

/** A game of the pinned type claiming block `l2` honestly, created at `created`. */
async function honest(l2Block: bigint, created: bigint, status = 0): Promise<Game> {
  return { type: PINNED, root: await rootOf(l2Block), l2: l2Block, status, created };
}

async function sourceOf(games: readonly Game[], node: PublicClient = l2) {
  const l1 = l1Of(games);
  const source = await ChainContractEvents.connect({
    l1: l1.client,
    l1ChainId: L1_CHAIN,
    portal: PORTAL,
    l2: node,
    l2ChainId: CHAIN,
    index: db.admin,
    indexSchema: index,
  });
  return { source, ...l1 };
}

/** The evidence check's verdict on a record, as a reader's and core's. */
function judged(record: NonNullable<Awaited<ReturnType<ChainContractEvents["evidence"]>>>) {
  const bytes = encodeContractEventEvidence(record);
  expect(decodeContractEventEvidence(bytes, 1)).toEqual(record);
  const proven = accumulatorAtOutputRoot(
    {
      outputRoot: record.output_root,
      messagePasserStorageRoot: record.message_passer_storage_root,
      header: record.header,
      nodes: record.nodes,
    },
    record.contract,
  );
  const check = checkContractEventEvidence(
    record,
    { contract: record.contract, l2Block: proven.block },
    CHAIN,
  );
  if (!check.ok) throw new Error(check.code);
  return check.accumulator;
}

const step = (i: number): Step => {
  const s = steps[i];
  if (s === undefined) throw new Error(`no step ${i}`);
  return s;
};

describe("the record for a period", () => {
  test("is the lowest block at or after the end that a game claims, whatever the games' order", async () => {
    const created = t0;
    // The second step's game is created first.
    const games = [await honest(step(1).block, created), await honest(step(0).block, created + 1n)];
    const { source } = await sourceOf(games);
    const record = await source.evidence(hexToBytes(REGISTRY), step(0).timestamp);
    if (record === undefined) throw new Error("no record");
    expect(record.game_index).toBe(1n);
    expect(bytesToHex(record.game)).toBe(proxyOf(1));
    expect(bytesToHex(record.output_root)).toBe(games[1]?.root);
    expect(judged(record)).toMatchObject({
      count: step(0).count,
      accumulator: step(0).accumulator,
      timestamp: step(0).timestamp,
    });
    // One second later the first step's block is before the end.
    const next = await source.evidence(hexToBytes(REGISTRY), step(0).timestamp + 1n);
    expect(next?.game_index).toBe(0n);
    expect(judged(next!)).toMatchObject({ count: step(1).count, accumulator: step(1).accumulator });
  });

  test("carries each proof node once, in ascending byte order", async () => {
    const { source } = await sourceOf([await honest(step(1).block, t0)]);
    const record = await source.evidence(hexToBytes(REGISTRY), step(1).timestamp);
    const hexes = record!.nodes.map((n) => bytesToHex(n));
    expect(new Set(hexes).size).toBe(hexes.length);
    expect([...hexes].sort()).toEqual(hexes);
  });

  test("passes over games shown false, of another type, with a root the node doesn't give, or of a block it lacks", async () => {
    const head = (await l2.getBlock({ blockTag: "latest" })).number;
    const good = await honest(step(2).block, t0 + 3n);
    const games: Game[] = [
      // CHALLENGER_WINS
      await honest(step(0).block, t0, 1),
      { ...(await honest(step(0).block, t0)), type: 1 },
      { ...(await honest(step(0).block, t0)), root: slot(7n) },
      // Another block's root claimed for the first step's.
      { ...(await honest(step(1).block, t0)), l2: step(0).block },
      { type: PINNED, root: slot(9n), l2: head + 100n, status: 0, created: t0 + 1n },
      good,
      // DEFENDER_WINS counts as in progress does.
      await honest(step(2).block + 1n, t0 + 4n, 2),
    ];
    const { source } = await sourceOf(games);
    const record = await source.evidence(hexToBytes(REGISTRY), step(0).timestamp);
    expect(record?.game_index).toBe(5n);
    expect(judged(record!)).toMatchObject({ count: step(2).count, timestamp: step(2).timestamp });
    // The game shown false aside, the next block is the resolved one's.
    const after = await source.evidence(hexToBytes(REGISTRY), step(2).timestamp + 1n);
    expect(after?.game_index).toBe(6n);
  });

  test("is none while no game claims a block at or after the end", async () => {
    const { source } = await sourceOf([await honest(step(0).block, t0)]);
    expect(await source.evidence(hexToBytes(REGISTRY), step(0).timestamp + 1n)).toBeUndefined();
    const { source: empty } = await sourceOf([]);
    expect(await empty.evidence(hexToBytes(REGISTRY), step(0).timestamp)).toBeUndefined();
  });

  test("reads games only from those created GAME_LEAD before the end, and at most MAX_EVIDENCE_GAMES", async () => {
    const end = step(1).timestamp;
    const old = Array.from({ length: 200 }, (_, i) => ({
      type: 7,
      root: slot(1n),
      l2: 1n,
      status: 0,
      created: end - GAME_LEAD - 1_000n + BigInt(i),
    }));
    const others = Array.from({ length: Number(MAX_EVIDENCE_GAMES) }, () => ({
      type: 7,
      root: slot(1n),
      l2: 1n,
      status: 0,
      created: end - GAME_LEAD,
    }));
    const games = [...old, ...others, await honest(step(1).block, end)];
    const { source, calls } = await sourceOf(games);
    expect(await source.evidence(hexToBytes(REGISTRY), end)).toBeUndefined();
    const read = calls.filter((c) => c.fn === "gameAtIndex").map((c) => c.index ?? -1);
    // The bisection's reads, then the window from the first game at or after
    // the lead, never an older game's claim.
    const window = read.filter((i) => i >= old.length);
    expect(new Set(window).size).toBe(Number(MAX_EVIDENCE_GAMES));
    expect(read.length).toBeLessThan(Number(MAX_EVIDENCE_GAMES) + 20);
    expect(calls.filter((c) => c.fn === "rootClaim")).toHaveLength(0);
    // One game fewer in the way finds the record.
    const { source: wider } = await sourceOf([...old, ...others.slice(1), games.at(-1)!]);
    expect((await wider.evidence(hexToBytes(REGISTRY), end))?.game_index).toBe(
      BigInt(old.length + others.length - 1),
    );
  });

  test("reads every L1 value at the finalized head, and each period's games once while it stays", async () => {
    const { source, calls, state } = await sourceOf([await honest(step(1).block, t0)]);
    await source.evidence(hexToBytes(REGISTRY), step(1).timestamp);
    const first = calls.length;
    for (const c of calls) expect(c.block).toBe(toHex(9_000n));
    // Another contract's record for the same period is at the same block.
    const other = await source.evidence(hexToBytes(OTHER), step(1).timestamp);
    expect(calls.length).toBe(first);
    expect(other?.game_index).toBe(0n);
    expect(bytesToHex(other!.contract)).toBe(OTHER);
    state.finalized = 9_001n;
    await source.evidence(hexToBytes(REGISTRY), step(1).timestamp);
    expect(calls.length).toBe(2 * first);
    for (const c of calls.slice(first)) expect(c.block).toBe(toHex(9_001n));
  });

  test("of a contract with no code proves its absence", async () => {
    const { source } = await sourceOf([await honest(step(0).block, t0)]);
    const record = await source.evidence(hexToBytes(NO_CODE), step(0).timestamp);
    expect(() =>
      accumulatorAtOutputRoot(
        {
          outputRoot: record!.output_root,
          messagePasserStorageRoot: record!.message_passer_storage_root,
          header: record!.header,
          nodes: record!.nodes,
        },
        hexToBytes(NO_CODE),
      ),
    ).toThrow(OutputRootError);
  });

  test("refuses nodes on other chains", async () => {
    const options = {
      l1ChainId: L1_CHAIN,
      portal: PORTAL,
      l2,
      l2ChainId: CHAIN,
      index: db.admin,
      indexSchema: index,
    };
    await expect(
      ChainContractEvents.connect({ ...options, l1: l1Of([], { chainId: 1n }).client }),
    ).rejects.toThrow("the L1 node is on another chain");
    await expect(
      ChainContractEvents.connect({ ...options, l1: l1Of([]).client, l2ChainId: 8_453n }),
    ).rejects.toThrow("the L2 node is on another chain");
  });
});

describe("the events since a record", () => {
  test("are the index's, numbered from the count asked, and replay from one record to the next", async () => {
    const { source } = await sourceOf([
      await honest(step(0).block, t0),
      await honest(step(1).block, t0),
    ]);
    const contract = hexToBytes(REGISTRY);
    const first = judged((await source.evidence(contract, step(0).timestamp))!);
    const second = judged((await source.evidence(contract, step(1).timestamp))!);
    const events = await source.events(contract, 0n, 1n);
    const log = logs[0]!;
    expect(events).toEqual([
      { l2_block: log.block, l2_timestamp: log.timestamp, topics: log.topics, data: log.data },
    ]);
    const archived = (from: bigint, es: typeof events) =>
      es.map((e, i) => ({
        n: from + BigInt(i),
        block: e.l2_block,
        timestamp: e.l2_timestamp,
        topics: e.topics,
        data: e.data,
      }));
    const genesis = {
      accumulator: eventAccumulatorGenesis(CHAIN, contract),
      count: 0n,
      block: 0n,
      lastBlock: 0n,
      lastTimestamp: 0n,
    };
    expect(checkEventAccumulatorContinuation(genesis, archived(0n, events), first)).toBeNull();
    const more = await source.events(contract, 1n, 3n);
    expect(more).toHaveLength(2);
    expect(
      checkEventAccumulatorContinuation(
        { ...first, lastBlock: log.block, lastTimestamp: log.timestamp },
        archived(1n, more),
        second,
      ),
    ).toBeNull();
    expect(await source.events(contract, 3n, 3n)).toEqual([]);
  });

  test("are refused, not cut short, while the index is behind", async () => {
    const { source } = await sourceOf([]);
    await expect(source.events(hexToBytes(REGISTRY), 1n, 4n)).rejects.toThrow(
      "the index hasn't caught up",
    );
  });
});

describe("failures", () => {
  test("never quote a node's or the index's URL", async () => {
    const secret = "k3y-0f-the-provider";
    const down = createPublicClient({
      transport: http(`http://127.0.0.1:1/${secret}`, { retryCount: 0 }),
    }) as PublicClient;
    // A node that answers the chain ID and nothing else.
    const flaky = createPublicClient({
      transport: custom({
        async request({ method, params }: { method: string; params?: unknown[] }) {
          if (method === "eth_chainId") return toHex(CHAIN);
          return down.request({ method: method as "eth_chainId", params: params as never });
        },
      }),
    }) as PublicClient;
    const { source: lame } = await sourceOf([await honest(step(0).block, t0)], flaky);
    const error = await lame.evidence(hexToBytes(REGISTRY), step(0).timestamp).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error.message)).toBe("an L1 or L2 node failed");
    expect(error.cause).toBeUndefined();
    const lost = await ChainContractEvents.connect({
      l1: l1Of([]).client,
      l1ChainId: L1_CHAIN,
      portal: PORTAL,
      l2,
      l2ChainId: CHAIN,
      index: db.admin,
      indexSchema: "no_such_schema",
    });
    const indexError = await lost.events(hexToBytes(REGISTRY), 0n, 1n).catch((e) => e);
    expect(indexError.message).toBe("the index couldn't be read");
  });
});
