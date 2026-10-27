import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createECDH, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import {
  boardAbi,
  boardAnchorAbi,
  electionRegistryAbi,
  groupRegistryAbi,
  trusteeRegistryAbi,
} from "@abolishus/contracts/abi";
import {
  createPollDraft,
  listPolls,
  newAccountId,
  POLL_DEFINITION_PROFILE,
  type PollStubDeployment,
  readAccountPoll,
  readBoard,
  readDefinition,
  readServedDisplayText,
  submitPollDraft,
} from "@abolishus/core";
import { Seat } from "@abolishus/core/test-ceremony-seats";
import { type TestDb, testDb } from "@abolishus/core/test-db";
import {
  ceremonyTranscriptHash,
  checkElectionRecordToShow,
  decodeBoardEntry,
  decodeElectionDefinitionV5,
  electionDefinitionV5Hash,
  encodeGroupAddition,
  groupAdditionDigest,
  groupRegistryDomainSeparator,
  identityKey,
  type Panel,
  RECORD_TYPES,
  signGroupApproval,
  tierTreeRoot,
} from "@abolishus/crypto";
import { electionAdmission } from "@abolishus/verifier";
import { Redis } from "ioredis";
import type { Sql } from "postgres";
import {
  type Address,
  bytesToHex,
  concat,
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  getContractAddress,
  type Hex,
  hexToBytes,
  http,
  keccak256,
  parseAbi,
  type PublicClient,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import {
  checkCreationAnchorsDeployment,
  checkPollCreationDeployment,
  type LogLine,
  MESSAGE_PASSER,
  PollRoots,
  pollStubDeployment,
  ProvenRegistryAccumulator,
  RegistrySync,
  type RunningWorker,
  startWorker,
  ViemCreationAnchors,
  ViemPollCreationChain,
} from "../src/index.ts";

// A poll's whole setup end to end (P2-22 part 7a; [[0032-poll-creation-operations]]):
// an author's submitted draft becomes an open poll through every step's real
// adapter and both worker processes as main.ts sets them up, the creation worker
// holding the key alone (rule 2) and the other running the registry sync,
// roots, stub, coordinator and opening. Two Anvils run the real contracts: the
// L1 the board anchor, the L2 the trustee, group and election registries and
// the board. Then the verifier admits the definition the registry holds with
// the board's entry 0, the API lists the poll, and the public page's check
// takes its text (T-25, T-34, T-37, T-71, T-72).
//
// Stood in, each tested against the real thing elsewhere:
// - the L2's sequencer, which here copies the L1's latest block into the
//   L1Block predeploy (MockL1Block) after each L1 block;
// - the proposer and the dispute game: each output root is computed here from
//   the L2's finalized block, as a proposer posts it, and handed to the proven
//   adapter, which proves every read under it (tests/output-roots.test.ts has
//   DisputeGameRoots against a scripted factory);
// - Ponder: the L2's logs are copied into `contract_log` as it writes them,
//   trusted for nothing, since each sequence is checked against its proven
//   accumulator (apps/indexer's tests run Ponder against Anvil);
// - the three seats run in-process against the coordinator's tables, not
//   through apps/api's routes (apps/api's ceremony tests);
// - the draft is created and submitted through core, not apps/web's handler
//   (apps/web's serve tests), with Turnstile passing.
//
// The run moves both chains' time on, and the workers and the seats read
// the chains' clock, so the half hour of the per-slot check and of setup
// pass in seconds. The creation key is a fresh random key funded on Anvil;
// the seats' keys and the registrars' are fixed test values (AGENTS.md).

const redisUrl = process.env["REDIS_URL"];
if (!redisUrl) throw new Error("REDIS_URL is not set");

const contractsRoot = fileURLToPath(new URL("../../../packages/contracts", import.meta.url));
// The reference election's local chains, which no real network uses: on an
// OP Stack network's ID (Base Sepolia's, say) Anvil charges the L1 data fee
// from the L1Block predeploy's storage, which the sequencer stand-in fills
// with a real block's hash, and drops every transaction after it.
const L1_CHAIN_ID = 31_337n;
const L2_CHAIN_ID = 31_338n;
/** The OP Stack's L1Block predeploy, which createElection reads its L1 origin from. */
const L1_BLOCK: Address = "0x4200000000000000000000000000000000000015";
const PERIOD = 3600n;
/** How often every scheduled step runs here, in real milliseconds. */
const EVERY_MS = 150;

interface RegistrarVectors {
  readonly threshold: number;
  readonly secretKeys: readonly string[];
  readonly addresses: readonly string[];
}
const vectors = JSON.parse(
  readFileSync(new URL("../../../docs/spec/vectors/group-registry.json", import.meta.url), "utf8"),
) as { registrars: RegistrarVectors };
const REGISTRARS = vectors.registrars.addresses.map((a) => getAddress(`0x${a}`));
const REGISTRAR_THRESHOLD = vectors.registrars.threshold;
const REGISTRAR_SIGNERS = [0, 2].map((i) => ({
  seat: i + 1,
  secretKey: hexToBytes(`0x${vectors.registrars.secretKeys[i]}`),
}));

const seatSecret = (i: number) => {
  const d = new Uint8Array(32);
  d[0] = 0x42;
  d[31] = i;
  return d;
};
/** The default panel: 2 of 3, pinned at rule 7's quorum of 2. */
const SECRETS = [1, 2, 3].map(seatSecret);
const PANEL: Panel = { threshold: 2, keys: SECRETS.map(identityKey) };
const RECEIPT_KEYS = [7, 8]
  .map((i) => identityKey(seatSecret(i)))
  .sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
/** The contract-event version the stubs' profile pins, which the sync must read. */
const EVENT_VERSION = POLL_DEFINITION_PROFILE.pins.find(
  (p) => p.record_type === RECORD_TYPES.contractEvent,
)?.version as 7;

/** The trustee registry's `PanelInput`, transitional, a seat's `(x, y)` from its secret. */
function panelInput(secrets: readonly Uint8Array[], threshold: number, quorum: number) {
  const points = secrets.map((d) => {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(d);
    const u = ecdh.getPublicKey();
    return [BigInt(toHex(u.subarray(1, 33))), BigInt(toHex(u.subarray(33)))] as const;
  });
  return {
    threshold,
    quorum,
    kind: 2,
    keys: toHex(Buffer.concat(secrets.map(identityKey))),
    points,
  };
}

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

interface Chain {
  readonly process: ChildProcess;
  readonly chain: ReturnType<typeof defineChain>;
  readonly client: PublicClient;
  readonly wallet: ReturnType<typeof createWalletClient>;
  readonly deployer: Address;
  rpc(method: string, params: unknown[]): Promise<unknown>;
}

/** An Anvil whose finalized block is its latest but two (one slot per epoch). */
async function anvil(chainId: bigint): Promise<Chain> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const process = spawn(
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
  const chain = defineChain({
    id: Number(chainId),
    name: "anvil",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  });
  // Polled every 20 ms: viem's default would add seconds to each wait.
  const client = createPublicClient({ chain, transport: http(url), pollingInterval: 20 });
  const wallet = createWalletClient({ chain, transport: http(url) });
  const [deployer] = (await until("anvil", 20_000, async () => {
    if (process.exitCode !== null) throw new Error("anvil exited (is the toolchain installed?)");
    return wallet.getAddresses();
  })) as [Address];
  return {
    process,
    chain,
    client: client as PublicClient,
    wallet,
    deployer,
    rpc: (method, params) => client.request({ method, params } as never) as Promise<unknown>,
  };
}

const forge = (target: string, field: "bytecode" | "deployedBytecode") =>
  execFileSync("forge", ["inspect", "--root", contractsRoot, target, field], {
    encoding: "utf8",
  }).trim() as Hex;

/** Polled directly: viem's wait can miss Anvil's one new block and hang. */
const receiptOf = (c: Chain, hash: Hex) =>
  until("a receipt", 20_000, () => c.client.getTransactionReceipt({ hash }));

async function deploy(
  c: Chain,
  abi: readonly unknown[],
  target: string,
  args: readonly unknown[],
): Promise<Address> {
  const hash = await c.wallet.deployContract({
    account: c.deployer,
    chain: c.chain,
    abi,
    bytecode: forge(target, "bytecode"),
    args,
  } as Parameters<typeof c.wallet.deployContract>[0]);
  const receipt = await receiptOf(c, hash);
  if (!receipt.contractAddress || receipt.status !== "success")
    throw new Error(`${target} wasn't deployed`);
  return getAddress(receipt.contractAddress);
}

async function send(c: Chain, tx: Parameters<typeof c.wallet.writeContract>[0]) {
  const hash = await c.wallet.writeContract(tx);
  const receipt = await receiptOf(c, hash);
  if (receipt.status !== "success") throw new Error(`${tx.functionName} reverted`);
}

let l1: Chain;
let l2: Chain;
let db: TestDb;
let app: Sql;
let redis: Redis;
let index: string;
let anchor: Address;
let electionRegistry: Address;
let trusteeRegistry: Address;
let groupRegistry: Address;
let board: Address;
let members: bigint[];
/** The last L2 block whose logs are in the index. */
let indexed = -1n;
/** What every stub pins, as the setup worker checked it at startup. */
let stubDeployment: PollStubDeployment;
const workers: RunningWorker[] = [];
const prefix = `abolish-test-${randomBytes(6).toString("hex")}`;
const lines: LogLine[] = [];

/**
 * The one clock, in seconds, that the workers and the seats read: the newer
 * of the two chains' latest block times, which run on from it with real time.
 */
let clock: bigint;
const now = () => new Date(Number(clock) * 1000);

/** Mines three blocks on `c`, so every block before them is final. */
const mine = (c: Chain) => c.rpc("anvil_mine", [toHex(3)]);

/**
 * The L2's sequencer stood in: its L1Block predeploy takes the L1's latest
 * block, as each L2 block's attributes carry it, so the next event's origin
 * is a real L1 block (docs/spec/contracts.md, The L1 origin).
 */
async function sequence() {
  const head = await l1.client.getBlock({ blockTag: "latest" });
  await send(l2, {
    account: l2.deployer,
    chain: l2.chain,
    address: L1_BLOCK,
    abi: parseAbi(["function set(uint64 number, uint64 timestamp, bytes32 hash)"]),
    functionName: "set",
    args: [head.number, head.timestamp, head.hash],
  });
}

/**
 * Ponder stood in: every log of the four L2 contracts up to the latest
 * block, as `contract_log` holds it, its ID sorting in chain order.
 */
async function indexLogs() {
  const head = await l2.client.getBlockNumber({ cacheTime: 0 });
  const logs = await l2.client.getLogs({
    address: [electionRegistry, trusteeRegistry, groupRegistry, board],
    fromBlock: indexed + 1n,
    toBlock: head,
  });
  for (const log of logs) {
    const block = await l2.client.getBlock({ blockNumber: log.blockNumber });
    const id = `${String(log.blockNumber).padStart(16, "0")}${String(log.logIndex).padStart(8, "0")}`;
    await db.admin`
      INSERT INTO ${db.admin(index)}.contract_log VALUES (
        ${id}, ${log.address.toLowerCase()}, ${log.blockNumber.toString()},
        ${block.timestamp.toString()}, ${log.topics as string[]}, ${log.data},
        ${log.transactionHash}, ${log.logIndex})
      ON CONFLICT (id) DO NOTHING`;
  }
  // Only once every log is in: the proposer reads `indexed` while the
  // workers run, and a root for a block whose logs aren't all copied fails
  // the registry sync's accumulator check as `incomplete`.
  indexed = head;
}

/**
 * Both chains moved `seconds` on and mined until it is final, the sequencer
 * carrying the L1's head over, the index caught up, and the clock set to
 * the newer chain's time.
 */
async function advance(seconds: bigint) {
  for (const c of [l1, l2]) await c.rpc("evm_increaseTime", [toHex(seconds)]);
  await mine(l1);
  await sequence();
  await mine(l2);
  await indexLogs();
  const times = await Promise.all(
    [l1, l2].map(async (c) => (await c.client.getBlock({ blockTag: "latest" })).timestamp),
  );
  clock = times.reduce((a, b) => (a > b ? a : b));
}

/**
 * The proposer stood in: the version-0 output root of the L2's finalized
 * block, from its state root, the message passer's storage root and its
 * hash, as the OP Stack defines it. Never past the index: a real proposer
 * posts hours behind the head, long after Ponder has the block's logs, while
 * here the creation worker's transactions mine L2 blocks at any moment, and
 * a root posted for one `indexLogs` hasn't copied yet fails the registry
 * sync's accumulator check as `incomplete`. And never the latest block: Anvil
 * answers `eth_getProof` for its latest block from its current state, so a
 * block the creation worker mines meanwhile can stand in for it, and the
 * registry's proof then fails under the root as `l2-proof-missing`. Under
 * load, Anvil also keeps an older block's state now and then as another
 * state than the one its header commits to, and answers every proof at that
 * block from it, so a root for that block fails the same way: such a block
 * is passed over for the one before it, as no real node serves one.
 */
const proposer = {
  async latest() {
    const latest = await l2.client.getBlockNumber({ cacheTime: 0 });
    const finalized = await l2.client.getBlock({ blockTag: "finalized" });
    const below = [indexed, latest - 1n].reduce((a, b) => (a < b ? a : b));
    let head =
      finalized.number <= below ? finalized : await l2.client.getBlock({ blockNumber: below });
    for (;;) {
      const passer = await l2.client.getProof({
        address: MESSAGE_PASSER,
        storageKeys: [],
        blockNumber: head.number,
      });
      // The account proof's first node is the state trie's root node.
      const proves = keccak256(passer.accountProof[0] ?? "0x") === head.stateRoot;
      if (proves || head.number === 0n) return rootOf(head, passer.storageHash);
      head = await l2.client.getBlock({ blockNumber: head.number - 1n });
    }
  },
};

/** The version-0 output root of `head`, with the message passer's storage root. */
function rootOf(head: { number: bigint; stateRoot: Hex; hash: Hex }, passerStorage: Hex) {
  const word0 = toHex(0n, { size: 32 });
  return {
    outputRoot: hexToBytes(keccak256(concat([word0, head.stateRoot, passerStorage, head.hash]))),
    l2Block: head.number,
  };
}

beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
  redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  // One after the other: two free ports asked for at once can be the same.
  l1 = await anvil(L1_CHAIN_ID);
  l2 = await anvil(L2_CHAIN_ID);
  clock = (await l1.client.getBlock({ blockTag: "latest" })).timestamp;

  // L1: the board anchor, its clock begun ten periods ago. Code that isn't a
  // single key's stands in for the authority's multisig, as its constructor
  // requires; nothing here anchors.
  const epoch = clock - 10n * PERIOD;
  const authority = getAddress(toHex(0xa0c5000n, { size: 20 }));
  await l1.rpc("anvil_setCode", [authority, "0x00"]);
  anchor = await deploy(l1, boardAnchorAbi, "src/BoardAnchor.sol:BoardAnchor", [
    { epoch, period: PERIOD, deadline: 43_200n },
    authority,
  ]);

  // L2: the predeploy, the panel pinned, the registrars' group registry, and
  // the election registry and board, which name each other: the board's
  // address is the one its CREATE will have.
  await l2.rpc("anvil_setCode", [
    L1_BLOCK,
    forge("test/utils/MockL1Block.sol:MockL1Block", "deployedBytecode"),
  ]);
  trusteeRegistry = await deploy(
    l2,
    trusteeRegistryAbi,
    "src/TrusteeRegistry.sol:TrusteeRegistry",
    [[panelInput(SECRETS, 2, 2)]],
  );
  // The pinned panel is the Tier 2 scope's initial panel too.
  const panelId = await l2.client.readContract({
    address: trusteeRegistry,
    abi: trusteeRegistryAbi,
    functionName: "panelIds",
    args: [0n],
  });
  groupRegistry = await deploy(l2, groupRegistryAbi, "src/GroupRegistry.sol:GroupRegistry", [
    REGISTRAR_THRESHOLD,
    REGISTRARS,
    trusteeRegistry,
    panelId,
  ]);
  // A relay on L1 that nothing here calls.
  const l1Relay = getAddress(toHex(0xd0005n, { size: 20 }));
  const nonce = BigInt(await l2.client.getTransactionCount({ address: l2.deployer }));
  const predicted = getContractAddress({ from: l2.deployer, nonce: nonce + 1n });
  electionRegistry = await deploy(
    l2,
    electionRegistryAbi,
    "src/ElectionRegistry.sol:ElectionRegistry",
    [
      {
        board: predicted,
        trusteeRegistry,
        groupRegistry,
        l1ChainId: L1_CHAIN_ID,
        l1Anchor: anchor,
        l1Relay,
        epoch,
      },
    ],
  );
  board = await deploy(l2, boardAbi, "src/Board.sol:Board", [
    electionRegistry,
    trusteeRegistry,
    l1Relay,
  ]);
  if (board !== predicted) throw new Error("the board isn't where the election registry names it");

  // The electorate: one Tier 0 group of three, added by a record the
  // registrars signed, as the Tier 0 batch job would send it.
  await send(l2, {
    account: l2.deployer,
    chain: l2.chain,
    address: groupRegistry,
    abi: groupRegistryAbi,
    functionName: "createGroup",
    args: [0],
  } as never);
  members = [11n, 12n, 13n].map((i) => (BigInt(`0x${randomBytes(8).toString("hex")}`) << 64n) + i);
  const digest = groupAdditionDigest(
    groupRegistryDomainSeparator(L2_CHAIN_ID, hexToBytes(groupRegistry)),
    { groupId: 0n, tier: 0, firstIndex: 0n, commitments: members },
  );
  await send(l2, {
    account: l2.deployer,
    chain: l2.chain,
    address: groupRegistry,
    abi: groupRegistryAbi,
    functionName: "addMembers",
    args: [
      toHex(
        encodeGroupAddition({
          groupId: 0n,
          firstIndex: 0n,
          commitments: members,
          approvals: REGISTRAR_SIGNERS.map((s) => signGroupApproval(digest, s.seat, s.secretKey)),
        }),
      ),
    ],
  } as never);

  // The indexer's `contract_log` as Ponder creates it (apps/indexer/ponder.schema.ts).
  index = `ix_${randomBytes(6).toString("hex")}`;
  await db.admin.unsafe(`CREATE SCHEMA "${index}"`);
  await db.admin.unsafe(`CREATE TABLE "${index}".contract_log (
    id text PRIMARY KEY, contract text NOT NULL, block_number numeric(78) NOT NULL,
    block_timestamp numeric(78) NOT NULL, topics text[] NOT NULL, data text NOT NULL,
    transaction_hash text NOT NULL, log_index integer NOT NULL)`);
  await advance(1n);
}, 120_000);

afterAll(async () => {
  await Promise.allSettled(workers.map((w) => w.close()));
  if (redis !== undefined) {
    for (const key of await redis.keys(`${prefix}:*`)) await redis.del(key);
    redis.disconnect();
  }
  await db?.admin.unsafe(`DROP SCHEMA IF EXISTS "${index}" CASCADE`);
  await db?.close();
  await Promise.all(
    [l1, l2].map(async (c) => {
      if (c === undefined || c.process.exitCode !== null) return;
      const exited = new Promise((r) => c.process.once("exit", r));
      c.process.kill("SIGTERM");
      await exited;
    }),
  );
});

/** The creation worker, set up as main.ts does from its configuration: the key and nothing else. */
async function creationWorker(): Promise<RunningWorker> {
  const key = generatePrivateKey();
  await l2.rpc("anvil_setBalance", [privateKeyToAddress(key), toHex(10n ** 20n)]);
  const checked = await checkPollCreationDeployment(l2.client, {
    chainId: L2_CHAIN_ID,
    registry: electionRegistry,
    l1ChainId: L1_CHAIN_ID,
    anchor,
    panel: PANEL,
  });
  const anchorClock = await checkCreationAnchorsDeployment(l1.client, {
    chainId: L1_CHAIN_ID,
    anchor,
  });
  return startWorker({
    connection: redis,
    sql: app,
    log: (l) => lines.push(l),
    auditEveryMs: 3_600_000,
    prefix,
    now,
    pollCreation: {
      chain: new ViemPollCreationChain({
        client: l2.client,
        chainId: L2_CHAIN_ID,
        registry: electionRegistry,
        trusteeRegistry: checked.trusteeRegistry,
        key: hexToBytes(key),
      }),
      dailyCeiling: 10,
      anchors: new ViemCreationAnchors({ client: l1.client, anchor, clock: anchorClock }),
      panel: PANEL,
      everyMs: EVERY_MS,
    },
  });
}

/**
 * The other worker, set up as main.ts does: the registry sync and, beside
 * it, the roots, the stub with the coordinator, and the opening step, all on
 * one deployment checked against the chains at startup.
 */
async function setupWorker(): Promise<RunningWorker> {
  const accumulator = await ProvenRegistryAccumulator.connect(l2.client, L2_CHAIN_ID, proposer);
  stubDeployment = await pollStubDeployment(
    l2.client,
    {
      chainId: L2_CHAIN_ID,
      l1ChainId: L1_CHAIN_ID,
      electionRegistry,
      board,
      trusteeRegistry,
      groupRegistry,
      eventVersion: EVENT_VERSION,
    },
    {
      panel: PANEL,
      receiptKeys: RECEIPT_KEYS,
      l1InclusionBound: 3600,
      sequencingWindow: 3600n,
      maxSequencerDrift: 1800n,
    },
  );
  const anchorClock = await checkCreationAnchorsDeployment(l1.client, {
    chainId: L1_CHAIN_ID,
    anchor: bytesToHex(stubDeployment.l1Anchor),
  });
  return startWorker({
    connection: redis,
    sql: app,
    log: (l) => lines.push(l),
    auditEveryMs: 3_600_000,
    prefix,
    now,
    registry: {
      sync: new RegistrySync({
        sql: app,
        index: db.admin,
        indexSchema: index,
        accumulator,
        deployment: {
          chainId: L2_CHAIN_ID,
          contracts: {
            electionRegistry: hexToBytes(electionRegistry),
            trusteeRegistry: hexToBytes(trusteeRegistry),
            groupRegistry: hexToBytes(groupRegistry),
            board: hexToBytes(board),
          },
          version: EVENT_VERSION,
        },
      }),
      everyMs: EVERY_MS,
    },
    pollRoots: {
      roots: new PollRoots({
        sql: app,
        index: db.admin,
        indexSchema: index,
        accumulator,
        chainId: L2_CHAIN_ID,
        deployment: {
          groups: new Map([[0, [{ group_id: 0n, region: 0 }]]]),
          pins: {
            version: EVENT_VERSION,
            chainId: L2_CHAIN_ID,
            registry: hexToBytes(groupRegistry),
            registrars: REGISTRARS.map((a) => hexToBytes(a)),
            threshold: REGISTRAR_THRESHOLD,
          },
        },
      }),
      everyMs: EVERY_MS,
    },
    pollStubs: {
      deployment: stubDeployment,
      everyMs: EVERY_MS,
      coordinateEveryMs: EVERY_MS,
      openEveryMs: EVERY_MS,
      clock: { anchor: stubDeployment.l1Anchor, ...anchorClock },
    },
  });
}

/** Setup's states in order, as the account side records them. */
const STATES = ["submitted", "created", "rooted", "ceremony", "registered", "open"];
/** Each state the run saw the poll in, in the order it saw them; a step can pass within one look. */
const seen: string[] = [];

/** The poll's row as the account side holds it; a failed poll fails the run with its reason. */
async function row(id: string) {
  const [r] = await db.admin`
    SELECT state, failure, election_id, anchors_checked_block, electorate
    FROM account_polls WHERE id = ${id}`;
  if (r === undefined) throw new Error("the poll is gone");
  if (r["state"] === "failed") throw new Error(`the poll failed: ${String(r["failure"])}`);
  if (seen.at(-1) !== r["state"]) seen.push(r["state"] as string);
  return r;
}

/** Whether the poll has reached `state` or gone past it. */
const reached = (state: string) => (r: Awaited<ReturnType<typeof row>>) =>
  STATES.indexOf(r["state"] as string) >= STATES.indexOf(state);

/**
 * Moves the clock `step` seconds at a time, the seats acting at each, until
 * `done` holds of the poll's row.
 */
async function drive(
  what: string,
  id: string,
  step: bigint,
  done: (r: Awaited<ReturnType<typeof row>>) => boolean,
  seats: readonly Seat[] = [],
) {
  // Its own loop, not `until`: a failed poll ends the run at once, with its reason.
  const end = Date.now() + 90_000;
  while (!done(await row(id))) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    for (const s of seats) await s.act(app, now());
    await advance(step);
    // A tick of every scheduled step at the new time.
    await new Promise((r) => setTimeout(r, 2 * EVERY_MS));
  }
}

test("a submitted poll is created, checked, rooted, keyed, registered, synced and opened, and the verifier admits it", async () => {
  workers.push(await creationWorker(), await setupWorker());

  // The author's draft, submitted.
  const author = newAccountId();
  await app`
    INSERT INTO account_users VALUES (${author}, ${`${newAccountId()}@account.invalid`},
      false, '', NULL, now(), now())`;
  const closesAt = clock + 7n * 24n * 3600n;
  const draft = {
    language: "en",
    title: "Lunch",
    description: "Where the team eats on Friday.",
    questions: [
      {
        question: "Which day?",
        description: "",
        options: [
          { label: "Friday", description: "" },
          { label: "Monday", description: "" },
        ],
        minSelections: 0,
        maxSelections: 1,
      },
    ],
    tiers: [0],
    closesAt,
  };
  const id = await createPollDraft(app, author, draft, now());
  await submitPollDraft(app, author, id, {
    turnstile: { verify: async () => "passed" as const },
    token: "t",
    now: now(),
  });

  // Created, once its block is final.
  await drive("the creation", id, 1n, reached("created"));
  // The per-slot check, once the drift has passed since its L1 origin.
  await drive("the per-slot check", id, 600n, (r) => r["anchors_checked_block"] !== null);
  // Rooted at a proven block, with the group's three members in one cell.
  await drive("the roots", id, 1n, reached("rooted"));
  const [tier] = (await row(id))["electorate"] as { cells: unknown[] }[];
  expect(tier?.cells).toEqual([{ root: tierTreeRoot(members).toString(), members: "3" }]);

  // The ceremony between the three seats, its record and the definition
  // registered, the registration synced and the poll opened, a few seconds
  // at a time: registration must come before the stub opens.
  const seats = [1, 2, 3].map(
    (i) =>
      new Seat(i, { deployment: stubDeployment, secrets: SECRETS, client: () => app, now: now() }),
  );
  await drive("the stub", id, 5n, reached("ceremony"));
  await drive("the registration", id, 5n, reached("registered"), seats);
  await drive("the opening", id, 5n, reached("open"));
  // It only ever moved forward: no identifier abandoned, no run retried.
  const order = seen.map((state) => STATES.indexOf(state));
  expect(order).toEqual([...order].sort((x, y) => x - y));
  expect(seen.at(-1)).toBe("open");

  // What the registry holds is the stored definition, under the identifier
  // the poll's page names.
  const poll = await readAccountPoll(app, author, id);
  expect(poll).toMatchObject({ state: "open" });
  const electionId = Uint8Array.from((await row(id))["election_id"] as Uint8Array);
  expect(Uint8Array.from(poll?.electionId ?? [])).toEqual(electionId);
  const definition = await readDefinition(app, electionId);
  if (definition === undefined) throw new Error("the definition wasn't stored");
  const decoded = decodeElectionDefinitionV5(definition);
  const held = await l2.client.readContract({
    address: electionRegistry,
    abi: electionRegistryAbi,
    functionName: "definitionHashOf",
    args: [bytesToHex(electionId)],
  });
  expect(held).toBe(bytesToHex(electionDefinitionV5Hash(decoded)));
  expect(decoded.l1_anchor).toEqual(hexToBytes(anchor));
  expect(decoded.closes_at).toBe(closesAt);

  // The board's entry 0 is the approved transcript, and the verifier admits
  // the definition with it under the pinned panel, as it would judge ballots.
  const entries = await readBoard(app, electionId);
  expect(entries.length).toBe(1);
  const entry = decodeBoardEntry(entries[0]!, 5);
  expect(entry.index).toBe(0n);
  expect(ceremonyTranscriptHash(entry.payload)).toEqual(decoded.ceremony_transcript_hash);
  expect(electionAdmission(definition, PANEL, entries)).toMatchObject({
    ok: true,
    electionId,
    closesAt,
  });

  // The API lists it, and the public page's check takes the text it serves.
  expect((await listPolls(app, undefined, 100)).map((e) => bytesToHex(e))).toContain(
    bytesToHex(electionId),
  );
  const served = await readServedDisplayText(app, electionId, clock);
  if (served?.served !== "text") throw new Error("the poll's text isn't served");
  expect(
    checkElectionRecordToShow(electionId, hexToBytes(held), definition, served.displayText),
  ).toMatchObject({ ok: true });

  // No step failed a job on the way. A refused registry sync logs its
  // finding on its own line, so a failure names it rather than only the job.
  expect(
    lines.filter((l) => "outcome" in l && l.outcome === "failed"),
    JSON.stringify(lines.filter((l) => "finding" in l)),
  ).toEqual([]);
}, 180_000);
