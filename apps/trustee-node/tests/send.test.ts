import { type Rpc, RpcError } from "@abolishus/node";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, randomBytes } from "@noble/hashes/utils.js";
import fc from "fast-check";
import { decodeFunctionData, type Hex, keccak256, parseAbi, parseTransaction } from "viem";
import { privateKeyToAccount, privateKeyToAddress } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import { padded, word } from "../../node/tests/anvil.ts";
import { anvil, type Node } from "./anvil.ts";
import {
  AVAILABILITY_CALL_GAS,
  availabilitySender,
  boardSender,
  DEPOSIT_GAS_FLOOR,
  MAX_SIGNED_PER_RECORD,
  COMPLAINT_CALL_GAS,
  RECEIPT_CALL_GAS,
  SendError,
  type SendOptions,
} from "../src/send.ts";

// The availability duty's sending path (P4-3 part 2c-4b-2b-1): the board's
// availability call through the sequencer, and its deposit through the L2's
// portal when the sequencer refuses or holds it back, or the cutoff is near
// (T-25, T-50, T-71). Two Anvil nodes stand in for the L2, mining only when
// told, so a transaction can wait outside any block, and for L1. The board
// and the portal are code that accepts any call: what is checked is the
// transactions the account signs, against encodings built here by hand.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const L1_CHAIN_ID = 31_401n;
const L2_CHAIN_ID = 31_402n;
const BOARD = new Uint8Array(20).fill(0xb0);
const PORTAL = new Uint8Array(20).fill(0x90);
const L2_CAP = 10n ** 10n;
const L1_CAP = 3n * 10n ** 11n;
const FORCE_AFTER = 1_800n;
const FORCE_LEAD = 3_600n;
const CUTOFF = 1_000_000n;
const ACCEPT = "0x00";
const REVERT = "0x60006000fd";

const hex = (b: Uint8Array): Hex => `0x${bytesToHex(b)}`;
const selector = (s: string) => keccak_256(new TextEncoder().encode(s)).slice(0, 4);

/** `submitAvailabilityRecord(record)` in the one encoding the board takes (CanonicalCalldata). */
const boardCall = (record: Uint8Array) =>
  concatBytes(
    selector("submitAvailabilityRecord(bytes)"),
    word(32n),
    word(BigInt(record.length)),
    padded(record),
  );

/** `submitReceiptBatch(record)` in the one encoding the board takes. */
const batchCall = (record: Uint8Array, signature = "submitReceiptBatch(bytes)") =>
  concatBytes(selector(signature), word(32n), word(BigInt(record.length)), padded(record));

const portalAbi = parseAbi([
  "function depositTransaction(address to, uint256 value, uint64 gasLimit, bool isCreation, bytes data) payable",
]);

let l1: Node;
let l2: Node;

beforeAll(async () => {
  [l1, l2] = await Promise.all([anvil(L1_CHAIN_ID, true), anvil(L2_CHAIN_ID, false)]);
});

afterAll(() => {
  l1?.process.kill();
  l2?.process.kill();
});

interface Tx {
  readonly hash: Hex;
  readonly from: string;
  readonly to: string;
  readonly input: Hex;
  readonly nonce: bigint;
  readonly gas: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly chainId: bigint;
  readonly blockNumber: string | null;
}

/** Every transaction a node holds from `from`, pending or in a block, by nonce. */
async function txsFrom(rpc: Rpc, from: string): Promise<Tx[]> {
  // L1's Anvil mines each transaction it takes, but not within the call
  // that hands it over.
  if (rpc === l1.rpc)
    for (let i = 0; ; i++) {
      const status = (await rpc.call("txpool_status", [])) as { pending: string };
      if (BigInt(status.pending) === 0n) break;
      if (i > 100) throw new Error("L1 doesn't mine");
      await new Promise((r) => setTimeout(r, 20));
    }
  const out: Tx[] = [];
  const latest = BigInt((await rpc.call("eth_blockNumber", [])) as string);
  for (let n = 0n; n <= latest; n++) {
    const block = (await rpc.call("eth_getBlockByNumber", [`0x${n.toString(16)}`, true])) as {
      transactions: Record<string, string>[];
    };
    for (const t of block.transactions) if (t["from"] === from) out.push(asTx(t));
  }
  const pool = (await rpc.call("txpool_content", [])) as {
    pending: Record<string, Record<string, Record<string, string>>>;
  };
  for (const [address, byNonce] of Object.entries(pool.pending))
    if (address.toLowerCase() === from) for (const t of Object.values(byNonce)) out.push(asTx(t));
  return out.sort((a, b) => Number(a.nonce - b.nonce));
}

const asTx = (t: Record<string, string>): Tx => ({
  hash: t["hash"] as Hex,
  from: (t["from"] as string).toLowerCase(),
  to: (t["to"] as string).toLowerCase(),
  input: t["input"] as Hex,
  nonce: BigInt(t["nonce"] as string),
  gas: BigInt(t["gas"] as string),
  maxFeePerGas: BigInt(t["maxFeePerGas"] as string),
  maxPriorityFeePerGas: BigInt(t["maxPriorityFeePerGas"] as string),
  chainId: BigInt(t["chainId"] as string),
  blockNumber: t["blockNumber"] ?? null,
});

/** An Rpc that answers through `node`, unless `hook` answers first. */
const hooked = (
  node: Rpc,
  hook: (method: string, params: readonly unknown[]) => Promise<unknown> | undefined,
): Rpc => ({ call: (method, params) => hook(method, params) ?? node.call(method, params) });

interface World {
  key: Uint8Array;
  from: string;
  now: bigint;
  /** Answers the L2 node gives instead of its own. */
  l2Hook: (method: string, params: readonly unknown[]) => Promise<unknown> | undefined;
  l1Hook: (method: string, params: readonly unknown[]) => Promise<unknown> | undefined;
}

let w: World;

beforeEach(async () => {
  const key = randomBytes(32);
  const from = privateKeyToAddress(hex(key)).toLowerCase();
  w = { key, from, now: 0n, l2Hook: () => undefined, l1Hook: () => undefined };
  for (const node of [l1, l2]) {
    await node.rpc.call("anvil_setBalance", [from, `0x${(10n ** 20n).toString(16)}`]);
  }
  await l2.rpc.call("anvil_setCode", [hex(BOARD), ACCEPT]);
  await l1.rpc.call("anvil_setCode", [hex(PORTAL), ACCEPT]);
});

const options = (over: Partial<SendOptions> = {}): SendOptions => ({
  l2: hooked(l2.rpc, (m, p) => w.l2Hook(m, p)),
  l2ChainId: L2_CHAIN_ID,
  l1: hooked(l1.rpc, (m, p) => w.l1Hook(m, p)),
  l1ChainId: L1_CHAIN_ID,
  board: BOARD,
  portal: PORTAL,
  accountKey: w.key,
  l2MaxFeePerGas: L2_CAP,
  l1MaxFeePerGas: L1_CAP,
  forceAfter: FORCE_AFTER,
  forceLead: FORCE_LEAD,
  clock: () => w.now,
  ...over,
});

const mineL2 = () => l2.rpc.call("anvil_mine", ["0x1"]);
const refuse = (method: string) => () => Promise.reject(new RpcError(`${method}: refused`));

/** The record's board call, as the deposit carries it. */
const depositOf = (tx: Tx) => {
  const d = decodeFunctionData({ abi: portalAbi, data: tx.input });
  expect(d.functionName).toBe("depositTransaction");
  const [to, value, gasLimit, isCreation, data] = d.args;
  return { to: to.toLowerCase(), value, gasLimit, isCreation, data };
};

describe("the board call through the sequencer", () => {
  test("is the record's canonical call, signed by the account for the L2, with the fixed gas and capped fee", async () => {
    const send = await availabilitySender(options());
    const record = randomBytes(106);
    await send(record, CUTOFF);
    const [tx, ...rest] = await txsFrom(l2.rpc, w.from);
    expect(rest).toEqual([]);
    expect(tx).toMatchObject({
      to: hex(BOARD),
      input: hex(boardCall(record)),
      nonce: 0n,
      gas: AVAILABILITY_CALL_GAS,
      maxFeePerGas: L2_CAP,
      chainId: L2_CHAIN_ID,
      blockNumber: null,
    });
    const tip = BigInt((await l2.rpc.call("eth_maxPriorityFeePerGas", [])) as string);
    expect(tx?.maxPriorityFeePerGas).toBe(tip);
    // Nothing deposited while it waits within `forceAfter`.
    expect(await txsFrom(l1.rpc, w.from)).toEqual([]);
  });

  test("resends the same signed transaction until a block holds it, then stops", async () => {
    const sent: Hex[] = [];
    w.l2Hook = (m, p) => {
      if (m === "eth_sendRawTransaction") sent.push(p[0] as Hex);
      return undefined;
    };
    const send = await availabilitySender(options());
    const record = randomBytes(106);
    await send(record, CUTOFF);
    w.now = FORCE_AFTER - 1n;
    await send(record, CUTOFF);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
    await mineL2();
    await send(record, CUTOFF);
    expect(sent).toHaveLength(2);
    const txs = await txsFrom(l2.rpc, w.from);
    expect(txs.map((t) => [t.hash, t.blockNumber !== null])).toEqual([
      [keccak256(sent[0] as Hex), true],
    ]);
  });

  test("tips the cap at most", async () => {
    w.l2Hook = (m) =>
      m === "eth_maxPriorityFeePerGas" ? Promise.resolve("0xffffffffff") : undefined;
    const send = await availabilitySender(options());
    await send(randomBytes(106), CUTOFF);
    const [tx] = await txsFrom(l2.rpc, w.from);
    expect([tx?.maxFeePerGas, tx?.maxPriorityFeePerGas]).toEqual([L2_CAP, L2_CAP]);
  });

  test("signs again at the account's next nonce when another transaction took the one it was signed at", async () => {
    const send = await availabilitySender(options());
    const record = randomBytes(106);
    await send(record, CUTOFF);
    const [first] = await txsFrom(l2.rpc, w.from);
    await l2.rpc.call("anvil_dropTransaction", [first?.hash]);
    const other = await privateKeyToAccount(hex(w.key)).signTransaction({
      type: "eip1559",
      chainId: Number(L2_CHAIN_ID),
      nonce: 0,
      to: hex(new Uint8Array(20).fill(0x11)),
      value: 1n,
      gas: 21_000n,
      maxFeePerGas: L2_CAP,
      maxPriorityFeePerGas: 1n,
    });
    await l2.rpc.call("eth_sendRawTransaction", [other]);
    await mineL2();
    await send(record, CUTOFF);
    const txs = await txsFrom(l2.rpc, w.from);
    expect(txs.map((t) => [t.nonce, t.input])).toEqual([
      [0n, "0x"],
      [1n, hex(boardCall(record))],
    ]);
  });

  test("two records sent at once take two nonces", async () => {
    const send = await availabilitySender(options());
    const a = randomBytes(106);
    const b = randomBytes(170);
    await Promise.all([send(a, CUTOFF), send(b, CUTOFF)]);
    const txs = await txsFrom(l2.rpc, w.from);
    expect(txs.map((t) => t.nonce)).toEqual([0n, 1n]);
    expect(new Set(txs.map((t) => t.input))).toEqual(
      new Set([hex(boardCall(a)), hex(boardCall(b))]),
    );
  });

  test("a call the board reverted is reported, and deposited only from cutoff − forceLead, once", async () => {
    await l2.rpc.call("anvil_setCode", [hex(BOARD), REVERT]);
    const send = await availabilitySender(options());
    const record = randomBytes(106);
    await send(record, CUTOFF);
    await mineL2();
    w.now = CUTOFF - FORCE_LEAD - 1n;
    await expect(send(record, CUTOFF)).rejects.toEqual(new SendError("reverted"));
    expect(await txsFrom(l1.rpc, w.from)).toEqual([]);
    // Only the node says it reverted: the record still goes through L1.
    w.now = CUTOFF - FORCE_LEAD;
    await expect(send(record, CUTOFF)).rejects.toEqual(new SendError("reverted"));
    await expect(send(record, CUTOFF)).rejects.toEqual(new SendError("reverted"));
    expect((await txsFrom(l1.rpc, w.from)).map((t) => t.nonce)).toEqual([0n]);
    expect((await txsFrom(l2.rpc, w.from)).map((t) => t.nonce)).toEqual([0n]);
  });

  test("a nonce no account reaches is the node's refusal, and the record is deposited", async () => {
    w.l2Hook = (m) =>
      m === "eth_getTransactionCount" ? Promise.resolve("0x20000000000000") : undefined;
    const send = await availabilitySender(options());
    await send(randomBytes(106), CUTOFF);
    expect(await txsFrom(l2.rpc, w.from)).toEqual([]);
    expect(await txsFrom(l1.rpc, w.from)).toHaveLength(1);
  });

  test("another transaction's receipt or hash is the node's refusal, and the record is deposited", async () => {
    const send = await availabilitySender(options());
    const record = randomBytes(106);
    await send(record, CUTOFF);
    w.l2Hook = (m) =>
      m === "eth_getTransactionReceipt"
        ? Promise.resolve({ transactionHash: hex(randomBytes(32)), status: "0x1" })
        : undefined;
    await send(record, CUTOFF);
    expect(await txsFrom(l1.rpc, w.from)).toHaveLength(1);
    const other = randomBytes(106);
    w.l2Hook = (m) =>
      m === "eth_sendRawTransaction" ? Promise.resolve(hex(randomBytes(32))) : undefined;
    await send(other, CUTOFF);
    expect(await txsFrom(l1.rpc, w.from)).toHaveLength(2);
  });
});

describe("the deposit through the portal", () => {
  const deposited = async (record: Uint8Array) => {
    const txs = await txsFrom(l1.rpc, w.from);
    return txs.map((t) => {
      expect([t.to, t.chainId, t.maxFeePerGas, t.blockNumber !== null]).toEqual([
        hex(PORTAL),
        L1_CHAIN_ID,
        L1_CAP,
        true,
      ]);
      expect(t.gas).toBeGreaterThanOrEqual(DEPOSIT_GAS_FLOOR);
      expect(depositOf(t)).toEqual({
        to: hex(BOARD),
        value: 0n,
        gasLimit: AVAILABILITY_CALL_GAS,
        isCreation: false,
        data: hex(boardCall(record)),
      });
      return t.nonce;
    });
  };

  test("is made once the call has waited forceAfter outside any block, and only once", async () => {
    const send = await availabilitySender(options());
    const record = randomBytes(106);
    await send(record, CUTOFF);
    w.now = FORCE_AFTER - 1n;
    await send(record, CUTOFF);
    expect(await deposited(record)).toEqual([]);
    w.now = FORCE_AFTER;
    await send(record, CUTOFF);
    w.now = FORCE_AFTER + 60n;
    await send(record, CUTOFF);
    expect(await deposited(record)).toEqual([0n]);
    // The sequencer still has its call to include.
    expect((await txsFrom(l2.rpc, w.from)).map((t) => t.blockNumber)).toEqual([null]);
  });

  test("is made at once when the sequencer refuses the call", async () => {
    w.l2Hook = (m) => (m === "eth_sendRawTransaction" ? refuse(m)() : undefined);
    const send = await availabilitySender(options());
    const record = randomBytes(170);
    await send(record, CUTOFF);
    expect(await deposited(record)).toEqual([0n]);
    expect(await txsFrom(l2.rpc, w.from)).toEqual([]);
  });

  test("is made at once when the L2 node can't be reached", async () => {
    const send = await availabilitySender(options());
    w.l2Hook = () => Promise.reject(new RpcError("eth_getTransactionCount: TypeError"));
    const record = randomBytes(106);
    await send(record, CUTOFF);
    expect(await deposited(record)).toEqual([0n]);
  });

  test("is made from cutoff − forceLead even when a block holds the call, and not before", async () => {
    const send = await availabilitySender(options());
    const record = randomBytes(106);
    await send(record, CUTOFF);
    await mineL2();
    w.now = CUTOFF - FORCE_LEAD - 1n;
    await send(record, CUTOFF);
    expect(await deposited(record)).toEqual([]);
    w.now = CUTOFF - FORCE_LEAD;
    await send(record, CUTOFF);
    expect(await deposited(record)).toEqual([0n]);
  });

  test("a record first sent past its cutoff is deposited at once", async () => {
    w.now = CUTOFF + 10n;
    const send = await availabilitySender(options());
    const record = randomBytes(106);
    await send(record, CUTOFF);
    expect(await deposited(record)).toEqual([0n]);
  });

  test("a deposit that reverted on L1 is signed again with a fresh estimate", async () => {
    w.l1Hook = (m) => (m === "eth_estimateGas" ? Promise.resolve("0x30d40") : undefined);
    await l1.rpc.call("anvil_setCode", [hex(PORTAL), REVERT]);
    w.now = CUTOFF;
    const send = await availabilitySender(options());
    const record = randomBytes(106);
    await send(record, CUTOFF);
    const [reverted] = await txsFrom(l1.rpc, w.from);
    const receipt = (await l1.rpc.call("eth_getTransactionReceipt", [reverted?.hash])) as {
      status: string;
    };
    expect(receipt.status).toBe("0x0");
    await l1.rpc.call("anvil_setCode", [hex(PORTAL), ACCEPT]);
    await send(record, CUTOFF);
    await send(record, CUTOFF);
    expect((await txsFrom(l1.rpc, w.from)).map((t) => t.nonce)).toEqual([0n, 1n]);
  });

  test("its gas is the L1 node's estimate and a quarter, never below the floor", async () => {
    w.now = CUTOFF;
    w.l1Hook = (m) => (m === "eth_estimateGas" ? Promise.resolve("0x61a80") : undefined);
    const send = await availabilitySender(options());
    await send(randomBytes(106), CUTOFF);
    w.l1Hook = (m) => (m === "eth_estimateGas" ? Promise.resolve("0x5208") : undefined);
    await send(randomBytes(106), CUTOFF);
    expect((await txsFrom(l1.rpc, w.from)).map((t) => t.gas)).toEqual([
      400_000n + 100_000n,
      DEPOSIT_GAS_FLOOR,
    ]);
  });

  test("a deposit needing more gas than one transaction may have is refused", async () => {
    w.now = CUTOFF;
    w.l1Hook = (m) => (m === "eth_estimateGas" ? Promise.resolve("0xe00000") : undefined);
    const send = await availabilitySender(options());
    await expect(send(randomBytes(106), CUTOFF)).rejects.toMatchObject({ code: "deposit-gas" });
    expect(await txsFrom(l1.rpc, w.from)).toEqual([]);
  });

  test("neither path taking the record is unsent, and the next send tries both again", async () => {
    w.l2Hook = (m) => (m === "eth_sendRawTransaction" ? refuse(m)() : undefined);
    w.l1Hook = (m) => (m === "eth_sendRawTransaction" ? refuse(m)() : undefined);
    const send = await availabilitySender(options());
    const record = randomBytes(106);
    await expect(send(record, CUTOFF)).rejects.toEqual(new SendError("unsent"));
    w.l2Hook = () => undefined;
    w.l1Hook = () => undefined;
    await send(record, CUTOFF);
    expect(await deposited(record)).toEqual([]);
    expect((await txsFrom(l2.rpc, w.from)).map((t) => t.nonce)).toEqual([0n]);
  });
});

describe("the transactions signed for one record", () => {
  test("are at most MAX_SIGNED_PER_RECORD on each chain, whatever the nodes say of nonces", async () => {
    let nonce = 0;
    const stale = (m: string) => {
      if (m === "eth_getTransactionCount") return Promise.resolve(`0x${(nonce++).toString(16)}`);
      if (m === "eth_sendRawTransaction")
        return Promise.reject(new RpcError(`${m}: nonce too low`));
      if (m === "eth_getTransactionReceipt") return Promise.resolve(null);
      return undefined;
    };
    const signed = { l1: new Set<Hex>(), l2: new Set<Hex>() };
    const counting = (chain: "l1" | "l2") => (m: string, p: readonly unknown[]) => {
      if (m === "eth_sendRawTransaction") signed[chain].add(p[0] as Hex);
      return stale(m);
    };
    w.l2Hook = counting("l2");
    w.l1Hook = counting("l1");
    w.now = CUTOFF;
    const send = await availabilitySender(options());
    const record = randomBytes(106);
    for (let i = 0; i < 6; i++)
      await expect(send(record, CUTOFF)).rejects.toEqual(new SendError("unsent"));
    expect([signed.l2.size, signed.l1.size]).toEqual([
      MAX_SIGNED_PER_RECORD,
      MAX_SIGNED_PER_RECORD,
    ]);
  });
});

describe("setup", () => {
  test("refuses nodes on other chains", async () => {
    await expect(availabilitySender(options({ l2ChainId: L1_CHAIN_ID }))).rejects.toEqual(
      new SendError("chain"),
    );
    await expect(availabilitySender(options({ l1ChainId: L2_CHAIN_ID }))).rejects.toEqual(
      new SendError("chain"),
    );
  });

  test("refuses a board or a portal without code", async () => {
    const empty = new Uint8Array(20).fill(0x77);
    await expect(availabilitySender(options({ board: empty }))).rejects.toEqual(
      new SendError("no-code"),
    );
    await expect(availabilitySender(options({ portal: empty }))).rejects.toEqual(
      new SendError("no-code"),
    );
  });

  test("refuses malformed options before any request, and never quotes the key", async () => {
    let asked = 0;
    const counting: Rpc = {
      call: () => {
        asked++;
        return Promise.reject(new RpcError("unreachable"));
      },
    };
    const n = new Uint8Array(32).fill(0xff);
    for (const over of [
      { board: new Uint8Array(19) },
      { portal: new Uint8Array(21) },
      { accountKey: new Uint8Array(31) },
      { accountKey: new Uint8Array(32) },
      { accountKey: n },
      { l2MaxFeePerGas: 0n },
      { l1MaxFeePerGas: -1n },
      { forceAfter: -1n },
      { forceLead: -1n },
    ] satisfies Partial<SendOptions>[]) {
      const e = await availabilitySender(options({ ...over, l1: counting, l2: counting })).catch(
        (x: unknown) => x,
      );
      expect(e).toBeInstanceOf(RangeError);
      expect((e as Error).message).not.toContain(bytesToHex(n));
    }
    expect(asked).toBe(0);
  });
});

// A scripted pair of nodes, for the property: each answers a send by the
// script's choice and includes what it took when the script mines.
interface Scripted {
  readonly rpc: Rpc;
  readonly taken: Map<Hex, { raw: Hex; mined: boolean }>;
  refuse: boolean;
  mine(): void;
}

function scripted(id: bigint, code: string): Scripted {
  const taken = new Map<Hex, { raw: Hex; mined: boolean }>();
  const s: Scripted = {
    taken,
    refuse: false,
    mine: () => {
      for (const t of taken.values()) t.mined = true;
    },
    rpc: {
      call: async (method, params) => {
        switch (method) {
          case "eth_chainId":
            return `0x${id.toString(16)}`;
          case "eth_getCode":
            return code;
          case "eth_getTransactionCount":
            return `0x${taken.size.toString(16)}`;
          case "eth_maxPriorityFeePerGas":
            return "0x1";
          case "eth_estimateGas":
            return "0x30d40";
          case "eth_getTransactionReceipt": {
            const t = taken.get(params[0] as Hex);
            return t?.mined === true ? { transactionHash: params[0], status: "0x1" } : null;
          }
          case "eth_sendRawTransaction": {
            if (s.refuse) throw new RpcError(`${method}: refused`);
            const raw = params[0] as Hex;
            const hash = keccak256(raw);
            const tx = parseTransaction(raw);
            for (const [h, t] of taken)
              if (h !== hash && parseTransaction(t.raw).nonce === tx.nonce)
                throw new RpcError(`${method}: nonce too low`);
            if (!taken.has(hash)) taken.set(hash, { raw, mined: false });
            return hash;
          }
        }
        throw new Error(`unscripted ${method}`);
      },
    },
  };
  return s;
}

test("over any refusals, mining and timing, every record's board call reaches the sequencer once and is deposited at most once, by cutoff − forceLead", async () => {
  const step = fc.record({
    record: fc.nat(2),
    advance: fc.bigInt({ min: 0n, max: 2_000n }),
    l2Refuses: fc.boolean(),
    l1Refuses: fc.boolean(),
    mineL2: fc.boolean(),
    mineL1: fc.boolean(),
  });
  await fc.assert(
    fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 30 }), async (steps) => {
      const a = scripted(L2_CHAIN_ID, ACCEPT);
      const b = scripted(L1_CHAIN_ID, ACCEPT);
      let now = 0n;
      const cutoff = 20_000n;
      const send = await availabilitySender(
        options({ l2: a.rpc, l1: b.rpc, clock: () => now, forceAfter: 3_000n, forceLead: 6_000n }),
      );
      const records = [0, 1, 2].map((i) => new Uint8Array(106).fill(i + 1));
      for (const s of steps) {
        now += s.advance;
        a.refuse = s.l2Refuses;
        b.refuse = s.l1Refuses;
        const record = records[s.record] as Uint8Array;
        const ok = await send(record, cutoff).then(
          () => true,
          (e: unknown) => {
            expect(e).toEqual(new SendError("unsent"));
            return false;
          },
        );
        if (s.mineL2) a.mine();
        if (s.mineL1) b.mine();
        const calls = (n: Scripted, deposit: boolean) =>
          [...n.taken.values()].map((t) => {
            const tx = parseTransaction(t.raw);
            return deposit ? depositOf({ input: tx.data } as Tx).data : (tx.data as Hex);
          });
        const call = hex(boardCall(record));
        const l2Calls = calls(a, false).filter((c) => c === call);
        const l1Calls = calls(b, true).filter((c) => c === call);
        expect(l2Calls.length).toBeLessThanOrEqual(1);
        expect(l1Calls.length).toBeLessThanOrEqual(1);
        // Every L2 transaction is one of the records' calls, every L1 one a deposit of one.
        for (const c of [...calls(a, false), ...calls(b, true)])
          expect(records.map((r) => hex(boardCall(r)))).toContain(c);
        if (ok) {
          expect(l2Calls.length + l1Calls.length).toBeGreaterThan(0);
          if (now >= cutoff - 6_000n) expect(l1Calls).toHaveLength(1);
        }
      }
    }),
    { numRuns },
  );
});

describe("the receipt-batch call (P2-13 part 4b-2b-1)", () => {
  test("is the batch's canonical call with RECEIPT_CALL_GAS, on the availability call's nonces", async () => {
    const sender = await boardSender(options());
    const record = new Uint8Array(104 + 64 * 1024).fill(0xab);
    const availability = randomBytes(106);
    await Promise.all([
      sender.receiptBatch(record, CUTOFF),
      sender.availability(availability, CUTOFF),
    ]);
    const txs = await txsFrom(l2.rpc, w.from);
    expect(txs.map((t) => [t.nonce, t.input, t.gas])).toEqual([
      [0n, hex(batchCall(record)), RECEIPT_CALL_GAS],
      [1n, hex(boardCall(availability)), AVAILABILITY_CALL_GAS],
    ]);
    expect(RECEIPT_CALL_GAS).toBe(4_500_000n);
  });

  test("is deposited from cutoff − forceLead with RECEIPT_CALL_GAS as the deposit's gas limit", async () => {
    const send = (await boardSender(options())).receiptBatch;
    const record = new Uint8Array(104 + 64 * 1024).fill(0xab);
    w.now = CUTOFF - FORCE_LEAD;
    await send(record, CUTOFF);
    const [deposit, ...rest] = await txsFrom(l1.rpc, w.from);
    expect(rest).toEqual([]);
    if (deposit === undefined) expect.fail("the batch was deposited");
    expect(deposit.to).toBe(hex(PORTAL));
    expect(depositOf(deposit)).toEqual({
      to: hex(BOARD),
      value: 0n,
      gasLimit: RECEIPT_CALL_GAS,
      isCreation: false,
      data: hex(batchCall(record)),
    });
  });
});

describe("the complaint-batch call (P2-13 part 4b-3b)", () => {
  const complaintCall = (record: Uint8Array) => batchCall(record, "submitComplaintBatch(bytes)");

  test("is the batch's canonical call with COMPLAINT_CALL_GAS, on the other calls' nonces", async () => {
    const sender = await boardSender(options());
    const record = new Uint8Array(104 + 128 * 512).fill(0xcd);
    const receipts = new Uint8Array(104 + 64).fill(0xab);
    await Promise.all([
      sender.complaintBatch(record, CUTOFF),
      sender.receiptBatch(receipts, CUTOFF),
    ]);
    const txs = await txsFrom(l2.rpc, w.from);
    expect(txs.map((t) => [t.nonce, t.input, t.gas])).toEqual([
      [0n, hex(complaintCall(record)), COMPLAINT_CALL_GAS],
      [1n, hex(batchCall(receipts)), RECEIPT_CALL_GAS],
    ]);
    expect(COMPLAINT_CALL_GAS).toBe(5_000_000n);
  });

  test("is deposited from cutoff − forceLead with COMPLAINT_CALL_GAS as the deposit's gas limit", async () => {
    const send = (await boardSender(options())).complaintBatch;
    const record = new Uint8Array(104 + 128 * 512).fill(0xcd);
    w.now = CUTOFF - FORCE_LEAD;
    await send(record, CUTOFF);
    const [deposit, ...rest] = await txsFrom(l1.rpc, w.from);
    expect(rest).toEqual([]);
    if (deposit === undefined) expect.fail("the batch was deposited");
    expect(deposit.to).toBe(hex(PORTAL));
    expect(depositOf(deposit)).toEqual({
      to: hex(BOARD),
      value: 0n,
      gasLimit: COMPLAINT_CALL_GAS,
      isCreation: false,
      data: hex(complaintCall(record)),
    });
  });
});
