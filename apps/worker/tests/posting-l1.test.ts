import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { boardAbi } from "@abolishus/contracts/abi";
import { decodeSharePosting } from "@abolishus/crypto";
import {
  POSTING_CANCEL_GAS,
  POSTING_FORCE_AFTER,
  POSTING_L1_GAS_LIMIT_MAX,
  postingDepositFeeCap,
  postingDepositGasLimit,
  postingDepositReserve,
  PostgresPostingDeposits,
  PostgresPostingElections,
  PostgresPostingLedger,
  postingKey,
} from "@abolishus/core";
import { type TestDb, testDb } from "@abolishus/core/test-db";
import { randomBytes } from "node:crypto";
import {
  type Address,
  bytesToHex,
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionData,
  defineChain,
  getAddress,
  type Hex,
  http,
  keccak256,
  parseAbi,
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
  checkPostingL1,
  PostingChainError,
  postingDepositChain,
  ViemPostingChain,
  ViemPostingL1,
  ViemPostingRegistry,
} from "../src/index.ts";

// The posting relay's forced path on L1 against real chains (P2-8 part
// 2b-2b-2b-2b-3b-2; docs/spec/posting-relay.md, Forced through L1 and
// Depositing): one Anvil as L1 with a stand-in portal that takes any deposit
// and a stand-in L1 relay naming it, another as L2 with a stand-in board and
// election registry. Deposits are estimated, priced, signed for the portal
// with the posting's own calldata and gas limit, cancelled to the key itself,
// broadcast and found in L1 blocks; the registry's events are read from
// finalized L2 blocks only; and a posting the L2 never includes is forced
// through L1 by core's deposits over these adapters (T-50, T-52, T-54). A
// node's answer that strays is refused. The posting key is a fresh random
// one funded on Anvil (AGENTS.md: no real key here).

const L1_ID = 2_000_000 + Math.floor(Math.random() * 1_000_000_000);
const L2_ID = L1_ID + 1;
// One slot per epoch: Anvil's safe block is the latest but one, its finalized the latest but two.
const FINALITY_DEPTH = 2;
const L1_FEE_CAP = 50_000_000_000n;
const CAP = 50_000_000_000n;

/** A portal that takes any call, a deposit's stand-in: the L2 side of a deposit is the OP Stack's. */
const PORTAL_CODE = "0x00" as Hex;
const REVERTING_CODE = "0x5f5ffd" as Hex;
const LOOPING_CODE = "0x5b5f56" as Hex;
/** Code that answers a call with the word its storage holds at the call's selector: the L1 relay's stand-in. */
const BY_SELECTOR = "0x5f3560e01c545f5260205ff3" as Hex;
/** A registry stand-in: `log3` with the call's three words as its topics, and no data. */
const LOGGING_CODE = "0x604035602035" + "5f355f5fa300";
const DEFINITION_REGISTERED = keccak256(
  toBytes("DefinitionRegistered(bytes32,bytes32,uint64,uint64,bytes32,bytes)"),
);

const portalAbi = parseAbi([
  "function depositTransaction(address _to, uint256 _value, uint64 _gasLimit, bool _isCreation, bytes _data) payable",
]);

const delivery = JSON.parse(
  readFileSync(new URL("../../../docs/spec/vectors/delivery.json", import.meta.url), "utf8"),
) as { records: { id: string; encoding: string }[] };
const vectorPosting = Uint8Array.from(
  Buffer.from(delivery.records.find((r) => r.id === "posting")?.encoding as string, "hex"),
);
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

interface Node {
  readonly process: ChildProcess;
  readonly url: string;
  readonly chain: ReturnType<typeof defineChain>;
  readonly client: PublicClient;
  rpc(method: string, params: unknown[]): Promise<unknown>;
  mine(blocks: number): Promise<unknown>;
  /** A client of this node through `hook`, which may change any answer: a node not to trust. */
  lying(
    hook: (method: string, params: unknown[], forward: () => Promise<unknown>) => Promise<unknown>,
  ): PublicClient;
}

async function startAnvil(id: number): Promise<Node> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(
    "anvil",
    [
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--chain-id",
      String(id),
      "--slots-in-an-epoch",
      "1",
      "--silent",
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  const chain = defineChain({
    id,
    name: "anvil",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  });
  const client = createPublicClient({ chain, transport: http(url), cacheTime: 0 }) as PublicClient;
  const rpc = (method: string, params: unknown[]) =>
    client.request({ method, params } as never) as Promise<unknown>;
  const end = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error("anvil exited (is the toolchain installed?)");
    try {
      await client.getChainId();
      break;
    } catch (e) {
      if (Date.now() > end) throw e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  let rid = 0;
  const lying: Node["lying"] = (hook) => {
    const forward = (method: string, params: unknown[]) => async () => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method, params }),
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
  };
  const node: Node = {
    process: child,
    url,
    chain,
    client,
    rpc,
    mine: (blocks) => rpc("anvil_mine", [toHex(blocks)]),
    lying,
  };
  await node.mine(FINALITY_DEPTH + 1);
  return node;
}

let l1: Node;
let l2: Node;

beforeAll(async () => {
  [l1, l2] = await Promise.all([startAnvil(L1_ID), startAnvil(L2_ID)]);
}, 60_000);

afterAll(async () => {
  await Promise.all(
    [l1, l2].map(async (n) => {
      if (n === undefined || n.process.exitCode !== null) return;
      const exited = new Promise((r) => n.process.once("exit", r));
      n.process.kill("SIGTERM");
      await exited;
    }),
  );
});

let contracts = 0;
/** A fresh address on `node` running `code`. */
async function deploy(node: Node, code: Hex): Promise<Address> {
  const address = getAddress(toHex(0xd0e0000 + ++contracts, { size: 20 }));
  await node.rpc("anvil_setCode", [address, code]);
  await node.mine(1);
  return address;
}

/** Sets what `BY_SELECTOR` code at `address` answers to `signature`. */
const answer = (node: Node, address: Address, signature: string, word: Address) =>
  node.rpc("anvil_setStorageAt", [
    address,
    toHex(BigInt(toFunctionSelector(signature)), { size: 32 }),
    toHex(BigInt(word), { size: 32 }),
  ]);

/** A fresh posting key holding `wei` on both chains. */
async function newKey(wei = 10n ** 18n): Promise<Uint8Array> {
  const key = generatePrivateKey();
  for (const node of [l1, l2])
    await node.rpc("anvil_setBalance", [privateKeyToAddress(key), toHex(wei)]);
  return Uint8Array.from(Buffer.from(key.slice(2), "hex"));
}

const BOARD = getAddress(toHex(0xb0a2d, { size: 20 }));

async function adapter(
  options: { code?: Hex; client?: PublicClient; key?: Uint8Array; board?: Address } = {},
) {
  const portal = await deploy(l1, options.code ?? PORTAL_CODE);
  const key = options.key ?? (await newKey());
  const board = options.board ?? BOARD;
  const chain = new ViemPostingL1({
    client: options.client ?? l1.client,
    chainId: BigInt(L1_ID),
    portal,
    board,
    key,
    l1FeeCap: L1_FEE_CAP,
  });
  return { chain, portal, board, key };
}

/** The `submitPosting` call a deposit carries, as the L2 call does. */
const call = (posting: Uint8Array, ballot: Uint8Array) =>
  encodeFunctionData({
    abi: boardAbi,
    functionName: "submitPosting",
    args: [bytesToHex(posting), bytesToHex(ballot)],
  });

describe("the startup check on L1", () => {
  /** A relay naming `board` and a portal, on L1. */
  async function relay(board: Address = BOARD) {
    const portal = await deploy(l1, PORTAL_CODE);
    const address = await deploy(l1, BY_SELECTOR);
    await answer(l1, address, "board()", board);
    await answer(l1, address, "portal()", portal);
    await l1.mine(FINALITY_DEPTH + 1);
    const key = await newKey();
    return {
      portal,
      relay: address,
      deployment: {
        l1ChainId: BigInt(L1_ID),
        l1Relay: address,
        board,
        address: privateKeyToAddress(bytesToHex(key)),
      },
    };
  }
  const refusal = (d: Parameters<typeof checkPostingL1>[1]) =>
    checkPostingL1(l1.client, d).then(
      () => "accepted",
      (e: unknown) => (e as Error).message,
    );

  test("passes a relay naming the board and a portal with code, and gives the portal", async () => {
    const { portal, deployment: d } = await relay();
    expect(await checkPostingL1(l1.client, d)).toBe(portal);
  });

  test("refuses another L1, a relay with no code, one naming another board, and a portal with no code", async () => {
    const { relay: r, deployment: d } = await relay();
    expect(await refusal({ ...d, l1ChainId: d.l1ChainId + 1n })).toBe(
      "the L1 node is on another chain",
    );
    expect(await refusal({ ...d, l1Relay: getAddress(toHex(0xdead, { size: 20 })) })).toBe(
      "the registry's L1 relay holds no code on this L1",
    );
    const other = await relay(getAddress(toHex(0xb0b, { size: 20 })));
    expect(await refusal({ ...other.deployment, board: BOARD })).toBe(
      "the registry's L1 relay names another board",
    );
    await answer(l1, r, "portal()", getAddress(toHex(0xdead, { size: 20 })));
    await l1.mine(FINALITY_DEPTH + 1);
    expect(await refusal(d)).toBe("the portal holds no code");
  });

  test("reads the relay at the L1's finalized head", async () => {
    const { portal, relay: r, deployment: d } = await relay();
    await answer(l1, r, "board()", getAddress(toHex(0xb0b, { size: 20 })));
    await l1.mine(1);
    expect(await checkPostingL1(l1.client, d)).toBe(portal);
  });

  test("refuses a posting key whose L1 account holds code (a delegation, say)", async () => {
    const { deployment: d } = await relay();
    await l1.rpc("anvil_setCode", [d.address, `0xef0100${BOARD.slice(2)}`]);
    await l1.mine(1);
    expect(await refusal(d)).toBe("the posting key's L1 account holds code");
  });
});

describe("the L1 heads and the key's count", () => {
  test("read the latest and finalized blocks, and the key's count at the latest and at a block", async () => {
    const { chain: c } = await adapter();
    const [latest, finalized] = await Promise.all([
      l1.client.getBlock({ blockTag: "latest" }),
      l1.client.getBlock({ blockTag: "finalized" }),
    ]);
    expect(await c.latest()).toEqual({ number: latest.number, timestamp: latest.timestamp });
    expect(await c.finalized()).toEqual({
      number: finalized.number,
      timestamp: finalized.timestamp,
    });
    expect(await c.nonce()).toBe(0n);
    const before = await l1.client.getBlockNumber();
    const s = await c.signCancel({ nonce: 0n, fees: { maxFee: CAP, priorityFee: 1n } });
    expect(await c.broadcast(s.tx)).toBe("sent");
    await l1.mine(1);
    expect(await c.nonce()).toBe(1n);
    expect(await c.nonceAt(before)).toBe(0n);
    await expect(c.nonceAt(-1n)).rejects.toThrow(PostingChainError);
  });
});

describe("estimates and the reserve", () => {
  test("estimate the deposit at the portal, and price its reserve from it", async () => {
    const { chain: c } = await adapter();
    const posting = freshPosting();
    const estimate = await c.estimate(posting, BALLOT, 600_000n);
    if (estimate === undefined) throw new Error("the stand-in portal reverted");
    expect(estimate).toBeGreaterThan(21_000n);
    const l1GasLimit = postingDepositGasLimit(estimate);
    expect(await c.reserve(posting, BALLOT, 600_000n)).toBe(
      postingDepositReserve(l1GasLimit, L1_FEE_CAP),
    );
    // A deposit signed with the limit it derives lands.
    const s = await c.signDeposit(posting, BALLOT, {
      nonce: 0n,
      gasLimit: 600_000n,
      l1GasLimit,
      feeCap: postingDepositFeeCap(L1_FEE_CAP),
    });
    expect(await c.broadcast(s.tx)).toBe("sent");
    await l1.mine(1);
    expect((await c.receipt(s.hash))?.success).toBe(true);
  });

  test("give no estimate, and no reserve, for a portal that reverts, and one past the cap for one no gas is enough for", async () => {
    const reverting = await adapter({ code: REVERTING_CODE });
    expect(await reverting.chain.estimate(freshPosting(), BALLOT, 600_000n)).toBeUndefined();
    expect(await reverting.chain.reserve(freshPosting(), BALLOT, 600_000n)).toBe(0n);
    const looping = await adapter({ code: LOOPING_CODE });
    expect(await looping.chain.estimate(freshPosting(), BALLOT, 600_000n)).toBe(
      POSTING_L1_GAS_LIMIT_MAX + 1n,
    );
    expect(await looping.chain.reserve(freshPosting(), BALLOT, 600_000n)).toBe(0n);
  });

  test("reject, rather than give none, when the node fails without a verdict", async () => {
    const failing = l1.lying(async (method, _params, forward) => {
      if (method === "eth_estimateGas")
        throw Object.assign(new Error("rate limited"), { code: -32005 });
      return forward();
    });
    const { chain: c } = await adapter({ client: failing });
    await expect(c.estimate(freshPosting(), BALLOT, 600_000n)).rejects.toThrow(PostingChainError);
    await expect(c.reserve(freshPosting(), BALLOT, 600_000n)).rejects.toThrow(PostingChainError);
  });
});

describe("signing", () => {
  test("signs the deposit for the portal, from the key, with the posting's calldata and gas limit", async () => {
    const { chain: c, portal, key } = await adapter();
    const posting = freshPosting();
    const s = await c.signDeposit(posting, BALLOT, {
      nonce: 3n,
      gasLimit: 600_000n,
      l1GasLimit: 900_000n,
      feeCap: postingDepositFeeCap(L1_FEE_CAP),
    });
    const tx = parseTransaction(bytesToHex(s.tx));
    expect(tx.chainId).toBe(L1_ID);
    expect(tx.to).toBe(portal.toLowerCase());
    expect(tx.nonce).toBe(3);
    expect(tx.gas).toBe(900_000n);
    expect(tx.value ?? 0n).toBe(0n);
    expect(tx.maxFeePerGas).toBe(s.maxFee);
    expect(tx.maxPriorityFeePerGas).toBe(s.priorityFee);
    expect(s.maxFee).toBeLessThanOrEqual(postingDepositFeeCap(L1_FEE_CAP));
    expect(bytesToHex(s.hash)).toBe(keccak256(bytesToHex(s.tx)));
    expect(
      await recoverTransactionAddress({ serializedTransaction: bytesToHex(s.tx) as never }),
    ).toBe(privateKeyToAddress(bytesToHex(key)));
    const { functionName, args } = decodeFunctionData({ abi: portalAbi, data: tx.data as Hex });
    expect(functionName).toBe("depositTransaction");
    expect(args).toEqual([BOARD, 0n, 600_000n, false, call(posting, BALLOT)]);
  });

  test("clamps the node's fees to the asked cap, and signs a replacement with exactly its fees", async () => {
    const { chain: c } = await adapter();
    const low = await c.signDeposit(freshPosting(), BALLOT, {
      nonce: 0n,
      gasLimit: 600_000n,
      l1GasLimit: 900_000n,
      feeCap: 1n,
    });
    expect(low.maxFee).toBe(1n);
    expect(low.priorityFee).toBeLessThanOrEqual(1n);
    const fees = { maxFee: 1_000_000_007n, priorityFee: 3n };
    const r = await c.signDeposit(freshPosting(), BALLOT, {
      nonce: 0n,
      gasLimit: 600_000n,
      l1GasLimit: 900_000n,
      feeCap: L1_FEE_CAP,
      fees,
    });
    expect({ maxFee: r.maxFee, priorityFee: r.priorityFee }).toEqual(fees);
    expect(parseTransaction(bytesToHex(r.tx)).maxFeePerGas).toBe(fees.maxFee);
  });

  test("refuses fees past the cap, a cap past the L1 fee cap, and gas limits out of range", async () => {
    const { chain: c } = await adapter();
    const base = { nonce: 0n, gasLimit: 600_000n, l1GasLimit: 900_000n, feeCap: L1_FEE_CAP };
    for (const options of [
      { ...base, fees: { maxFee: L1_FEE_CAP + 1n, priorityFee: 1n } },
      { ...base, fees: { maxFee: 10n, priorityFee: 11n } },
      { ...base, feeCap: L1_FEE_CAP + 1n },
      { ...base, feeCap: 0n },
      { ...base, l1GasLimit: 0n },
      { ...base, l1GasLimit: POSTING_L1_GAS_LIMIT_MAX + 1n },
      { ...base, gasLimit: 0n },
      { ...base, gasLimit: 10_000_001n },
      { ...base, nonce: -1n },
    ])
      await expect(c.signDeposit(freshPosting(), BALLOT, options)).rejects.toThrow(
        PostingChainError,
      );
  });

  test("signs a cancellation as a transfer of nothing to the key itself, at up to twice the L1 fee cap", async () => {
    const { chain: c, key } = await adapter();
    const fees = { maxFee: 2n * L1_FEE_CAP, priorityFee: 2n * L1_FEE_CAP };
    const s = await c.signCancel({ nonce: 5n, fees });
    const tx = parseTransaction(bytesToHex(s.tx));
    const self = privateKeyToAddress(bytesToHex(key));
    expect(tx.to).toBe(self.toLowerCase());
    expect(tx.nonce).toBe(5);
    expect(tx.gas).toBe(POSTING_CANCEL_GAS);
    expect(tx.value ?? 0n).toBe(0n);
    expect(tx.data ?? "0x").toBe("0x");
    expect(tx.chainId).toBe(L1_ID);
    expect({ maxFee: s.maxFee, priorityFee: s.priorityFee }).toEqual(fees);
    await expect(
      c.signCancel({ nonce: 5n, fees: { maxFee: 2n * L1_FEE_CAP + 1n, priorityFee: 1n } }),
    ).rejects.toThrow(PostingChainError);
  });
});

describe("broadcasts and receipts", () => {
  const automine = (on: boolean) => l1.rpc("evm_setAutomine", [on]);

  test("finds a deposit once it is in a block, with its gas, price and block, and refuses a used nonce", async () => {
    const { chain: c } = await adapter();
    await automine(false);
    let s;
    try {
      s = await c.signDeposit(freshPosting(), BALLOT, {
        nonce: 0n,
        gasLimit: 600_000n,
        l1GasLimit: 900_000n,
        feeCap: postingDepositFeeCap(L1_FEE_CAP),
      });
      expect(await c.broadcast(s.tx)).toBe("sent");
      expect(await c.broadcast(s.tx)).toBe("sent");
      expect(await c.receipt(s.hash)).toBeUndefined();
      await l1.mine(1);
    } finally {
      await automine(true);
    }
    const r = await l1.client.getTransactionReceipt({ hash: bytesToHex(s.hash) });
    expect(await c.receipt(s.hash)).toEqual({
      success: true,
      gasUsed: r.gasUsed,
      effectiveGasPrice: r.effectiveGasPrice,
      block: r.blockNumber,
    });
    // Another transaction at the used nonce is refused, never taken as sent.
    const again = await c.signCancel({ nonce: 0n, fees: { maxFee: CAP, priorityFee: 1n } });
    expect(await c.broadcast(again.tx)).toBe("refused");
  });

  test("reports a deposit the portal reverted as no success, and a cancellation that landed as one", async () => {
    const reverting = await adapter({ code: REVERTING_CODE });
    const d = await reverting.chain.signDeposit(freshPosting(), BALLOT, {
      nonce: 0n,
      gasLimit: 600_000n,
      l1GasLimit: 900_000n,
      feeCap: postingDepositFeeCap(L1_FEE_CAP),
    });
    await reverting.chain.broadcast(d.tx);
    await l1.mine(1);
    expect((await reverting.chain.receipt(d.hash))?.success).toBe(false);
    const x = await reverting.chain.signCancel({
      nonce: 1n,
      fees: { maxFee: CAP, priorityFee: 1n },
    });
    await reverting.chain.broadcast(x.tx);
    await l1.mine(1);
    expect((await reverting.chain.receipt(x.hash))?.success).toBe(true);
  });

  test("refuses a receipt naming another transaction or out of form", async () => {
    let lie: "other" | "status" = "other";
    const lying = l1.lying(async (method, _params, forward) => {
      const a = await forward();
      if (method !== "eth_getTransactionReceipt" || a === null) return a;
      return lie === "other"
        ? { ...(a as object), transactionHash: bytesToHex(new Uint8Array(32).fill(7)) }
        : { ...(a as object), status: "0x2" };
    });
    const { chain: c } = await adapter({ client: lying });
    const s = await c.signCancel({ nonce: 0n, fees: { maxFee: CAP, priorityFee: 1n } });
    await c.broadcast(s.tx);
    await l1.mine(1);
    await expect(c.receipt(s.hash)).rejects.toThrow(PostingChainError);
    lie = "status";
    await expect(c.receipt(s.hash)).rejects.toThrow(PostingChainError);
  });
});

describe("the registry's events", () => {
  /** A registry stand-in on L2 and the block it starts at. */
  async function registry() {
    const address = await deploy(l2, LOGGING_CODE as Hex);
    return { address, fromBlock: await l2.client.getBlockNumber() };
  }
  /** Registers `definitionHash` in a block of its own, as the registry's event. */
  async function register(at: Address, definitionHash: Hex): Promise<bigint> {
    const [from] = (await l2.client.request({ method: "eth_accounts" } as never)) as Address[];
    const tx = await l2.client.request({
      method: "eth_sendTransaction",
      params: [
        {
          from,
          to: at,
          data: `${DEFINITION_REGISTERED}${keccak256(definitionHash).slice(2)}${definitionHash.slice(2)}`,
        },
      ],
    } as never);
    await l2.mine(1);
    return (await l2.client.getTransactionReceipt({ hash: tx as Hex })).blockNumber;
  }
  const hash = () => bytesToHex(new Uint8Array(randomBytes(32)));

  test("are read from finalized blocks only, with each block's time, from the block asked", async () => {
    const { address, fromBlock } = await registry();
    const r = new ViemPostingRegistry({ client: l2.client, registry: address, fromBlock });
    const a = hash();
    const at = await register(address, a);
    // Not final yet.
    expect((await r.registered(0n)).events).toEqual([]);
    await l2.mine(FINALITY_DEPTH);
    const block = await l2.client.getBlock({ blockNumber: at });
    const finalized = await l2.client.getBlock({ blockTag: "finalized" });
    const read = await r.registered(0n);
    // The head's time comes with what was read up to it.
    expect(read.finalizedTime).toBe(finalized.timestamp);
    expect(read.events).toEqual([
      {
        definitionHash: Uint8Array.from(Buffer.from(a.slice(2), "hex")),
        l2Block: at,
        timestamp: block.timestamp,
      },
    ]);
    // From a later block: none.
    expect((await r.registered(at + 1n)).events).toEqual([]);
  });

  test("are found across log ranges, reading only the finalized blocks since the last ask, and again from further back", async () => {
    // Each log query's first and last block, in the order asked.
    let reads: [bigint, bigint][] = [];
    const counting = l2.lying(async (method, params, forward) => {
      if (method === "eth_getLogs") {
        const { fromBlock, toBlock } = params[0] as { fromBlock: Hex; toBlock: Hex };
        reads.push([BigInt(fromBlock), BigInt(toBlock)]);
      }
      return forward();
    });
    const { address, fromBlock } = await registry();
    const r = new ViemPostingRegistry({
      client: counting,
      registry: address,
      fromBlock,
      logRange: 2n,
    });
    const first = await register(address, hash());
    const second = await register(address, hash());
    await l2.mine(FINALITY_DEPTH + 3);
    expect((await r.registered(0n)).events.map((e) => e.l2Block)).toEqual([first, second]);
    const kept = reads.at(-1)?.[1] as bigint;
    reads = [];
    await l2.mine(2);
    expect((await r.registered(first)).events.map((e) => e.l2Block)).toEqual([first, second]);
    // Only the blocks finalized since, however far the head moved on a busy runner.
    expect(reads.length).toBeGreaterThan(0);
    reads.forEach(([lo], i) =>
      expect(lo).toBe(i === 0 ? kept + 1n : (reads[i - 1]?.[1] as bigint) + 1n),
    );
    expect((await r.registered(second)).events.map((e) => e.l2Block)).toEqual([second]);
    // Asked from further back than kept (an index wiped, say): read again.
    reads = [];
    expect((await r.registered(0n)).events.map((e) => e.l2Block)).toEqual([first, second]);
    expect(reads[0]?.[0]).toBe(fromBlock);
  });

  test("reads one ask at a time, so an abandoned read and the next never race over the kept blocks", async () => {
    let inLogs = 0;
    let most = 0;
    const slow = l2.lying(async (method, _params, forward) => {
      if (method !== "eth_getLogs") return forward();
      inLogs++;
      most = Math.max(most, inLogs);
      await new Promise((r) => setTimeout(r, 5));
      try {
        return await forward();
      } finally {
        inLogs--;
      }
    });
    const { address, fromBlock } = await registry();
    const r = new ViemPostingRegistry({ client: slow, registry: address, fromBlock, logRange: 1n });
    const first = await register(address, hash());
    await l2.mine(FINALITY_DEPTH + 3);
    // A read from the latest block, then one from further back while it runs.
    const [late, back] = await Promise.all([r.registered(first + 1n), r.registered(0n)]);
    expect(late.events).toEqual([]);
    expect(back.events.map((e) => e.l2Block)).toEqual([first]);
    expect(most).toBe(1);
  });

  test("refuses a node whose logs stray from the filter", async () => {
    const strays: ((log: Record<string, unknown>) => Record<string, unknown>)[] = [
      (log) => ({ ...log, address: getAddress(toHex(0xbad, { size: 20 })) }),
      (log) => ({ ...log, topics: [hash(), ...(log["topics"] as Hex[]).slice(1)] }),
      (log) => ({ ...log, topics: (log["topics"] as Hex[]).slice(0, 2) }),
      (log) => ({ ...log, blockNumber: "0x0" }),
      (log) => ({ ...log, removed: true }),
    ];
    for (const stray of strays) {
      const lying = l2.lying(async (method, _params, forward) => {
        const a = await forward();
        return method === "eth_getLogs" ? (a as Record<string, unknown>[]).map(stray) : a;
      });
      const { address, fromBlock } = await registry();
      const r = new ViemPostingRegistry({ client: lying, registry: address, fromBlock });
      await register(address, hash());
      await l2.mine(FINALITY_DEPTH);
      await expect(r.registered(0n)).rejects.toThrow(PostingChainError);
    }
  });
});

describe("the forced path", () => {
  // As posting-main.ts composes it: a posting the L2 node never includes
  // (its automine off, a censoring sequencer's stand-in) is deposited on L1
  // once POSTING_FORCE_AFTER has passed, lands, and is settled at its
  // receipt, against Postgres as abolish_app.
  let db: TestDb;
  beforeAll(async () => {
    db = await testDb();
  });
  afterAll(() => db?.close());

  test("deposits a posting the L2 keeps out, sees it land, and settles it once final", async () => {
    const sql = await db.as("abolish_app");
    const key = await newKey();
    const board = await deploy(l2, PORTAL_CODE);
    const { chain: onL1, portal } = await adapter({ key, board });
    const registryAddress = await deploy(l2, LOGGING_CODE as Hex);
    const fromBlock = await l2.client.getBlockNumber();
    const onL2 = new ViemPostingChain({
      client: l2.client,
      chainId: BigInt(L2_ID),
      board,
      fromBlock,
      key,
      deposits: onL1,
    });
    const start = (await l1.client.getBlock({ blockTag: "latest" })).timestamp;
    let clock = Number(start);
    const now = () => clock;
    const budget = 10n ** 18n;
    const ledger = new PostgresPostingLedger({ sql, chain: onL2, budget, feeCap: CAP, now });
    const deposits = new PostgresPostingDeposits({
      sql,
      chain: postingDepositChain(onL2, onL1),
      // A connection of its own: the deposits ask for the elections' times
      // while holding theirs in the ledger's lock, as a pool does in
      // posting-main.ts.
      elections: new PostgresPostingElections({
        sql: await db.as("abolish_app"),
        registry: new ViemPostingRegistry({
          client: l2.client,
          registry: registryAddress,
          fromBlock,
        }),
        now,
      }),
      budget,
      l1FeeCap: L1_FEE_CAP,
      now,
    });
    const heads = async () => ({ latest: await onL1.latest(), finalized: await onL1.finalized() });

    // Both chains mine only when told: Anvil's automine mines in the
    // background, so a transaction it took may not be in a block yet when
    // the next call reads.
    await Promise.all([l1, l2].map((n) => n.rpc("evm_setAutomine", [false])));
    try {
      const posting = freshPosting();
      const decoded = decodeSharePosting(posting, 1);
      const outcome = await ledger.send({
        key: postingKey(posting),
        posting,
        ballot: BALLOT,
        electionId: new Uint8Array(randomBytes(32)),
        definitionHash: decoded.definition_hash,
        ballotHash: decoded.ballot_hash,
        tier: 0,
        nullifier: 7n,
        gasLimit: 600_000n,
        closesAt: start + 30n * 86_400n,
        l1InclusionBound: 600n,
      });
      expect(outcome.sent).toBe(true);
      // Not yet due.
      expect((await deposits.tend(await heads())).deposited).toBe(0);

      clock = Number(start + POSTING_FORCE_AFTER);
      await l1.rpc("evm_setNextBlockTimestamp", [toHex(clock)]);
      await l1.mine(1);
      const deposited = await deposits.tend(await heads());
      expect(deposited).toMatchObject({ deposited: 1, unjudged: 0, errors: 0 });
      const [row] = await db.admin`SELECT deposits FROM posting_deposits`;
      const hash = new Uint8Array(row?.["deposits"] as Buffer);
      const tx = await l1.client.getTransaction({ hash: bytesToHex(hash) });
      expect(tx.to).toBe(portal.toLowerCase());
      const { args } = decodeFunctionData({ abi: portalAbi, data: tx.input });
      expect(args).toEqual([board, 0n, 600_000n, false, call(posting, BALLOT)]);

      expect(await deposits.tend(await heads())).toMatchObject({ landed: 0, errors: 0 });
      // The clock keeps up with L1 as a worker's does: nothing is made final
      // on a head ahead of it, and Anvil stamps a block a second on when
      // the wall clock has moved on (T-25).
      const mine = async (blocks: number) => {
        await l1.mine(blocks);
        clock = Number((await onL1.latest()).timestamp);
      };
      await mine(1);
      expect(await deposits.tend(await heads())).toMatchObject({ landed: 1, errors: 0 });
      await mine(FINALITY_DEPTH);
      expect(await deposits.tend(await heads())).toMatchObject({ final: 1, errors: 0 });
      // A landed deposit is never sent again.
      expect((await deposits.tend(await heads())).deposited).toBe(0);
    } finally {
      await Promise.all([l1, l2].map((n) => n.rpc("evm_setAutomine", [true])));
    }
  }, 30_000);
});
