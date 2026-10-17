import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { electionRegistryAbi, trusteeRegistryAbi } from "@abolishus/contracts/abi";
import {
  createPollDraft,
  newAccountId,
  type PollStubDeployment,
  type RegistrySyncReport,
  SETUP_SECONDS,
  submitPollDraft,
} from "@abolishus/core";
import { type TestDb, testDb } from "@abolishus/core/test-db";
import { decodeElectionDefinitionV5, tierTreeRoot } from "@abolishus/crypto";
import { Redis } from "ioredis";
import type { Sql } from "postgres";
import {
  type Abi,
  type Address,
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  type Hex,
  hexToBigInt,
  http,
  type PublicClient,
  toHex,
} from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  type LogLine,
  type PollStubConfig,
  pollStubDeployment,
  type PollStubPins,
  type RegistrySync,
  startWorker,
} from "../src/index.ts";

// The stub step's worker side (src/poll-stub-chain.ts; P2-22 part 4b): at
// startup every pin comes from one deployment, the registry sync's addresses
// as the election registry on Anvil holds them, with the anchor and relay
// read from it and the panel one the trustee registry pins; anything else
// refuses to start (T-25, T-34, T-37). Then the scheduled job moves a rooted
// poll to `ceremony` with a stub that carries exactly those pins.

const contractsRoot = fileURLToPath(new URL("../../../packages/contracts", import.meta.url));
const CHAIN_ID = 84_532n;
const L1_CHAIN_ID = 11_155_111n;
/** The OP Stack's L1Block predeploy, which the registry's constructor needn't read but its tests stub. */
const L1_BLOCK = "0x4200000000000000000000000000000000000015";
const NOW = new Date();
const NOW_S = BigInt(Math.floor(NOW.getTime() / 1000));
const redisUrl = process.env["REDIS_URL"];
if (!redisUrl) throw new Error("REDIS_URL is not set");

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const stand = (n: number) => getAddress(toHex(0xd0000 + n, { size: 20 }));

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

/** A made-up seat or receipt key: only the public point is used. */
function p256Key(): { encoded: Uint8Array; x: bigint; y: bigint } {
  const jwk = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({
    format: "jwk",
  });
  const xb = Buffer.from(jwk.x as string, "base64url");
  const x = hexToBigInt(toHex(xb));
  const y = hexToBigInt(toHex(Buffer.from(jwk.y as string, "base64url")));
  return { encoded: Uint8Array.from([2 + Number(y & 1n), ...xb]), x, y };
}

let anvil: ChildProcess;
let client: PublicClient;
let wallet: ReturnType<typeof createWalletClient>;
let chain: ReturnType<typeof defineChain>;
let deployer: Address;
let pins: PollStubPins;
let config: PollStubConfig;
let unpinned: PollStubConfig["panel"];
let db: TestDb;
let app: Sql;

const rpc = (method: string, params: unknown[]) =>
  client.request({ method, params } as never) as Promise<unknown>;
const forge = (target: string, field: "bytecode" | "deployedBytecode") =>
  execFileSync("forge", ["inspect", "--root", contractsRoot, target, field], {
    encoding: "utf8",
  }).trim() as Hex;

async function deploy(target: string, abi: Abi, args: readonly unknown[]): Promise<Address> {
  const hash = await wallet.deployContract({
    account: deployer,
    chain,
    abi,
    bytecode: forge(target, "bytecode"),
    args,
  } as never);
  const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 20 });
  if (!receipt.contractAddress) throw new Error(`${target} wasn't deployed`);
  return receipt.contractAddress;
}

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
  await rpc("anvil_setCode", [
    L1_BLOCK,
    forge("test/utils/MockL1Block.sol:MockL1Block", "deployedBytecode"),
  ]);
  const seats = [p256Key(), p256Key(), p256Key()];
  const panelInput = (threshold: number) => ({
    threshold,
    quorum: 3,
    keys: toHex(Buffer.concat(seats.map((s) => s.encoded))),
    points: seats.map((s) => [s.x, s.y]),
  });
  // Pinned at 3 of 3 only: the same seats at 2 of 3 are another panel.
  const trusteeRegistry = await deploy(
    "src/TrusteeRegistry.sol:TrusteeRegistry",
    trusteeRegistryAbi,
    [[panelInput(3)]],
  );
  const electionRegistry = await deploy(
    "src/ElectionRegistry.sol:ElectionRegistry",
    electionRegistryAbi,
    [
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
  );
  // Final at once: one slot per epoch, two blocks deep.
  await rpc("anvil_mine", [toHex(2)]);
  pins = {
    chainId: CHAIN_ID,
    l1ChainId: L1_CHAIN_ID,
    electionRegistry,
    board: stand(1),
    trusteeRegistry,
    groupRegistry: stand(3),
    eventVersion: 7,
  };
  config = {
    panel: { threshold: 3, keys: seats.map((s) => s.encoded) },
    receiptKeys: [p256Key().encoded, p256Key().encoded].sort((a, b) =>
      Buffer.from(a).compare(Buffer.from(b)),
    ),
    l1InclusionBound: 3600,
    sequencingWindow: 3600n,
    maxSequencerDrift: 1800n,
  };
  unpinned = { threshold: 2, keys: config.panel.keys };
}, 120_000);

afterAll(async () => {
  await db?.close();
  if (anvil !== undefined && anvil.exitCode === null) {
    const exited = new Promise((r) => anvil.once("exit", r));
    anvil.kill("SIGTERM");
    await exited;
  }
});

beforeEach(async () => {
  await db.admin`DELETE FROM account_polls`;
});

describe("the startup check", () => {
  test("takes the anchor and relay from the election registry, and the rest as configured", async () => {
    const d = await pollStubDeployment(client, pins, config);
    const bytes = (a: Address) => Uint8Array.from(Buffer.from(a.slice(2), "hex"));
    expect(d).toEqual({
      l2ChainId: CHAIN_ID,
      l1ChainId: L1_CHAIN_ID,
      electionRegistry: bytes(pins.electionRegistry),
      board: bytes(stand(1)),
      trusteeRegistry: bytes(pins.trusteeRegistry),
      groupRegistry: bytes(stand(3)),
      l1Anchor: bytes(stand(4)),
      l1Relay: bytes(stand(5)),
      ...config,
    } satisfies PollStubDeployment);
  });

  test("refuses another chain, another contract or L1, and another event version", async () => {
    for (const [over, message] of [
      [{ chainId: CHAIN_ID + 1n }, "another chain"],
      [{ board: stand(9) }, "another board"],
      [{ trusteeRegistry: stand(9) }, "another trustee registry"],
      [{ groupRegistry: stand(9) }, "another group registry"],
      [{ l1ChainId: 1n }, "another L1"],
      [{ eventVersion: 6 }, "another contract-event version"],
      // Code that isn't a registry, and no code at all.
      [{ electionRegistry: getAddress(L1_BLOCK) }, "isn't an election registry"],
      [{ electionRegistry: deployer }, "isn't an election registry"],
    ] as const)
      await expect(pollStubDeployment(client, { ...pins, ...over }, config)).rejects.toThrow(
        message,
      );
  });

  test("refuses a panel the trustee registry doesn't pin, at its threshold", async () => {
    await expect(pollStubDeployment(client, pins, { ...config, panel: unpinned })).rejects.toThrow(
      "doesn't pin the panel",
    );
    // A panel the rule refuses is refused before the registry is read.
    await expect(
      pollStubDeployment(client, pins, {
        ...config,
        panel: { threshold: 1, keys: config.panel.keys },
      }),
    ).rejects.toThrow("breaks its rule: panel");
  });

  test("refuses what the stub's rules refuse, naming the rule", async () => {
    const [a, b] = config.receiptKeys as [Uint8Array, Uint8Array];
    for (const [over, rule] of [
      [{ receiptKeys: [b, a] }, "receipt-keys"],
      [{ l1InclusionBound: 1 }, "sequencing"],
      [{ maxSequencerDrift: 1n << 40n }, "sequencing"],
    ] as const)
      await expect(pollStubDeployment(client, pins, { ...config, ...over })).rejects.toThrow(
        `breaks its rule: ${rule}`,
      );
  });
});

/** A registry sync with nothing to record: the stub step runs only beside one. */
const idleSync = {
  run: async (): Promise<RegistrySyncReport> => ({ recorded: 0, unstored: [] }),
} as unknown as RegistrySync;

/** A submitted poll moved through creation, the per-slot check and the roots. */
async function rooted(closesAt = NOW_S + 7n * 24n * 3600n): Promise<string> {
  const author = newAccountId();
  await app`
    INSERT INTO account_users VALUES (${author}, ${`${newAccountId()}@account.invalid`},
      false, '', NULL, now(), now())`;
  const submittedAt = new Date(NOW.getTime() - 3600_000);
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
      closesAt,
    },
    submittedAt,
  );
  await submitPollDraft(app, author, id, {
    turnstile: { verify: async () => "passed" as const },
    token: "t",
    now: submittedAt,
  });
  const electorate = [
    {
      tier: 0,
      rootL2Block: "1",
      groups: [{ groupId: "1", region: 0 }],
      regions: ["2"],
      cells: [{ root: tierTreeRoot([11n, 12n]).toString(), members: "2" }],
    },
  ];
  await db.admin`
    UPDATE account_polls SET state = 'rooted', creator_address = ${new Uint8Array(20).fill(0xc0)},
      create_tx_hash = ${randomBytes(32)}, election_id = ${randomBytes(32)}, created_block = 7,
      l1_origin_timestamp = 1, anchors_checked_block = 9,
      electorate = ${db.admin.json(electorate as never)}
    WHERE id = ${id}`;
  return id;
}

/** Runs the scheduled stub job once through a worker, with the clock at `NOW`. */
async function scheduledRun(deployment: PollStubDeployment) {
  const lines: LogLine[] = [];
  const prefix = `abolish-test-${hex(randomBytes(6))}`;
  const connection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
  const worker = await startWorker({
    connection,
    sql: app,
    log: (l) => lines.push(l),
    auditEveryMs: 3_600_000,
    prefix,
    now: () => NOW,
    registry: { sync: idleSync, everyMs: 3_600_000 },
    pollStubs: {
      deployment,
      everyMs: 3_600_000,
      clock: { anchor: new Uint8Array(20), epoch: 0n, period: 3600n },
    },
  });
  let keys: string[];
  try {
    for (let i = 0; i < 200 && !lines.some((l) => l.queue === "{poll-stub}" && "outcome" in l); i++)
      await new Promise((r) => setTimeout(r, 25));
    keys = await connection.keys(`${prefix}:{poll-stub}:*`);
  } finally {
    await worker.close();
    for (const key of await connection.keys(`${prefix}:*`)) await connection.del(key);
    connection.disconnect();
  }
  return { lines: lines.filter((l) => l.queue === "{poll-stub}"), keys };
}

describe("the stub job", () => {
  test("stubs a rooted poll under the checked deployment, logging counts only", async () => {
    const deployment = await pollStubDeployment(client, pins, config);
    const id = await rooted();
    const { lines, keys } = await scheduledRun(deployment);
    // Its queue's keys are under its own hash tag.
    expect(keys.length).toBeGreaterThan(0);
    expect(lines).toEqual([
      { queue: "{poll-stub}", stubbed: 1, failed: {} },
      { queue: "{poll-stub}", outcome: "completed", ms: expect.any(Number) },
    ]);
    const [poll] = await db.admin`SELECT state, stub_hash FROM account_polls WHERE id = ${id}`;
    expect(poll!["state"]).toBe("ceremony");
    const [row] = await db.admin`SELECT stub, opens_at FROM ceremony_stubs
      WHERE stub_hash = ${poll!["stub_hash"]}`;
    const stub = decodeElectionDefinitionV5(row!["stub"]);
    expect(stub.opens_at).toBe(NOW_S + BigInt(SETUP_SECONDS));
    const address = (b: Uint8Array) => getAddress(toHex(b));
    // The registry's own anchor and relay, and the sync's contracts.
    expect({
      l2: stub.l2_chain_id,
      l1: stub.l1_chain_id,
      electionRegistry: address(stub.election_registry),
      board: address(stub.board),
      trusteeRegistry: address(stub.trustee_registry),
      groupRegistry: address(stub.group_registry),
      l1Anchor: address(stub.l1_anchor),
      l1Relay: address(stub.l1_relay),
      threshold: stub.threshold,
      panelSize: stub.panel_size,
    }).toEqual({
      l2: CHAIN_ID,
      l1: L1_CHAIN_ID,
      electionRegistry: getAddress(pins.electionRegistry),
      board: stand(1),
      trusteeRegistry: getAddress(pins.trusteeRegistry),
      groupRegistry: stand(3),
      l1Anchor: stand(4),
      l1Relay: stand(5),
      threshold: 3,
      panelSize: 3,
    });
  });

  test("fails a poll that would close too soon, by count, and an idle run writes only its job line", async () => {
    const deployment = await pollStubDeployment(client, pins, config);
    const id = await rooted(NOW_S + BigInt(SETUP_SECONDS));
    expect((await scheduledRun(deployment)).lines).toEqual([
      { queue: "{poll-stub}", stubbed: 0, failed: { "closes-too-soon": 1 } },
      { queue: "{poll-stub}", outcome: "completed", ms: expect.any(Number) },
    ]);
    const [poll] = await db.admin`SELECT state, failure FROM account_polls WHERE id = ${id}`;
    expect(poll).toEqual({ state: "failed", failure: "closes-too-soon" });
    expect((await scheduledRun(deployment)).lines).toEqual([
      { queue: "{poll-stub}", outcome: "completed", ms: expect.any(Number) },
    ]);
  });
});
