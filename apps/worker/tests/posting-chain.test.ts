import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { boardAbi } from "@abolishus/contracts/abi";
import { decodeSharePosting } from "@abolishus/crypto";
import {
  BallotAdmissions,
  parsePostingIndex,
  parsePostingOutcome,
  POSTING_GAS_LIMIT_MAX,
  postingCalldataLength,
  postingGasLimit,
  PostgresPostingDeposits,
  PostgresPostingElections,
  PostgresPostingLedger,
  postingKey,
  postingKeys,
  postingPairValue,
  PostingWorker,
} from "@abolishus/core";
import { type TestDb, testDb } from "@abolishus/core/test-db";
import { Redis } from "ioredis";
import { randomBytes } from "node:crypto";
import {
  type Address,
  BaseError,
  bytesToHex,
  createPublicClient,
  createWalletClient,
  custom,
  decodeFunctionData,
  defineChain,
  getAddress,
  type Hex,
  http,
  keccak256,
  parseTransaction,
  type PublicClient,
  recoverTransactionAddress,
  toBytes,
  toFunctionSelector,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  checkPostingDeployment,
  type LogLine,
  postingDepositChain,
  PostingChainError,
  type PostingChainOptions,
  startPostingRunner,
  ViemPostingChain,
  ViemPostingL1,
  ViemPostingRegistry,
} from "../src/index.ts";

// The posting relay's chain adapter against a real chain (P2-8 part
// 2b-2b-2b-2b-1; docs/spec/posting-relay.md, Sending, In flight and
// Pruning): Anvil runs a stand-in board that emits `SharePosted` for the
// posting of any call, as the board does for one that passes its checks,
// so the adapter's reads are judged against real logs, reorganisations and
// finality; the board's own checks are packages/contracts' to test. Calls
// are simulated within the gas cap, signed for the board at the asked nonce
// with fees within the cap, broadcast and found in blocks with their costs;
// a posting is found on the board exactly, at the latest and the finalized
// head, and a node's answer that strays from the filter is refused (T-25,
// T-52). The posting key is a fresh random one funded on Anvil (AGENTS.md:
// no real key here).

const chainId = 1_000_000 + Math.floor(Math.random() * 1_000_000_000);
// One slot per epoch: Anvil's finalized block is then the latest but two.
const FINALITY_DEPTH = 2;
const CAP = 50_000_000_000n;

const GAS_PRICE_ORACLE = "0x420000000000000000000000000000000000000F";
/** The stand-in oracle's answer to every call. */
const ORACLE_FEE = 10n ** 12n;
const ORACLE_CODE = `0x7f${ORACLE_FEE.toString(16).padStart(64, "0")}60005260206000f3` as Hex;

const SHARE_POSTED = keccak256(toBytes("SharePosted(bytes32,bytes32,bytes)")).slice(2);
/**
 * A stand-in board: for any call, `SharePosted(definition_hash, ballot_hash,
 * posting)` with the posting of `submitPosting`'s canonical calldata, its
 * topics read from the record (header, then the two hashes), its data
 * `abi.encode(posting)` copied from the calldata's length word on.
 */
const BOARD_CODE = `0x${[
  "60205f52", // mem[0] = 0x20
  "604435601f01601f191660200180", // size = 32 + ⌈len/32⌉·32, twice
  "6044602037", // calldatacopy(0x20, 0x44, size)
  "608735", // ballot_hash
  "606735", // definition_hash
  `7f${SHARE_POSTED}`,
  "8360200160", // size + 32
  "00a300", // log3 from 0, stop
].join("")}` as Hex;
/** A board whose every call reverts. */
const REVERTING_CODE = "0x5f5ffd" as Hex;
/** A board whose every call runs out of gas, however much it is given. */
const LOOPING_CODE = "0x5b5f56" as Hex;

const delivery = JSON.parse(
  readFileSync(new URL("../../../docs/spec/vectors/delivery.json", import.meta.url), "utf8"),
) as { records: { id: string; encoding: string }[] };
const vectorPosting = Uint8Array.from(
  Buffer.from(delivery.records.find((r) => r.id === "posting")?.encoding as string, "hex"),
);
// A version-1 posting's `m` follows its header, the two hashes and the seat.
const M_AT = 3 + 32 + 32 + 1;
let made = 0;
/** A posting of the vector's election and ballot that no other test made: its `m` changed. */
function freshPosting(): Uint8Array {
  const p = vectorPosting.slice();
  new DataView(p.buffer).setUint32(M_AT, ++made);
  decodeSharePosting(p, 1);
  return p;
}
const BALLOT = Uint8Array.from({ length: 77 }, (_, i) => i);
/** A panel the verifier's vectors pin, for the admission the worker judges by. */
const PANEL = (() => {
  const file = JSON.parse(
    readFileSync(
      new URL("../../../docs/spec/vectors/verifier-ballots.json", import.meta.url),
      "utf8",
    ),
  ) as { panels: Record<string, { threshold: string; keys: string[] }> };
  const p = file.panels["panel-4"] as { threshold: string; keys: string[] };
  return {
    threshold: Number(p.threshold),
    keys: p.keys.map((k) => Uint8Array.from(Buffer.from(k, "hex"))),
  };
})();

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
let rpcUrl: string;
let client: PublicClient;
let wallet: ReturnType<typeof createWalletClient>;
let chain: ReturnType<typeof defineChain>;
let accounts: Address[];

const rpc = (method: string, params: unknown[]) =>
  client.request({ method, params } as never) as Promise<unknown>;
const mine = (blocks: number) => rpc("anvil_mine", [toHex(blocks)]);
const automine = (on: boolean) => rpc("evm_setAutomine", [on]);

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
  // No cached block number: the tests mine and read straight after.
  client = createPublicClient({ chain, transport: http(rpcUrl), cacheTime: 0 }) as PublicClient;
  wallet = createWalletClient({ chain, transport: http(rpcUrl) });
  const end = Date.now() + 20_000;
  for (;;) {
    if (anvil.exitCode !== null) throw new Error("anvil exited (is the toolchain installed?)");
    try {
      accounts = await wallet.getAddresses();
      break;
    } catch (e) {
      if (Date.now() > end) throw e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  await mine(FINALITY_DEPTH + 1);
}, 60_000);

afterAll(async () => {
  if (anvil !== undefined && anvil.exitCode === null) {
    const exited = new Promise((r) => anvil.once("exit", r));
    anvil.kill("SIGTERM");
    await exited;
  }
});

let boards = 0;
/** A fresh board at a fresh address running `code`, and the block it starts at. */
async function board(code: Hex = BOARD_CODE): Promise<{ address: Address; fromBlock: bigint }> {
  const address = getAddress(toHex(0xb0a2d000 + ++boards, { size: 20 }));
  await rpc("anvil_setCode", [address, code]);
  await mine(1);
  return { address, fromBlock: await client.getBlockNumber() };
}

/** A fresh posting key holding `wei` on Anvil. */
async function newKey(wei = 10n ** 18n): Promise<Uint8Array> {
  const key = generatePrivateKey();
  await rpc("anvil_setBalance", [privateKeyToAddress(key), toHex(wei)]);
  return Uint8Array.from(Buffer.from(key.slice(2), "hex"));
}

async function adapter(
  options: {
    code?: Hex;
    client?: PublicClient;
    logRange?: bigint;
    lookback?: bigint;
    deposits?: PostingChainOptions["deposits"];
  } = {},
) {
  const { address, fromBlock } = await board(options.code);
  const key = await newKey();
  const posting = new ViemPostingChain({
    client: options.client ?? client,
    chainId: BigInt(chainId),
    board: address,
    fromBlock,
    key,
    ...(options.logRange !== undefined && { logRange: options.logRange }),
    ...(options.lookback !== undefined && { lookback: options.lookback }),
    ...(options.deposits !== undefined && { deposits: options.deposits }),
  });
  return { chain: posting, board: address, fromBlock, key };
}

/** Signs and sends `posting` from the adapter's key at its next nonce, and mines it. */
async function land(c: ViemPostingChain, posting: Uint8Array): Promise<Uint8Array> {
  const s = await c.sign(posting, BALLOT, {
    nonce: await c.nonce(),
    gasLimit: 1_000_000n,
    feeCap: CAP,
  });
  expect(await c.broadcast(s.tx)).toBe("sent");
  await mine(1);
  return s.hash;
}

/** A client of the Anvil node through `hook`, which may change any answer: a node not to trust. */
function nodeClient(
  hook: (method: string, params: unknown[], forward: () => Promise<unknown>) => Promise<unknown>,
): PublicClient {
  let id = 0;
  const forward = (method: string, params: unknown[]) => async () => {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    const answer = (await response.json()) as {
      result?: unknown;
      error?: { code: number; message: string };
    };
    if (answer.error !== undefined)
      throw Object.assign(new Error(answer.error.message), { code: answer.error.code });
    return answer.result;
  };
  return createPublicClient({
    chain,
    cacheTime: 0,
    transport: custom(
      {
        request: ({ method, params }: { method: string; params?: unknown }) => {
          const p = (params ?? []) as unknown[];
          return hook(method, p, forward(method, p));
        },
      },
      { retryCount: 0 },
    ),
  }) as PublicClient;
}

describe("the head and the simulation", () => {
  test("reads the latest block's number and time", async () => {
    const { chain: c } = await adapter();
    await mine(1);
    const block = await client.getBlock({ blockTag: "latest" });
    expect(await c.latest()).toEqual({ number: block.number, timestamp: block.timestamp });
  });

  test("gives the gas a call within the cap needs, which serves as the call's gas limit", async () => {
    const { chain: c, board: to } = await adapter();
    const posting = freshPosting();
    const simulation = await c.simulate(posting, BALLOT);
    if (simulation.reverted) throw new Error("the stand-in board reverted");
    expect(simulation.gasUsed).toBeGreaterThan(21_000n);
    expect(simulation.gasUsed).toBeLessThanOrEqual(POSTING_GAS_LIMIT_MAX);
    // The call lands with the limit the worker derives from it.
    const s = await c.sign(posting, BALLOT, {
      nonce: await c.nonce(),
      gasLimit: postingGasLimit(
        simulation.gasUsed,
        postingCalldataLength(posting.length, BALLOT.length),
      ),
      feeCap: CAP,
    });
    await c.broadcast(s.tx);
    await mine(1);
    const receipt = await client.getTransactionReceipt({ hash: bytesToHex(s.hash) });
    expect(receipt.status).toBe("success");
    expect(receipt.to).toBe(to.toLowerCase());
    // Nothing was signed or sent by the simulation itself.
    expect(await c.nonce()).toBe(1n);
  });

  test("reports a revert as one, and a call past the cap as more gas than it", async () => {
    const reverting = await adapter({ code: REVERTING_CODE });
    expect(await reverting.chain.simulate(freshPosting(), BALLOT)).toEqual({ reverted: true });
    const looping = await adapter({ code: LOOPING_CODE });
    const simulation = await looping.chain.simulate(freshPosting(), BALLOT);
    expect(simulation).toEqual({ reverted: false, gasUsed: POSTING_GAS_LIMIT_MAX + 1n });
    // So the worker refuses it as `too-costly`.
    expect(postingGasLimit(POSTING_GAS_LIMIT_MAX + 1n, 0)).toBeGreaterThan(POSTING_GAS_LIMIT_MAX);
  });

  test("rejects, rather than reverts, when the node fails without a verdict", async () => {
    const failing = nodeClient(async (method, _params, forward) => {
      if (method === "eth_estimateGas")
        throw Object.assign(new Error("rate limited"), { code: -32005 });
      return forward();
    });
    const { chain: c } = await adapter({ client: failing });
    await expect(c.simulate(freshPosting(), BALLOT)).rejects.toThrow(PostingChainError);
  });
});

describe("the posting key", () => {
  test("counts the key's transactions at the latest block", async () => {
    const { chain: c } = await adapter();
    expect(await c.nonce()).toBe(0n);
    await land(c, freshPosting());
    await land(c, freshPosting());
    expect(await c.nonce()).toBe(2n);
  });

  test("signs submitPosting to the board at the nonce, gas limit and fees asked, within the cap", async () => {
    const { chain: c, board: to, key } = await adapter();
    const posting = freshPosting();
    const s = await c.sign(posting, BALLOT, { nonce: 7n, gasLimit: 345_678n, feeCap: CAP });
    const tx = parseTransaction(bytesToHex(s.tx));
    expect(tx).toMatchObject({
      type: "eip1559",
      chainId,
      nonce: 7,
      to: to.toLowerCase(),
      gas: 345_678n,
      maxFeePerGas: s.maxFee,
      maxPriorityFeePerGas: s.priorityFee,
    });
    expect(s.hash).toEqual(
      Uint8Array.from(Buffer.from(keccak256(bytesToHex(s.tx)).slice(2), "hex")),
    );
    expect(s.maxFee).toBeLessThanOrEqual(CAP);
    expect(s.priorityFee).toBeLessThanOrEqual(s.maxFee);
    expect(tx.value ?? 0n).toBe(0n);
    const call = decodeFunctionData({ abi: boardAbi, data: tx.data as Hex });
    expect(call.functionName).toBe("submitPosting");
    expect(call.args).toEqual([bytesToHex(posting), bytesToHex(BALLOT)]);
    expect(
      await recoverTransactionAddress({ serializedTransaction: bytesToHex(s.tx) as never }),
    ).toBe(privateKeyToAddress(bytesToHex(key)));
  });

  test("keeps the fees within a cap below the node's estimate", async () => {
    const { chain: c } = await adapter();
    const s = await c.sign(freshPosting(), BALLOT, { nonce: 0n, gasLimit: 100_000n, feeCap: 3n });
    expect(s.maxFee).toBe(3n);
    expect(s.priorityFee).toBeLessThanOrEqual(3n);
  });

  test("signs a replacement with exactly the fees asked, and nothing past the cap", async () => {
    const { chain: c } = await adapter();
    const posting = freshPosting();
    const fees = { maxFee: 9_000_000_000n, priorityFee: 2_000_000_000n };
    const s = await c.sign(posting, BALLOT, { nonce: 0n, gasLimit: 100_000n, feeCap: CAP, fees });
    expect({ maxFee: s.maxFee, priorityFee: s.priorityFee }).toEqual(fees);
    expect(parseTransaction(bytesToHex(s.tx))).toMatchObject({
      maxFeePerGas: fees.maxFee,
      maxPriorityFeePerGas: fees.priorityFee,
    });
    for (const bad of [
      { maxFee: CAP + 1n, priorityFee: 1n },
      { maxFee: 5n, priorityFee: 6n },
    ])
      await expect(
        c.sign(posting, BALLOT, { nonce: 0n, gasLimit: 100_000n, feeCap: CAP, fees: bad }),
      ).rejects.toThrow(PostingChainError);
    for (const gasLimit of [0n, POSTING_GAS_LIMIT_MAX + 1n])
      await expect(c.sign(posting, BALLOT, { nonce: 0n, gasLimit, feeCap: CAP })).rejects.toThrow(
        PostingChainError,
      );
  });

  test("broadcasts: sent, sent again for a transaction the node holds, refused for a used nonce", async () => {
    const { chain: c } = await adapter();
    await automine(false);
    try {
      const s = await c.sign(freshPosting(), BALLOT, {
        nonce: 0n,
        gasLimit: 100_000n,
        feeCap: CAP,
      });
      expect(await c.broadcast(s.tx)).toBe("sent");
      expect(await c.broadcast(s.tx)).toBe("sent");
      await mine(1);
      const stale = await c.sign(freshPosting(), BALLOT, {
        nonce: 0n,
        gasLimit: 100_000n,
        feeCap: CAP,
      });
      expect(await c.broadcast(stale.tx)).toBe("refused");
    } finally {
      await automine(true);
    }
  });
});

describe("costs and receipts", () => {
  test("prices no L1 data on a chain with no fee oracle, and the oracle's fee where there is one", async () => {
    const { chain: c } = await adapter();
    expect(await c.costs(freshPosting(), BALLOT, 100_000n)).toEqual({ l1DataFee: 0n, deposit: 0n });
    await rpc("anvil_setCode", [GAS_PRICE_ORACLE, ORACLE_CODE]);
    try {
      expect(await c.costs(freshPosting(), BALLOT, 100_000n)).toEqual({
        l1DataFee: ORACLE_FEE,
        deposit: 0n,
      });
      // And a receipt without its L1 fee is refused there, never counted at nothing.
      const hash = await land(c, freshPosting());
      await expect(c.receipt(hash)).rejects.toThrow(PostingChainError);
    } finally {
      await rpc("anvil_setCode", [GAS_PRICE_ORACLE, "0x"]);
    }
    // An oracle once seen that goes away is a node to distrust.
    await expect(c.costs(freshPosting(), BALLOT, 100_000n)).rejects.toThrow(PostingChainError);
  });

  test("counts a deposit's reserve as the forced path prices it, and fails with it", async () => {
    const asked: bigint[] = [];
    let fail = false;
    const { chain: c } = await adapter({
      deposits: {
        reserve: async (_posting, _ballot, gasLimit) => {
          asked.push(gasLimit);
          if (fail) throw new Error("the L1 node is down");
          return 12_345n;
        },
      },
    });
    expect(await c.costs(freshPosting(), BALLOT, 100_000n)).toEqual({
      l1DataFee: 0n,
      deposit: 12_345n,
    });
    await rpc("anvil_setCode", [GAS_PRICE_ORACLE, ORACLE_CODE]);
    try {
      expect(await c.costs(freshPosting(), BALLOT, 100_000n)).toEqual({
        l1DataFee: ORACLE_FEE,
        deposit: 12_345n,
      });
    } finally {
      await rpc("anvil_setCode", [GAS_PRICE_ORACLE, "0x"]);
    }
    expect(asked).toEqual([100_000n, 100_000n]);
    // An L1 node that fails fails the send (Depositing, step 2).
    fail = true;
    await expect(c.costs(freshPosting(), BALLOT, 100_000n)).rejects.toThrow(PostingChainError);
  });

  test("finds a transaction once it is in a block, with the gas it used at its price", async () => {
    const { chain: c } = await adapter();
    await automine(false);
    let hash: Uint8Array;
    try {
      const s = await c.sign(freshPosting(), BALLOT, {
        nonce: 0n,
        gasLimit: 200_000n,
        feeCap: CAP,
      });
      hash = s.hash;
      await c.broadcast(s.tx);
      expect(await c.receipt(hash)).toBeUndefined();
      await mine(1);
    } finally {
      await automine(true);
    }
    const r = await client.getTransactionReceipt({ hash: bytesToHex(hash) });
    expect(await c.receipt(hash)).toEqual({
      gasUsed: r.gasUsed,
      effectiveGasPrice: r.effectiveGasPrice,
      l1Fee: 0n,
    });
  });

  test("reads an OP Stack receipt's L1 fee, and refuses a node naming another transaction", async () => {
    const hashes: Uint8Array[] = [];
    let lie: "fee" | "other" = "fee";
    const lying = nodeClient(async (method, _params, forward) => {
      const answer = await forward();
      if (method !== "eth_getTransactionReceipt" || answer === null) return answer;
      return lie === "fee"
        ? { ...(answer as object), l1Fee: "0x1234" }
        : { ...(answer as object), transactionHash: bytesToHex(new Uint8Array(32).fill(7)) };
    });
    const { chain: c } = await adapter({ client: lying });
    hashes.push(await land(c, freshPosting()));
    expect((await c.receipt(hashes[0] as Uint8Array))?.l1Fee).toBe(0x1234n);
    lie = "other";
    await expect(c.receipt(hashes[0] as Uint8Array)).rejects.toThrow(PostingChainError);
  });
});

describe("the posting's event", () => {
  test("is found at the latest head once it lands, and at the finalized head once that is final", async () => {
    const { chain: c } = await adapter();
    const posting = freshPosting();
    expect(await c.posted(posting)).toBe(false);
    expect(await c.postedFinal(posting)).toBe(false);
    await land(c, posting);
    expect(await c.posted(posting)).toBe(true);
    expect(await c.postedFinal(posting)).toBe(false);
    await mine(FINALITY_DEPTH);
    expect(await c.postedFinal(posting)).toBe(true);
    expect(await c.posted(posting)).toBe(true);
    // Another posting of the same election and ballot isn't this one.
    expect(await c.posted(freshPosting())).toBe(false);
  });

  test("is lost again when a reorganisation takes its block from the latest head", async () => {
    const { chain: c } = await adapter();
    const posting = freshPosting();
    const snapshot = await rpc("evm_snapshot", []);
    await land(c, posting);
    expect(await c.posted(posting)).toBe(true);
    await rpc("evm_revert", [snapshot]);
    await mine(1);
    expect(await c.posted(posting)).toBe(false);
  });

  test("is found across log ranges, and only from the board itself", async () => {
    const { chain: c } = await adapter({ logRange: 2n });
    const posting = freshPosting();
    await land(c, posting);
    await mine(FINALITY_DEPTH + 5);
    expect(await c.postedFinal(posting)).toBe(true);
    // The same log from another contract is no posting of the board.
    const other = await adapter();
    await land(other.chain, freshPosting());
    const elsewhere = freshPosting();
    await land(other.chain, elsewhere);
    await mine(FINALITY_DEPTH);
    expect(await c.posted(elsewhere)).toBe(false);
    expect(await other.chain.postedFinal(elsewhere)).toBe(true);
  });

  test("searches from the lookback behind the head it is first asked at, and keeps what is final", async () => {
    let reads = 0;
    const counting = nodeClient(async (method, _params, forward) => {
      if (method === "eth_getLogs") reads++;
      return forward();
    });
    const { chain: c } = await adapter({ client: counting, lookback: 3n, logRange: 1n });
    const posting = freshPosting();
    await land(c, posting);
    await mine(10);
    // Its block is past the lookback of the first ask: missed (Known-weak).
    expect(await c.postedFinal(posting)).toBe(false);
    // Each later ask reads only the blocks since the last.
    reads = 0;
    await mine(2);
    expect(await c.postedFinal(posting)).toBe(false);
    expect(reads).toBe(2);
    // A posting found at the finalized head isn't searched again.
    const found = freshPosting();
    await land(c, found);
    await mine(FINALITY_DEPTH);
    expect(await c.postedFinal(found)).toBe(true);
    reads = 0;
    await mine(5);
    expect(await c.postedFinal(found)).toBe(true);
    expect(await c.posted(found)).toBe(true);
    expect(reads).toBe(0);
  });

  test("refuses a node whose logs stray from the filter", async () => {
    const strays: ((log: Record<string, unknown>) => Record<string, unknown>)[] = [
      (log) => ({ ...log, address: getAddress(toHex(0xbad, { size: 20 })) }),
      (log) => ({
        ...log,
        topics: [
          (log["topics"] as Hex[])[0],
          (log["topics"] as Hex[])[2],
          (log["topics"] as Hex[])[1],
        ],
      }),
      (log) => ({ ...log, blockNumber: "0x0" }),
      (log) => ({ ...log, removed: true }),
    ];
    for (const stray of strays) {
      let lie = false;
      const lying = nodeClient(async (method, _params, forward) => {
        const answer = await forward();
        if (method !== "eth_getLogs" || !lie) return answer;
        return (answer as Record<string, unknown>[]).map(stray);
      });
      const { chain: c } = await adapter({ client: lying });
      const posting = freshPosting();
      await land(c, posting);
      lie = true;
      await expect(c.posted(posting)).rejects.toThrow(PostingChainError);
    }
  });

  test("is found only with exactly the posting's bytes as the record", async () => {
    const lying = nodeClient(async (method, _params, forward) => {
      const answer = await forward();
      if (method !== "eth_getLogs") return answer;
      // The same topics, another record: a log the board never emitted for this posting.
      return (answer as Record<string, unknown>[]).map((log) => {
        const data = log["data"] as string;
        return { ...log, data: `${data.slice(0, -2)}${data.endsWith("00") ? "01" : "00"}` };
      });
    });
    const { chain: c } = await adapter({ client: lying });
    const posting = freshPosting();
    await land(c, posting);
    await mine(FINALITY_DEPTH);
    expect(await c.posted(posting)).toBe(false);
    expect(await c.postedFinal(posting)).toBe(false);
  });
});

/** Code that answers every call with `word`, an address as a 32-byte word. */
const answering = (word: Address) =>
  `0x7f${word.slice(2).toLowerCase().padStart(64, "0")}5f5260205ff3` as Hex;
/** Code that answers a call with the word its storage holds at the call's selector. */
const BY_SELECTOR = "0x5f3560e01c545f5260205ff3" as Hex;
/** Sets what `BY_SELECTOR` code at `address` answers to `signature`. */
const answer = (address: Address, signature: string, word: bigint | Address) =>
  rpc("anvil_setStorageAt", [
    address,
    toHex(BigInt(toFunctionSelector(signature)), { size: 32 }),
    toHex(typeof word === "bigint" ? word : BigInt(word), { size: 32 }),
  ]);
const L1_CHAIN_ID = 11_155_111n;
const L1_RELAY = getAddress(toHex(0x1e1a7, { size: 20 }));

describe("the safe head", () => {
  // Anvil with one slot an epoch: the safe block is the latest but one, the
  // finalized the latest but two.
  test("holds a transaction once its block is at the safe head", async () => {
    const { chain: c } = await adapter();
    expect(await c.includedSafe(new Uint8Array(32).fill(9))).toBe(false);
    const hash = await land(c, freshPosting());
    expect(await c.includedSafe(hash)).toBe(false);
    await mine(1);
    const safe = await client.getBlock({ blockTag: "safe" });
    const r = await client.getTransactionReceipt({ hash: bytesToHex(hash) });
    expect(r.blockNumber).toBeLessThanOrEqual(safe.number);
    expect(await c.includedSafe(hash)).toBe(true);
  });

  test("never takes a receipt whose block the safe chain doesn't hold, or that names another transaction", async () => {
    let lie: "block" | "other" = "block";
    const lying = nodeClient(async (method, _params, forward) => {
      const answer = await forward();
      if (method !== "eth_getTransactionReceipt" || answer === null) return answer;
      return lie === "block"
        ? { ...(answer as object), blockHash: bytesToHex(new Uint8Array(32).fill(3)) }
        : { ...(answer as object), transactionHash: bytesToHex(new Uint8Array(32).fill(7)) };
    });
    const { chain: c } = await adapter({ client: lying });
    const hash = await land(c, freshPosting());
    await mine(FINALITY_DEPTH);
    expect(await c.includedSafe(hash)).toBe(false);
    lie = "other";
    await expect(c.includedSafe(hash)).rejects.toThrow(PostingChainError);
  });

  test("finds the posting's event once its block is at the safe head, and only this posting's", async () => {
    const { chain: c } = await adapter();
    const posting = freshPosting();
    expect(await c.postedSafe(posting)).toBe(false);
    await land(c, posting);
    expect(await c.posted(posting)).toBe(true);
    expect(await c.postedSafe(posting)).toBe(false);
    await mine(1);
    expect(await c.postedSafe(posting)).toBe(true);
    expect(await c.postedFinal(posting)).toBe(false);
    await mine(1);
    expect(await c.postedSafe(posting)).toBe(true);
    expect(await c.postedSafe(freshPosting())).toBe(false);
  });

  test("refuses a node whose finalized block is past its safe one", async () => {
    const lying = nodeClient(async (method, params, forward) => {
      const answer = await forward();
      if (method !== "eth_getBlockByNumber" || params[0] !== "finalized") return answer;
      return { ...(answer as object), number: "0xffffffff" };
    });
    const { chain: c } = await adapter({ client: lying });
    await expect(c.postedSafe(freshPosting())).rejects.toThrow(PostingChainError);
  });
});

describe("the startup check", () => {
  /** A board naming a registry that names the board back, as a deployment's pair. */
  async function deployment() {
    const registry = getAddress(toHex(0xe1e0000 + ++boards, { size: 20 }));
    const { address, fromBlock } = await board(answering(registry));
    await rpc("anvil_setCode", [registry, BY_SELECTOR]);
    await answer(registry, "board()", address);
    await answer(registry, "l1ChainId()", L1_CHAIN_ID);
    await answer(registry, "l1Relay()", L1_RELAY);
    await mine(FINALITY_DEPTH + 1);
    const key = await newKey();
    const c = new ViemPostingChain({
      client,
      chainId: BigInt(chainId),
      board: address,
      fromBlock,
      key,
    });
    return {
      registry,
      key,
      deployment: { chainId: BigInt(chainId), board: address, fromBlock, address: c.address },
    };
  }
  const refusal = (deployment: Parameters<typeof checkPostingDeployment>[1]) =>
    checkPostingDeployment(client, deployment).then(
      () => "accepted",
      (e: unknown) => (e as Error).message,
    );

  test("passes a board whose election registry names it back, and a key with no code, reading what the registry names on L1", async () => {
    const { registry, deployment: d } = await deployment();
    await expect(checkPostingDeployment(client, d)).resolves.toEqual({
      registry,
      l1ChainId: L1_CHAIN_ID,
      l1Relay: L1_RELAY,
    });
  });

  test("refuses another chain, a deployment block past the finalized head, and an address that isn't a board", async () => {
    const { deployment: d } = await deployment();
    expect(await refusal({ ...d, chainId: d.chainId + 1n })).toBe(
      "the L2 node is on another chain",
    );
    const finalized = (await client.getBlock({ blockTag: "finalized" })).number;
    expect(await refusal({ ...d, fromBlock: finalized + 1n })).toBe(
      "the board's deployment block is past the finalized head",
    );
    // The stand-in board of the tests above answers nothing.
    const { address: silent } = await board();
    await mine(FINALITY_DEPTH + 1);
    expect(await refusal({ ...d, board: silent })).toBe("the address isn't a board");
    // One byte, too short for an address: no board either, not a node failing.
    const { address: short } = await board("0x60016000f3");
    await mine(FINALITY_DEPTH + 1);
    expect(await refusal({ ...d, board: short })).toBe("the address isn't a board");
  });

  test("refuses a board whose registry isn't one, or names another board", async () => {
    const { registry, deployment: d } = await deployment();
    await rpc("anvil_setCode", [registry, "0x00"]);
    await mine(FINALITY_DEPTH + 1);
    expect(await refusal(d)).toBe("the address isn't a board's election registry");
    await rpc("anvil_setCode", [registry, BY_SELECTOR]);
    await answer(registry, "board()", accounts[0] as Address);
    await mine(FINALITY_DEPTH + 1);
    expect(await refusal(d)).toBe("the board's election registry names another board");
  });

  test("rethrows a node that fails mid-read rather than calling the address no board", async () => {
    const { deployment: d } = await deployment();
    let calls = 0;
    const failing = nodeClient((method, _params, forward) => {
      // The board's read answers; the registry's dies in transit.
      if (method === "eth_call" && ++calls === 2)
        return Promise.reject(new Error("socket hang up"));
      return forward();
    });
    const error = await checkPostingDeployment(failing, d).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(BaseError);
    expect((error as Error).message).not.toContain("isn't");
  });

  test("reads the registry's answer at the finalized head, not the latest", async () => {
    const { registry, deployment: d } = await deployment();
    await answer(registry, "board()", accounts[0] as Address);
    await answer(registry, "l1Relay()", accounts[0] as Address);
    await mine(1);
    // The changes aren't final yet.
    await expect(checkPostingDeployment(client, d)).resolves.toMatchObject({ l1Relay: L1_RELAY });
  });

  test("refuses a posting key whose account holds code (an EIP-7702 delegation, say)", async () => {
    const { deployment: d } = await deployment();
    await rpc("anvil_setCode", [d.address, `0xef0100${(accounts[0] as Address).slice(2)}`]);
    await mine(1);
    expect(await refusal(d)).toBe("the posting key's account holds code");
  });

  test("the finalized head is the node's", async () => {
    const { chain: c } = await adapter();
    const finalized = await client.getBlock({ blockTag: "finalized" });
    expect(await c.finalized()).toEqual({
      number: finalized.number,
      timestamp: finalized.timestamp,
    });
  });
});

describe("the posting worker's deployment", () => {
  // As posting-main.ts composes it: the queue's worker and the ledger over the
  // adapter, run by the loop, against Postgres as abolish_app and the relay's
  // store under a prefix of this run's.
  const redisUrl = process.env["REDIS_URL"];
  let db: TestDb;
  let redis: Redis;
  const prefix = `abolish-test-${randomBytes(6).toString("hex")}`;
  beforeAll(async () => {
    if (!redisUrl) throw new Error("REDIS_URL is not set");
    db = await testDb();
    redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  });
  afterAll(async () => {
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
    await db.close();
  });

  test("ticks the queue against the node, answering its pairs and keeping the route's index, and tends, deposits and prunes without a failure", async () => {
    const sql = await db.as("abolish_app");
    const now = () => Math.floor(Date.now() / 1000);
    // This node stands in for L1 too, with a portal that takes any deposit
    // (posting-l1.test.ts runs the forced path across two chains).
    const portal = getAddress(toHex(0x9047a1 + ++boards, { size: 20 }));
    await rpc("anvil_setCode", [portal, "0x00"]);
    const { board: to, fromBlock, key } = await adapter();
    const l1 = new ViemPostingL1({
      client,
      chainId: BigInt(chainId),
      portal,
      board: to,
      key,
      l1FeeCap: CAP,
    });
    const c = new ViemPostingChain({
      client,
      chainId: BigInt(chainId),
      board: to,
      fromBlock,
      key,
      deposits: l1,
    });
    const ledger = new PostgresPostingLedger({
      sql,
      chain: c,
      budget: 10n ** 16n,
      feeCap: CAP,
      now,
    });
    const deposits = new PostgresPostingDeposits({
      sql,
      chain: postingDepositChain(c, l1),
      elections: new PostgresPostingElections({
        sql,
        registry: new ViemPostingRegistry({ client, registry: portal, fromBlock }),
        now,
      }),
      budget: 10n ** 16n,
      l1FeeCap: CAP,
      now,
    });
    const keys = postingKeys(prefix);
    // Bytes no decoder takes: answered `malformed` before any node call.
    const posting = Uint8Array.from(randomBytes(200));
    await redis.hset(keys.queue, postingKey(posting), postingPairValue(posting, BALLOT));
    await mine(1);
    const lines: LogLine[] = [];
    const runner = startPostingRunner({
      worker: new PostingWorker({
        sql,
        redis,
        chain: c,
        ledger,
        admissions: new BallotAdmissions({
          panels: [PANEL],
          clock: { epoch: 0n, period: 3_600n },
        }),
        now,
        prefix,
      }),
      ledger,
      chain: c,
      deposits,
      l1,
      log: (line) => lines.push(line),
      tickMs: 20,
      pruneEveryMs: 20,
      depositEveryMs: 20,
    });
    const end = Date.now() + 10_000;
    while ((await redis.get(keys.index)) === null || (await redis.hlen(keys.queue)) > 0) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 20));
    }
    await runner.close();
    const head = await client.getBlock({ blockTag: "latest" });
    expect(parsePostingIndex(await redis.get(keys.index))?.l2Time).toBe(head.timestamp);
    expect(parsePostingOutcome(await redis.get(keys.outcome(postingKey(posting))))).toEqual({
      sent: false,
      code: "malformed",
    });
    expect(lines.filter((l) => "outcome" in l)).toEqual([]);
    expect(lines).toContainEqual(
      expect.objectContaining({ queue: "{posting}", step: "tick", kept: 0 }),
    );
  }, 30_000);
});

describe("errors", () => {
  test("name the step and never the node's URL", async () => {
    const port = await freePort();
    const secret = "k3y-in-the-path";
    const unreachable = createPublicClient({
      chain,
      transport: http(`http://127.0.0.1:${port}/${secret}`, { retryCount: 0, timeout: 1_000 }),
    }) as PublicClient;
    const c = new ViemPostingChain({
      client: unreachable,
      chainId: BigInt(chainId),
      board: accounts[0] as Address,
      fromBlock: 0n,
      key: await newKey(0n),
    });
    const calls: (() => Promise<unknown>)[] = [
      () => c.latest(),
      () => c.finalized(),
      () => c.simulate(freshPosting(), BALLOT),
      () => c.nonce(),
      () => c.costs(freshPosting(), BALLOT, 100_000n),
      () => c.sign(freshPosting(), BALLOT, { nonce: 0n, gasLimit: 100_000n, feeCap: CAP }),
      () => c.broadcast(new Uint8Array([1, 2, 3])),
      () => c.receipt(new Uint8Array(32)),
      () => c.posted(freshPosting()),
      () => c.postedFinal(freshPosting()),
      () => c.includedSafe(new Uint8Array(32)),
      () => c.postedSafe(freshPosting()),
    ];
    for (const call of calls) {
      const error = await call().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(PostingChainError);
      expect(String((error as Error).message)).not.toContain(secret);
      expect((error as Error).cause).toBeUndefined();
    }
  });

  test("refuse a key that isn't one, without quoting it", () => {
    const options = {
      client,
      chainId: BigInt(chainId),
      board: accounts[0] as Address,
      fromBlock: 0n,
    };
    expect(() => new ViemPostingChain({ ...options, key: new Uint8Array(31) })).toThrow(
      "the posting key must be 32 bytes",
    );
    const zero = new Uint8Array(32);
    expect(() => new ViemPostingChain({ ...options, key: zero })).toThrow(
      "the posting key isn't a secp256k1 key",
    );
  });
});
