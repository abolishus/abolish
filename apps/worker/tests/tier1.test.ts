import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { groupRegistryAbi } from "@abolishus/contracts/abi";
import { decodeTier1Addition, groupRegistryEvents } from "@abolishus/crypto";
import {
  parseTier1Index,
  recordKey,
  TIER1_RELAY_GAS_LIMIT,
  TIER1_RELAY_PERIOD,
  Tier1Batches,
  tier1Keys,
} from "@abolishus/core";
import { testDb, type TestDb } from "@abolishus/core/test-db";
import { Redis } from "ioredis";
import type { Sql } from "postgres";
import {
  type Address,
  bytesToHex,
  createPublicClient,
  createWalletClient,
  custom,
  decodeFunctionData,
  defineChain,
  getAddress,
  type Hex,
  http,
  keccak256,
  parseTransaction,
  type PublicClient,
  toHex,
} from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  checkTier1Deployment,
  HANDLERS,
  type LogLine,
  type RunningWorker,
  startWorker,
  TIER1_BOUNDARY_WITHIN,
  Tier1ChainError,
  ViemTier1Chain,
} from "../src/index.ts";

// The Tier 1 relay's chain adapter against a real chain (P3-3 part
// 3c-2b-2b): Anvil runs the group registry pinned to the vectors'
// registrars; the adapter's records are the registry's logs as
// contract-event records, numbered and checked against its own event
// accumulator, the same at any log range and read in steps; a node that
// drops, alters or re-times a log is refused; calls are signed for the
// registry at the relay's nonce with the fixed gas limit, replaced only with
// both fees raised and never above the cap, and broadcast, rebroadcast and
// found included; the startup check refuses a group that isn't a final
// Tier 1 group; and the worker's scheduled jobs keep the index and judge the
// queue (T-52, T-53, T-71). No addition can count on this chain, which has
// no Tier 2 group, so what is sent is checked here against a stand-in
// registry; core's tests/tier1-batch.test.ts judges what counts. The relay
// key is a fresh random one funded on Anvil (AGENTS.md: no real key here).

const redisUrl = process.env["REDIS_URL"];
if (!redisUrl) throw new Error("REDIS_URL is not set");

const read = (path: string) =>
  JSON.parse(readFileSync(new URL(`../../../docs/spec/vectors/${path}`, import.meta.url), "utf8"));
const registrarVectors = read("group-registry.json").registrars as {
  readonly threshold: number;
  readonly addresses: readonly string[];
};
const REGISTRARS = registrarVectors.addresses.map((a) => getAddress(`0x${a}`));
const THRESHOLD = registrarVectors.threshold;
const bytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

// A well-formed Tier 1 addition from the vectors, moved to group 1: it
// decodes, and can't count here.
const vectorRecord = bytes(
  (read("vouch-count.json").cases[0].events as { kind: string; record?: string }[]).find(
    (e) => e.kind === "tier1-addition",
  )?.record as string,
);
function junkRecord(groupId: bigint): Uint8Array {
  const r = vectorRecord.slice();
  new DataView(r.buffer).setBigUint64(0, groupId);
  return r;
}

const contractsRoot = fileURLToPath(new URL("../../../packages/contracts", import.meta.url));
const chainId = 1_000_000 + Math.floor(Math.random() * 1_000_000_000);
// One slot per epoch: Anvil's finalized block is then the latest but two.
const FINALITY_DEPTH = 2;
const VERSION = 7;
const CAP = 50_000_000_000n;

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
let chain: ReturnType<typeof defineChain>;
let client: PublicClient;
let wallet: ReturnType<typeof createWalletClient>;
let accounts: Address[];
let bytecode: Hex;
let redis: Redis;
let db: TestDb;
let app: Sql;

beforeAll(async () => {
  const port = await freePort();
  rpcUrl = `http://127.0.0.1:${port}`;
  anvil = spawn(
    "anvil",
    [
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--chain-id",
      String(chainId),
      "--slots-in-an-epoch",
      "1",
      "--silent",
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  chain = defineChain({
    id: chainId,
    name: "anvil",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  client = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;
  wallet = createWalletClient({ chain, transport: http(rpcUrl) });
  accounts = await until("anvil", 20_000, async () => {
    if (anvil.exitCode !== null) throw new Error("anvil exited (is the toolchain installed?)");
    return wallet.getAddresses();
  });
  bytecode = execFileSync(
    "forge",
    ["inspect", "--root", contractsRoot, "src/GroupRegistry.sol:GroupRegistry", "bytecode"],
    { encoding: "utf8" },
  ).trim() as Hex;
  redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  db = await testDb();
  app = await db.as("abolish_app");
}, 120_000);

afterAll(async () => {
  redis?.disconnect();
  await db?.close();
  if (anvil !== undefined && anvil.exitCode === null) {
    const exited = new Promise((r) => anvil.once("exit", r));
    anvil.kill("SIGTERM");
    await exited;
  }
});

const rpc = (method: string, params: unknown[]) =>
  client.request({ method, params } as never) as Promise<unknown>;
const mine = (blocks: number) => rpc("anvil_mine", [toHex(blocks)]);

async function deployRegistry(): Promise<{ registry: Address; fromBlock: bigint }> {
  const hash = await wallet.deployContract({
    account: accounts[0] as Address,
    chain,
    abi: groupRegistryAbi,
    bytecode,
    args: [THRESHOLD, REGISTRARS],
  });
  const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 20 });
  if (!receipt.contractAddress) throw new Error("GroupRegistry wasn't deployed");
  return { registry: receipt.contractAddress, fromBlock: receipt.blockNumber };
}

async function createGroup(registry: Address, tier: number) {
  const hash = await wallet.writeContract({
    account: accounts[5] as Address,
    chain,
    address: registry,
    abi: groupRegistryAbi,
    functionName: "createGroup",
    args: [tier],
  });
  const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 20 });
  if (receipt.status !== "success") throw new Error("createGroup reverted");
}

/** A registry with group 0 at Tier 0 and group 1 at Tier 1, both final. */
async function deployWithGroups() {
  const deployed = await deployRegistry();
  await createGroup(deployed.registry, 0);
  await createGroup(deployed.registry, 1);
  await mine(FINALITY_DEPTH);
  return deployed;
}

/** A fresh relay key, funded on Anvil. */
async function relayKey(): Promise<Uint8Array> {
  const key = new Uint8Array(randomBytes(32));
  await rpc("anvil_setBalance", [privateKeyToAddress(bytesToHex(key)), toHex(10n ** 20n)]);
  return key;
}

function adapter(
  registry: Address,
  fromBlock: bigint,
  key: Uint8Array,
  options: { client?: PublicClient; logRange?: bigint; maxFeePerGas?: bigint } = {},
) {
  return new ViemTier1Chain({
    client: options.client ?? client,
    chainId: BigInt(chainId),
    registry,
    fromBlock,
    key,
    maxFeePerGas: options.maxFeePerGas ?? CAP,
    ...(options.logRange === undefined ? {} : { logRange: options.logRange }),
  });
}

type Forward = (params: unknown[]) => Promise<unknown>;
type Hook = (method: string, params: unknown[], forward: Forward) => Promise<unknown>;

/** Logs as a node that gives no timestamp of their own answers them. */
function untimed(logs: unknown): unknown {
  return (logs as Record<string, unknown>[]).map((l) => {
    const copy = { ...l };
    delete copy["blockTimestamp"];
    return copy;
  });
}

/** A client of the Anvil node through `hook`, which may change any answer: a node not to trust. */
function nodeClient(hook: Hook): PublicClient {
  let id = 0;
  const forward =
    (method: string): Forward =>
    async (params) => {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      });
      const answer = (await response.json()) as {
        result?: unknown;
        error?: { code: number; message: string };
      };
      if (answer.error !== undefined)
        throw Object.assign(new Error(answer.error.message), { code: answer.error.code });
      return answer.result;
    };
  return createPublicClient({
    chain,
    transport: custom(
      {
        request: ({ method, params }: { method: string; params?: unknown }) =>
          hook(method, (params ?? []) as unknown[], forward(method)),
      },
      { retryCount: 0 },
    ),
  }) as PublicClient;
}

describe("the startup check", () => {
  test("passes a final Tier 1 group, and refuses any other", async () => {
    const { registry, fromBlock } = await deployWithGroups();
    const deployment = {
      chainId: BigInt(chainId),
      registry,
      fromBlock,
      registrars: REGISTRARS,
      threshold: THRESHOLD,
      group: 1n,
    };
    await expect(checkTier1Deployment(client, deployment)).resolves.toBeUndefined();
    await expect(checkTier1Deployment(client, { ...deployment, group: 0n })).rejects.toThrow(
      "isn't a Tier 1 group",
    );
    await expect(checkTier1Deployment(client, { ...deployment, group: 2n })).rejects.toThrow(
      "isn't final",
    );
    // A Tier 1 group whose creation isn't final yet.
    await createGroup(registry, 1);
    await expect(checkTier1Deployment(client, { ...deployment, group: 2n })).rejects.toThrow(
      "isn't final",
    );
    await mine(FINALITY_DEPTH);
    await expect(checkTier1Deployment(client, { ...deployment, group: 2n })).resolves.toBe(
      undefined,
    );
    // The registry's own checks are Tier 0's (tests/tier0.test.ts).
    await expect(
      checkTier1Deployment(client, { ...deployment, chainId: BigInt(chainId) + 1n }),
    ).rejects.toThrow("another chain");
    await expect(
      checkTier1Deployment(client, { ...deployment, threshold: THRESHOLD + 1 }),
    ).rejects.toThrow("another threshold");
    await expect(
      checkTier1Deployment(client, { ...deployment, fromBlock: fromBlock + 1n }),
    ).rejects.toThrow("deployment block");
  });
});

/** The registry's records up to the latest block, as core reads them: heads first. */
async function readTo(reader: ViemTier1Chain, after: bigint | null = null) {
  const latest = (await reader.heads()).latest.number;
  return { latest, records: await reader.records(after, latest) };
}

describe("the registry's records", () => {
  test("are its logs in order, numbered from 0, reaching its accumulator at any log range", async () => {
    const { registry, fromBlock } = await deployWithGroups();
    const key = await relayKey();
    // In steps, as core extends its state: the second read starts at `n` 3.
    const stepped = adapter(registry, fromBlock, key);
    const first = await readTo(stepped);
    expect(first.records.map((r) => r.n)).toEqual([0n, 1n, 2n]);
    await createGroup(registry, 1);
    await createGroup(registry, 0);
    const rest = await readTo(stepped, first.latest);
    expect(rest.records.map((r) => r.n)).toEqual([3n, 4n]);
    const { latest, records: whole } = await readTo(adapter(registry, fromBlock, key));
    expect(latest).toBe(rest.latest);
    expect([...first.records, ...rest.records]).toEqual(whole);
    // The constructor's RegistrarsPinned and four GroupCreated.
    expect(whole[0]?.l2_block).toBe(fromBlock);
    for (const r of whole) {
      expect(hex(r.contract)).toBe(registry.slice(2).toLowerCase());
      const block = await client.getBlock({ blockNumber: r.l2_block });
      expect(r.l2_timestamp).toBe(block.timestamp);
    }
    const events = groupRegistryEvents(whole, bytes(registry.slice(2)), VERSION);
    expect(events.ok).toBe(true);
    if (events.ok) {
      expect(events.events.map((e) => [e.kind, e.kind === "group-created" ? e.tier : -1])).toEqual([
        ["group-created", 0],
        ["group-created", 1],
        ["group-created", 1],
        ["group-created", 0],
      ]);
      expect(events.pinned).toHaveLength(1);
    }
    for (const logRange of [1n, 2n, 3n])
      expect((await readTo(adapter(registry, fromBlock, key, { logRange }))).records).toEqual(
        whole,
      );
    // A read from a block this adapter never ended at reads the
    // accumulator there from the node.
    expect((await readTo(adapter(registry, fromBlock, key), first.latest)).records).toEqual(
      rest.records,
    );
    // A range with no logs.
    await mine(1);
    expect((await readTo(stepped, rest.latest)).records).toEqual([]);
    // Only up to the block heads() gave: core checks that block's hash.
    await expect(stepped.records(null, first.latest)).rejects.toThrow(Tier1ChainError);
  });

  test("are refused when the node drops, alters or re-times a log", async () => {
    const { registry, fromBlock } = await deployWithGroups();
    const latest = await client.getBlockNumber({ cacheTime: 0 });
    const key = await relayKey();
    const hooks: Hook[] = [
      async (method, params, forward) => {
        const answer = await forward(params);
        return method === "eth_getLogs" ? (answer as unknown[]).slice(1) : answer;
      },
      async (method, params, forward) => {
        const answer = await forward(params);
        if (method !== "eth_getLogs") return answer;
        const logs = answer as { data: Hex }[];
        return logs.map((l, i) => (i === 1 ? { ...l, data: `${l.data}00` } : l));
      },
      async (method, params, forward) => {
        const answer = await forward(params);
        if (method !== "eth_getLogs") return answer;
        // Two logs' contents swapped, each at the other's place: a reorder
        // the adapter's own sort can't undo.
        const logs = answer as { topics: Hex[]; data: Hex }[];
        const [a, b] = [logs[1], logs[2]] as [(typeof logs)[number], (typeof logs)[number]];
        return logs.map((l, i) =>
          i === 1
            ? { ...l, topics: b.topics, data: b.data }
            : i === 2
              ? { ...l, topics: a.topics, data: a.data }
              : l,
        );
      },
      // Logs without their own timestamps, and a block re-timed.
      async (method, params, forward) => {
        const answer = await forward(params);
        if (method === "eth_getLogs") return untimed(answer);
        const block = answer as { timestamp: Hex } | null;
        if (method !== "eth_getBlockByNumber" || block === null || params[0] === "latest")
          return block;
        return { ...block, timestamp: toHex(BigInt(block.timestamp) + 1n) };
      },
      // A log's own timestamp, where a node gives one, is bound as well.
      async (method, params, forward) => {
        const answer = await forward(params);
        if (method !== "eth_getLogs") return answer;
        return (answer as object[]).map((l) => ({ ...l, blockTimestamp: "0x1" }));
      },
      async (method, params, forward) => {
        const answer = await forward(params);
        if (method !== "eth_getLogs") return answer;
        return (answer as { blockNumber: Hex }[]).map((l) => ({
          ...l,
          blockNumber: toHex(latest + 1n),
        }));
      },
    ];
    for (const [i, hook] of hooks.entries()) {
      const reader = adapter(registry, fromBlock, key, { client: nodeClient(hook) });
      const error = await readTo(reader).catch((e: unknown) => e);
      expect(error, `hook ${i}`).toBeInstanceOf(Tier1ChainError);
      expect(String(error)).toBe("Tier1ChainError: the Tier 1 relay's L2 node: records");
    }
    // Logs without their own timestamps read their blocks' instead.
    const plain = adapter(registry, fromBlock, key, {
      client: nodeClient(async (method, params, forward) => {
        const answer = await forward(params);
        return method === "eth_getLogs" ? untimed(answer) : answer;
      }),
    });
    expect((await readTo(plain)).records).toEqual(
      (await readTo(adapter(registry, fromBlock, key))).records,
    );
  });

  test("are read against the block core was given, refused for a block the node doesn't have", async () => {
    const { registry, fromBlock } = await deployWithGroups();
    const key = await relayKey();
    // A node whose latest block, as heads() gives it, isn't the one its
    // state is at: a backend on another fork.
    const other = toHex(randomBytes(32));
    const forked = adapter(registry, fromBlock, key, {
      client: nodeClient(async (method, params, forward) => {
        const answer = (await forward(params)) as { hash: Hex } | null;
        return method === "eth_getBlockByNumber" && params[0] === "latest" && answer !== null
          ? { ...answer, hash: other }
          : answer;
      }),
    });
    const heads = await forked.heads();
    expect(bytesToHex(heads.latest.hash)).toBe(other);
    await expect(forked.records(null, heads.latest.number)).rejects.toThrow(Tier1ChainError);
    // A nonce read there is refused too: the count is read by that hash.
    await expect(forked.nonce()).rejects.toThrow(Tier1ChainError);
    // The same reads without the fork pass.
    const honest = adapter(registry, fromBlock, key);
    expect((await readTo(honest)).records).toHaveLength(3);
    expect((await honest.nonce()).count).toBe(0n);
  });
});

describe("the heads", () => {
  test("are the node's latest, safe and finalized blocks, and a block it lacks has no hash", async () => {
    const { registry, fromBlock } = await deployWithGroups();
    const reader = adapter(registry, fromBlock, await relayKey());
    const heads = await reader.heads();
    const latest = await client.getBlock({ blockTag: "latest" });
    expect(heads.latest.number).toBe(latest.number);
    expect(bytesToHex(heads.latest.hash)).toBe(latest.hash);
    expect(heads.finalized).toBe(latest.number - BigInt(FINALITY_DEPTH));
    expect(heads.safe).toBeGreaterThanOrEqual(heads.finalized);
    expect(bytesToHex((await reader.blockHash(fromBlock)) as Uint8Array)).toBe(
      (await client.getBlock({ blockNumber: fromBlock })).hash,
    );
    expect(await reader.blockHash(latest.number + 1_000n)).toBeNull();
  });

  test("throw a fixed error when the node can't be reached, quoting neither URL nor record", async () => {
    const closed = `http://127.0.0.1:${await freePort()}/secret-api-key`;
    const reader = adapter(REGISTRARS[0] as Address, 0n, await relayKey(), {
      client: createPublicClient({ transport: http(closed, { retryCount: 0 }) }) as PublicClient,
    });
    const record = junkRecord(1n);
    // A transaction signed while the node was up, broadcast once it isn't.
    const standIn = getAddress(`0x${randomBytes(20).toString("hex")}`);
    const signed = await adapter(standIn, 0n, await relayKey()).sign(record, 0n);
    for (const call of [
      () => reader.heads(),
      () => reader.blockHash(1n),
      () => reader.records(null, 10n),
      () => reader.nonce(),
      () => reader.included(signed.hash),
      () => reader.simulate(record),
      () => reader.sign(record, 0n),
      () => reader.broadcast(signed.tx),
    ]) {
      const error = await call().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Tier1ChainError);
      expect(String(error)).not.toContain("secret-api-key");
      expect(String(error)).not.toContain(hex(record).slice(0, 64));
      expect(String(error)).not.toContain(hex(signed.tx).slice(0, 64));
      expect(String(error)).not.toContain(hex(signed.hash));
    }
  });
});

describe("sending", () => {
  test("a reverting call simulates false, and any other error answer rejects", async () => {
    const { registry, fromBlock } = await deployWithGroups();
    const key = await relayKey();
    const reader = adapter(registry, fromBlock, key);
    // Group 1 is Tier 1, but the vouches name no Tier 2 group here.
    expect(await reader.simulate(junkRecord(1n))).toBe(false);
    expect(await reader.simulate(junkRecord(0n))).toBe(false);
    // A rate limit, an internal error or a backend without the block isn't
    // a revert: the record must stay queued.
    for (const [code, message] of [
      [-32005, "limit exceeded"],
      [-32603, "internal error"],
      [-32000, "header not found"],
    ] as const) {
      const flaky = adapter(registry, fromBlock, key, {
        client: nodeClient(async (method, params, forward) => {
          if (method === "eth_call") throw Object.assign(new Error(message), { code });
          return forward(params);
        }),
      });
      await expect(flaky.simulate(junkRecord(1n)), message).rejects.toThrow(Tier1ChainError);
    }
  });

  test("a broadcast the node already holds is sent, another error refused, a wrong hash rejected", async () => {
    const standIn = getAddress(`0x${randomBytes(20).toString("hex")}`);
    const key = await relayKey();
    const signed = await adapter(standIn, 0n, key).sign(junkRecord(1n), 0n);
    const answering = (answer: (forward: Forward, params: unknown[]) => Promise<unknown>) =>
      adapter(standIn, 0n, key, {
        client: nodeClient(async (method, params, forward) =>
          method === "eth_sendRawTransaction" ? answer(forward, params) : forward(params),
        ),
      });
    const failing = (code: number, message: string) =>
      answering(async () => {
        throw Object.assign(new Error(message), { code });
      });
    expect(await failing(-32000, "already known").broadcast(signed.tx)).toBe("sent");
    expect(await failing(-32000, "known transaction: 0xab").broadcast(signed.tx)).toBe("sent");
    expect(await failing(-32000, "nonce too low").broadcast(signed.tx)).toBe("refused");
    expect(await failing(-32000, "insufficient funds").broadcast(signed.tx)).toBe("refused");
    await expect(
      answering(async () => toHex(randomBytes(32))).broadcast(signed.tx),
    ).rejects.toThrow(Tier1ChainError);
  });

  test("signs addTier1Member at the nonce, replaces with both fees raised, and finds what landed", async () => {
    // A stand-in registry that accepts any call, so a send lands.
    const standIn = getAddress(`0x${randomBytes(20).toString("hex")}`);
    await rpc("anvil_setCode", [standIn, "0x00"]);
    const key = await relayKey();
    const reader = adapter(standIn, 0n, key);
    const record = junkRecord(1n);
    expect(await reader.simulate(record)).toBe(true);
    const relay = privateKeyToAddress(bytesToHex(key));
    expect(reader.address).toBe(relay);

    const before = await reader.nonce();
    expect(before.count).toBe(0n);
    const first = await reader.sign(record, 0n);
    expect(bytesToHex(first.hash)).toBe(keccak256(bytesToHex(first.tx)));
    const tx = parseTransaction(bytesToHex(first.tx));
    expect(tx).toMatchObject({
      type: "eip1559",
      chainId,
      nonce: 0,
      to: standIn.toLowerCase(),
      gas: TIER1_RELAY_GAS_LIMIT,
    });
    expect(tx.value ?? 0n).toBe(0n);
    const call = decodeFunctionData({ abi: groupRegistryAbi, data: tx.data as Hex });
    expect(call.functionName).toBe("addTier1Member");
    expect(call.args).toEqual([bytesToHex(record)]);

    await rpc("evm_setAutomine", [false]);
    try {
      expect(await reader.broadcast(first.tx)).toBe("sent");
      // Rebroadcast unchanged: the node already holds it.
      expect(await reader.broadcast(first.tx)).toBe("sent");
      expect(await reader.included(first.hash)).toBeNull();
      const second = await reader.sign(record, 0n, first.tx);
      const replaced = parseTransaction(bytesToHex(second.tx));
      expect(replaced.nonce).toBe(0);
      expect(replaced.maxFeePerGas as bigint).toBeGreaterThan(
        ((tx.maxFeePerGas as bigint) * 9n) / 8n,
      );
      expect(replaced.maxPriorityFeePerGas as bigint).toBeGreaterThan(
        ((tx.maxPriorityFeePerGas as bigint) * 9n) / 8n,
      );
      expect(await reader.broadcast(second.tx)).toBe("sent");
      // A replacement at the old fees is refused by the node.
      expect(await reader.broadcast(first.tx)).toBe("refused");
      await mine(1);
      const block = await client.getBlockNumber({ cacheTime: 0 });
      expect(await reader.included(second.hash)).toBe(block);
      expect(await reader.included(first.hash)).toBeNull();
      expect((await reader.nonce()).count).toBe(1n);
      // Its nonce is taken: the node refuses it now.
      expect(await reader.broadcast(second.tx)).toBe("refused");
    } finally {
      await rpc("evm_setAutomine", [true]);
    }
    // Only a transaction of ours at that nonce is replaced.
    await expect(reader.sign(record, 1n, first.tx)).rejects.toThrow(Tier1ChainError);
  });

  test("never signs above the fee cap, and at it replaces a record's transaction with itself", async () => {
    const standIn = getAddress(`0x${randomBytes(20).toString("hex")}`);
    const key = await relayKey();
    const record = junkRecord(1n);
    const free = await adapter(standIn, 0n, key).sign(record, 0n);
    const fee = parseTransaction(bytesToHex(free.tx)).maxFeePerGas as bigint;
    const cap = fee / 2n;
    const capped = adapter(standIn, 0n, key, { maxFeePerGas: cap });
    const first = await capped.sign(record, 0n);
    const t = parseTransaction(bytesToHex(first.tx));
    expect(t.maxFeePerGas).toBe(cap);
    expect(t.maxPriorityFeePerGas as bigint).toBeLessThanOrEqual(cap);
    // No raise fits under the cap: the same record's transaction stays as
    // it is, so core keeps one copy.
    for (const replacing of [first.tx, free.tx]) {
      const again = await capped.sign(record, 0n, replacing);
      expect(hex(again.tx)).toBe(hex(replacing));
      expect(bytesToHex(again.hash)).toBe(keccak256(bytesToHex(replacing)));
    }
    // Another record's transaction at a freed nonce is outbid up to the cap.
    const other = await capped.sign(junkRecord(2n), 0n, free.tx);
    const o = parseTransaction(bytesToHex(other.tx));
    expect(o.maxFeePerGas).toBe(cap);
    expect(decodeFunctionData({ abi: groupRegistryAbi, data: o.data as Hex }).args).toEqual([
      bytesToHex(junkRecord(2n)),
    ]);
  });
});

describe("the worker", () => {
  let worker: RunningWorker | undefined;
  afterAll(async () => {
    await worker?.close();
  });

  test("keeps the relay's index current and judges the queue at the boundary", async () => {
    const { registry, fromBlock } = await deployWithGroups();
    const prefix = `abolish-test-${randomBytes(6).toString("hex")}`;
    const keys = tier1Keys(prefix);
    const record = junkRecord(1n);
    await redis.hset(keys.queue, recordKey(record), hex(record));
    const lines: LogLine[] = [];
    // A clock five seconds past a period's boundary, so the boundary runs
    // within its bound whenever the test starts.
    const skew = (Math.floor(Date.now() / 1000) % TIER1_RELAY_PERIOD) - 5;
    const seconds = () => Math.floor(Date.now() / 1000) - skew;
    const batches = new Tier1Batches({
      redis,
      chain: adapter(registry, fromBlock, await relayKey()),
      groups: new Map([[0, 1n]]),
      chainId: BigInt(chainId),
      registry: bytes(registry.slice(2)),
      registrars: REGISTRARS.map((a) => bytes(a.slice(2))),
      threshold: THRESHOLD,
      version: VERSION,
      now: seconds,
      prefix,
    });
    worker = await startWorker({
      connection: redis,
      sql: app,
      log: (l) => lines.push(l),
      auditEveryMs: 3_600_000,
      prefix,
      now: () => new Date(seconds() * 1000),
      tier1: { batches, indexEveryMs: 200, boundaryEveryMs: 200 },
    });
    const line = await until("the boundary", 30_000, async () =>
      lines.find((l) => "queue" in l && l.queue === "{tier1-boundary}" && "dropped" in l),
    );
    // The record decodes but can't count here: dropped, nothing sent.
    expect(decodeTier1Addition(record).ok).toBe(true);
    expect(line).toMatchObject({ outcome: "judged", dropped: 1, sent: 0, reverted: 0 });
    expect(await redis.hlen(keys.queue)).toBe(0);
    expect(await redis.hlen(keys.inflight)).toBe(0);
    // The index follows the node's latest block.
    await mine(3);
    const target = await client.getBlockNumber({ cacheTime: 0 });
    const index = await until("the index", 30_000, async () => {
      const i = parseTier1Index(await redis.get(keys.index));
      return i !== undefined && i.latest >= target ? i : undefined;
    });
    expect(index.safe).toBeLessThanOrEqual(index.latest);
    expect(Math.abs(index.at - seconds())).toBeLessThan(30);
    // A boundary runs once per period: no second line within it.
    await new Promise((r) => setTimeout(r, 600));
    expect(lines.filter((l) => "dropped" in l)).toHaveLength(1);
    // Every line is a count or a step: nothing names the record.
    const all = JSON.stringify(lines);
    expect(all).not.toContain(hex(record).slice(0, 64));
    expect(all).not.toContain(recordKey(record));
    await worker.close();
    worker = undefined;
  }, 60_000);

  test("runs a boundary only early in its period, never late", async () => {
    let runs = 0;
    const ctx = {
      sql: app,
      log: () => {},
      tier1: {
        runBoundary: async () => {
          runs++;
          return null;
        },
      } as unknown as Tier1Batches,
    };
    const start = 1_800_000_000 - (1_800_000_000 % TIER1_RELAY_PERIOD);
    for (const [offset, expected] of [
      [0, 1],
      [TIER1_BOUNDARY_WITHIN - 1, 2],
      [TIER1_BOUNDARY_WITHIN, 2],
      [TIER1_RELAY_PERIOD - 1, 2],
      [TIER1_RELAY_PERIOD, 3],
    ] as const) {
      await HANDLERS.tier1Boundary({ ...ctx, now: () => new Date((start + offset) * 1000) }, {});
      expect(runs, `at ${offset}`).toBe(expected);
    }
  });
});
