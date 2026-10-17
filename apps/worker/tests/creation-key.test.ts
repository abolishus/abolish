import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { electionRegistryAbi } from "@abolishus/contracts/abi";
import {
  advancePollCreations,
  createPollDraft,
  creationKeyRecords,
  newAccountId,
  submitPollDraft,
} from "@abolishus/core";
import { type TestDb, testDb } from "@abolishus/core/test-db";
import type { Sql } from "postgres";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  type Hex,
  hexToBytes,
  http,
  type PublicClient,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  creationKeyChainState,
  creationKeyReport,
  parseCreationKeyCommand,
  sweepCreationKey,
  ViemPollCreationChain,
} from "../src/index.ts";

// The creation key's status and sweep commands against a real chain (the
// poll-creation runbook, Funding, Rotation and Compromise; P2-22 part
// 3b-3): the status lists the polls the key still has to finish and finds
// a transaction the worker didn't record (T-72); the sweep moves the whole
// balance, less what the transfer can cost, to the funding account, and
// refuses while the key has anything pending. Keys are fresh random keys
// funded on Anvil; no real key is held here (AGENTS.md).

const contractsRoot = fileURLToPath(new URL("../../../packages/contracts", import.meta.url));
const FINALITY_DEPTH = 2;
const CHAIN_ID = 84_532n;
const L1_BLOCK = "0x4200000000000000000000000000000000000015";
const GAS_PRICE_ORACLE = "0x420000000000000000000000000000000000000F";
/** The stand-in oracle's answer to every call: both its L1 fee and its operator fee. */
const ORACLE_FEE = 10n ** 12n;
const feeWord = ORACLE_FEE.toString(16).padStart(64, "0");
/** Runtime code that returns `ORACLE_FEE` as one word to any call. */
const ORACLE_CODE = `0x7f${feeWord}60005260206000f3` as Hex;
/**
 * An oracle from before the operator fee: `ORACLE_FEE` to `getL1Fee(bytes)`
 * (selector 0x49948e0e) and a revert to anything else.
 */
const L1_ONLY_ORACLE_CODE =
  `0x60003560e01c6349948e0e14601357600080fd5b7f${feeWord}60005260206000f3` as Hex;
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

let anvil: ChildProcess;
let client: PublicClient;
let wallet: ReturnType<typeof createWalletClient>;
let chain: ReturnType<typeof defineChain>;
let registry: Address;
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
  // No cached block number: the tests mine and read straight after.
  client = createPublicClient({ chain, transport: http(rpcUrl), cacheTime: 0 }) as PublicClient;
  wallet = createWalletClient({ chain, transport: http(rpcUrl) });
  const end = Date.now() + 20_000;
  let deployer: Address | undefined;
  while (deployer === undefined) {
    if (anvil.exitCode !== null) throw new Error("anvil exited (is the toolchain installed?)");
    try {
      [deployer] = await wallet.getAddresses();
    } catch (e) {
      if (Date.now() > end) throw e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  await rpc("anvil_setCode", [
    L1_BLOCK,
    forge("test/utils/MockL1Block.sol:MockL1Block", "deployedBytecode"),
  ]);
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

/** A fresh key holding `wei` on Anvil. */
async function newKey(wei = 10n ** 18n): Promise<Uint8Array> {
  const key = generatePrivateKey();
  await rpc("anvil_setBalance", [privateKeyToAddress(key), toHex(wei)]);
  return hexToBytes(key);
}

/** A fresh address with nothing on it. */
const fundingAccount = () => privateKeyToAddress(generatePrivateKey());

async function withOracle<T>(run: () => Promise<T>, code = ORACLE_CODE): Promise<T> {
  await rpc("anvil_setCode", [GAS_PRICE_ORACLE, code]);
  try {
    return await run();
  } finally {
    await rpc("anvil_setCode", [GAS_PRICE_ORACLE, "0x"]);
  }
}

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

describe("the status command", () => {
  test("lists the key's poll in setup and its ledger, and finds a transaction it didn't record", async () => {
    const key = await newKey();
    const state = () => creationKeyChainState(client, { chainId: CHAIN_ID, registry, key });
    const report = async () => {
      const s = await state();
      return creationKeyReport(
        s,
        await creationKeyRecords(app, hexToBytes(s.address), s.nonces, NOW),
        200,
      );
    };
    const fresh = await report();
    expect(fresh).toMatchObject({
      key: privateKeyToAddress(`0x${Buffer.from(key).toString("hex")}`),
      balance: (10n ** 18n).toString(),
      nonces: { finalized: "0", latest: "0", pending: "0" },
      ledger: { recorded: 0, unincluded: 0, unfinalized: 0, lastDay: 0 },
      unrecorded: "0",
      pollCount: 0,
      polls: [],
    });
    expect(BigInt(fresh.creationCost)).toBeGreaterThan(0n);

    await submittedPoll();
    const adapter = new ViemPollCreationChain({
      client,
      chainId: CHAIN_ID,
      registry,
      // The stand-in the registry names: nothing here registers.
      trusteeRegistry: getAddress(toHex(0xd0002, { size: 20 })),
      key,
    });
    await advancePollCreations(app, adapter, { now: NOW });
    // Anvil mines each transaction as it arrives, but after the send returns.
    const [{ hash: sent }] = (await db.admin`
      SELECT encode(tx_hash, 'hex') AS hash FROM poll_creation_txs`) as unknown as [
      { hash: string },
    ];
    await client.waitForTransactionReceipt({ hash: `0x${sent}`, pollingInterval: 20 });
    await mine(FINALITY_DEPTH);
    await advancePollCreations(app, adapter, { now: NOW });
    const created = await report();
    expect(created).toMatchObject({
      nonces: { finalized: "1", latest: "1", pending: "1" },
      ledger: { recorded: 1, unincluded: 0, unfinalized: 0, lastDay: 1 },
      unrecorded: "0",
      pollCount: 1,
      polls: [{ state: "created" }],
    });
    expect(created.polls[0]!.electionId).toMatch(/^0x[0-9a-f]{64}$/);

    // A transfer the worker didn't send: the runbook's sign of compromise.
    const account = privateKeyToAccount(`0x${Buffer.from(key).toString("hex")}`);
    const hash = await wallet.sendTransaction({ account, chain, to: fundingAccount(), value: 1n });
    await client.waitForTransactionReceipt({ hash, pollingInterval: 20 });
    expect(await report()).toMatchObject({ unrecorded: "1", ledger: { recorded: 1 } });
  });

  test("prices a creation with the oracle's L1 and operator fees on an OP Stack chain", async () => {
    const key = await newKey();
    const without = await creationKeyChainState(client, { chainId: CHAIN_ID, registry, key });
    const withFees = await withOracle(() =>
      creationKeyChainState(client, { chainId: CHAIN_ID, registry, key }),
    );
    // Nothing is mined between the two reads, so only the oracle differs.
    expect(withFees.creationCost - without.creationCost).toBe(2n * ORACLE_FEE);
  });

  test("prices only the L1 fee with an oracle from before the operator fee", async () => {
    const key = await newKey();
    const without = await creationKeyChainState(client, { chainId: CHAIN_ID, registry, key });
    const l1Only = await withOracle(
      () => creationKeyChainState(client, { chainId: CHAIN_ID, registry, key }),
      L1_ONLY_ORACLE_CODE,
    );
    expect(l1Only.creationCost - without.creationCost).toBe(ORACLE_FEE);
  });

  test("says when the balance is below a day's ceiling of creations", async () => {
    const key = await newKey();
    const s = await creationKeyChainState(client, { chainId: CHAIN_ID, registry, key });
    const records = await creationKeyRecords(app, hexToBytes(s.address), s.nonces, NOW);
    const affordable = s.balance / s.creationCost;
    expect(creationKeyReport(s, records, Number(affordable))).toMatchObject({
      creationsAffordable: affordable.toString(),
      belowDailyCeiling: false,
    });
    expect(creationKeyReport(s, records, Number(affordable) + 1).belowDailyCeiling).toBe(true);
  });
});

describe("the sweep command", () => {
  test("sends the whole balance less the transfer's most gas and twice its L1 and operator fees", async () => {
    const key = await newKey();
    const address = privateKeyToAddress(toKey(key));
    const to = fundingAccount();
    const before = await client.getBalance({ address });
    // Base's node charges the L1 fee beside gas, and refuses a transfer
    // whose balance doesn't cover it; the oracle is how the sweep knows it.
    const { sweep, receipt } = await withOracle(async () => {
      const s = await sweepCreationKey({ client, sql: app, chainId: CHAIN_ID, key, to });
      return {
        sweep: s,
        receipt: await client.waitForTransactionReceipt({ hash: s.hash, pollingInterval: 20 }),
      };
    });
    expect(receipt.status).toBe("success");
    expect(await client.getBalance({ address: to })).toBe(sweep.value);
    const tx = await client.getTransaction({ hash: sweep.hash });
    expect(tx.gas).toBe(21_000n);
    expect(before - sweep.value).toBe(21_000n * tx.maxFeePerGas! + 4n * ORACLE_FEE);
    // What stays is the fee cap's unspent part and whatever of the reserve
    // the chain's own L1 fee didn't take.
    const left = await client.getBalance({ address });
    const unspent = 21_000n * (tx.maxFeePerGas! - receipt.effectiveGasPrice);
    expect(left).toBeGreaterThanOrEqual(unspent);
    expect(left).toBeLessThanOrEqual(unspent + 4n * ORACLE_FEE);
  });
  test("gives a funding contract's receive path headroom", async () => {
    const key = await newKey();
    const address = privateKeyToAddress(toKey(key));
    // A receive path that writes a slot, so the transfer costs more than 21,000.
    const to = fundingAccount();
    await rpc("anvil_setCode", [to, "0x600160005500"]);
    const before = await client.getBalance({ address });
    const sweep = await withOracle(async () => {
      const s = await sweepCreationKey({ client, sql: app, chainId: CHAIN_ID, key, to });
      await client.waitForTransactionReceipt({ hash: s.hash, pollingInterval: 20 });
      return s;
    });
    const tx = await client.getTransaction({ hash: sweep.hash });
    const receipt = await client.getTransactionReceipt({ hash: sweep.hash });
    expect(receipt.status).toBe("success");
    expect(receipt.gasUsed).toBeGreaterThan(21_000n);
    expect(tx.gas).toBeGreaterThan(receipt.gasUsed);
    expect(await client.getBalance({ address: to })).toBe(sweep.value);
    expect(before - sweep.value).toBe(tx.gas * tx.maxFeePerGas! + 4n * ORACLE_FEE);
  });

  test("refuses while the ledger holds a creation the node hasn't included", async () => {
    const key = await newKey();
    const address = privateKeyToAddress(toKey(key));
    // A creation recorded at the key's next nonce that the node dropped.
    await db.admin`
      INSERT INTO poll_creation_txs (creator_address, nonce, tx, tx_hash, sent_at, kind)
      VALUES (${Buffer.from(hexToBytes(address))}, 0, ${Buffer.from([1])},
        ${Buffer.alloc(32, 7)}, now(), 'create')`;
    await expect(
      sweepCreationKey({ client, sql: app, chainId: CHAIN_ID, key, to: fundingAccount() }),
    ).rejects.toThrow("1 creation(s) the node hasn't included");
    expect(await client.getTransactionCount({ address })).toBe(0);
  });

  test("refuses while the key has a pending transaction", async () => {
    const key = await newKey();
    const account = privateKeyToAccount(toKey(key));
    await automine(false);
    try {
      await wallet.sendTransaction({ account, chain, to: fundingAccount(), value: 1n });
      await expect(
        sweepCreationKey({ client, sql: app, chainId: CHAIN_ID, key, to: fundingAccount() }),
      ).rejects.toThrow("1 pending transaction(s)");
    } finally {
      await automine(true);
      await mine(1);
    }
  });

  test("refuses the key itself, the zero address and a balance that can't pay the fees", async () => {
    const key = await newKey();
    await expect(
      sweepCreationKey({
        client,
        sql: app,
        chainId: CHAIN_ID,
        key,
        to: privateKeyToAddress(toKey(key)),
      }),
    ).rejects.toThrow("is the creation key");
    await expect(
      sweepCreationKey({ client, sql: app, chainId: CHAIN_ID, key, to: `0x${"00".repeat(20)}` }),
    ).rejects.toThrow("zero address");
    const poor = await newKey(1_000n);
    await expect(
      sweepCreationKey({ client, sql: app, chainId: CHAIN_ID, key: poor, to: fundingAccount() }),
    ).rejects.toThrow("nothing to sweep");
  });
});

describe("parseCreationKeyCommand", () => {
  test("takes status, and sweep with one full, checksummed address", () => {
    const to = fundingAccount();
    expect(parseCreationKeyCommand(["status"])).toEqual({ command: "status" });
    expect(parseCreationKeyCommand(["sweep", to])).toEqual({ command: "sweep", to });
    expect(parseCreationKeyCommand(["sweep", to.toLowerCase()])).toEqual({
      command: "sweep",
      to,
    });
  });

  test("refuses anything else with the usage", () => {
    const to = fundingAccount();
    // EIP-55's own example with one letter's case flipped.
    const badChecksum = "0x52908400098527886e0F7030069857D2E4169EE7";
    expect(
      parseCreationKeyCommand(["sweep", "0x52908400098527886E0F7030069857D2E4169EE7"]),
    ).toEqual({
      command: "sweep",
      to: "0x52908400098527886E0F7030069857D2E4169EE7",
    });
    for (const args of [
      [],
      ["sweep"],
      ["status", "extra"],
      ["sweep", to.slice(0, -1)],
      ["sweep", to.slice(2)],
      ["sweep", `0x${"00".repeat(20)}`],
      ["sweep", to, "extra"],
      ["drain", to],
      ["sweep", badChecksum],
    ])
      expect(() => parseCreationKeyCommand(args), args.join(" ")).toThrow("usage:");
    // A key pasted for the address is never echoed.
    const pasted = toKey(hexToBytes(generatePrivateKey()));
    expect(() => parseCreationKeyCommand(["sweep", pasted])).toThrow("usage:");
    try {
      parseCreationKeyCommand(["sweep", pasted]);
    } catch (e) {
      expect(String(e)).not.toContain(pasted.slice(2));
    }
  });
});

function toKey(key: Uint8Array): Hex {
  return `0x${Buffer.from(key).toString("hex")}`;
}
