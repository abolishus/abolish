import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import {
  groupRegistryAbi,
  registrationAccountAbi,
  registrationPaymasterAbi,
} from "@abolishus/contracts/abi";
import {
  decodeGroupAddition,
  encodeGroupAddition,
  groupAdditionDigest,
  groupRegistryDomainSeparator,
  signGroupApproval,
} from "@abolishus/crypto";
import { commitmentKey, MIN_REGISTRATION_BATCH, Tier0Batches, tier0Keys } from "@abolishus/core";
import { Redis } from "ioredis";
import {
  type Abi,
  type Address,
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  defineChain,
  getAddress,
  type Hex,
  http,
  type PublicClient,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import {
  entryPoint08Abi,
  formatUserOperation,
  type RpcUserOperation,
  toPackedUserOperation,
  type UserOperation,
} from "viem/account-abstraction";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  type BundlerRequest,
  connectTier0Bundler,
  TIER0_PAYMASTER_VERIFICATION_GAS,
  type Tier0BundlerOptions,
  ViemTier0Chain,
} from "../src/index.ts";

// The Tier 0 batch job's submitter (P3-2 part 4d-2b-2b) against EntryPoint
// v0.8 itself on Anvil, with the group registry, the registration account
// and the paymaster from packages/contracts. The bundler is a stand-in in
// this file: it speaks ERC-7769's methods and lands each operation with
// `handleOps` from one of Anvil's unlocked accounts, so every rule the
// EntryPoint, the account and the paymaster enforce runs, but no bundler's
// ERC-7562 simulation does (Known-weak). The account's owner key is made up
// for each run, and the registrar keys are the published vectors' (no key of
// ours is held here, AGENTS.md).

const redisUrl = process.env["REDIS_URL"];
if (!redisUrl) throw new Error("REDIS_URL is not set");

interface RegistrarVectors {
  readonly threshold: number;
  readonly secretKeys: readonly string[];
  readonly addresses: readonly string[];
}
const vectors = JSON.parse(
  readFileSync(new URL("../../../docs/spec/vectors/group-registry.json", import.meta.url), "utf8"),
) as { registrars: RegistrarVectors };
const bytes = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
const REGISTRARS = vectors.registrars.addresses.map((a) => getAddress(`0x${a}`));
const SECRETS = vectors.registrars.secretKeys.map(bytes);
const THRESHOLD = vectors.registrars.threshold;
const SIGNERS = [
  { seat: 1, secretKey: SECRETS[0] as Uint8Array },
  { seat: 3, secretKey: SECRETS[2] as Uint8Array },
];
const MAX_COST = 10n ** 16n;
const OWNER_KEY = generatePrivateKey();

const contractsRoot = fileURLToPath(new URL("../../../packages/contracts", import.meta.url));
const chainId = 1_000_000 + Math.floor(Math.random() * 1_000_000_000);
const FINALITY_DEPTH = 2;

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

const inspect = (contract: string) =>
  execFileSync("forge", ["inspect", "--root", contractsRoot, contract, "bytecode"], {
    encoding: "utf8",
  }).trim() as Hex;

let anvil: ChildProcess;
let chain: ReturnType<typeof defineChain>;
let client: PublicClient;
let wallet: ReturnType<typeof createWalletClient>;
let accounts: Address[];
let redis: Redis;

beforeAll(async () => {
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
  redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
}, 120_000);

afterAll(async () => {
  redis?.disconnect();
  if (anvil !== undefined && anvil.exitCode === null) {
    const exited = new Promise((r) => anvil.once("exit", r));
    anvil.kill("SIGTERM");
    await exited;
  }
});

async function mine(blocks: number) {
  await client.request({ method: "anvil_mine", params: [toHex(blocks)] } as never);
}

// Polls for the receipt itself rather than through viem's
// `waitForTransactionReceipt`: that one checks again only when the block
// number changes, and drops a change that comes while it is still checking
// the last. Anvil mines each transaction just after answering it and then
// mines nothing more, so the dropped change is the only one there will be,
// and the wait would last until viem's 180-second timeout, past the test's.
const receiptOf = (hash: Hex) =>
  until("a receipt", 20_000, () => client.getTransactionReceipt({ hash }));

async function deploy(abi: Abi, bytecode: Hex, args: readonly unknown[]) {
  const hash = await wallet.deployContract({
    account: accounts[0] as Address,
    chain,
    abi,
    bytecode,
    args,
  } as Parameters<typeof wallet.deployContract>[0]);
  const receipt = await receiptOf(hash);
  if (receipt.contractAddress == null) throw new Error("not deployed");
  return { address: getAddress(receipt.contractAddress), block: receipt.blockNumber };
}

async function write(
  address: Address,
  abi: Abi,
  functionName: string,
  args: unknown[],
  value = 0n,
) {
  const hash = await wallet.writeContract({
    account: accounts[0] as Address,
    chain,
    address,
    abi,
    functionName,
    args,
    value,
  } as unknown as Parameters<typeof wallet.writeContract>[0]);
  const receipt = await receiptOf(hash);
  if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
}

interface Deployment {
  readonly entryPoint: Address;
  readonly registry: Address;
  readonly registryBlock: bigint;
  readonly account: Address;
  readonly paymaster: Address;
}

let bytecodes: { entryPoint: Hex; registry: Hex; account: Hex; paymaster: Hex } | undefined;

/** EntryPoint v0.8, a group registry with one Tier 0 group, the account and a funded paymaster. */
async function deployAll(maxCost = MAX_COST): Promise<Deployment> {
  bytecodes ??= {
    entryPoint: inspect("vendor/account-abstraction/contracts/core/EntryPoint.sol:EntryPoint"),
    registry: inspect("src/GroupRegistry.sol:GroupRegistry"),
    account: inspect("src/RegistrationAccount.sol:RegistrationAccount"),
    paymaster: inspect("src/RegistrationPaymaster.sol:RegistrationPaymaster"),
  };
  const entryPoint = (await deploy(entryPoint08Abi, bytecodes.entryPoint, [])).address;
  const registry = await deploy(groupRegistryAbi, bytecodes.registry, [THRESHOLD, REGISTRARS]);
  await write(registry.address, groupRegistryAbi, "createGroup", [0]);
  const account = (
    await deploy(registrationAccountAbi, bytecodes.account, [
      entryPoint,
      privateKeyToAddress(OWNER_KEY),
    ])
  ).address;
  // The admin must have code; any contract stands in for the timelock, which
  // these tests never call.
  const paymaster = (
    await deploy(registrationPaymasterAbi, bytecodes.paymaster, [
      entryPoint,
      registry.address,
      account,
      entryPoint,
      maxCost,
    ])
  ).address;
  await write(paymaster, registrationPaymasterAbi, "deposit", [], 10n ** 18n);
  await mine(FINALITY_DEPTH);
  return {
    entryPoint,
    registry: registry.address,
    registryBlock: registry.block,
    account,
    paymaster,
  };
}

interface Estimate {
  preVerificationGas: Hex;
  verificationGasLimit: Hex;
  callGasLimit: Hex;
  paymasterVerificationGasLimit?: Hex;
}

const GENEROUS: Estimate = {
  preVerificationGas: toHex(60_000),
  verificationGasLimit: toHex(150_000),
  callGasLimit: toHex(400_000),
  paymasterVerificationGasLimit: toHex(50_000),
};

/**
 * A stand-in bundler: answers ERC-7769's methods for one EntryPoint and
 * lands each operation it is sent with `handleOps`, answering the
 * EntryPoint's own hash of it. `tamper` lets a test make it lie.
 */
function standInBundler(
  entryPoint: Address,
  tamper: {
    chainId?: Hex;
    entryPoints?: unknown;
    estimate?: unknown;
    /** An estimate that depends on the fee the operation names, as an L2 bundler's `preVerificationGas` does. */
    estimateAt?: (maxFeePerGas: bigint) => unknown;
    answer?: (hash: Hex) => unknown;
    sendError?: (params: unknown) => Error;
  } = {},
) {
  const sent: UserOperation<"0.8">[] = [];
  const estimated: RpcUserOperation<"0.8">[] = [];
  const request: BundlerRequest = async ({ method, params }) => {
    switch (method) {
      case "eth_chainId":
        return tamper.chainId ?? toHex(chainId);
      case "eth_supportedEntryPoints":
        return tamper.entryPoints ?? [entryPoint];
      case "eth_estimateUserOperationGas": {
        const [op, at] = params as [RpcUserOperation<"0.8">, Address];
        if (getAddress(at) !== entryPoint) throw new Error("unsupported EntryPoint");
        estimated.push(op);
        if (tamper.estimateAt) return tamper.estimateAt(BigInt(op.maxFeePerGas));
        return "estimate" in tamper ? tamper.estimate : GENEROUS;
      }
      case "eth_sendUserOperation": {
        if (tamper.sendError) throw tamper.sendError(params);
        const [rpc, at] = params as [RpcUserOperation<"0.8">, Address];
        if (getAddress(at) !== entryPoint) throw new Error("unsupported EntryPoint");
        const op = formatUserOperation(rpc) as UserOperation<"0.8">;
        sent.push(op);
        const packed = toPackedUserOperation(op);
        await write(entryPoint, entryPoint08Abi, "handleOps", [[packed], accounts[9] as Address]);
        const hash = await client.readContract({
          address: entryPoint,
          abi: entryPoint08Abi,
          functionName: "getUserOpHash",
          args: [packed],
        });
        return tamper.answer ? tamper.answer(hash) : hash;
      }
      default:
        throw new Error(`unsupported method ${method}`);
    }
  };
  return { request, sent, estimated };
}

function options(d: Deployment, bundler: BundlerRequest): Tier0BundlerOptions {
  return {
    client,
    bundler,
    chainId: BigInt(chainId),
    entryPoint: d.entryPoint,
    account: d.account,
    ownerKey: bytes(OWNER_KEY),
    paymaster: d.paymaster,
    registry: d.registry,
  };
}

let nextCommitment = BigInt(`0x${randomBytes(8).toString("hex")}`) << 64n;
const commitments = (n: number) => Array.from({ length: n }, () => (nextCommitment += 7919n));

function signedRecord(
  registry: Address,
  firstIndex: bigint,
  values: bigint[],
  groupId = 0n,
): Uint8Array {
  const digest = groupAdditionDigest(
    groupRegistryDomainSeparator(BigInt(chainId), bytes(registry)),
    { groupId, tier: 0, firstIndex, commitments: values },
  );
  const approvals = SIGNERS.map((s) => signGroupApproval(digest, s.seat, s.secretKey));
  return encodeGroupAddition({ groupId, firstIndex, commitments: values, approvals });
}

async function count(registry: Address) {
  const [, , size] = await client.readContract({
    address: registry,
    abi: groupRegistryAbi,
    functionName: "groupOf",
    args: [0n],
  });
  return size;
}

const deposit = (paymaster: Address) =>
  client.readContract({
    address: paymaster,
    abi: registrationPaymasterAbi,
    functionName: "getDeposit",
  });

const units = (op: UserOperation<"0.8">) =>
  op.callGasLimit +
  op.verificationGasLimit +
  op.preVerificationGas +
  (op.paymasterVerificationGasLimit ?? 0n) +
  (op.paymasterPostOpGasLimit ?? 0n);

describe("connecting", () => {
  test("passes the configured deployment and refuses each mismatch, never quoting a key", async () => {
    const d = await deployAll();
    const other = await deployAll();
    const good = standInBundler(d.entryPoint).request;
    await expect(connectTier0Bundler(options(d, good))).resolves.toBeTypeOf("function");

    const refusals: [Tier0BundlerOptions, string][] = [
      [{ ...options(d, good), chainId: BigInt(chainId) + 1n }, "the L2 node is on another chain"],
      [
        options(d, standInBundler(d.entryPoint, { chainId: toHex(chainId + 1) }).request),
        "the bundler is on another chain",
      ],
      [
        options(d, standInBundler(d.entryPoint, { entryPoints: [other.entryPoint] }).request),
        "the bundler doesn't serve the EntryPoint",
      ],
      [
        options(d, standInBundler(d.entryPoint, { entryPoints: "0x" }).request),
        "the bundler doesn't serve the EntryPoint",
      ],
      [{ ...options(d, good), account: accounts[3] as Address }, "the account has no code"],
      [
        { ...options(d, standInBundler(other.entryPoint).request), entryPoint: other.entryPoint },
        "the account runs on another EntryPoint",
      ],
      [
        { ...options(d, good), ownerKey: bytes(generatePrivateKey()) },
        "the account key isn't the account's owner",
      ],
      [
        { ...options(d, good), registry: other.registry },
        "the paymaster sponsors another registry",
      ],
    ];
    for (const [o, message] of refusals)
      await expect(connectTier0Bundler(o), message).rejects.toThrow(message);
    // Paymasters on this EntryPoint for another account, and on another
    // EntryPoint for this account and registry.
    const paymasterBytecode = inspect("src/RegistrationPaymaster.sol:RegistrationPaymaster");
    const stray = async (entryPoint: Address, account: Address) =>
      (
        await deploy(registrationPaymasterAbi, paymasterBytecode, [
          entryPoint,
          d.registry,
          account,
          entryPoint,
          MAX_COST,
        ])
      ).address;
    const strays: [Address, string][] = [
      [await stray(d.entryPoint, other.account), "the paymaster sponsors another account"],
      [await stray(other.entryPoint, d.account), "the paymaster is another EntryPoint's"],
    ];
    for (const [paymaster, message] of strays)
      await expect(
        connectTier0Bundler({ ...options(d, good), paymaster }),
        message,
      ).rejects.toThrow(message);

    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    for (const key of [new Uint8Array(32), new Uint8Array(32).fill(0xff), bytes(N.toString(16))]) {
      const e = await connectTier0Bundler({ ...options(d, good), ownerKey: key }).catch((x) => x);
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toBe("the account key isn't a secp256k1 key");
      expect(JSON.stringify(e, Object.getOwnPropertyNames(e))).not.toContain(
        Buffer.from(key).toString("hex"),
      );
    }
  }, 120_000);
});

describe("submitting", () => {
  test("lands a record through EntryPoint v0.8 at the paymaster's cost, within its cap", async () => {
    const d = await deployAll();
    const bundler = standInBundler(d.entryPoint);
    const submit = await connectTier0Bundler(options(d, bundler.request));
    const before = await deposit(d.paymaster);
    const record = signedRecord(d.registry, 0n, commitments(8));
    await submit(record);
    expect(await count(d.registry)).toBe(8n);

    expect(bundler.sent).toHaveLength(1);
    const op = bundler.sent[0] as UserOperation<"0.8">;
    // What the paymaster's rules read: sender, no factory, no paymaster
    // data, `execute(registry, 0, addMembers(record))`, and the cap.
    expect(op.sender).toBe(d.account);
    expect(op.factory).toBeUndefined();
    expect(op.paymaster).toBe(d.paymaster);
    expect(op.paymasterData).toBe("0x");
    expect(op.paymasterPostOpGasLimit).toBe(0n);
    expect(op.nonce).toBe(0n);
    const call = decodeFunctionData({ abi: registrationAccountAbi, data: op.callData });
    expect(call.functionName).toBe("execute");
    const [target, value, inner] = call.args as [Address, bigint, Hex];
    expect([target, value]).toEqual([d.registry, 0n]);
    expect(decodeFunctionData({ abi: groupRegistryAbi, data: inner }).args).toEqual([
      toHex(record),
    ]);
    expect(units(op) * op.maxFeePerGas).toBeLessThanOrEqual(MAX_COST);
    // The estimate ran on the same operation, with a signature that parses.
    const draft = bundler.estimated[0] as RpcUserOperation<"0.8">;
    expect(draft.callData).toBe(op.callData);
    expect(draft.signature).toHaveLength(2 + 130);

    // Paid from the deposit, never by the account.
    const spent = before - (await deposit(d.paymaster));
    expect(spent).toBeGreaterThan(0n);
    expect(spent).toBeLessThanOrEqual(MAX_COST);
    expect(await client.getBalance({ address: d.account })).toBe(0n);

    // The next record takes the next nonce.
    await submit(signedRecord(d.registry, 8n, commitments(8)));
    expect(bundler.sent[1]?.nonce).toBe(1n);
    expect(await count(d.registry)).toBe(16n);
  }, 120_000);

  test("lowers the fee to fit the paymaster's cap however much gas the bundler asks", async () => {
    const d = await deployAll();
    const huge = {
      ...GENEROUS,
      preVerificationGas: toHex(5_000_000),
      callGasLimit: toHex(5_000_000),
    };
    const bundler = standInBundler(d.entryPoint, { estimate: huge });
    const submit = await connectTier0Bundler(options(d, bundler.request));
    const fees = await client.estimateFeesPerGas();
    await submit(signedRecord(d.registry, 0n, commitments(8)));
    expect(await count(d.registry)).toBe(8n);
    const op = bundler.sent[0] as UserOperation<"0.8">;
    expect(units(op) * fees.maxFeePerGas).toBeGreaterThan(MAX_COST);
    // Taking all of the first estimate's preVerificationGas as data fee.
    const first = BigInt((bundler.estimated[0] as RpcUserOperation<"0.8">).maxFeePerGas);
    expect(op.maxFeePerGas).toBe(
      (MAX_COST - 5_000_000n * first) / (units(op) - op.preVerificationGas),
    );
    expect(op.maxPriorityFeePerGas).toBeLessThanOrEqual(op.maxFeePerGas);
  }, 120_000);

  test("estimates the lowered fee again, and sends nothing if it no longer fits the cap", async () => {
    const d = await deployAll();
    const fees = await client.estimateFeesPerGas();
    // The L1 data fee as gas: a fixed cost in wei divided by the fee, beside
    // a call limit that alone doesn't fit at the node's fee.
    const l1 = MAX_COST / 4n;
    const callGasLimit = ((MAX_COST / fees.maxFeePerGas) * 9n) / 10n;
    const at = (fee: bigint) => ({
      ...GENEROUS,
      callGasLimit: toHex(callGasLimit),
      preVerificationGas: toHex(60_000n + l1 / fee),
    });
    const fits = standInBundler(d.entryPoint, { estimateAt: at });
    await connectTier0Bundler(options(d, fits.request)).then((submit) =>
      submit(signedRecord(d.registry, 0n, commitments(8))),
    );
    // Over the cap at the node's fee, so estimated twice, and sent at the
    // second estimate's gas within the cap.
    const op = fits.sent[0] as UserOperation<"0.8">;
    const [first, second] = fits.estimated.map((o) => BigInt(o.maxFeePerGas));
    expect(fits.estimated).toHaveLength(2);
    expect(second).toBe(op.maxFeePerGas);
    expect(op.maxFeePerGas).toBeLessThan(first as bigint);
    expect(op.preVerificationGas).toBe(60_000n + l1 / op.maxFeePerGas);
    expect(units(op) * op.maxFeePerGas).toBeLessThanOrEqual(MAX_COST);
    expect(await count(d.registry)).toBe(8n);

    // A data fee above the cap fits no fee.
    const never = standInBundler(d.entryPoint, {
      estimateAt: (fee) => ({ ...GENEROUS, preVerificationGas: toHex((2n * MAX_COST) / fee) }),
    });
    const submit = await connectTier0Bundler(options(d, never.request));
    await expect(submit(signedRecord(d.registry, 8n, commitments(8)))).rejects.toThrow(
      "the paymaster's cap can't pay for the batch's gas",
    );
    expect(never.sent).toHaveLength(0);
  }, 120_000);

  test("takes each group's nonce from the key named by its ID", async () => {
    const d = await deployAll();
    await write(d.registry, groupRegistryAbi, "createGroup", [0]);
    await mine(FINALITY_DEPTH);
    const bundler = standInBundler(d.entryPoint);
    const submit = await connectTier0Bundler(options(d, bundler.request));
    await submit(signedRecord(d.registry, 0n, commitments(8), 1n));
    await submit(signedRecord(d.registry, 0n, commitments(8)));
    expect(bundler.sent.map((o) => o.nonce)).toEqual([1n << 64n, 0n]);
    expect(await count(d.registry)).toBe(8n);
  }, 120_000);

  test("takes the paymaster's verification gas from the estimate, or its own when it names none", async () => {
    const d = await deployAll();
    const { paymasterVerificationGasLimit: _, ...without } = GENEROUS;
    const bundler = standInBundler(d.entryPoint, { estimate: without });
    const submit = await connectTier0Bundler(options(d, bundler.request));
    await submit(signedRecord(d.registry, 0n, commitments(8)));
    expect(bundler.sent[0]?.paymasterVerificationGasLimit).toBe(TIER0_PAYMASTER_VERIFICATION_GAS);
    expect(await count(d.registry)).toBe(8n);
  }, 120_000);

  test("refuses a cap too small for one unit of fee, sending nothing", async () => {
    const d = await deployAll(1000n);
    const bundler = standInBundler(d.entryPoint);
    const submit = await connectTier0Bundler(options(d, bundler.request));
    await expect(submit(signedRecord(d.registry, 0n, commitments(8)))).rejects.toThrow(
      "the paymaster's cap can't pay for the batch's gas",
    );
    expect(bundler.sent).toHaveLength(0);
  }, 120_000);

  test("refuses a malformed estimate, sending nothing", async () => {
    const d = await deployAll();
    const malformed: unknown[] = [
      null,
      "0x1",
      { ...GENEROUS, extra: "0x1" },
      { ...GENEROUS, callGasLimit: "100000" },
      { ...GENEROUS, callGasLimit: "-0x1" },
      { ...GENEROUS, callGasLimit: toHex(2n ** 128n) },
      { ...GENEROUS, verificationGasLimit: undefined },
      {
        preVerificationGas: "0x0",
        verificationGasLimit: "0x0",
        callGasLimit: "0x0",
        paymasterVerificationGasLimit: "0x0",
      },
    ];
    for (const estimate of malformed) {
      const bundler = standInBundler(d.entryPoint, { estimate });
      const submit = await connectTier0Bundler(options(d, bundler.request));
      await expect(
        submit(signedRecord(d.registry, 0n, commitments(8))),
        JSON.stringify(estimate),
      ).rejects.toThrow("the bundler's estimate is malformed");
      expect(bundler.sent).toHaveLength(0);
    }
    expect(await count(d.registry)).toBe(0n);
  }, 120_000);

  test("refuses a bundler that answers another operation's hash", async () => {
    const d = await deployAll();
    for (const answer of [
      (h: Hex) => `0x${(BigInt(h) ^ 1n).toString(16).padStart(64, "0")}`,
      () => null,
      () => 7,
    ]) {
      const bundler = standInBundler(d.entryPoint, { answer });
      const submit = await connectTier0Bundler(options(d, bundler.request));
      await expect(
        submit(signedRecord(d.registry, await count(d.registry), commitments(8))),
      ).rejects.toThrow("the bundler answered another operation");
    }
  }, 120_000);

  test("never quotes the record or the operation when the bundler refuses it", async () => {
    const d = await deployAll();
    const bundler = standInBundler(d.entryPoint, {
      sendError: (params) => new Error(`refused ${JSON.stringify(params)}`),
    });
    const submit = await connectTier0Bundler(options(d, bundler.request));
    const record = signedRecord(d.registry, 0n, commitments(8));
    const e = await submit(record).catch((x) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toBe("the batch wasn't taken");
    expect((e as Error).cause).toBeUndefined();
    expect(JSON.stringify(e, Object.getOwnPropertyNames(e))).not.toContain(
      Buffer.from(record).toString("hex"),
    );
    // A record the registry refuses (signed for a position not yet reached)
    // is taken and lands as a reverted operation: it adds nothing and costs
    // the deposit at most the cap (docs/spec/contracts.md, Registration
    // paymaster, Known-weak).
    const before = await deposit(d.paymaster);
    const ok = await connectTier0Bundler(options(d, standInBundler(d.entryPoint).request));
    await expect(ok(signedRecord(d.registry, 8n, commitments(8)))).resolves.toBeUndefined();
    expect(await count(d.registry)).toBe(0n);
    expect(before - (await deposit(d.paymaster))).toBeLessThanOrEqual(MAX_COST);
  }, 120_000);
});

describe("the batch job through the bundler", () => {
  test("a boundary signs a batch and the paymaster pays for it to land", async () => {
    const d = await deployAll();
    const bundler = standInBundler(d.entryPoint);
    const submit = await connectTier0Bundler(options(d, bundler.request));
    const prefix = `abolish-test-${randomBytes(6).toString("hex")}`;
    const keys = tier0Keys(prefix);
    let clock = 1_800_000_000;
    const batches = new Tier0Batches({
      redis,
      chain: new ViemTier0Chain({
        client,
        registry: d.registry,
        fromBlock: d.registryBlock,
        submit,
      }),
      groups: new Map([[0, 0n]]),
      chainId: BigInt(chainId),
      registry: bytes(d.registry),
      registrars: REGISTRARS.map(bytes),
      threshold: THRESHOLD,
      signers: SIGNERS,
      now: () => clock,
      prefix,
    });
    try {
      const queued = commitments(MIN_REGISTRATION_BATCH);
      for (const v of queued) {
        await redis.hset(keys.queue, commitmentKey(v), "0");
        await redis.hincrby(keys.sizes, "0", 1);
      }
      expect(await batches.refreshIndex()).toBe(true);
      clock += 600;
      expect(await batches.runBoundary()).toEqual([
        { groupId: 0n, outcome: "signed", abandoned: false, submitFailed: false },
      ]);
      expect(await count(d.registry)).toBe(BigInt(MIN_REGISTRATION_BATCH));
      expect(bundler.sent).toHaveLength(1);
      const inner = decodeFunctionData({
        abi: groupRegistryAbi,
        data: (
          decodeFunctionData({
            abi: registrationAccountAbi,
            data: bundler.sent[0]?.callData as Hex,
          }).args as [Address, bigint, Hex]
        )[2],
      }).args[0] as Hex;
      const record = decodeGroupAddition(bytes(inner));
      if (!record.ok) throw new Error("undecodable");
      expect(record.value.commitments).toEqual(
        [...queued].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)),
      );
    } finally {
      const left = await redis.keys(`${prefix}:*`);
      if (left.length > 0) await redis.del(...left);
    }
  }, 120_000);
});
