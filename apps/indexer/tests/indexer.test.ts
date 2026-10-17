// The indexer against a real chain: Anvil runs the four L2 contracts, the
// group registry's registrars sign through Anvil's unlocked development
// accounts (no key is held here, AGENTS.md), Ponder indexes into a fresh
// Postgres schema, and the indexed records must replay through
// @abolishus/crypto to exactly the tier trees the registry was given, and
// every contract's logs to its stored event accumulator, both from a
// backfill and live, and again after the index is wiped and rebuilt from the
// chain (T-66). The board reads its registries through the stubs its own
// tests use, set from ballot.json, so its ballots are the vectors'.

import { type ChildProcess, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  applyGroupRecords,
  checkContractEvent,
  checkEventAccumulatorProof,
  contractEventLog,
  type ContractEventRecord,
  decodeContractEvent,
  decodeElectionDefinition,
  encodeContractEvent,
  encodeGroupAddition,
  encodeGroupRemoval,
  type GroupApproval,
  groupRegistryDomainSeparator,
} from "@abolishus/crypto";
import {
  boardAbi,
  electionRegistryAbi,
  groupRegistryAbi,
  trusteeRegistryAbi,
} from "@abolishus/contracts/abi";
import postgres from "postgres";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  type Hex,
  hexToBigInt,
  hexToBytes,
  http,
  keccak256,
  encodeFunctionData,
  parseAbi,
  parseSignature,
  stringToHex,
  toHex,
} from "viem";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { readContractEvents, readIndexedGroups, readIndexedLogs } from "../src/records.ts";

const ballotVectors = JSON.parse(
  readFileSync(new URL("../../../docs/spec/vectors/ballot.json", import.meta.url), "utf8"),
) as {
  readonly elections: Record<
    string,
    {
      readonly definition: Hex;
      readonly definitionHash: Hex;
      readonly tiers: readonly { readonly tier: number; readonly root: string }[];
    }
  >;
  readonly ballots: readonly {
    readonly id: string;
    readonly election: string;
    readonly registered: readonly number[];
    readonly encoding: Hex;
  }[];
};
// The vectors' hex has no 0x.
const prefixed = (h: string): Hex => (h.startsWith("0x") ? h : `0x${h}`) as Hex;
const definitionOf = (name: string) => {
  const e = ballotVectors.elections[name];
  if (e === undefined) throw new Error(`ballot.json has no election ${name}`);
  const definition = prefixed(e.definition);
  return {
    ...e,
    definition,
    definitionHash: prefixed(e.definitionHash),
    decoded: decodeElectionDefinition(hexToBytes(definition)),
  };
};
const plurality = definitionOf("plurality");

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
let trusteeRegistry: Address;
let electionRegistry: Address;
let board: Address;
let elections: Address;
let trustees: Address;
let deployer: Address;
/** The block each contract was deployed in. */
const startBlocks = new Map<Address, bigint>();
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
        GROUP_REGISTRY_START_BLOCK: String(startBlocks.get(registry)),
        TRUSTEE_REGISTRY_ADDRESS: trusteeRegistry,
        TRUSTEE_REGISTRY_START_BLOCK: String(startBlocks.get(trusteeRegistry)),
        ELECTION_REGISTRY_ADDRESS: electionRegistry,
        ELECTION_REGISTRY_START_BLOCK: String(startBlocks.get(electionRegistry)),
        BOARD_ADDRESS: board,
        BOARD_START_BLOCK: String(startBlocks.get(board)),
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
  sent(registry, GROUP_EVENT[functionName]);
}

const GROUP_EVENT = {
  createGroup: "GroupCreated",
  addMembers: "MembersAdded",
  removeMembers: "MembersRemoved",
} as const;

/** Sends `data` to `to` from the deployer and waits for its successful receipt. */
async function call(to: Address, data: Hex): Promise<void> {
  const hash = await walletClient.sendTransaction({ account: deployer, chain, to, data });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 50 });
  if (receipt.status !== "success") throw new Error(`call to ${to} reverted`);
}

/** The OP Stack's L1Block predeploy, which Anvil lacks: forge's MockL1Block stands in. */
const L1_BLOCK = "0x4200000000000000000000000000000000000015";
const stubAbi = parseAbi([
  "function set(bytes32,(uint8,uint8,uint8,uint16,uint16,uint8,uint8,uint64,uint64,uint32,(uint8,uint16,uint16,uint16)[]),uint8[],uint256[])",
  "function setCeremony(bytes32,bytes32,bytes32)",
  "function setKeySet(bytes32,bytes32,uint256)",
  "function set(uint64,uint64,bytes32)",
]);

/**
 * Creates an election in the election registry, its L1 origin a made-up L1
 * block (the registry records whatever the predeploy says).
 */
async function createElection(): Promise<void> {
  const count = BigInt(emitted.get(electionRegistry)?.length ?? 0);
  await call(
    L1_BLOCK,
    encodeFunctionData({
      abi: stubAbi,
      functionName: "set",
      args: [100n + count, 1_700_000_000n + count, keccak256(toHex(count))],
    }),
  );
  await call(
    electionRegistry,
    encodeFunctionData({ abi: electionRegistryAbi, functionName: "createElection" }),
  );
  sent(electionRegistry, "ElectionCreated");
}

/**
 * Registers `name`'s definition with the board's stubs, as the sdk's
 * direct-submit tests do: its parameters, a ceremony of its own, and the
 * seats `registered` in that ceremony's key set.
 */
async function registerWithStubs(name: string, registered: readonly number[]): Promise<void> {
  const e = definitionOf(name);
  const d = e.decoded;
  const stub = keccak256(stringToHex(`${name} stub`));
  const panel = keccak256(stringToHex("panel"));
  await call(
    elections,
    encodeFunctionData({
      abi: stubAbi,
      functionName: "set",
      args: [
        e.definitionHash,
        [
          1,
          d.threshold,
          d.panel_size,
          d.option_count,
          e.tiers.length,
          0,
          0,
          d.opens_at,
          d.closes_at,
          0,
          [[1, d.option_count, d.min_selections, d.max_selections]],
        ],
        e.tiers.map((t) => t.tier),
        e.tiers.map((t) => BigInt(t.root)),
      ],
    }),
  );
  await call(
    elections,
    encodeFunctionData({
      abi: stubAbi,
      functionName: "setCeremony",
      args: [e.definitionHash, stub, panel],
    }),
  );
  const seats = registered.reduce((m, seat) => m | (1n << BigInt(seat)), 0n);
  await call(
    trustees,
    encodeFunctionData({ abi: stubAbi, functionName: "setKeySet", args: [stub, panel, seats] }),
  );
}

/** Submits ballot.json's ballot `id` directly to the board, as any voter can (T-25). */
async function submitBallot(id: string): Promise<void> {
  const v = ballotVectors.ballots.find((b) => b.id === id);
  if (v === undefined) throw new Error(`ballot.json has no ballot ${id}`);
  await registerWithStubs(v.election, v.registered);
  await call(
    board,
    encodeFunctionData({
      abi: boardAbi,
      functionName: "submitBallot",
      args: [prefixed(v.encoding)],
    }),
  );
  sent(board, "BallotSubmitted");
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

/**
 * The accumulator's slots, derived here from docs/spec/contracts.md (ERC-7201
 * namespace `abolish.event-accumulator`) rather than taken from the contract.
 */
const accumulatorSlot =
  hexToBigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: "uint256" }],
        [hexToBigInt(keccak256(stringToHex("abolish.event-accumulator"))) - 1n],
      ),
    ),
  ) & ~0xffn;

/**
 * A contract's accumulator and count after `block`, read from its storage.
 * A verifier proves these slots under an output root (verifier 4.4); Anvil's
 * own state stands in for that proof here.
 */
async function storedAccumulator(contract: Address, block: bigint) {
  const word = async (slot: bigint) =>
    (await publicClient.getStorageAt({
      address: contract,
      slot: toHex(slot, { size: 32 }),
      blockNumber: block,
    })) ?? "0x";
  return {
    block,
    accumulator: hexToBytes(await word(accumulatorSlot), { size: 32 }),
    count: hexToBigInt(await word(accumulatorSlot + 1n)),
  };
}

/** The contract-event version every profile pins (verifier 2.3). */
const EVENTS = 5;

const eventContracts = () => ({
  electionRegistry: hexToBytes(electionRegistry),
  trusteeRegistry: hexToBytes(trusteeRegistry),
  groupRegistry: hexToBytes(registry),
  board: hexToBytes(board),
});

/** The accumulator check of a contract's indexed logs against its storage at `block`. */
async function accumulatorCheck(
  logs: readonly ContractEventRecord[],
  block: bigint,
  contract: Address = registry,
) {
  return checkEventAccumulatorProof(
    BigInt(chainId),
    hexToBytes(contract),
    logs.map(contractEventLog),
    await storedAccumulator(contract, block),
  );
}

/** What each contract emitted, by event name in chain order, as the test sent it. */
const emitted = new Map<Address, string[]>();
const sent = (contract: Address, ...events: string[]) =>
  emitted.set(contract, [...(emitted.get(contract) ?? []), ...events]);

/**
 * Every log each contract emitted up to the head is indexed, as a
 * contract-event record that frames, passes the event check under its
 * contract's role, and replays to the contract's stored accumulator, from
 * the constructors' `RegistrarsPinned` and `PanelPinned` on (T-71, T-25).
 */
async function expectLogsComplete(schema: string): Promise<void> {
  const head = await publicClient.getBlockNumber({ cacheTime: 0 });
  for (const contract of [electionRegistry, trusteeRegistry, registry, board]) {
    const logs = await readContractEvents(sql, schema, contract);
    const stored = await storedAccumulator(contract, head);
    expect(BigInt(logs.length), contract).toBe(stored.count);
    const names = logs.map((log) => {
      expect(decodeContractEvent(encodeContractEvent(log, EVENTS), EVENTS)).toEqual(log);
      const checked = checkContractEvent(log, eventContracts(), EVENTS);
      if (!checked.ok) throw new Error(`${contract}: ${checked.error}`);
      return checked.event.event;
    });
    expect(names, contract).toEqual(emitted.get(contract) ?? []);
    expect(await accumulatorCheck(logs, head, contract), contract).toBeNull();
    // Each log's position in its block, as the node reports it.
    const onChain = await publicClient.getLogs({ address: contract, fromBlock: 0n, toBlock: head });
    expect(
      (await readIndexedLogs(sql, schema, contract)).map((l) => [l.record, l.logIndex]),
      contract,
    ).toEqual(logs.map((log, i) => [log, onChain[i]?.logIndex]));
  }
  const [first] = await readContractEvents(sql, schema, registry);
  expect(first && checkContractEvent(first, eventContracts(), EVENTS)).toMatchObject({
    ok: true,
    event: { event: "RegistrarsPinned", threshold: 2 },
  });
}

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
      // A day before ballot.json's elections open, so the board's window
      // can be reached later.
      "--timestamp",
      String(plurality.decoded.opens_at - 86_400n),
      "--silent",
    ],
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

  deployer = accounts[0] as Address;

  registry = await deploy("src/GroupRegistry.sol:GroupRegistry", groupRegistryAbi, [2, registrars]);
  sent(registry, "RegistrarsPinned");

  // A panel of three made-up seats; only their public keys are pinned.
  const keys = [0, 1, 2].map(() => {
    const jwk = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({
      format: "jwk",
    });
    const x = hexToBigInt(toHex(Buffer.from(jwk.x as string, "base64url")));
    const y = hexToBigInt(toHex(Buffer.from(jwk.y as string, "base64url")));
    return {
      x,
      y,
      encoded: toHex(
        Buffer.concat([Buffer.of(2 + Number(y & 1n)), Buffer.from(jwk.x as string, "base64url")]),
      ),
    };
  });
  trusteeRegistry = await deploy("src/TrusteeRegistry.sol:TrusteeRegistry", trusteeRegistryAbi, [
    [
      {
        threshold: 2,
        quorum: 2,
        keys: `0x${keys.map((k) => k.encoded.slice(2)).join("")}`,
        points: keys.map((k) => [k.x, k.y]),
      },
    ],
  ]);
  sent(trusteeRegistry, "PanelPinned");

  elections = await deploy("test/utils/BoardFixture.sol:ElectionsStub", [], []);
  trustees = await deploy("test/utils/BoardFixture.sol:TrusteesStub", [], []);
  // Nothing relays here: the relay's alias is a placeholder.
  const relay = "0x1111111111111111111111111111111111111111";
  board = await deploy("src/Board.sol:Board", boardAbi, [elections, trustees, relay]);
  await publicClient.request({
    method: "anvil_setCode",
    params: [L1_BLOCK, forge("test/utils/MockL1Block.sol:MockL1Block", "deployedBytecode")],
  } as never);
  electionRegistry = await deploy(
    "src/ElectionRegistry.sol:ElectionRegistry",
    electionRegistryAbi,
    [
      {
        board,
        trusteeRegistry,
        groupRegistry: registry,
        l1ChainId: 1n,
        l1Anchor: "0x2222222222222222222222222222222222222222",
        l1Relay: relay,
        epoch: 1n,
      },
    ],
  );
}, 120_000);

/** forge's build of `contract`, compiled from packages/contracts' sources. */
function forge(contract: string, field: "bytecode" | "deployedBytecode"): Hex {
  return execFileSync("forge", ["inspect", "--root", contractsRoot, contract, field], {
    encoding: "utf8",
  }).trim() as Hex;
}

async function deploy(contract: string, abi: unknown, args: readonly unknown[]): Promise<Address> {
  const hash = await walletClient.deployContract({
    account: deployer,
    chain,
    abi,
    bytecode: forge(contract, "bytecode"),
    args,
  } as Parameters<typeof walletClient.deployContract>[0]);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 50 });
  if (receipt.status !== "success" || receipt.contractAddress == null)
    throw new Error(`${contract} wasn't deployed`);
  const address = receipt.contractAddress.toLowerCase() as Address;
  startBlocks.set(address, receipt.blockNumber);
  return address;
}

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
    await createElection();
    // Into the vector elections' window, where the board takes their ballots.
    await publicClient.request({
      method: "evm_mine",
      params: [Number(plurality.decoded.opens_at)],
    } as never);
    await submitBallot("ok-tier-0");
    // Group 2 stays empty: it must still be listed, with no records.
    // Past Ponder's reorg window (600 s), so these blocks are finalized and
    // reach the index through its backfill; the next ones arrive live.
    await publicClient.request({ method: "evm_increaseTime", params: [3600] } as never);
    await publicClient.request({ method: "evm_mine", params: [] } as never);

    const indexer = await startIndexer();
    try {
      await expectIndexMatches(indexer.schema);
      await expectLogsComplete(indexer.schema);

      // Live: records after the backfill reach the index too.
      await submitBallot("ok-approval");
      await createElection();
      await submitBallot("ok-tier-2-blank");
      await add(2n, commitments(2));
      await remove(0n, [0n]);
      await caughtUp(indexer.port);
      await expectIndexMatches(indexer.schema);
      await expectLogsComplete(indexer.schema);
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
      await expectLogsComplete(indexer.schema);
    } finally {
      await stopped(indexer.child);
    }
  }, 240_000);

  test("the board's direct-submitted ballots are indexed as the records it accepted (T-25)", async () => {
    const logs = await readContractEvents(sql, schemas[1] as string, board);
    const ballots = logs.map((log) => {
      const checked = checkContractEvent(log, eventContracts(), EVENTS);
      if (!checked.ok || checked.event.event !== "BallotSubmitted")
        throw new Error("a board log that isn't a ballot");
      return {
        definitionHash: toHex(checked.event.definitionHash),
        record: toHex(checked.event.record),
      };
    });
    expect(ballots).toEqual(
      ["ok-tier-0", "ok-approval", "ok-tier-2-blank"].map((id) => {
        const v = ballotVectors.ballots.find((b) => b.id === id);
        if (v === undefined) throw new Error(`ballot.json has no ballot ${id}`);
        return {
          definitionHash: definitionOf(v.election).definitionHash.toLowerCase(),
          record: prefixed(v.encoding).toLowerCase(),
        };
      }),
    );
  });

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

  test("replay catches a reordered row, but not a dropped removal: the accumulator does", async () => {
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

  test("the accumulator check fails a dropped, altered or moved log", async () => {
    const logs = await readContractEvents(sql, schemas[1] as string, registry);
    const head = await publicClient.getBlockNumber({ cacheTime: 0 });
    const renumber = (list: readonly ContractEventRecord[]) =>
      list.map((log, i) => ({ ...log, n: BigInt(i) }));
    const last = logs.at(-1);
    // Logs 1 to 3 create the groups; log 4 is group 0's first addition.
    const middle = logs[4];
    if (last === undefined || middle === undefined) throw new Error("too few logs indexed");
    // The last log is group 0's live removal of member 0, the one replay can't miss.
    expect(checkContractEvent(last, eventContracts(), EVENTS)).toMatchObject({
      ok: true,
      event: { event: "MembersRemoved" },
    });
    expect(await accumulatorCheck(logs.slice(0, -1), head)).toBe("accumulator");
    expect(await accumulatorCheck(renumber(logs.toSpliced(4, 1)), head)).toBe("accumulator");
    const altered = {
      ...middle,
      data: Uint8Array.from(middle.data, (b, i) => (i === 0 ? b ^ 1 : b)),
    };
    expect(await accumulatorCheck(logs.with(4, altered), head)).toBe("accumulator");
    const moved = { ...middle, l2_block: middle.l2_block + 1n };
    expect(await accumulatorCheck(logs.with(4, moved), head)).not.toBeNull();
    // Against the storage before the last log's block, the archive's extra
    // log is past the proven count: it waits for a later proof.
    expect(await accumulatorCheck(logs, last.l2_block - 1n)).toBeNull();
  });

  test("a row deleted from the index shifts every later log and fails the accumulator check", async () => {
    const schema = schemas[1] as string;
    const head = await publicClient.getBlockNumber({ cacheTime: 0 });
    // Group 0's first removal, in the middle of the sequence.
    const [row] = await sql<{ id: string }[]>`
      select id from ${sql(schema)}.contract_log
      where topics[1] = ${keccak256(stringToHex("MembersRemoved(uint64,bytes)"))}
      order by id collate "C" limit 1`;
    if (row === undefined) throw new Error("no MembersRemoved indexed");
    // Ponder's live-query trigger expects its running instance; the indexer
    // has stopped, so only the user triggers are set aside for the delete.
    await sql.begin(async (tx) => {
      await tx`alter table ${tx(schema)}.contract_log disable trigger user`;
      await tx`delete from ${tx(schema)}.contract_log where id = ${row.id}`;
      await tx`alter table ${tx(schema)}.contract_log enable trigger user`;
    });
    const logs = await readContractEvents(sql, schema, registry);
    expect(logs.map((l) => l.n)).toEqual(logs.map((_, i) => BigInt(i)));
    expect(await accumulatorCheck(logs, head)).toBe("accumulator");
  });
});
