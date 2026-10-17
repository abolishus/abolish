import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { boardAnchorAbi } from "@abolishus/contracts/abi";
import {
  type AnchorFinding,
  anchorBoards,
  appendEntry,
  readCheckpoints,
  readDefinition,
} from "@abolishus/core";
import { newElection, type TestDb, testDb } from "@abolishus/core/test-db";
import { checkpointHash, decodeElectionDefinition } from "@abolishus/crypto";
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
import { type AnchorDeployment, checkAnchorDeployment, ViemAnchorChain } from "../src/index.ts";

// The anchoring job's chain adapter against a real chain (P4-1 part 2b-1):
// Anvil runs the board anchor, the startup check refuses every mismatch,
// and core's anchorBoards, run through the adapter, anchors a stored board's
// checkpoints under the hashes a verifier reads (T-23, T-49). The authority
// is an address given code and impersonated on Anvil, standing in for the
// Safe, whose transactions are part 2b-2's (no key of ours is held here,
// AGENTS.md).

const ballot = (...body: number[]) => Uint8Array.of(0x00, 0x02, 1, ...body);
const bytes = (a: Address) => Uint8Array.from(Buffer.from(a.slice(2), "hex"));
const contractsRoot = fileURLToPath(new URL("../../../packages/contracts", import.meta.url));
// One slot per epoch: Anvil's finalized block is then the latest but two.
const FINALITY_DEPTH = 2;
const PERIOD = 3600n;
const DEADLINE = 43_200n;
// Code that isn't a single key's: STOP. The anchor needs only that the
// authority has code.
const AUTHORITY_CODE = "0x00";

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
let chainId: bigint;
let chain: ReturnType<typeof defineChain>;
let client: PublicClient;
let wallet: ReturnType<typeof createWalletClient>;
let accounts: Address[];
let bytecode: Hex;
let db: TestDb;
let app: Sql;
let nextAuthority = 0xa0c4000n;

beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
  // The chain the vector's definitions name, so its elections are served.
  const probe = await newElection(app);
  chainId = decodeElectionDefinition((await readDefinition(app, probe))!).l1_chain_id;
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
    id: Number(chainId),
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
    ["inspect", "--root", contractsRoot, "src/BoardAnchor.sol:BoardAnchor", "bytecode"],
    { encoding: "utf8" },
  ).trim() as Hex;
}, 120_000);

afterAll(async () => {
  await db?.close();
  if (anvil !== undefined && anvil.exitCode === null) {
    const exited = new Promise((r) => anvil.once("exit", r));
    anvil.kill("SIGTERM");
    await exited;
  }
});

// Polled directly: viem's waitForTransactionReceipt looks again only when
// the block number changes, and skips a change that lands during a look, so
// Anvil's one block for the transaction can leave it waiting for good.
const receiptOf = (hash: Hex) =>
  until("a receipt", 20_000, () => client.getTransactionReceipt({ hash }));

const rpc = (method: string, params: unknown[]) =>
  client.request({ method, params } as never) as Promise<unknown>;
const mine = (blocks: number) => rpc("anvil_mine", [toHex(blocks)]);

/** A fresh address with code, funded and impersonated, as the anchoring authority. */
async function newAuthority(): Promise<Address> {
  const authority = getAddress(toHex((nextAuthority += 1n), { size: 20 }));
  await rpc("anvil_setCode", [authority, AUTHORITY_CODE]);
  await rpc("anvil_setBalance", [authority, toHex(10n ** 20n)]);
  await rpc("anvil_impersonateAccount", [authority]);
  return authority;
}

/** A board anchor whose periods 0 and 1 have ended at the latest block, and its deployment. */
async function deployAnchor(): Promise<AnchorDeployment> {
  const latest = await client.getBlock({ blockTag: "latest" });
  const clock = { epoch: latest.timestamp - 2n * PERIOD - 60n, period: PERIOD, deadline: DEADLINE };
  const authority = await newAuthority();
  const hash = await wallet.deployContract({
    account: accounts[0] as Address,
    chain,
    abi: boardAnchorAbi,
    bytecode,
    args: [clock, authority],
  });
  const receipt = await receiptOf(hash);
  if (!receipt.contractAddress) throw new Error("BoardAnchor wasn't deployed");
  return { chainId, anchor: receipt.contractAddress, clock, authority };
}

/** Sends calldata to the anchor from the impersonated authority, as the Safe will. */
function sender(deployment: AnchorDeployment, sent: Hex[] = []) {
  return async (calldata: Uint8Array) => {
    const data = toHex(calldata);
    sent.push(data);
    const hash = await wallet.sendTransaction({
      account: deployment.authority,
      chain,
      to: deployment.anchor,
      data,
    });
    const receipt = await receiptOf(hash);
    if (receipt.status !== "success") throw new Error("the anchor call reverted");
  };
}

function adapter(
  deployment: AnchorDeployment,
  send: (calldata: Uint8Array) => Promise<void> = sender(deployment),
  through: PublicClient = client,
) {
  return new ViemAnchorChain({
    client: through,
    chainId: deployment.chainId,
    anchor: deployment.anchor,
    clock: deployment.clock,
    authority: deployment.authority,
    send,
  });
}

/** An election served by `anchor`, with entries in periods 0 and 1. */
async function board(anchor: Address): Promise<Uint8Array> {
  const id = await newElection(app, 5, bytes(anchor));
  await appendEntry(app, id, 0, ballot(0));
  await appendEntry(app, id, 1, ballot(1));
  await appendEntry(app, id, 1, ballot(2));
  return id;
}

/** A run's findings about `id`, or about no election: earlier tests' boards name other anchors. */
const about = (findings: readonly AnchorFinding[], id: Uint8Array) =>
  findings.filter((f) => f.electionId === undefined || toHex(f.electionId) === toHex(id));

const localNow = () => BigInt(Math.floor(Date.now() / 1000));

const held = (deployment: AnchorDeployment, electionId: Uint8Array, segment: number) =>
  client.readContract({
    address: deployment.anchor,
    abi: boardAnchorAbi,
    functionName: "checkpointHashOf",
    args: [toHex(electionId), segment],
  });

describe("the startup check", () => {
  test("passes the anchor's own clock and authority, and refuses each mismatch", async () => {
    const deployment = await deployAnchor();
    await mine(FINALITY_DEPTH);
    await expect(checkAnchorDeployment(client, deployment)).resolves.toBeUndefined();
    await expect(
      checkAnchorDeployment(client, { ...deployment, chainId: chainId + 1n }),
    ).rejects.toThrow("another chain");
    for (const clock of [
      { ...deployment.clock, epoch: deployment.clock.epoch + 1n },
      { ...deployment.clock, period: deployment.clock.period - 1n },
      { ...deployment.clock, deadline: deployment.clock.deadline + 1n },
    ])
      await expect(checkAnchorDeployment(client, { ...deployment, clock })).rejects.toThrow(
        "another clock",
      );
    await expect(
      checkAnchorDeployment(client, { ...deployment, authority: accounts[1] as Address }),
    ).rejects.toThrow("another authority");
    await expect(
      checkAnchorDeployment(client, { ...deployment, anchor: accounts[1] as Address }),
    ).rejects.toThrow("no anchor");
  });

  test("refuses an authority that is now a single key", async () => {
    const deployment = await deployAnchor();
    await mine(FINALITY_DEPTH);
    // An EIP-7702 delegation, then no code at all.
    for (const code of [`0xef0100${accounts[2]!.slice(2)}`, "0x"]) {
      await rpc("anvil_setCode", [deployment.authority, code]);
      await mine(FINALITY_DEPTH);
      await expect(checkAnchorDeployment(client, deployment)).rejects.toThrow("single key");
    }
  });

  test("judges the anchor's finalized state, not a deployment still unfinalized", async () => {
    const deployment = await deployAnchor();
    await expect(checkAnchorDeployment(client, deployment)).rejects.toThrow("no anchor");
    await mine(FINALITY_DEPTH);
    await expect(checkAnchorDeployment(client, deployment)).resolves.toBeUndefined();
  });
});

describe("the adapter", () => {
  test("anchors a stored board's checkpoints through core's run, under the verifier's hashes", async () => {
    const deployment = await deployAnchor();
    const id = await board(deployment.anchor);
    const sent: Hex[] = [];
    const reader = adapter(deployment, sender(deployment, sent));
    expect(reader.address).toEqual(bytes(deployment.anchor));

    const run = await anchorBoards(app, reader, localNow());
    expect(about(run.findings, id)).toEqual([]);
    const report = run.reports.find((r) => toHex(r.electionId) === toHex(id));
    expect(report).toEqual({ electionId: id, taken: [0, 1], anchored: [0, 1] });
    expect(sent).toHaveLength(1);
    const taken = await readCheckpoints(app, id);
    expect(taken.map((c) => c.segment)).toEqual([0, 1]);
    for (const c of taken) {
      expect(await held(deployment, id, c.segment)).toBe(toHex(checkpointHash(c)));
      expect(await reader.anchored(id, c.segment)).toBeUndefined();
    }
    // Judged at the pin until the next run's now().
    await reader.now();
    for (const c of taken) expect(await reader.anchored(id, c.segment)).toEqual(checkpointHash(c));
    expect(await reader.anchored(id, 2)).toBeUndefined();

    // Nothing more to send.
    const again = await anchorBoards(app, reader, localNow());
    expect(about(again.findings, id)).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  test("sends nothing the anchor would refuse", async () => {
    const deployment = await deployAnchor();
    const id = await board(deployment.anchor);
    await anchorBoards(app, adapter(deployment), localNow());
    const sent: Hex[] = [];
    const again = adapter(deployment, sender(deployment, sent));
    // A slot already filled reverts the simulation, before any signature.
    await expect(again.anchor(await readCheckpoints(app, id))).rejects.toThrow();
    // So does a checkpoint of an anchor whose authority is another account.
    const other = await deployAnchor();
    const stranger = adapter({ ...other, authority: accounts[3] as Address }, sender(other, sent));
    await expect(stranger.anchor(await readCheckpoints(app, id))).rejects.toThrow();
    expect(sent).toEqual([]);
    await expect(again.anchor([])).rejects.toThrow(RangeError);
  });

  test("fails a call whose sender resolved without the anchor holding it", async () => {
    const deployment = await deployAnchor();
    const id = await board(deployment.anchor);
    const run = await anchorBoards(
      app,
      adapter(deployment, async () => {}),
      localNow(),
    );
    expect(about(run.findings, id)).toEqual([{ code: "anchor-send-failed", electionId: id }]);
    expect(await held(deployment, id, 0)).toMatch(/^0x0{64}$/);
  });

  test("refuses bad arguments and clocks", async () => {
    const deployment = await deployAnchor();
    const reader = adapter(deployment);
    await expect(reader.anchored(new Uint8Array(31), 0)).rejects.toThrow(TypeError);
    for (const segment of [-1, 0.5, 2 ** 32])
      await expect(reader.anchored(new Uint8Array(32), segment)).rejects.toThrow(RangeError);
    for (const clock of [
      { ...deployment.clock, period: 0n },
      { ...deployment.clock, epoch: -1n },
      { ...deployment.clock, deadline: -1n },
    ])
      expect(() => adapter({ ...deployment, clock })).toThrow(RangeError);
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

describe("a node not to trust", () => {
  test("a node behind a block or a time already read is refused", async () => {
    const deployment = await deployAnchor();
    let behind = { number: 0n, timestamp: 0n };
    const reader = adapter(
      deployment,
      sender(deployment),
      nodeClient(async (method, params, forward) => {
        const result = await forward(params);
        if (method !== "eth_getBlockByNumber") return result;
        const block = result as { number: Hex; timestamp: Hex };
        return {
          ...block,
          number: toHex(BigInt(block.number) - behind.number),
          timestamp: toHex(BigInt(block.timestamp) - behind.timestamp),
        };
      }),
    );
    await reader.now();
    behind = { number: 1n, timestamp: 0n };
    await expect(reader.now()).rejects.toThrow("behind blocks already read");
    behind = { number: 0n, timestamp: 1n };
    await expect(reader.now()).rejects.toThrow("behind blocks already read");
    behind = { number: 0n, timestamp: 0n };
    await expect(reader.now()).resolves.toBeTypeOf("bigint");
  });

  test("a call the node reports as sent but whose slot it shows empty is a failure", async () => {
    const deployment = await deployAnchor();
    const id = await board(deployment.anchor);
    // The node answers every eth_call with an empty slot once the call is sent.
    let lying = false;
    const send = sender(deployment);
    const reader = adapter(
      deployment,
      async (calldata) => {
        await send(calldata);
        lying = true;
      },
      nodeClient(async (method, params, forward) =>
        lying && method === "eth_call" ? toHex(0n, { size: 32 }) : forward(params),
      ),
    );
    const run = await anchorBoards(app, reader, localNow());
    expect(about(run.findings, id)).toEqual([{ code: "anchor-send-failed", electionId: id }]);
  });
});
