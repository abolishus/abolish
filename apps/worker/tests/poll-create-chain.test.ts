import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { electionRegistryAbi } from "@abolishus/contracts/abi";
import {
  advancePollCreations,
  createPollDraft,
  newAccountId,
  submitPollDraft,
} from "@abolishus/core";
import { type TestDb, testDb } from "@abolishus/core/test-db";
import type { Sql } from "postgres";
import {
  type Address,
  bytesToHex,
  createPublicClient,
  createWalletClient,
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
import { checkPollCreationDeployment, ViemPollCreationChain } from "../src/index.ts";

// The creation step's chain adapter against a real chain (P2-22 part 3a):
// Anvil runs the election registry, the startup check refuses a node or an
// address that isn't the configured registry, and core's
// advancePollCreations, run through the adapter, creates a submitted poll
// and records the identifier the registry gave only once its block is final
// (T-25, T-34, T-72). The creation key is a fresh random key funded on Anvil
// for the run; no real key is held here (AGENTS.md).

const contractsRoot = fileURLToPath(new URL("../../../packages/contracts", import.meta.url));
// One slot per epoch: Anvil's finalized block is then the latest but two.
const FINALITY_DEPTH = 2;
const CHAIN_ID = 84_532n;
/** The OP Stack's L1Block predeploy, which createElection reads its L1 origin from. */
const L1_BLOCK = "0x4200000000000000000000000000000000000015";
const NOW = new Date();
const NOW_S = BigInt(Math.floor(NOW.getTime() / 1000));

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
  // Distinct non-zero stand-ins: creation reads none of them.
  const stand = (n: number) => getAddress(toHex(0xd0000 + n, { size: 20 }));
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
        l1ChainId: 11_155_111n,
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
    key: key ?? (await newKey()),
  });

async function submittedPoll(): Promise<string> {
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
      l1ChainId: 11_155_111n,
      anchor: getAddress(toHex(0xd0004, { size: 20 })),
    };
    await expect(checkPollCreationDeployment(client, deployment)).resolves.toBeUndefined();
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
        anchor: getAddress(toHex(0xd0005, { size: 20 })),
      }),
    ).rejects.toThrow("names another board anchor");
  });
});

describe("ViemPollCreationChain", () => {
  test("refuses a key that isn't one, without quoting it", () => {
    const bad = new Uint8Array(32).fill(0xff);
    expect(
      () => new ViemPollCreationChain({ client, chainId: CHAIN_ID, registry, key: bad }),
    ).toThrow("isn't a valid key");
    try {
      new ViemPollCreationChain({ client, chainId: CHAIN_ID, registry, key: bad });
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
    await expect(key.creation(hexToBytes(other))).rejects.toThrow("isn't the creation's");
  });
});
