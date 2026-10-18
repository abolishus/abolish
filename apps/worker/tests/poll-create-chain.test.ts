import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { electionRegistryAbi, trusteeRegistryAbi } from "@abolishus/contracts/abi";
import {
  advancePollCreations,
  advancePollRegistrations,
  approvedCeremony,
  createPollDraft,
  pollRegistration,
  newAccountId,
  openCeremonyRuns,
  type PollStubDeployment,
  type StoredTierElectorate,
  stubPolls,
  submitPollDraft,
} from "@abolishus/core";
import { Seat } from "@abolishus/core/test-ceremony-seats";
import { type TestDb, testDb } from "@abolishus/core/test-db";
import {
  decodeElectionDefinitionV5,
  electionDefinitionV5Hash,
  identityKey,
  type Panel,
  PanelError,
  tierTreeRoot,
} from "@abolishus/crypto";
import { createECDH } from "node:crypto";
import type { Sql } from "postgres";
import {
  type Address,
  bytesToHex,
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  defineChain,
  getAddress,
  type Hex,
  hexToBytes,
  http,
  parseTransaction,
  type PublicClient,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  checkPollCreationDeployment,
  FALLBACK_GAS_BASE,
  FALLBACK_GAS_PER_BYTE,
  MAX_TX_GAS,
  ViemPollCreationChain,
} from "../src/index.ts";

// The creation step's chain adapter against a real chain (P2-22 parts 3a and
// 5b): Anvil runs the election and trustee registries, the startup check
// refuses a node or an address that isn't the configured registry, or a
// panel its trustee registry doesn't pin at rule 7's quorum, and core's
// advancePollCreations, run through the adapter, creates a submitted poll
// and records the identifier the registry gave only once its block is final
// (T-25, T-34, T-72). Then advancePollRegistrations registers that poll's
// approved ceremony and definition through it, and the registry admits them
// (T-37). The creation key is a fresh random key funded on Anvil for the
// run, and the seats' keys are fixed test values; no real key is held here
// (AGENTS.md).

const contractsRoot = fileURLToPath(new URL("../../../packages/contracts", import.meta.url));
// One slot per epoch: Anvil's finalized block is then the latest but two.
const FINALITY_DEPTH = 2;
const CHAIN_ID = 84_532n;
/** The OP Stack's L1Block predeploy, which createElection reads its L1 origin from. */
const L1_BLOCK = "0x4200000000000000000000000000000000000015";
const NOW = new Date();
const NOW_S = BigInt(Math.floor(NOW.getTime() / 1000));
const L1_CHAIN_ID = 11_155_111n;

const seatSecret = (i: number) => {
  const d = new Uint8Array(32);
  d[0] = 0x42;
  d[31] = i;
  return d;
};
/** The default panel: 2 of 3, pinned at rule 7's quorum of 2. */
const SECRETS = [1, 2, 3].map(seatSecret);
const PANEL: Panel = { threshold: 2, keys: SECRETS.map(identityKey) };
/** Pinned too, at a quorum of 3 where rule 7 asks 2. */
const OFF_QUORUM: Panel = { threshold: 2, keys: [4, 5, 6].map((i) => identityKey(seatSecret(i))) };
/** Distinct non-zero stand-ins for the contracts nothing here calls. */
const stand = (n: number) => getAddress(toHex(0xd0000 + n, { size: 20 }));

/** The trustee registry's `PanelInput`, a seat's `(x, y)` from its secret. */
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

let anvil: ChildProcess;
let client: PublicClient;
let wallet: ReturnType<typeof createWalletClient>;
let chain: ReturnType<typeof defineChain>;
let deployer: Address;
let registry: Address;
let trusteeRegistry: Address;
let l1BlockCode: Hex;
let db: TestDb;
let app: Sql;

const rpc = (method: string, params: unknown[]) =>
  client.request({ method, params } as never) as Promise<unknown>;
const mine = (blocks: number) => rpc("anvil_mine", [toHex(blocks)]);
const automine = (on: boolean) => rpc("evm_setAutomine", [on]);
const forge = (target: string, field: "bytecode" | "deployedBytecode") =>
  execFileSync("forge", ["inspect", "--root", contractsRoot, target, field], {
    encoding: "utf8",
  }).trim() as Hex;

beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  anvil = spawn(
    "anvil",
    [
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--chain-id",
      String(CHAIN_ID),
      "--slots-in-an-epoch",
      "1",
      "--silent",
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  chain = defineChain({
    id: Number(CHAIN_ID),
    name: "anvil",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  client = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;
  wallet = createWalletClient({ chain, transport: http(rpcUrl) });
  [deployer] = (await until("anvil", 20_000, async () => {
    if (anvil.exitCode !== null) throw new Error("anvil exited (is the toolchain installed?)");
    return wallet.getAddresses();
  })) as [Address];
  l1BlockCode = forge("test/utils/MockL1Block.sol:MockL1Block", "deployedBytecode");
  await rpc("anvil_setCode", [L1_BLOCK, l1BlockCode]);
  const pinned = await wallet.deployContract({
    account: deployer,
    chain,
    abi: trusteeRegistryAbi,
    bytecode: forge("src/TrusteeRegistry.sol:TrusteeRegistry", "bytecode"),
    args: [[panelInput(SECRETS, 2, 2), panelInput([4, 5, 6].map(seatSecret), 2, 3)]],
  });
  const pinnedReceipt = await client.waitForTransactionReceipt({
    hash: pinned,
    pollingInterval: 20,
  });
  if (!pinnedReceipt.contractAddress) throw new Error("TrusteeRegistry wasn't deployed");
  trusteeRegistry = getAddress(pinnedReceipt.contractAddress);
  // The board, the group registry, the anchor and the relay are stand-ins:
  // creation and registration read none of them.
  const hash = await wallet.deployContract({
    account: deployer,
    chain,
    abi: electionRegistryAbi,
    bytecode: forge("src/ElectionRegistry.sol:ElectionRegistry", "bytecode"),
    args: [
      {
        board: stand(1),
        trusteeRegistry,
        groupRegistry: stand(3),
        l1ChainId: L1_CHAIN_ID,
        l1Anchor: stand(4),
        l1Relay: stand(5),
        epoch: 0n,
      },
    ],
  });
  const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 20 });
  if (!receipt.contractAddress) throw new Error("ElectionRegistry wasn't deployed");
  registry = receipt.contractAddress;
  await mine(FINALITY_DEPTH);
}, 120_000);

afterAll(async () => {
  await db?.close();
  if (anvil !== undefined && anvil.exitCode === null) {
    const exited = new Promise((r) => anvil.once("exit", r));
    anvil.kill("SIGTERM");
    await exited;
  }
});

/** A fresh creation key, funded on Anvil. */
async function newKey(): Promise<Uint8Array> {
  const key = generatePrivateKey();
  await rpc("anvil_setBalance", [privateKeyToAddress(key), toHex(10n ** 20n)]);
  return hexToBytes(key);
}

const adapter = async (key?: Uint8Array) =>
  new ViemPollCreationChain({
    client,
    chainId: CHAIN_ID,
    registry,
    trusteeRegistry,
    key: key ?? (await newKey()),
  });

/** One question with two options, or `count` of them. */
const questions = (count = 1) =>
  Array.from({ length: count }, (_, i) => ({
    question: `Which day, ${i + 1}?`,
    description: "",
    options: [
      { label: "Friday", description: "" },
      { label: "Monday", description: "" },
    ],
    minSelections: 0,
    maxSelections: 1,
  }));

async function submittedPoll(count = 1): Promise<string> {
  const author = newAccountId();
  await app`
    INSERT INTO account_users VALUES (${author}, ${`${newAccountId()}@account.invalid`},
      false, '', NULL, now(), now())`;
  const id = await createPollDraft(
    app,
    author,
    {
      language: "en",
      title: "Lunch",
      description: "",
      questions: questions(count),
      tiers: [0],
      closesAt: NOW_S + 7n * 24n * 3600n,
    },
    NOW,
  );
  await submitPollDraft(app, author, id, {
    turnstile: { verify: async () => "passed" },
    token: "t",
    now: NOW,
  });
  return id;
}

describe("the startup check", () => {
  test("passes the configured registry, and refuses another chain, address, L1 or anchor", async () => {
    const deployment = {
      chainId: CHAIN_ID,
      registry,
      l1ChainId: L1_CHAIN_ID,
      anchor: stand(4),
      panel: PANEL,
    };
    await expect(checkPollCreationDeployment(client, deployment)).resolves.toEqual({
      trusteeRegistry,
    });
    await expect(
      checkPollCreationDeployment(client, { ...deployment, chainId: CHAIN_ID + 1n }),
    ).rejects.toThrow("another chain");
    await expect(
      checkPollCreationDeployment(client, { ...deployment, registry: deployer }),
    ).rejects.toThrow("no election registry");
    // Code that isn't a registry.
    await expect(
      checkPollCreationDeployment(client, { ...deployment, registry: getAddress(L1_BLOCK) }),
    ).rejects.toThrow("isn't an election registry");
    // The per-slot check must read the anchor the registry, and so every
    // stub, names.
    await expect(
      checkPollCreationDeployment(client, { ...deployment, l1ChainId: 1n }),
    ).rejects.toThrow("names another L1");
    await expect(
      checkPollCreationDeployment(client, {
        ...deployment,
        anchor: stand(5),
      }),
    ).rejects.toThrow("names another board anchor");
  });

  test("refuses a panel the trustee registry doesn't pin, or pins at another quorum than rule 7's", async () => {
    const deployment = {
      chainId: CHAIN_ID,
      registry,
      l1ChainId: L1_CHAIN_ID,
      anchor: stand(4),
      panel: PANEL,
    };
    // The same seats at 3 of 3 are another panel.
    await expect(
      checkPollCreationDeployment(client, { ...deployment, panel: { ...PANEL, threshold: 3 } }),
    ).rejects.toThrow("doesn't pin the panel");
    await expect(
      checkPollCreationDeployment(client, {
        ...deployment,
        panel: { threshold: 2, keys: PANEL.keys.slice(0, 2) },
      }),
    ).rejects.toThrow("doesn't pin the panel");
    await expect(
      checkPollCreationDeployment(client, { ...deployment, panel: OFF_QUORUM }),
    ).rejects.toThrow("another quorum");
    // An election registry whose trustee registry holds no code.
    const hash = await wallet.deployContract({
      account: deployer,
      chain,
      abi: electionRegistryAbi,
      bytecode: forge("src/ElectionRegistry.sol:ElectionRegistry", "bytecode"),
      args: [
        {
          board: stand(1),
          trusteeRegistry: stand(2),
          groupRegistry: stand(3),
          l1ChainId: L1_CHAIN_ID,
          l1Anchor: stand(4),
          l1Relay: stand(5),
          epoch: 0n,
        },
      ],
    });
    const other = (await client.waitForTransactionReceipt({ hash, pollingInterval: 20 }))
      .contractAddress;
    if (!other) throw new Error("ElectionRegistry wasn't deployed");
    await mine(FINALITY_DEPTH);
    await expect(
      checkPollCreationDeployment(client, { ...deployment, registry: other }),
    ).rejects.toThrow("trustee registry isn't one");
    // Not a panel at all: refused before anything is read.
    await expect(
      checkPollCreationDeployment(client, {
        ...deployment,
        panel: { threshold: 4, keys: PANEL.keys },
      }),
    ).rejects.toThrow(PanelError);
    // It deploys a registry and mines to finality on Anvil besides its
    // reads, which outruns the default 5 s on a loaded runner.
  }, 60_000);
});

describe("ViemPollCreationChain", () => {
  test("refuses a key that isn't one, without quoting it", () => {
    const bad = new Uint8Array(32).fill(0xff);
    expect(
      () =>
        new ViemPollCreationChain({
          client,
          chainId: CHAIN_ID,
          registry,
          trusteeRegistry,
          key: bad,
        }),
    ).toThrow("isn't a valid key");
    try {
      new ViemPollCreationChain({ client, chainId: CHAIN_ID, registry, trusteeRegistry, key: bad });
    } catch (e) {
      expect(String(e)).not.toContain("ff".repeat(32));
    }
  });

  test("core creates a submitted poll through it, and records the registry's identifier once final", async () => {
    const id = await submittedPoll();
    const key = await adapter();
    const before = await client.readContract({
      address: registry,
      abi: electionRegistryAbi,
      functionName: "electionCount",
    });
    // Anvil mines each transaction as it arrives.
    expect(await advancePollCreations(app, key, { now: NOW })).toMatchObject({ sent: 1 });
    expect(await advancePollCreations(app, key, { now: NOW })).toMatchObject({ created: 0 });
    const [mid] = await db.admin`SELECT state FROM account_polls WHERE id = ${id}`;
    expect(mid!["state"]).toBe("submitted");
    await mine(FINALITY_DEPTH);
    expect(await advancePollCreations(app, key, { now: NOW })).toMatchObject({ created: 1 });
    const [row] = await db.admin`
      SELECT state, election_id, creator_address, created_block FROM account_polls WHERE id = ${id}`;
    const electionId = await client.readContract({
      address: registry,
      abi: electionRegistryAbi,
      functionName: "electionIdAt",
      args: [before],
    });
    expect(row!["state"]).toBe("created");
    expect(bytesToHex(row!["election_id"])).toBe(electionId);
    expect(bytesToHex(row!["creator_address"])).toBe(bytesToHex(key.creator));
    const creator = await client.readContract({
      address: registry,
      abi: electionRegistryAbi,
      functionName: "creatorOf",
      args: [electionId],
    });
    expect(getAddress(creator)).toBe(getAddress(bytesToHex(key.creator)));
  });

  test("reports a creation pending, then included, then created only once final", async () => {
    const key = await adapter();
    await automine(false);
    try {
      const { tx, hash } = await key.signCreation(0n);
      await key.broadcast(tx);
      // A second send of the same bytes is one the node already has.
      await key.broadcast(tx);
      expect(await key.nonces()).toEqual({ finalized: 0n, latest: 0n, pending: 1n });
      // Pending: known to the node, so never taken for replaced.
      expect(await key.creation(hash)).toEqual({ state: "included" });
      expect(await key.creation(new Uint8Array(32).fill(9))).toEqual({ state: "unknown" });
      // The fee cap is three base fees ahead, so a fee rise doesn't strand it.
      const { baseFeePerGas } = await client.getBlock({ blockTag: "latest" });
      expect(parseTransaction(bytesToHex(tx)).maxFeePerGas!).toBeGreaterThanOrEqual(
        3n * baseFeePerGas!,
      );
      await mine(1);
      expect(await key.nonces()).toMatchObject({ latest: 1n, pending: 1n });
      expect(await key.creation(hash)).toEqual({ state: "included" });
      await mine(FINALITY_DEPTH);
      expect(await key.nonces()).toEqual({ finalized: 1n, latest: 1n, pending: 1n });
      expect(await key.creation(hash)).toMatchObject({ state: "created" });
    } finally {
      await automine(true);
    }
  });

  test("reports a final revert as reverted", async () => {
    const key = await adapter();
    const { tx, hash } = await key.signCreation(0n);
    // Without its L1 origin's predeploy, createElection reverts.
    await rpc("anvil_setCode", [L1_BLOCK, "0x"]);
    try {
      await key.broadcast(tx);
      await client.waitForTransactionReceipt({ hash: bytesToHex(hash), pollingInterval: 20 });
    } finally {
      await rpc("anvil_setCode", [L1_BLOCK, l1BlockCode]);
    }
    await mine(FINALITY_DEPTH);
    expect(await key.creation(hash)).toEqual({ state: "reverted" });
  });

  test("refuses a receipt that isn't the key's creation", async () => {
    const key = await adapter();
    const other = await wallet.sendTransaction({
      account: deployer,
      chain,
      to: deployer,
      value: 1n,
    });
    await client.waitForTransactionReceipt({ hash: other, pollingInterval: 20 });
    await mine(FINALITY_DEPTH);
    await expect(key.creation(hexToBytes(other))).rejects.toThrow("isn't the transaction's");
    await expect(key.registration(hexToBytes(other))).rejects.toThrow("isn't the transaction's");
  });
});

describe("the registration, through ViemPollCreationChain", () => {
  /** The deployment the poll's stub pins: this registry's, with stand-ins it never calls. */
  const deployment = (): PollStubDeployment => ({
    l2ChainId: CHAIN_ID,
    l1ChainId: L1_CHAIN_ID,
    electionRegistry: hexToBytes(registry),
    board: hexToBytes(stand(1)),
    trusteeRegistry: hexToBytes(trusteeRegistry),
    groupRegistry: hexToBytes(stand(3)),
    l1Anchor: hexToBytes(stand(4)),
    l1Relay: hexToBytes(stand(5)),
    panel: PANEL,
    receiptKeys: [7, 8]
      .map((i) => identityKey(seatSecret(i)))
      .sort((a, b) => Buffer.from(a).compare(Buffer.from(b))),
    l1InclusionBound: 3600,
    sequencingWindow: 3600n,
    maxSequencerDrift: 1800n,
  });

  /** A poll created through `key`, rooted at an early block and stubbed, its ceremony approved. */
  async function approvedPoll(key: ViemPollCreationChain, count = 1): Promise<string> {
    const id = await submittedPoll(count);
    expect(await advancePollCreations(app, key, { now: NOW })).toMatchObject({ sent: 1 });
    // Anvil mines each transaction as it arrives, but after the send returns.
    await until("the creation", 10_000, async () =>
      (await key.nonces()).latest === 1n ? true : undefined,
    );
    await mine(FINALITY_DEPTH);
    expect(await advancePollCreations(app, key, { now: NOW })).toMatchObject({ created: 1 });
    // The roots step's work, as part 3b-2 leaves it: one Tier 0 cell rooted
    // at block 1, which registration requires to be in the past.
    const electorate: StoredTierElectorate[] = [
      {
        tier: 0,
        rootL2Block: "1",
        groups: [{ groupId: "1", region: 0 }],
        regions: ["3"],
        cells: [{ root: tierTreeRoot([11n, 12n, 13n]).toString(), members: "3" }],
      },
    ];
    await db.admin`
      UPDATE account_polls SET state = 'rooted', anchors_checked_block = created_block,
        electorate = ${db.admin.json(electorate as never)}
      WHERE id = ${id}`;
    const d = deployment();
    expect((await stubPolls(app, d, { now: NOW })).stubbed).toBe(1);
    expect((await openCeremonyRuns(app, d, { now: NOW })).opened).toBe(1);
    const seats = [1, 2, 3].map(
      (i) => new Seat(i, { deployment: d, secrets: SECRETS, client: () => app, now: NOW }),
    );
    for (let round = 1; round <= 5; round++) for (const s of seats) await s.act();
    const [row] = await db.admin`SELECT stub_hash FROM account_polls WHERE id = ${id}`;
    expect(await approvedCeremony(app, Uint8Array.from(row!["stub_hash"]))).toBeDefined();
    return id;
  }

  test("registers an approved poll's ceremony and definition, which the registry admits, and records it once final", async () => {
    const key = await adapter();
    const id = await approvedPoll(key);
    expect(await advancePollRegistrations(app, key, PANEL, { now: NOW })).toMatchObject({
      sent: 1,
      sendFailed: 0,
    });
    const [sent] = await db.admin`
      SELECT state, election_id, ceremony_tx_hash, register_tx_hash
      FROM account_polls WHERE id = ${id}`;
    // Anvil mines each as it arrives; not final yet.
    expect(sent!["state"]).toBe("ceremony");
    const ceremonyTx = bytesToHex(sent!["ceremony_tx_hash"]);
    const definitionTx = bytesToHex(sent!["register_tx_hash"]);
    for (const hash of [ceremonyTx, definitionTx])
      expect((await client.waitForTransactionReceipt({ hash, pollingInterval: 20 })).status).toBe(
        "success",
      );
    expect(await key.registration(hexToBytes(definitionTx))).toEqual({ state: "included" });
    expect(await advancePollRegistrations(app, key, PANEL, { now: NOW })).toMatchObject({
      registered: 0,
    });

    await mine(FINALITY_DEPTH);
    expect(await advancePollRegistrations(app, key, PANEL, { now: NOW })).toMatchObject({
      registered: 1,
      failed: {},
    });
    const [row] = await db.admin`
      SELECT state, registered_block FROM account_polls WHERE id = ${id}`;
    expect(row!["state"]).toBe("registered");

    // What the registry holds is the definition that was signed, in the
    // block recorded.
    const electionId = bytesToHex(sent!["election_id"]);
    const definition = await client.getTransaction({ hash: definitionTx });
    const { functionName, args } = decodeFunctionData({
      abi: electionRegistryAbi,
      data: definition.input,
    });
    expect(functionName).toBe("registerDefinition");
    const signed = hexToBytes((args as readonly [Hex])[0]);
    const held = await client.readContract({
      address: registry,
      abi: electionRegistryAbi,
      functionName: "definitionHashOf",
      args: [electionId],
    });
    expect(held).toBe(bytesToHex(electionDefinitionV5Hash(decodeElectionDefinitionV5(signed))));
    const receipt = await client.getTransactionReceipt({ hash: definitionTx });
    expect(BigInt(row!["registered_block"])).toBe(receipt.blockNumber);
    expect(await key.registration(hexToBytes(definitionTx))).toEqual({
      state: "registered",
      electionId: hexToBytes(electionId),
      definitionHash: hexToBytes(held),
      block: receipt.blockNumber,
    });

    // The definition's limit, estimated before its ceremony landed, covers
    // what it used, within the headroom.
    expect(receipt.gasUsed).toBeLessThanOrEqual(definition.gas);
    expect(definition.gas).toBeLessThan((receipt.gasUsed * 3n) / 2n);
    expect(definition.gas).toBeLessThan(
      FALLBACK_GAS_BASE + FALLBACK_GAS_PER_BYTE * BigInt(signed.length),
    );
    expect(definition.gas).toBeLessThanOrEqual(MAX_TX_GAS);

    // The ceremony's transaction is the trustee registry's, not the
    // election registry's.
    await expect(key.registration(hexToBytes(ceremonyTx))).rejects.toThrow(
      "isn't the transaction's",
    );
    // The key's own call to the registry with no DefinitionRegistered (its
    // creation) is never read as a registration.
    const [created] = await db.admin`SELECT create_tx_hash FROM account_polls WHERE id = ${id}`;
    await expect(key.registration(Uint8Array.from(created!["create_tx_hash"]))).rejects.toThrow(
      "no DefinitionRegistered",
    );
  }, 120_000);

  test("estimates a definition of the most questions a ballot takes, which registers within it", async () => {
    // 32 questions: the registry writes a slot per question, which a
    // per-byte bound would undercount.
    const key = await adapter();
    const id = await approvedPoll(key, 32);
    expect(await advancePollRegistrations(app, key, PANEL, { now: NOW })).toMatchObject({
      sent: 1,
    });
    const [sent] = await db.admin`SELECT register_tx_hash FROM account_polls WHERE id = ${id}`;
    const hash = bytesToHex(sent!["register_tx_hash"]);
    const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 20 });
    expect(receipt.status).toBe("success");
    const { gas } = await client.getTransaction({ hash });
    expect(receipt.gasUsed).toBeLessThanOrEqual(gas);
    expect(gas).toBeLessThan((receipt.gasUsed * 3n) / 2n);
    await mine(FINALITY_DEPTH);
    expect(await advancePollRegistrations(app, key, PANEL, { now: NOW })).toMatchObject({
      registered: 1,
    });
  }, 120_000);

  test("registers a poll whose ceremony another sender registered first", async () => {
    const key = await adapter();
    const id = await approvedPoll(key);
    // Anyone may send the approved record: here the deployer, before the
    // step runs, so the key's estimate of its own reverts (AlreadyRecorded).
    const [row] = await db.admin`
      SELECT p.election_id, s.stub, s.stub_hash
      FROM account_polls p JOIN ceremony_stubs s USING (stub_hash) WHERE p.id = ${id}`;
    const stubHash = Uint8Array.from(row!["stub_hash"]);
    const built = pollRegistration(
      Uint8Array.from(row!["stub"]),
      stubHash,
      Uint8Array.from(row!["election_id"]),
      PANEL,
      (await approvedCeremony(app, stubHash))!,
    );
    if (typeof built === "string") throw new Error(`the run doesn't check: ${built}`);
    const first = await wallet.writeContract({
      account: deployer,
      chain,
      address: trusteeRegistry,
      abi: trusteeRegistryAbi,
      functionName: "registerCeremony",
      args: [bytesToHex(built.record)],
    });
    expect(
      (await client.waitForTransactionReceipt({ hash: first, pollingInterval: 20 })).status,
    ).toBe("success");

    expect(await advancePollRegistrations(app, key, PANEL, { now: NOW })).toMatchObject({
      sent: 1,
    });
    const [sent] = await db.admin`
      SELECT ceremony_tx_hash, register_tx_hash FROM account_polls WHERE id = ${id}`;
    const ceremony = await client.waitForTransactionReceipt({
      hash: bytesToHex(sent!["ceremony_tx_hash"]),
      pollingInterval: 20,
    });
    await client.waitForTransactionReceipt({
      hash: bytesToHex(sent!["register_tx_hash"]),
      pollingInterval: 20,
    });
    // The key's copy reverts, under the fallback limit, and the definition
    // registers against the record already there.
    expect(ceremony.status).toBe("reverted");
    const tx = await client.getTransaction({ hash: ceremony.transactionHash });
    expect(tx.gas).toBe(FALLBACK_GAS_BASE + FALLBACK_GAS_PER_BYTE * BigInt(built.record.length));
    await mine(FINALITY_DEPTH);
    expect(await advancePollRegistrations(app, key, PANEL, { now: NOW })).toMatchObject({
      registered: 1,
    });
  }, 120_000);

  test("reports a definition the registry refuses as reverted once final", async () => {
    const key = await adapter();
    // Bytes that aren't a definition: the registry reverts.
    const { tx, hash } = await key.signDefinition(0n, new Uint8Array([1, 2, 3]));
    await key.broadcast(tx);
    await client.waitForTransactionReceipt({ hash: bytesToHex(hash), pollingInterval: 20 });
    expect(await key.registration(hash)).toEqual({ state: "included" });
    await mine(FINALITY_DEPTH);
    expect(await key.registration(hash)).toEqual({ state: "reverted" });
    expect(await key.registration(new Uint8Array(32).fill(9))).toEqual({ state: "unknown" });
  });
});
