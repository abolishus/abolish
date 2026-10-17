import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { boardAnchorAbi } from "@abolishus/contracts/abi";
import {
  checkCreationAnchors,
  createPollDraft,
  newAccountId,
  submitPollDraft,
} from "@abolishus/core";
import { type TestDb, testDb } from "@abolishus/core/test-db";
import { checkpointSlot } from "@abolishus/verifier";
import type { Sql } from "postgres";
import {
  type Address,
  bytesToHex,
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  type Hex,
  http,
  type PublicClient,
  toHex,
} from "viem";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { checkCreationAnchorsDeployment, headerRlp, ViemCreationAnchors } from "../src/index.ts";

// The per-slot check's L1 reader against a real chain (P2-22 part 3b-1):
// Anvil runs the board anchor, the startup check reads its clock and refuses
// a node or an address that isn't it, every word is proven against the
// finalized block's state root through the verifier's trie walk, and core's
// checkCreationAnchors, run through the reader, abandons an identifier with
// an anchor in its range and passes one without (T-69). A word is written
// into the anchor's storage directly: what the reader proves is the slot,
// whoever wrote it.

const contractsRoot = fileURLToPath(new URL("../../../packages/contracts", import.meta.url));
// One slot per epoch: Anvil's finalized block is then the latest but two.
const FINALITY_DEPTH = 2;
const CHAIN_ID = 11_155_111n;
const PERIOD = 3600n;
const NOW = new Date();
const NOW_S = BigInt(Math.floor(NOW.getTime() / 1000));
/** When the creation step saw a test's poll created: before Anvil's finalized block. */
const SEEN = new Date(NOW.getTime() - 3600_000);

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
let chain: ReturnType<typeof defineChain>;
let client: PublicClient;
let wallet: ReturnType<typeof createWalletClient>;
let accounts: Address[];
let bytecode: Hex;
let db: TestDb;
let app: Sql;

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

const rpc = (method: string, params: unknown[]) =>
  client.request({ method, params } as never) as Promise<unknown>;
const mine = (blocks: number) => rpc("anvil_mine", [toHex(blocks)]);

/** A board anchor whose periods 0 to 4 have ended at the latest block. */
async function deployAnchor(): Promise<{ anchor: Address; epoch: bigint }> {
  const latest = await client.getBlock({ blockTag: "latest" });
  const epoch = latest.timestamp - 5n * PERIOD - 60n;
  // Code that isn't a single key's, as the constructor requires of the authority.
  const authority = getAddress(toHex(0xa0c5000n, { size: 20 }));
  await rpc("anvil_setCode", [authority, "0x00"]);
  const hash = await wallet.deployContract({
    account: accounts[0] as Address,
    chain,
    abi: boardAnchorAbi,
    bytecode,
    args: [{ epoch, period: PERIOD, deadline: 43_200n }, authority],
  });
  // Polled directly: viem's wait can miss Anvil's one new block and hang.
  const receipt = await until("the deployment", 20_000, () =>
    client.getTransactionReceipt({ hash }),
  );
  if (!receipt.contractAddress) throw new Error("BoardAnchor wasn't deployed");
  // Final before any word is written, so each test's words land in later blocks.
  await mine(FINALITY_DEPTH + 1);
  return { anchor: receipt.contractAddress, epoch };
}

/** Writes a non-zero checkpoint word for the election's segment into the anchor's storage. */
async function setWord(anchor: Address, electionId: Uint8Array, segment: number, fill: number) {
  await rpc("anvil_setStorageAt", [
    anchor,
    bytesToHex(checkpointSlot(electionId, segment)),
    bytesToHex(new Uint8Array(32).fill(fill)),
  ]);
}

describe("the startup check", () => {
  test("reads the anchor's clock, and refuses another chain or an address with no anchor", async () => {
    const { anchor, epoch } = await deployAnchor();
    await mine(FINALITY_DEPTH);
    await expect(
      checkCreationAnchorsDeployment(client, { chainId: CHAIN_ID, anchor }),
    ).resolves.toEqual({
      epoch,
      period: PERIOD,
    });
    await expect(
      checkCreationAnchorsDeployment(client, { chainId: CHAIN_ID + 1n, anchor }),
    ).rejects.toThrow("another chain");
    await expect(
      checkCreationAnchorsDeployment(client, { chainId: CHAIN_ID, anchor: accounts[1] as Address }),
    ).rejects.toThrow("no anchor");
  });
});

describe("the reader", () => {
  test("proves each word at the finalized block, zero where nothing is stored", async () => {
    const { anchor, epoch } = await deployAnchor();
    const id = randomBytes(32);
    const other = randomBytes(32);
    await setWord(anchor, id, 2, 0xaa);
    await setWord(anchor, id, 140, 0xbb);
    await setWord(anchor, other, 3, 0xcc);
    await mine(FINALITY_DEPTH + 1);
    const reader = new ViemCreationAnchors({ client, anchor, clock: { epoch, period: PERIOD } });
    const block = await reader.finalized();
    const finalized = await client.getBlock({ blockTag: "finalized" });
    expect(block).toEqual({
      number: finalized.number,
      hash: Uint8Array.from(Buffer.from(finalized.hash.slice(2), "hex")),
      timestamp: finalized.timestamp,
    });
    const words = (segments: number[]) =>
      reader.words(block, id, segments).then((w) => w.map((x) => bytesToHex(x)));
    const zero = bytesToHex(new Uint8Array(32));
    expect(await words([1, 2, 3])).toEqual([zero, bytesToHex(new Uint8Array(32).fill(0xaa)), zero]);
    // More than one proof's worth of slots, in the order asked.
    const many = Array.from({ length: 150 }, (_, i) => i);
    const all = await words(many);
    expect(all.flatMap((w, s) => (w === zero ? [] : [s]))).toEqual([2, 140]);
    // A word written after the block isn't in its proof.
    await setWord(anchor, id, 3, 0xdd);
    await mine(FINALITY_DEPTH);
    expect(await words([3])).toEqual([zero]);
  });

  test("proves only against a block it read, and only a header that hashes to its block", async () => {
    const { anchor, epoch } = await deployAnchor();
    await mine(FINALITY_DEPTH);
    const reader = new ViemCreationAnchors({ client, anchor, clock: { epoch, period: PERIOD } });
    const block = await reader.finalized();
    await expect(
      reader.words({ ...block, hash: new Uint8Array(32) }, randomBytes(32), [1]),
    ).rejects.toThrow("wasn't read");
    const raw = (await rpc("eth_getBlockByNumber", ["finalized", false])) as {
      hash: Hex;
      [field: string]: unknown;
    };
    expect(headerRlp(raw)).toBeInstanceOf(Uint8Array);
    expect(() => headerRlp({ ...raw, stateRoot: `0x${"00".repeat(32)}` })).toThrow("doesn't hash");
  });
});

describe("the per-slot check through the reader", () => {
  test("abandons an identifier with an anchor in its range and passes one without", async () => {
    const { anchor, epoch } = await deployAnchor();
    const reader = new ViemCreationAnchors({ client, anchor, clock: { epoch, period: PERIOD } });
    // Both created with an origin in period 1, so periods 1 to 4 are read.
    const origin = epoch + PERIOD + 10n;
    const clear = await created(origin);
    const taken = await created(origin);
    await setWord(anchor, taken.election, 3, 0xaa);
    // Before `f`, and not counted.
    await setWord(anchor, clear.election, 0, 0xaa);
    await mine(FINALITY_DEPTH + 1);
    expect(await checkCreationAnchors(app, reader, { now: NOW })).toEqual({
      checked: 1,
      waiting: 0,
      abandoned: 1,
      overdue: 0,
      failed: 0,
    });
    const [a] =
      await db.admin`SELECT state, anchors_checked_block FROM account_polls WHERE id = ${clear.id}`;
    const [b] =
      await db.admin`SELECT state, abandoned_ids FROM account_polls WHERE id = ${taken.id}`;
    expect(a).toMatchObject({ state: "created" });
    expect(BigInt(a!["anchors_checked_block"] as string)).toBeGreaterThan(0n);
    expect(b).toMatchObject({ state: "submitted", abandoned_ids: 1 });
  });
});

/** A submitted poll moved to `created` as the creation step moves it, its origin at `origin`. */
async function created(origin: bigint): Promise<{ id: string; election: Uint8Array }> {
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
    turnstile: { verify: async () => "passed" as const },
    token: "t",
    now: NOW,
  });
  const election = randomBytes(32);
  await db.admin`
    UPDATE account_polls SET state = 'created', creator_address = ${new Uint8Array(20).fill(0xc0)},
      create_tx_hash = ${randomBytes(32)}, election_id = ${election}, created_block = 7,
      l1_origin_timestamp = ${origin.toString()}, updated_at = ${SEEN}
    WHERE id = ${id}`;
  return { id, election };
}
