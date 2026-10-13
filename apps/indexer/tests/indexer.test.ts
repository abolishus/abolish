// The indexer against a real chain: Anvil runs the group registry, its
// registrars sign through Anvil's unlocked development accounts (no key is
// held here, AGENTS.md), Ponder indexes into a fresh Postgres schema, and the
// indexed records must replay through @abolishus/crypto to exactly the tier
// trees the registry was given, both from a backfill and live, and again
// after the index is wiped and rebuilt from the chain (T-66).

import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  applyGroupRecords,
  encodeGroupAddition,
  encodeGroupRemoval,
  type GroupApproval,
  groupRegistryDomainSeparator,
} from "@abolishus/crypto";
import { groupRegistryAbi } from "@abolishus/contracts/abi";
import postgres from "postgres";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  defineChain,
  type Hex,
  hexToBytes,
  http,
  parseSignature,
  toHex,
} from "viem";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { readIndexedGroups } from "../src/records.ts";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
if (DATABASE_URL === undefined) throw new Error("TEST_DATABASE_URL is required (AGENTS.md)");

const root = fileURLToPath(new URL("..", import.meta.url));
const ponderBin = fileURLToPath(
  new URL("../node_modules/ponder/dist/esm/bin/ponder.js", import.meta.url),
);
const contractsRoot = fileURLToPath(new URL("../../../packages/contracts", import.meta.url));

// A chain ID of this run's own, so nothing Ponder cached for another Anvil
// (its RPC cache is keyed by chain ID) can answer for this one.
const chainId = 1_000_000 + Math.floor(Math.random() * 1_000_000_000);
const anvilChain = (rpcUrl: string) =>
  defineChain({
    id: chainId,
    name: "anvil",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
let chain: ReturnType<typeof anvilChain>;

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
    await new Promise((r) => setTimeout(r, 200));
  }
}

function stopped(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

const sql = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });
const schemas: string[] = [];
let anvil: ChildProcess;
let rpcUrl: string;
let publicClient: ReturnType<typeof createPublicClient>;
let walletClient: ReturnType<typeof createWalletClient>;
let registry: Address;
let startBlock: bigint;
let registrars: Address[];
let submitter: Address;

/** Waits until the indexer at `port` has processed every block up to the chain's head. */
async function caughtUp(port: number): Promise<void> {
  const head = await publicClient.getBlockNumber({ cacheTime: 0 });
  await until(`the indexer at block ${head}`, 60_000, async () => {
    const response = await fetch(`http://127.0.0.1:${port}/status`);
    if (response.status !== 200) return undefined;
    const status = (await response.json()) as { l2?: { block?: { number?: number } } };
    const at = status.l2?.block?.number;
    return at !== undefined && BigInt(at) >= head ? true : undefined;
  });
}

/**
 * Starts `ponder start` on a schema of its own and waits until it has caught
 * up with the chain: `/ready` alone only says the backfill of finalized
 * blocks is done.
 */
async function startIndexer(): Promise<{ schema: string; child: ChildProcess; port: number }> {
  const schema = `indexer_test_${process.pid}_${schemas.length}`;
  schemas.push(schema);
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [ponderBin, "start", "--root", root, "--schema", schema, "--port", String(port)],
    {
      env: {
        PATH: process.env.PATH,
        DATABASE_URL,
        INDEXER_CHAIN_ID: String(chainId),
        INDEXER_RPC_URL: rpcUrl,
        GROUP_REGISTRY_ADDRESS: registry,
        GROUP_REGISTRY_START_BLOCK: startBlock.toString(),
        PONDER_LOG_LEVEL: "info",
      },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  await until("the indexer's backfill", 120_000, async () => {
    if (child.exitCode !== null) throw new Error(`ponder exited with ${child.exitCode}`);
    const response = await fetch(`http://127.0.0.1:${port}/ready`);
    return response.status === 200 ? true : undefined;
  });
  await caughtUp(port);
  return { schema, child, port };
}

async function send(functionName: "createGroup" | "addMembers" | "removeMembers", arg: unknown) {
  const hash = await walletClient.writeContract({
    account: submitter,
    chain,
    address: registry,
    abi: groupRegistryAbi,
    functionName,
    args: [arg],
  } as Parameters<typeof walletClient.writeContract>[0]);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 50 });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
}

const domain = () => ({
  name: "Abolish group registry",
  version: "1",
  chainId,
  verifyingContract: registry,
});

/** Seats 1 and 3 of the registrars approve: any two meet the threshold. */
async function approvals(
  types: Record<string, readonly { name: string; type: string }[]>,
  primaryType: string,
  message: Record<string, unknown>,
): Promise<GroupApproval[]> {
  const out: GroupApproval[] = [];
  for (const seat of [1, 3]) {
    const signature = await walletClient.signTypedData({
      account: registrars[seat - 1] as Address,
      domain: domain(),
      types,
      primaryType,
      message,
    } as Parameters<typeof walletClient.signTypedData>[0]);
    const { r, s, v } = parseSignature(signature);
    if (v === undefined) throw new Error("signature without v");
    out.push({ seat, r: BigInt(r), s: BigInt(s), v: Number(v) });
  }
  return out;
}

/** What the test sent each group: the leaves the registry holds, `0n` for removed ones. */
const expected = new Map<bigint, bigint[]>();

async function add(groupId: bigint, commitments: bigint[]): Promise<void> {
  const leaves = expected.get(groupId) ?? [];
  const firstIndex = BigInt(leaves.length);
  const approved = await approvals(
    {
      AddMembers: [
        { name: "groupId", type: "uint64" },
        { name: "tier", type: "uint8" },
        { name: "firstIndex", type: "uint64" },
        { name: "commitments", type: "uint256[]" },
      ],
    },
    "AddMembers",
    { groupId, tier: 0, firstIndex, commitments },
  );
  await send(
    "addMembers",
    toHex(encodeGroupAddition({ groupId, firstIndex, commitments, approvals: approved })),
  );
  expected.set(groupId, [...leaves, ...commitments]);
}

async function remove(groupId: bigint, indices: bigint[]): Promise<void> {
  const leaves = expected.get(groupId) ?? [];
  const size = BigInt(leaves.length);
  const approved = await approvals(
    {
      RemoveMembers: [
        { name: "groupId", type: "uint64" },
        { name: "tier", type: "uint8" },
        { name: "size", type: "uint64" },
        { name: "indices", type: "uint64[]" },
      ],
    },
    "RemoveMembers",
    { groupId, tier: 0, size, indices },
  );
  await send(
    "removeMembers",
    toHex(encodeGroupRemoval({ groupId, size, indices, approvals: approved })),
  );
  for (const i of indices) leaves[Number(i)] = 0n;
}

/** Distinct commitments, all allowed (above 1 and below BN254's `r`). */
let nextCommitment = 0x1000n;
const commitments = (n: number) => Array.from({ length: n }, () => (nextCommitment += 7919n));

/** Replays every indexed group under the pinned registrars and compares it with what was sent. */
async function expectIndexMatches(schema: string): Promise<void> {
  const groups = await readIndexedGroups(sql, schema);
  expect(groups.map((g) => g.groupId)).toEqual([...expected.keys()]);
  const separator = groupRegistryDomainSeparator(BigInt(chainId), hexToBytes(registry));
  for (const g of groups) {
    expect(g.tier).toBe(0);
    const replay = applyGroupRecords(g.records, {
      groupId: g.groupId,
      domainSeparator: separator,
      tier: g.tier,
      registrars: registrars.map((a) => hexToBytes(a)),
      threshold: 2,
    });
    if (!replay.ok) throw new Error(`group ${g.groupId}: ${replay.reason} at ${replay.at}`);
    expect(replay.leaves).toEqual(expected.get(g.groupId));
  }
}

beforeAll(async () => {
  const port = await freePort();
  rpcUrl = `http://127.0.0.1:${port}`;
  anvil = spawn(
    "anvil",
    ["--host", "127.0.0.1", "--port", String(port), "--chain-id", String(chainId), "--silent"],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  chain = anvilChain(rpcUrl);
  publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  walletClient = createWalletClient({ chain, transport: http(rpcUrl) });
  const accounts = await until("anvil", 20_000, async () => {
    if (anvil.exitCode !== null) throw new Error("anvil exited (is the toolchain installed?)");
    return walletClient.getAddresses();
  });
  // Pinned in ascending order, as the registry requires.
  registrars = accounts
    .slice(1, 4)
    .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
    .map((a) => a.toLowerCase() as Address);
  // Anyone may submit a record: here an account that is no registrar.
  submitter = accounts[5] as Address;

  // forge's build of the registry, compiled from packages/contracts' sources.
  const bytecode = execFileSync(
    "forge",
    ["inspect", "--root", contractsRoot, "src/GroupRegistry.sol:GroupRegistry", "bytecode"],
    { encoding: "utf8" },
  ).trim() as Hex;
  const hash = await walletClient.deployContract({
    account: accounts[0] as Address,
    chain,
    abi: groupRegistryAbi,
    bytecode,
    args: [2, registrars],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 50 });
  if (receipt.contractAddress === null || receipt.contractAddress === undefined)
    throw new Error("GroupRegistry wasn't deployed");
  registry = receipt.contractAddress.toLowerCase() as Address;
  startBlock = receipt.blockNumber;
}, 120_000);

/** Drops Ponder's own schemas (its RPC cache): everything it knows then comes from the chain. */
async function dropPonderCache(): Promise<void> {
  const rows = await sql<{ nspname: string }[]>`
    select nspname from pg_namespace where nspname like 'ponder\_%'`;
  for (const { nspname } of rows) await sql`drop schema ${sql(nspname)} cascade`;
}

afterAll(async () => {
  for (const schema of schemas) await sql`drop schema if exists ${sql(schema)} cascade`;
  await dropPonderCache();
  await sql.end();
  if (anvil !== undefined) await stopped(anvil);
});

describe("apps/indexer on the group registry", () => {
  test("indexes additions and removals so they replay to the registry's tier trees", async () => {
    for (const _ of [0, 1, 2]) {
      await send("createGroup", 0);
      expected.set(BigInt(expected.size), []);
    }
    await add(0n, commitments(3));
    await add(1n, commitments(1));
    await add(0n, commitments(4));
    await remove(0n, [1n, 5n]);
    await add(1n, commitments(2));
    await remove(1n, [0n]);
    // Group 2 stays empty: it must still be listed, with no records.
    // Past Ponder's reorg window (600 s), so these blocks are finalized and
    // reach the index through its backfill; the next ones arrive live.
    await publicClient.request({ method: "evm_increaseTime", params: [3600] } as never);
    await publicClient.request({ method: "evm_mine", params: [] } as never);

    const indexer = await startIndexer();
    try {
      await expectIndexMatches(indexer.schema);

      // Live: records after the backfill reach the index too.
      await add(2n, commitments(2));
      await remove(0n, [0n]);
      await caughtUp(indexer.port);
      await expectIndexMatches(indexer.schema);
    } finally {
      await stopped(indexer.child);
    }
  }, 240_000);

  test("a wiped index is rebuilt from the chain alone (T-66)", async () => {
    // A fresh schema holds nothing, and with Ponder's RPC cache dropped too
    // the indexer rebuilds every row from the chain.
    await dropPonderCache();
    const indexer = await startIndexer();
    try {
      await expectIndexMatches(indexer.schema);
    } finally {
      await stopped(indexer.child);
    }
  }, 240_000);

  test("the index vouches for nothing: under other registrars every group's history fails", async () => {
    const groups = await readIndexedGroups(sql, schemas[1] as string);
    const separator = groupRegistryDomainSeparator(BigInt(chainId), hexToBytes(registry));
    const others = [registrars[0], registrars[1], submitter]
      .map((a) => a as Address)
      .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    for (const g of groups.filter((g) => g.records.length > 0)) {
      const replay = applyGroupRecords(g.records, {
        groupId: g.groupId,
        domainSeparator: separator,
        tier: g.tier,
        registrars: others.map((a) => hexToBytes(a)),
        threshold: 2,
      });
      expect(replay).toMatchObject({ ok: false, error: "group-history", at: 0 });
    }
  });

  test("replay catches a reordered row, but not a dropped removal: completeness needs the accumulator", async () => {
    const groups = await readIndexedGroups(sql, schemas[1] as string);
    const g = groups.find((x) => x.groupId === 0n);
    if (g === undefined) throw new Error("group 0 isn't indexed");
    const replay = (records: typeof g.records) =>
      applyGroupRecords(records, {
        groupId: 0n,
        domainSeparator: groupRegistryDomainSeparator(BigInt(chainId), hexToBytes(registry)),
        tier: 0,
        registrars: registrars.map((a) => hexToBytes(a)),
        threshold: 2,
      });
    const [first, second, ...rest] = g.records;
    if (first === undefined || second === undefined) throw new Error("group 0 has too few records");
    expect(replay([second, first, ...rest])).toMatchObject({
      ok: false,
      at: 0,
      reason: "position",
    });
    // The last record is the live removal of member 0: without it the history
    // still replays, to a tree that keeps member 0.
    expect(g.records.at(-1)?.kind).toBe("remove");
    const shorter = replay(g.records.slice(0, -1));
    expect(shorter.ok).toBe(true);
    if (shorter.ok) expect(shorter.leaves).not.toEqual(expected.get(0n));
  });
});
