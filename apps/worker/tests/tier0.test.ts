import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { groupRegistryAbi, trusteeRegistryAbi } from "@abolishus/contracts/abi";
import {
  decodeGroupAddition,
  encodeGroupAddition,
  encodeSelfPaidAddition,
  groupAdditionDigest,
  groupRegistryDomainSeparator,
  POSEIDON2_ZERO_ONE,
  signGroupApproval,
} from "@abolishus/crypto";
import {
  commitmentKey,
  MIN_REGISTRATION_BATCH,
  REGISTRATION_PERIOD,
  Tier0Batches,
  tier0Keys,
} from "@abolishus/core";
import { testDb, type TestDb } from "@abolishus/core/test-db";
import { Redis } from "ioredis";
import type { Sql } from "postgres";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  getAddress,
  type Hex,
  http,
  type PublicClient,
  toHex,
} from "viem";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  checkTier0Deployment,
  type LogLine,
  QUEUES,
  type RunningWorker,
  startWorker,
  TIER0_QUEUES,
  ViemTier0Chain,
} from "../src/index.ts";
import { TIER2_INITIAL_PANEL, TIER2_PANELS } from "./tier2-scope.ts";

// The Tier 0 batch job against a real chain (P3-2 part 4d-2b): Anvil runs the
// group registry pinned to the vectors' registrars, the adapter reads it at
// pinned finalized and latest blocks, the startup check refuses every
// mismatch, and the worker's scheduled jobs keep the index and sign, submit
// and finish a batch that the registry accepts (T-06, T-13). Records reach
// `addMembers` from one of Anvil's unlocked development accounts here, so
// these tests judge the job's reads and timing alone; the paymaster's path
// through EntryPoint v0.8 is tests/tier0-bundler.test.ts's (no key of ours is
// held here, AGENTS.md; the registrar keys are the published vectors').

const redisUrl = process.env["REDIS_URL"];
if (!redisUrl) throw new Error("REDIS_URL is not set");

interface RegistrarVectors {
  readonly threshold: number;
  readonly secretKeys: readonly string[];
  readonly addresses: readonly string[];
  readonly outsiderSecretKey: string;
}
const vectors = JSON.parse(
  readFileSync(new URL("../../../docs/spec/vectors/group-registry.json", import.meta.url), "utf8"),
) as { registrars: RegistrarVectors };
const bytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const REGISTRARS = vectors.registrars.addresses.map((a) => getAddress(`0x${a}`));
const SECRETS = vectors.registrars.secretKeys.map(bytes);
const THRESHOLD = vectors.registrars.threshold;
const SIGNERS = [
  { seat: 1, secretKey: SECRETS[0] as Uint8Array },
  { seat: 3, secretKey: SECRETS[2] as Uint8Array },
];

const contractsRoot = fileURLToPath(new URL("../../../packages/contracts", import.meta.url));
const chainId = 1_000_000 + Math.floor(Math.random() * 1_000_000_000);
// One slot per epoch: Anvil's finalized block is then the latest but two.
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

let anvil: ChildProcess;
let rpcUrl: string;
let chain: ReturnType<typeof defineChain>;
let client: PublicClient;
let wallet: ReturnType<typeof createWalletClient>;
let accounts: Address[];
let bytecode: Hex;
let trustees: Address;
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
  // The trustee registry pinning the Tier 2 scope's initial panel, which
  // every group registry's deployment requires.
  const pinned = await client.waitForTransactionReceipt({
    hash: await wallet.deployContract({
      account: accounts[0] as Address,
      chain,
      abi: trusteeRegistryAbi,
      bytecode: execFileSync(
        "forge",
        ["inspect", "--root", contractsRoot, "src/TrusteeRegistry.sol:TrusteeRegistry", "bytecode"],
        { encoding: "utf8" },
      ).trim() as Hex,
      args: [TIER2_PANELS],
    }),
    pollingInterval: 20,
  });
  if (!pinned.contractAddress) throw new Error("TrusteeRegistry wasn't deployed");
  trustees = pinned.contractAddress;
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

async function mine(blocks: number) {
  await client.request({ method: "anvil_mine", params: [toHex(blocks)] } as never);
}

async function deployRegistry(): Promise<{ registry: Address; fromBlock: bigint }> {
  const hash = await wallet.deployContract({
    account: accounts[0] as Address,
    chain,
    abi: groupRegistryAbi,
    bytecode,
    args: [THRESHOLD, REGISTRARS, trustees, TIER2_INITIAL_PANEL],
  });
  const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 20 });
  if (!receipt.contractAddress) throw new Error("GroupRegistry wasn't deployed");
  return { registry: receipt.contractAddress, fromBlock: receipt.blockNumber };
}

/** Resolves with the block that included the call. */
async function send(
  registry: Address,
  functionName: "createGroup" | "addMembers" | "createSelfPaidGroup" | "addSelfPaidMember",
  arg?: unknown,
): Promise<bigint> {
  const hash = await wallet.writeContract({
    account: accounts[5] as Address,
    chain,
    address: registry,
    abi: groupRegistryAbi,
    functionName,
    args: arg === undefined ? [] : [arg],
    // The registry's fixed fee for a self-paid addition.
    ...(functionName === "addSelfPaidMember" ? { value: SELF_PAID_FEE } : {}),
  } as unknown as Parameters<typeof wallet.writeContract>[0]);
  const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 20 });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
  return receipt.blockNumber;
}

/** Distinct allowed commitments, fresh for each call. */
let nextCommitment = BigInt(`0x${randomBytes(8).toString("hex")}`) << 64n;
const cmp = (x: bigint, y: bigint) => (x < y ? -1 : x > y ? 1 : 0);
const commitments = (n: number) => Array.from({ length: n }, () => (nextCommitment += 7919n));

/** A record signed by the vectors' registrars, as the job would sign it. */
/** The registry's fee for one self-paid addition, in wei (GroupRegistryLib.SELF_PAID_FEE). */
const SELF_PAID_FEE = 2n * 10n ** 14n;

/** An `addSelfPaidMember` record of one commitment. */
function selfPaidRecord(groupId: bigint, commitment: bigint) {
  return toHex(encodeSelfPaidAddition({ groupId, commitment }));
}

function signedRecord(
  registry: Address,
  groupId: bigint,
  firstIndex: bigint,
  values: bigint[],
): Hex {
  const digest = groupAdditionDigest(
    groupRegistryDomainSeparator(BigInt(chainId), bytes(registry.slice(2))),
    { groupId, tier: 0, firstIndex, commitments: values },
  );
  const approvals = SIGNERS.map((s) => signGroupApproval(digest, s.seat, s.secretKey));
  return toHex(encodeGroupAddition({ groupId, firstIndex, commitments: values, approvals }));
}

function adapter(registry: Address, fromBlock: bigint, logRange?: bigint) {
  const submitted: Uint8Array[] = [];
  const chainReader = new ViemTier0Chain({
    client,
    registry,
    fromBlock,
    ...(logRange === undefined ? {} : { logRange }),
    submit: async (record) => {
      submitted.push(record);
      await send(registry, "addMembers", toHex(record));
    },
  });
  return { chain: chainReader, submitted };
}

describe("the startup check", () => {
  test("passes the registry's own registrars, threshold and keys, and refuses each mismatch", async () => {
    const { registry, fromBlock } = await deployRegistry();
    await mine(FINALITY_DEPTH);
    const deployment = {
      chainId: BigInt(chainId),
      registry,
      fromBlock,
      registrars: REGISTRARS,
      threshold: THRESHOLD,
      signers: SIGNERS,
    };
    await expect(checkTier0Deployment(client, deployment)).resolves.toBeUndefined();
    await expect(
      checkTier0Deployment(client, { ...deployment, chainId: BigInt(chainId) + 1n }),
    ).rejects.toThrow("another chain");
    await expect(
      checkTier0Deployment(client, { ...deployment, registrars: REGISTRARS.slice(0, 2) }),
    ).rejects.toThrow("other registrars");
    await expect(
      checkTier0Deployment(client, { ...deployment, threshold: THRESHOLD + 1 }),
    ).rejects.toThrow("another threshold");
    // A later fromBlock would leave the deployment's logs out of the index;
    // an earlier one isn't where the registry was deployed.
    for (const at of [fromBlock + 1n, fromBlock - 1n])
      await expect(checkTier0Deployment(client, { ...deployment, fromBlock: at })).rejects.toThrow(
        "deployment block",
      );
    // Seat 2's key put at seat 3, and the vectors' outsider at seat 1.
    await expect(
      checkTier0Deployment(client, {
        ...deployment,
        signers: [SIGNERS[0], { seat: 3, secretKey: SECRETS[1] as Uint8Array }] as never,
      }),
    ).rejects.toThrow("seat 3");
    await expect(
      checkTier0Deployment(client, {
        ...deployment,
        signers: [{ seat: 1, secretKey: bytes(vectors.registrars.outsiderSecretKey) }],
      }),
    ).rejects.toThrow("seat 1");
    // No key in the message, a key out of secp256k1's range included.
    const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    for (const secretKey of [
      SECRETS[0] as Uint8Array,
      new Uint8Array(32),
      new Uint8Array(32).fill(0xff),
      bytes((order + 5n).toString(16)),
    ]) {
      const error = await checkTier0Deployment(client, {
        ...deployment,
        signers: [{ seat: secretKey === SECRETS[0] ? 4 : 1, secretKey }],
      }).catch((e: unknown) => e);
      expect(String(error)).toMatch(/the key for seat \d isn't that seat's registrar/);
      const hexKey = Buffer.from(secretKey).toString("hex");
      expect(String(error)).not.toContain(hexKey);
      expect(String(error)).not.toContain(BigInt(`0x${hexKey}`).toString());
    }
  });

  test("judges the registry's finalized state, not a deployment still unfinalized", async () => {
    const { registry, fromBlock } = await deployRegistry();
    await expect(
      checkTier0Deployment(client, {
        chainId: BigInt(chainId),
        registry,
        fromBlock,
        registrars: REGISTRARS,
        threshold: THRESHOLD,
        signers: SIGNERS,
      }),
    ).rejects.toThrow();
    await mine(FINALITY_DEPTH);
  });
});

describe("the adapter", () => {
  test("reads a group's tier and counts, final and latest, at one pinned block pair", async () => {
    const { registry, fromBlock } = await deployRegistry();
    await send(registry, "createGroup", 0);
    const { chain: reader } = adapter(registry, fromBlock);
    // Created but not final: no tier to sign under yet.
    await expect(reader.group(0n)).rejects.toThrow("isn't final");
    await mine(FINALITY_DEPTH);
    expect(await reader.group(0n)).toEqual({ tier: 0, finalizedSize: 0n, latestSize: 0n });

    const first = commitments(3);
    const addedAt = await send(registry, "addMembers", signedRecord(registry, 0n, 0n, first));
    const unfinal = await reader.group(0n);
    expect(unfinal).toEqual({ tier: 0, finalizedSize: 0n, latestSize: 3n });
    expect(await reader.additionAt(0n, 0n)).toMatchObject({ final: false });

    // Pinned: blocks mined after group() don't change what additionAt judges.
    await mine(FINALITY_DEPTH);
    expect(await reader.additionAt(0n, 0n)).toMatchObject({ final: false });
    expect(await reader.group(0n)).toEqual({ tier: 0, finalizedSize: 3n, latestSize: 3n });
    const logged = await reader.additionAt(0n, 0n);
    expect(logged?.final).toBe(true);
    // The block that logged it, for the index's floor once it is finished.
    expect(logged?.block).toBe(addedAt);
    expect(toHex(logged?.record as Uint8Array)).toBe(signedRecord(registry, 0n, 0n, first));
    expect(await reader.additionAt(0n, 3n)).toBeNull();
    // A group that was never created has no final creation.
    await expect(reader.group(9n)).rejects.toThrow("isn't final");
  });

  test("lists every Tier 0 commitment, signed and self-paid, up to the latest block, the same at any log range", async () => {
    const { registry, fromBlock } = await deployRegistry();
    await send(registry, "createGroup", 0);
    await send(registry, "createGroup", 0);
    await send(registry, "createSelfPaidGroup");
    const a = commitments(4);
    const b = commitments(2);
    const c = commitments(5);
    const paid = commitments(2);
    await send(registry, "addMembers", signedRecord(registry, 0n, 0n, a));
    await send(registry, "addSelfPaidMember", selfPaidRecord(2n, paid[0] as bigint));
    await send(registry, "addMembers", signedRecord(registry, 1n, 0n, b));
    await send(registry, "addMembers", signedRecord(registry, 0n, 4n, c));
    await send(registry, "addSelfPaidMember", selfPaidRecord(2n, paid[1] as bigint));
    const expected = [...a, ...b, ...c, ...paid].sort(cmp);
    for (const range of [undefined, 1n, 2n, 3n]) {
      const { chain: reader } = adapter(registry, fromBlock, range);
      const read = await reader.tier0Commitments();
      expect([...read.commitments].sort(cmp)).toEqual(expected);
      // At the node's latest block when the read began.
      expect(read.block).toBe(await client.getBlockNumber({ cacheTime: 0 }));
    }
  });

  test("refuses an empty log range", () => {
    expect(
      () =>
        new ViemTier0Chain({
          client,
          registry: REGISTRARS[0] as Address,
          fromBlock: 0n,
          logRange: 0n,
          submit: async () => {},
        }),
    ).toThrow(RangeError);
  });
});

type Forward = (params: unknown[]) => Promise<unknown>;
type Hook = (method: string, params: unknown[], forward: Forward) => Promise<unknown>;

/** A client of the Anvil node through `hook`, which may change any request or answer: a node not to trust. */
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
      const answer = (await response.json()) as { result?: unknown; error?: { message: string } };
      if (answer.error !== undefined) throw new Error(answer.error.message);
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

const word = (n: bigint) => toHex(n, { size: 32 });

describe("a node not to trust", () => {
  // One group with one final addition of three at position 0.
  let registry: Address;
  let fromBlock: bigint;
  beforeAll(async () => {
    ({ registry, fromBlock } = await deployRegistry());
    await send(registry, "createGroup", 0);
    await send(registry, "addMembers", signedRecord(registry, 0n, 0n, commitments(3)));
    await mine(FINALITY_DEPTH);
  });
  const reader = (hook: Hook, logRange?: bigint) =>
    new ViemTier0Chain({
      client: nodeClient(hook),
      registry,
      fromBlock,
      ...(logRange === undefined ? {} : { logRange }),
      submit: async () => {},
    });
  const honest: Hook = (_method, params, forward) => forward(params);

  test("an honest node through the same client reads as Anvil", async () => {
    const r = reader(honest);
    expect(await r.group(0n)).toEqual({ tier: 0, finalizedSize: 3n, latestSize: 3n });
    expect(await r.additionAt(0n, 0n)).toMatchObject({ final: true });
    expect([...(await r.tier0Commitments()).commitments]).toHaveLength(3);
  });

  test("a finalized block above the latest is refused", async () => {
    const r = reader(async (method, params, forward) => {
      const result = (await forward(params)) as { number: Hex };
      if (method !== "eth_getBlockByNumber" || params[0] !== "finalized") return result;
      return { ...result, number: toHex(BigInt(result.number) + 100n) };
    });
    await expect(r.group(0n)).rejects.toThrow("finalized block leads");
  });

  test("a node behind blocks already read is refused", async () => {
    let behind = 0n;
    const r = reader(async (method, params, forward) => {
      const result = await forward(params);
      if (method === "eth_blockNumber") return toHex(BigInt(result as Hex) - behind);
      if (method === "eth_getBlockByNumber") {
        const block = result as { number: Hex };
        return { ...block, number: toHex(BigInt(block.number) - behind) };
      }
      return result;
    });
    await r.tier0Commitments();
    await r.group(0n);
    behind = 1n;
    await expect(r.tier0Commitments()).rejects.toThrow("behind blocks already read");
    await expect(r.group(0n)).rejects.toThrow("behind blocks already read");
  });

  test("a groupOf that disagrees with the group's creation log is refused", async () => {
    const r = reader(async (method, params, forward) => {
      const result = (await forward(params)) as Hex;
      // groupOf's (tier, exists, memberCount), with exists cleared.
      if (method !== "eth_call") return result;
      return `0x${result.slice(2, 66)}${word(0n).slice(2)}${result.slice(130)}` as Hex;
    });
    await expect(r.group(0n)).rejects.toThrow("reads disagree");
  });

  test("two additions at one position are refused", async () => {
    const r = reader(async (method, params, forward) => {
      const result = await forward(params);
      // Only the position's query, which alone names a third topic.
      const filter = params[0] as { topics?: (Hex | null)[] } | undefined;
      const atPosition = method === "eth_getLogs" && typeof filter?.topics?.[2] === "string";
      return atPosition ? [...(result as unknown[]), ...(result as unknown[])] : result;
    });
    await r.group(0n);
    await expect(r.additionAt(0n, 0n)).rejects.toThrow("two additions at one position");
  });

  test("an addition answered for another position is refused", async () => {
    // Asked for position 3, the node answers with the addition at 0.
    const r = reader(async (method, params, forward) => {
      if (method !== "eth_getLogs") return forward(params);
      const filter = params[0] as { topics: (Hex | null)[] };
      const asked = filter.topics[2];
      if (asked === null || asked === undefined) return forward(params);
      const topics = filter.topics.map((t, i) => (i === 2 ? word(0n) : t));
      // Relabelled with the position asked for, as viem filters by topic.
      const logs = (await forward([{ ...filter, topics }])) as { topics: Hex[] }[];
      return logs.map((l) => ({ ...l, topics: l.topics.map((t, i) => (i === 2 ? asked : t)) }));
    });
    await r.group(0n);
    await expect(r.additionAt(0n, 3n)).rejects.toThrow("another position");
  });

  test("logs from outside the asked range, or pending, are refused", async () => {
    // Each one-block query answered with every log of the registry.
    const wide = reader(async (method, params, forward) => {
      if (method !== "eth_getLogs") return forward(params);
      const filter = params[0] as Record<string, unknown>;
      return forward([{ ...filter, fromBlock: toHex(fromBlock), toBlock: "latest" }]);
    }, 1n);
    await expect(wide.tier0Commitments()).rejects.toThrow("outside the asked range");
    const pending = reader(async (method, params, forward) => {
      const result = await forward(params);
      if (method !== "eth_getLogs") return result;
      return (result as Record<string, unknown>[]).map((l) => ({ ...l, blockNumber: null }));
    });
    await expect(pending.tier0Commitments()).rejects.toThrow("outside the asked range");
  });
});

describe("the worker's Tier 0 jobs", () => {
  test("keep the index and sign, submit and finish a batch the registry accepts", async () => {
    const { registry, fromBlock } = await deployRegistry();
    await send(registry, "createGroup", 0);
    await mine(FINALITY_DEPTH);
    const already = commitments(2);
    await send(registry, "addMembers", signedRecord(registry, 0n, 0n, already));
    await mine(FINALITY_DEPTH);

    const prefix = `abolish-test-${randomBytes(6).toString("hex")}`;
    const keys = tier0Keys(prefix);
    let clock = 1_800_000_000;
    const { chain: reader, submitted } = adapter(registry, fromBlock);
    const batches = new Tier0Batches({
      redis,
      chain: reader,
      groups: new Map([[0, 0n]]),
      chainId: BigInt(chainId),
      registry: bytes(registry.slice(2)),
      registrars: REGISTRARS.map((r) => bytes(r.slice(2))),
      threshold: THRESHOLD,
      signers: SIGNERS,
      now: () => clock,
      prefix,
    });
    const lines: LogLine[] = [];
    const worker: RunningWorker = await startWorker({
      connection: redis,
      sql: app,
      log: (l) => lines.push(l),
      auditEveryMs: 3_600_000,
      prefix,
      tier0: { batches, indexEveryMs: 100, boundaryEveryMs: 100 },
    });
    try {
      // The index catches up with what is already on chain.
      await until("the index", 20_000, async () =>
        (await redis.sismember(keys.live, commitmentKey(already[0] as bigint))) === 1
          ? true
          : undefined,
      );

      // Queued as the route queues (core's script), plus one already live.
      const queued = [...commitments(MIN_REGISTRATION_BATCH), already[0] as bigint];
      for (const v of queued) {
        await redis.hset(keys.queue, commitmentKey(v), "0");
        await redis.hincrby(keys.sizes, "0", 1);
      }
      clock += REGISTRATION_PERIOD;
      const signed = await until("a signed batch", 20_000, async () =>
        lines.find(
          (l) => "outcome" in l && l.queue === "{tier0-boundary}" && l.outcome === "signed",
        ),
      );
      expect(signed).toEqual({
        queue: "{tier0-boundary}",
        group: "0",
        outcome: "signed",
        abandoned: false,
        submitFailed: false,
      });
      expect(submitted).toHaveLength(1);
      const record = decodeGroupAddition(submitted[0] as Uint8Array);
      if (!record.ok) throw new Error("undecodable");
      // At the group's count, sorted, without the live one.
      expect(record.value.firstIndex).toBe(2n);
      expect(record.value.commitments).toEqual(queued.slice(0, MIN_REGISTRATION_BATCH).sort(cmp));
      const [, , count] = await client.readContract({
        address: registry,
        abi: groupRegistryAbi,
        functionName: "groupOf",
        args: [0n],
      });
      expect(count).toBe(2n + BigInt(MIN_REGISTRATION_BATCH));

      // Not final: the next boundary waits; once final, it finishes the batch.
      clock += REGISTRATION_PERIOD;
      await until("a waiting boundary", 20_000, async () =>
        lines.find((l) => "outcome" in l && l.outcome === "waiting"),
      );
      expect(await redis.hexists(keys.batches, "0")).toBe(1);
      await mine(FINALITY_DEPTH);
      clock += REGISTRATION_PERIOD;
      await until("the batch finished", 20_000, async () =>
        (await redis.hexists(keys.batches, "0")) === 0 ? true : undefined,
      );
      expect(await redis.smembers(keys.inflight)).toEqual([]);
      expect(await redis.hgetall(keys.queue)).toEqual({});
      // The boundary refreshes the index after it finishes the batch.
      await until("the batch in the index", 20_000, async () => {
        for (const v of record.value.commitments)
          if ((await redis.sismember(keys.live, commitmentKey(v))) !== 1) return undefined;
        return true;
      });
      expect(submitted).toHaveLength(1);

      // T-10, T-13: no log line names a commitment or a record.
      const text = JSON.stringify(lines);
      for (const v of queued) expect(text).not.toContain(commitmentKey(v));
      expect(text).not.toContain(Buffer.from(submitted[0] as Uint8Array).toString("hex"));
      expect(text).not.toContain(commitmentKey(POSEIDON2_ZERO_ONE));
      // Every key under a queue's hash tag or the registration's.
      const tags = [
        ...Object.values(QUEUES).map((q) => `${prefix}:${q.name}:`),
        `${prefix}:{tier0-registration}:`,
      ];
      for (const k of TIER0_QUEUES)
        expect((await redis.keys(`${prefix}:${QUEUES[k].name}:*`)).length).toBeGreaterThan(0);
      for (const key of await redis.keys(`${prefix}:*`))
        expect(
          tags.some((t) => key.startsWith(t)),
          key,
        ).toBe(true);
    } finally {
      await worker.close();
      const left = await redis.keys(`${prefix}:*`);
      if (left.length > 0) await redis.del(...left);
    }
  }, 90_000);
});
