import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { boardAnchorAbi } from "@abolishus/contracts/abi";
import { type Checkpoint, checkpointHash, encodeCheckpoint } from "@abolishus/crypto";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  encodeFunctionData,
  getAddress,
  type Hex,
  hexToBytes,
  http,
  keccak256,
  pad,
  parseAbi,
  type PublicClient,
  toHex,
  zeroAddress,
} from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  type AnchorSafe,
  checkAnchorSafe,
  FALLBACK_HANDLER_SLOT,
  GUARD_SLOT,
  keySigner,
  type SafeSigner,
  safeSender,
  ViemAnchorChain,
} from "../src/index.ts";

// The anchoring authority's Safe against a real one (P4-1 part 2b-2a): Safe
// v1.4.1, vendored in packages/contracts, deployed on Anvil through its
// proxy factory as the board anchor's authority. The check passes the
// deployment record's Safe and refuses each change that would let fewer
// than its threshold act as it; the sender anchors through the Safe with
// the threshold's signatures, and sends nothing for a changed Safe, too few
// honest signatures or a call that would revert (T-49, T-69). Every key
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
  singleton = await deploy(inspect("vendor/safe-smart-account/contracts/Safe.sol:Safe"));
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
  readonly executor: Uint8Array;
}

/** A `threshold`-of-`n` Safe, the anchor whose authority it is (periods 0 and 1 ended), and a funded executor. */
async function fixture(n = 3, threshold = 2n): Promise<Fixture> {
  const keys = Array.from({ length: n }, () => generatePrivateKey());
  const owners = keys.map((k) => privateKeyToAddress(k));
  const initializer = encode("setup", [
    owners,
    threshold,
    zeroAddress,
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
  await receiptOf(await wallet.writeContract({ ...request, chain }));
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
      proxyCodeHash: await codeHash(proxy),
      singleton,
      singletonCodeHash: await codeHash(singleton),
      owners,
      threshold,
      fallbackHandler: zeroAddress,
    },
    keys,
    anchor,
    executor: hexToBytes(executor),
  };
}

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
      [{ address: f.anchor }, "isn't the Safe's proxy"],
      [{ singleton: f.anchor }, "another singleton"],
      [{ singletonCodeHash: f.safe.proxyCodeHash }, "singleton has other code"],
      [{ fallbackHandler: f.anchor }, "another fallback handler"],
      [{ owners: other.owners }, "other owners"],
      [{ owners: [...f.safe.owners.slice(1), f.safe.owners[1]!] }, "other owners"],
      [{ threshold: 3n }, "another threshold"],
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

describe("the sender", () => {
  test("anchors through the Safe with the threshold's signatures", async () => {
    const f = await fixture();
    const id = election();
    const chain = adapter(f, sender(f));
    await chain.anchor([segment(id, 0)]);
    expect(await held(f, id, 0)).toBe(toHex(checkpointHash(segment(id, 0))));
    await chain.anchor([segment(id, 1)]);
    expect(await held(f, id, 1)).toBe(toHex(checkpointHash(segment(id, 1))));
    expect(await sent(f)).toBe(2);
  });

  test("sends nothing for a Safe changed since the record", async () => {
    const f = await fixture();
    const send = sender(f);
    await as(f.safe.address, f.safe.address, encode("enableModule", [f.anchor]));
    const id = election();
    await expect(adapter(f, send).anchor([segment(id, 0)])).rejects.toThrow("has a module");
    expect(await sent(f)).toBe(0);
    expect(await held(f, id, 0)).toMatch(/^0x0{64}$/);
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
      adapter(f, sender(f, [liar, signer(a), broken])).anchor([segment(id, 0)]),
    ).rejects.toThrow("too few owners signed");
    expect(await sent(f)).toBe(0);
    await adapter(f, sender(f, [liar, broken, signer(a), signer(c)])).anchor([segment(id, 0)]);
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
      adapter(f, sender(f, f.keys.map(signer), stripped)).anchor([segment(election(), 0)]),
    ).rejects.toThrow("didn't execute");
  });

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
    expect(getAddress(signer(a).address)).toBe(f.safe.owners[0]);
  });
});
