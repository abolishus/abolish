import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { boardAnchorAbi } from "@abolishus/contracts/abi";
import type { AnchoringClock } from "@abolishus/core";
import { type Checkpoint, checkpointHash, encodeCheckpoint } from "@abolishus/crypto";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  type Hex,
  hexToBytes,
  http,
  keccak256,
  pad,
  parseAbi,
  parseTransaction,
  type PublicClient,
  toHex,
  zeroAddress,
} from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  type AnchorSafe,
  checkAnchorSafe,
  checkAnchorSafeHistory,
  checkAnchorSafeState,
  connectAnchorRunner,
  FALLBACK_HANDLER_SLOT,
  GUARD_SLOT,
  keySigner,
  LOG_RANGE,
  type SafeSigner,
  safeSender,
  ViemAnchorChain,
} from "../src/index.ts";

// The anchoring authority's Safe against a real one (P4-1 part 2b-2a):
// SafeL2 v1.4.1, vendored in packages/contracts, deployed on Anvil through
// its proxy factory as the board anchor's authority. The check passes the
// deployment record's Safe and refuses each change that would let fewer
// than its threshold act as it, through the Safe's own functions or through
// a delegatecall the getters can't see; the sender anchors through the Safe
// with the threshold's signatures, and sends nothing for a changed Safe, too
// few honest signatures or a call that would revert (T-49, T-69). Every key
// here is made by the test and held by no one else (AGENTS.md).

const contractsRoot = fileURLToPath(new URL("../../../packages/contracts", import.meta.url));
const FINALITY_DEPTH = 2;
const PERIOD = 3600n;
const DEADLINE = 43_200n;

const factoryAbi = parseAbi([
  "function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address)",
]);
const setupAbi = parseAbi([
  "function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function enableModule(address module)",
  "function setFallbackHandler(address handler)",
  "function addOwnerWithThreshold(address owner, uint256 threshold)",
  "function changeThreshold(uint256 threshold)",
  "function execTransactionFromModule(address to, uint256 value, bytes data, uint8 operation) returns (bool)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce) view returns (bytes32)",
  "function nonce() view returns (uint256)",
]);

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
let rpcUrl: string;
let chainId: bigint;
let chain: ReturnType<typeof defineChain>;
let client: PublicClient;
let wallet: ReturnType<typeof createWalletClient>;
let deployer: Address;
let singleton: Address;
let factory: Address;
let anchorBytecode: Hex;
let salt = 0n;

beforeAll(async () => {
  chainId = 31_337n;
  const port = await freePort();
  rpcUrl = `http://127.0.0.1:${port}`;
  anvil = spawn(
    "anvil",
    ["--host", "127.0.0.1", "--port", String(port), "--slots-in-an-epoch", "1", "--silent"],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  chain = defineChain({
    id: Number(chainId),
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
  anchorBytecode = inspect("src/BoardAnchor.sol:BoardAnchor");
  singleton = await deploy(inspect("vendor/safe-smart-account/contracts/SafeL2.sol:SafeL2"));
  factory = await deploy(
    inspect("vendor/safe-smart-account/contracts/proxies/SafeProxyFactory.sol:SafeProxyFactory"),
  );
}, 180_000);

afterAll(async () => {
  if (anvil !== undefined && anvil.exitCode === null) {
    const exited = new Promise((r) => anvil.once("exit", r));
    anvil.kill("SIGTERM");
    await exited;
  }
});

const rpc = (method: string, params: unknown[]) =>
  client.request({ method, params } as never) as Promise<unknown>;
const mine = (blocks: number) => rpc("anvil_mine", [toHex(blocks)]);
const receiptOf = (hash: Hex) =>
  until("a receipt", 20_000, () => client.getTransactionReceipt({ hash }));
const finalized = async () => (await client.getBlock({ blockTag: "finalized" })).number;
const codeHash = async (address: Address) => keccak256((await client.getCode({ address }))!);

async function deploy(bytecode: Hex): Promise<Address> {
  const hash = await wallet.sendTransaction({ account: deployer, chain, data: bytecode });
  const receipt = await receiptOf(hash);
  if (!receipt.contractAddress) throw new Error("not deployed");
  return receipt.contractAddress;
}

/** Sends `data` to `to` as `from`, impersonated, and requires it to succeed. */
async function as(from: Address, to: Address, data: Hex) {
  await rpc("anvil_impersonateAccount", [from]);
  await rpc("anvil_setBalance", [from, toHex(10n ** 20n)]);
  const hash = await wallet.sendTransaction({ account: from, chain, to, data });
  if ((await receiptOf(hash)).status !== "success") throw new Error("the call reverted");
}

interface Fixture {
  readonly safe: AnchorSafe;
  readonly keys: readonly Hex[];
  readonly anchor: Address;
  readonly clock: AnchoringClock;
  readonly executor: Uint8Array;
}

/** A `threshold`-of-`n` Safe, the anchor whose authority it is (periods 0 and 1 ended), and a funded executor. */
async function fixture(n = 3, threshold = 2n, setupTo: Address = zeroAddress): Promise<Fixture> {
  const keys = Array.from({ length: n }, () => generatePrivateKey());
  const owners = keys.map((k) => privateKeyToAddress(k));
  const initializer = encode("setup", [
    owners,
    threshold,
    setupTo,
    "0x",
    zeroAddress,
    zeroAddress,
    0n,
    zeroAddress,
  ]);
  const { result: proxy, request } = await client.simulateContract({
    account: deployer,
    address: factory,
    abi: factoryAbi,
    functionName: "createProxyWithNonce",
    args: [singleton, initializer, (salt += 1n)],
  });
  const created = await receiptOf(await wallet.writeContract({ ...request, chain }));
  const latest = await client.getBlock({ blockTag: "latest" });
  const clock = { epoch: latest.timestamp - 2n * PERIOD - 60n, period: PERIOD, deadline: DEADLINE };
  const hash = await wallet.deployContract({
    account: deployer,
    chain,
    abi: boardAnchorAbi,
    bytecode: anchorBytecode,
    args: [clock, proxy],
  });
  const anchor = (await receiptOf(hash)).contractAddress!;
  const executor = generatePrivateKey();
  await rpc("anvil_setBalance", [privateKeyToAddress(executor), toHex(10n ** 20n)]);
  await mine(FINALITY_DEPTH);
  return {
    safe: {
      address: proxy,
      deploymentBlock: created.blockNumber,
      proxyCodeHash: await codeHash(proxy),
      singleton,
      singletonCodeHash: await codeHash(singleton),
      owners,
      threshold,
      fallbackHandler: zeroAddress,
    },
    keys,
    anchor,
    clock,
    executor: hexToBytes(executor),
  };
}

/** Code at a fresh address: `code`, or STOP. */
async function contractAt(code: Hex = "0x00"): Promise<Address> {
  const address = privateKeyToAddress(generatePrivateKey());
  await rpc("anvil_setCode", [address, code]);
  return address;
}

/** Executes a Safe transaction signed by the first two owners. */
async function execSafe(f: Fixture, to: Address, data: Hex, operation: number) {
  const nonce = (await client.readContract({
    address: f.safe.address,
    abi: setupAbi,
    functionName: "nonce",
  })) as bigint;
  const hash = (await client.readContract({
    address: f.safe.address,
    abi: setupAbi,
    functionName: "getTransactionHash",
    args: [to, 0n, data, operation, 0n, 0n, 0n, zeroAddress, zeroAddress, nonce],
  })) as Hex;
  const signers = f.keys.slice(0, 2).map(signer);
  signers.sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
  const signatures =
    `0x${(await Promise.all(signers.map((s) => s.sign(hash)))).map((x) => x.slice(2)).join("")}` as Hex;
  await as(
    deployer,
    f.safe.address,
    encodeFunctionData({
      abi: parseAbi([
        "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
      ]),
      functionName: "execTransaction",
      args: [to, 0n, data, operation, 0n, 0n, 0n, zeroAddress, zeroAddress, signatures],
    }),
  );
}

/** Code that writes `modules[module] = 1` into the Safe's storage when delegatecalled. */
const hiddenModuleCode = (module: Address): Hex =>
  `0x7f${toHex(1n, { size: 32 }).slice(2)}7f${keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [module, 1n]),
  ).slice(2)}5500`;

const encode = (name: (typeof setupAbi)[number]["name"], args: readonly unknown[]): Hex =>
  encodeFunctionData({ abi: setupAbi, functionName: name, args } as never);

const segment = (election: Uint8Array, s: number): Checkpoint => ({
  election_id: election,
  segment: s,
  size: 1n,
  head: new Uint8Array(32).fill(s + 1),
  root: new Uint8Array(32).fill(s + 2),
  object_cid: Uint8Array.of(0x01, 0x55, 0x12, 0x20, ...new Uint8Array(32).fill(7)),
  hashes_cid: Uint8Array.of(0x01, 0x70, 0x12, 0x20, ...new Uint8Array(32).fill(9)),
});

const adapter = (f: Fixture, send: (calldata: Uint8Array) => Promise<void>) =>
  new ViemAnchorChain({
    client,
    chainId,
    anchor: f.anchor,
    clock: { epoch: 0n, period: PERIOD, deadline: DEADLINE },
    authority: f.safe.address,
    send,
  });

const sender = (
  f: Fixture,
  signers: readonly SafeSigner[] = f.keys.map(signer),
  through = client,
) =>
  safeSender({
    client: through,
    chainId,
    anchor: f.anchor,
    safe: f.safe,
    signers,
    executor: f.executor,
    pollMs: 50,
  });

const signer = (key: Hex) => keySigner(hexToBytes(key));
const sent = (f: Fixture) =>
  client.getTransactionCount({ address: privateKeyToAddress(toHex(f.executor)) });
const held = (f: Fixture, election: Uint8Array, s: number) =>
  client.readContract({
    address: f.anchor,
    abi: boardAnchorAbi,
    functionName: "checkpointHashOf",
    args: [toHex(election), s],
  });
const election = () => crypto.getRandomValues(new Uint8Array(32));

describe("the Safe's check", () => {
  test("passes the deployment record's Safe at a finalized block", async () => {
    const f = await fixture();
    await expect(checkAnchorSafe(client, f.safe, await finalized())).resolves.toBeUndefined();
    // Owners in any order.
    const owners = [...f.safe.owners].reverse();
    await expect(
      checkAnchorSafe(client, { ...f.safe, owners }, await finalized()),
    ).resolves.toBeUndefined();
  });

  test("refuses a record naming another Safe", async () => {
    const f = await fixture();
    const block = await finalized();
    const other = (await fixture()).safe;
    const cases: [Partial<AnchorSafe>, string][] = [
      [{ proxyCodeHash: f.safe.singletonCodeHash }, "isn't the Safe's proxy"],
      [{ address: f.anchor }, "setup isn't the record's"],
      [{ singleton: f.anchor }, "another singleton"],
      [{ singletonCodeHash: f.safe.proxyCodeHash }, "singleton has other code"],
      [{ fallbackHandler: f.anchor }, "another fallback handler"],
      [{ owners: other.owners }, "other owners"],
      [{ owners: [...f.safe.owners.slice(1), f.safe.owners[1]!] }, "other owners"],
      [{ threshold: 3n }, "another threshold"],
      [{ deploymentBlock: f.safe.deploymentBlock + 1n }, "setup isn't the record's"],
    ];
    for (const [change, error] of cases)
      await expect(checkAnchorSafe(client, { ...f.safe, ...change }, block)).rejects.toThrow(error);
    for (const threshold of [0n, 1n, 4n])
      await expect(checkAnchorSafe(client, { ...f.safe, threshold }, block)).rejects.toThrow(
        RangeError,
      );
  });

  test("refuses each change that lets fewer than the threshold act as the Safe", async () => {
    const changes: [string, (f: Fixture) => Promise<unknown>, string][] = [
      [
        "a module",
        (f) => as(f.safe.address, f.safe.address, encode("enableModule", [f.anchor])),
        "has a module",
      ],
      [
        "a guard",
        (f) => rpc("anvil_setStorageAt", [f.safe.address, GUARD_SLOT, pad(f.anchor)]),
        "has a guard",
      ],
      [
        "a fallback handler",
        (f) => as(f.safe.address, f.safe.address, encode("setFallbackHandler", [f.anchor])),
        "another fallback handler",
      ],
      [
        "another singleton",
        (f) => rpc("anvil_setStorageAt", [f.safe.address, "0x0", pad(f.anchor)]),
        "another singleton",
      ],
      [
        "a lower threshold",
        (f) => as(f.safe.address, f.safe.address, encode("changeThreshold", [1n])),
        "another threshold",
      ],
      [
        "another owner",
        (f) =>
          as(
            f.safe.address,
            f.safe.address,
            encode("addOwnerWithThreshold", [privateKeyToAddress(generatePrivateKey()), 2n]),
          ),
        "other owners",
      ],
      [
        "another proxy",
        (f) => rpc("anvil_setCode", [f.safe.address, "0x00"]),
        "isn't the Safe's proxy",
      ],
    ];
    for (const [what, change, error] of changes) {
      const f = await fixture();
      await change(f);
      await mine(FINALITY_DEPTH);
      await expect(checkAnchorSafe(client, f.safe, await finalized()), what).rejects.toThrow(error);
    }
    // The fallback handler slot is the one Safe keeps it in.
    const f = await fixture();
    await as(f.safe.address, f.safe.address, encode("setFallbackHandler", [f.anchor]));
    expect(
      await client.getStorageAt({ address: f.safe.address, slot: FALLBACK_HANDLER_SLOT }),
    ).toBe(pad(f.anchor.toLowerCase() as Hex));
  });
});

describe("the Safe's history", () => {
  test("refuses a delegatecall that hides a module from the Safe's getters", async () => {
    const f = await fixture();
    const module = privateKeyToAddress(generatePrivateKey());
    await execSafe(f, await contractAt(hiddenModuleCode(module)), "0x", 1);
    await mine(FINALITY_DEPTH);
    const block = await finalized();
    // The getters and slots show nothing, yet the module acts as the Safe.
    await expect(checkAnchorSafeState(client, f.safe, block)).resolves.toBeUndefined();
    await as(module, f.safe.address, encode("execTransactionFromModule", [deployer, 0n, "0x", 0]));
    await expect(checkAnchorSafe(client, f.safe, block)).rejects.toThrow("made a delegatecall");
  });

  test("refuses any delegatecall, and accepts calls", async () => {
    const f = await fixture();
    await execSafe(f, await contractAt(), "0x", 0);
    await mine(FINALITY_DEPTH);
    await expect(checkAnchorSafe(client, f.safe, await finalized())).resolves.toBeUndefined();
    await execSafe(f, await contractAt(), "0x", 1);
    await mine(FINALITY_DEPTH);
    await expect(checkAnchorSafe(client, f.safe, await finalized())).rejects.toThrow(
      "made a delegatecall",
    );
  });

  test("refuses a Safe set up with a delegatecall", async () => {
    const f = await fixture(3, 2n, await contractAt());
    await expect(checkAnchorSafe(client, f.safe, await finalized())).rejects.toThrow(
      "setup isn't the record's",
    );
  });

  test("refuses a module's execution", async () => {
    const f = await fixture();
    const module = privateKeyToAddress(generatePrivateKey());
    await as(f.safe.address, f.safe.address, encode("enableModule", [module]));
    await as(module, f.safe.address, encode("execTransactionFromModule", [deployer, 0n, "0x", 0]));
    await mine(FINALITY_DEPTH);
    const block = await finalized();
    await expect(
      checkAnchorSafeHistory(client, f.safe, f.safe.deploymentBlock, block),
    ).rejects.toThrow("a module has acted");
  });

  test("reads the history in ranges, and only from the deployment", async () => {
    const f = await fixture();
    await mine(Number(LOG_RANGE) + 10);
    await execSafe(f, await contractAt(), "0x", 1);
    await mine(FINALITY_DEPTH);
    await expect(checkAnchorSafe(client, f.safe, await finalized())).rejects.toThrow(
      "made a delegatecall",
    );
    await expect(
      checkAnchorSafeHistory(client, f.safe, f.safe.deploymentBlock - 1n, await finalized()),
    ).rejects.toThrow(RangeError);
  });
});

describe("the sender", () => {
  test("anchors through the Safe with the threshold's signatures", async () => {
    const f = await fixture();
    const id = election();
    const chain = adapter(f, sender(f));
    await chain.anchor([segment(id, 0)], undefined);
    expect(await held(f, id, 0)).toBe(toHex(checkpointHash(segment(id, 0))));
    await chain.anchor([segment(id, 1)], undefined);
    expect(await held(f, id, 1)).toBe(toHex(checkpointHash(segment(id, 1))));
    expect(await sent(f)).toBe(2);
  });

  test("sends nothing for a Safe changed since the record", async () => {
    const f = await fixture();
    const send = sender(f);
    await as(f.safe.address, f.safe.address, encode("enableModule", [f.anchor]));
    const id = election();
    await expect(adapter(f, send).anchor([segment(id, 0)], undefined)).rejects.toThrow(
      "has a module",
    );
    expect(await sent(f)).toBe(0);
    expect(await held(f, id, 0)).toMatch(/^0x0{64}$/);
  });

  test("sends nothing once the Safe has made a delegatecall, finalized or not", async () => {
    const f = await fixture();
    const send = sender(f);
    const id = election();
    await adapter(f, send).anchor([segment(id, 0)], undefined);
    await execSafe(f, await contractAt(), "0x", 1);
    await expect(adapter(f, send).anchor([segment(id, 1)], undefined)).rejects.toThrow(
      "made a delegatecall",
    );
    await mine(FINALITY_DEPTH);
    await expect(adapter(f, send).anchor([segment(id, 1)], undefined)).rejects.toThrow(
      "made a delegatecall",
    );
    expect(await sent(f)).toBe(1);
  });

  test("signs only anchor calls, and refuses a node behind a block already read", async () => {
    const f = await fixture();
    await expect(
      sender(f)(
        hexToBytes(
          encodeFunctionData({
            abi: boardAnchorAbi,
            functionName: "retireReceiptKey",
            args: [toHex(new Uint8Array(33).fill(2))],
          }),
        ),
      ),
    ).rejects.toThrow("only anchor calls");
    let behind = 0n;
    const lagging = createPublicClient({
      chain,
      transport: custom(
        {
          async request({ method, params }: { method: string; params?: unknown }) {
            const answer = await client.request({ method, params } as never);
            if (method !== "eth_getBlockByNumber" || answer === null) return answer;
            const b = answer as { number: Hex };
            return { ...b, number: toHex(BigInt(b.number) - behind) };
          },
        },
        { retryCount: 0 },
      ),
    }) as PublicClient;
    const send = sender(f, f.keys.map(signer), lagging);
    const id = election();
    await adapter(f, send).anchor([segment(id, 0)], undefined);
    behind = 5n;
    await expect(adapter(f, send).anchor([segment(id, 1)], undefined)).rejects.toThrow(
      "behind blocks",
    );
    expect(await sent(f)).toBe(1);
  });

  test("skips a signer whose signature isn't its own, and sends nothing without the threshold", async () => {
    const f = await fixture();
    const [a, b, c] = f.keys as [Hex, Hex, Hex];
    // Signs with another owner's key while claiming its own address.
    const liar: SafeSigner = {
      address: privateKeyToAddress(b),
      sign: (hash) => signer(c).sign(hash),
    };
    const broken: SafeSigner = {
      address: privateKeyToAddress(c),
      sign: async () => {
        throw new Error("offline");
      },
    };
    const id = election();
    await expect(
      adapter(f, sender(f, [liar, signer(a), broken])).anchor([segment(id, 0)], undefined),
    ).rejects.toThrow("too few owners signed");
    expect(await sent(f)).toBe(0);
    await adapter(f, sender(f, [liar, broken, signer(a), signer(c)])).anchor(
      [segment(id, 0)],
      undefined,
    );
    expect(await held(f, id, 0)).toBe(toHex(checkpointHash(segment(id, 0))));
  });

  test("sends nothing for a call whose execution would revert", async () => {
    const f = await fixture();
    // Segment 2's period hasn't ended: the anchor refuses it, so the Safe
    // reverts the transaction (GS013) and the node's estimate fails.
    await expect(
      sender(f)(
        hexToBytes(
          encodeFunctionData({
            abi: boardAnchorAbi,
            functionName: "anchor",
            args: [toHex(encodeCheckpoint(segment(election(), 2))), "0x"],
          }),
        ),
      ),
    ).rejects.toThrow();
    expect(await sent(f)).toBe(0);
  });

  test("fails a receipt without the Safe's ExecutionSuccess for the hash signed", async () => {
    const f = await fixture();
    const stripped = createPublicClient({
      chain,
      transport: custom(
        {
          async request({ method, params }: { method: string; params?: unknown }) {
            const answer = await client.request({ method, params } as never);
            if (method !== "eth_getTransactionReceipt" || answer === null) return answer;
            return { ...(answer as object), logs: [] };
          },
        },
        { retryCount: 0 },
      ),
    }) as PublicClient;
    await expect(
      adapter(f, sender(f, f.keys.map(signer), stripped)).anchor(
        [segment(election(), 0)],
        undefined,
      ),
    ).rejects.toThrow("didn't execute");
  });

  test("replaces its own transaction stuck past the receipt timeout, raising both fees", async () => {
    const f = await fixture();
    const executor = privateKeyToAddress(toHex(f.executor));
    const send = safeSender({
      client,
      chainId,
      anchor: f.anchor,
      safe: f.safe,
      signers: f.keys.map(signer),
      executor: f.executor,
      receiptTimeoutMs: 300,
      pollMs: 50,
    });
    const chain = adapter(f, send);
    const id = election();
    type Pending = { hash: Hex; maxFeePerGas: Hex; maxPriorityFeePerGas: Hex };
    const pending = async () => {
      const pool = (await rpc("txpool_content", [])) as {
        pending: Record<string, Record<string, Pending>>;
      };
      const ours = Object.entries(pool.pending).find(([a]) => getAddress(a) === executor);
      return ours === undefined ? [] : Object.values(ours[1]);
    };
    await rpc("evm_setAutomine", [false]);
    try {
      // A locator-only call that isn't mined before the receipt times out.
      await expect(chain.anchor([], Uint8Array.of(0, 3, 1))).rejects.toThrow("in time");
      const [stuck] = (await pending()) as [Pending];
      // The next run's checkpoint call at the same nonce, at the same base
      // fee and tip: a pool takes it only with both fees raised.
      const next = chain.anchor([segment(id, 0)], undefined);
      const replacement = await until("the replacement", 20_000, async () => {
        const [tx, ...rest] = await pending();
        return tx !== undefined && rest.length === 0 && tx.hash !== stuck.hash ? tx : undefined;
      });
      expect(BigInt(replacement.maxPriorityFeePerGas) * 8n).toBeGreaterThanOrEqual(
        BigInt(stuck.maxPriorityFeePerGas) * 9n,
      );
      expect(BigInt(replacement.maxFeePerGas) * 8n).toBeGreaterThanOrEqual(
        BigInt(stuck.maxFeePerGas) * 9n,
      );
      await mine(1);
      await next;
    } finally {
      await rpc("evm_setAutomine", [true]);
    }
    expect(await held(f, id, 0)).toBe(toHex(checkpointHash(segment(id, 0))));
    const [, count] = await client.readContract({
      address: f.anchor,
      abi: boardAnchorAbi,
      functionName: "latestLocator",
    });
    expect(count).toBe(0n);
    expect(await sent(f)).toBe(1);
  }, 60_000);

  test("caps the bump at twice today's fees when sends are refused run after run", async () => {
    const f = await fixture();
    const signed: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }[] = [];
    const refusing = createPublicClient({
      chain,
      transport: custom(
        {
          async request({ method, params }: { method: string; params?: unknown }) {
            if (method !== "eth_sendRawTransaction")
              return client.request({ method, params } as never);
            const tx = parseTransaction((params as [Hex])[0]);
            signed.push({
              maxFeePerGas: tx.maxFeePerGas!,
              maxPriorityFeePerGas: tx.maxPriorityFeePerGas!,
            });
            throw new Error("insufficient funds");
          },
        },
        { retryCount: 0 },
      ),
    }) as PublicClient;
    const refused = adapter(f, sender(f, f.keys.map(signer), refusing));
    for (let i = 0; i < 12; i++)
      await expect(refused.anchor([segment(election(), 0)], undefined)).rejects.toThrow("refused");
    const [today, second] = signed as [(typeof signed)[0], (typeof signed)[0]];
    expect(second.maxFeePerGas * 8n).toBeGreaterThanOrEqual(today.maxFeePerGas * 9n);
    expect(second.maxPriorityFeePerGas * 8n).toBeGreaterThanOrEqual(
      today.maxPriorityFeePerGas * 9n,
    );
    for (const fees of signed) {
      expect(fees.maxFeePerGas).toBeLessThanOrEqual(today.maxFeePerGas * 2n + 1n);
      expect(fees.maxPriorityFeePerGas).toBeLessThanOrEqual(today.maxPriorityFeePerGas * 2n + 1n);
      expect(fees.maxPriorityFeePerGas).toBeLessThanOrEqual(fees.maxFeePerGas);
    }
    expect(signed.at(-1)!.maxFeePerGas).toBe(today.maxFeePerGas * 2n + 1n);
    expect(await sent(f)).toBe(0);
  }, 60_000);

  test("refuses signers that can't meet the threshold and malformed keys", async () => {
    const f = await fixture();
    const [a, b] = f.keys as [Hex, Hex];
    expect(() => sender(f, [signer(a)])).toThrow("fewer signers");
    expect(() => sender(f, [signer(a), signer(a)])).toThrow("fewer signers");
    expect(() => sender(f, [signer(a), signer(generatePrivateKey())])).toThrow("isn't one of");
    expect(() =>
      safeSender({
        client,
        chainId,
        anchor: f.anchor,
        safe: f.safe,
        signers: [signer(a), signer(b)],
        executor: new Uint8Array(31),
      }),
    ).toThrow(TypeError);
    expect(() => keySigner(new Uint8Array(31))).toThrow(TypeError);
    for (const key of [new Uint8Array(32), new Uint8Array(32).fill(0xff)]) {
      expect(() => keySigner(key)).toThrow(RangeError);
      expect(() => keySigner(key)).not.toThrow(/00|ff/i);
    }
    expect(getAddress(signer(a).address)).toBe(f.safe.owners[0]);
  });
});

describe("the runner's startup", () => {
  const runner = (f: Fixture, change: Partial<Parameters<typeof connectAnchorRunner>[1]> = {}) =>
    connectAnchorRunner(client, {
      chainId,
      anchor: f.anchor,
      clock: f.clock,
      safe: f.safe,
      ownerKeys: f.keys.slice(0, 2).map((k) => hexToBytes(k)),
      executorKey: f.executor,
      ...change,
    });

  test("passes the deployment record and anchors through the Safe", async () => {
    const f = await fixture();
    const chain = await runner(f);
    const id = election();
    await chain.anchor([segment(id, 0)], undefined);
    expect(await held(f, id, 0)).toBe(toHex(checkpointHash(segment(id, 0))));
    expect(await sent(f)).toBe(1);
    // Every owner key it holds, beyond the threshold too.
    await runner(f, { ownerKeys: f.keys.map((k) => hexToBytes(k)) });
  });

  test("refuses keys that can't sign for the Safe and any chain but a testnet, before reading anything", async () => {
    const f = await fixture();
    const [a, b] = f.keys.map((k) => hexToBytes(k)) as [Uint8Array, Uint8Array];
    const stranger = hexToBytes(generatePrivateKey());
    // A node that fails every request: each refusal comes before one is made.
    const unread = new Proxy({} as PublicClient, {
      get: () => () => Promise.reject(new Error("the node was read")),
    });
    const offline = (change: Partial<Parameters<typeof connectAnchorRunner>[1]>) =>
      connectAnchorRunner(unread, {
        chainId,
        anchor: f.anchor,
        clock: f.clock,
        safe: f.safe,
        ownerKeys: [a, b],
        executorKey: f.executor,
        ...change,
      });
    await expect(offline({ ownerKeys: [a] })).rejects.toThrow("fewer signers");
    await expect(offline({ ownerKeys: [a, stranger] })).rejects.toThrow("isn't one of");
    await expect(offline({ executorKey: new Uint8Array(32) })).rejects.toThrow(RangeError);
    // T-69 and rule A: one runner holds the whole threshold, so it runs
    // only where no real funds are.
    for (const id of [1n, 100n, 137n, 8453n, 17_000n])
      await expect(offline({ chainId: id })).rejects.toThrow("only on Sepolia or Anvil");
    await expect(offline({})).rejects.toThrow("the node was read");
  });

  test("refuses another chain, clock or authority than the anchor's", async () => {
    const f = await fixture();
    await expect(runner(f, { chainId: 11_155_111n })).rejects.toThrow("another chain");
    await expect(
      runner(f, { clock: { ...f.clock, deadline: f.clock.deadline + 1n } }),
    ).rejects.toThrow("another clock");
    const other = await fixture();
    await expect(
      runner(f, { safe: other.safe, ownerKeys: other.keys.map((k) => hexToBytes(k)) }),
    ).rejects.toThrow("another authority");
  });

  test("refuses a Safe changed since the record, before its first run", async () => {
    const f = await fixture();
    await as(f.safe.address, f.safe.address, encode("enableModule", [f.anchor]));
    await mine(FINALITY_DEPTH);
    await expect(runner(f)).rejects.toThrow("has a module");
    const g = await fixture();
    await expect(
      runner(g, {
        safe: { ...g.safe, threshold: 3n },
        ownerKeys: g.keys.map((k) => hexToBytes(k)),
      }),
    ).rejects.toThrow("another threshold");
    expect(await sent(f)).toBe(0);
  });
});
