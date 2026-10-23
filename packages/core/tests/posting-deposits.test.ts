import { CONTRACT_EVENT_WINDOW, deliveryDeadlines, intakeCutoff } from "@abolishus/crypto";
import { PINNED_FORCED_INCLUSION, PINNED_MARGIN } from "@abolishus/verifier";
import { randomBytes } from "node:crypto";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  POSTING_CANCEL_GAS,
  POSTING_DEPOSIT_PATIENCE,
  POSTING_DEPOSIT_SPAN,
  POSTING_FORCE_AFTER,
  POSTING_HEAD_AGE,
  POSTING_L1_GAS_LIMIT_MAX,
  POSTING_RESEND,
  postingCapacityIntervals,
  type PostingCosts,
  type PostingDepositChain,
  postingDepositFeeCap,
  postingDepositGasLimit,
  type PostingDepositReport,
  postingDepositReserve,
  type PostingElectionTimes,
  type PostingKeyChain,
  type PostingL1Receipt,
  postingLandingClear,
  type PostingReceipt,
  type PostingSigned,
  type PostingToSend,
  postingWindows,
  PostgresPostingDeposits,
  PostgresPostingLedger,
} from "../src/index.ts";
import { type TestDb, testDb } from "./db.ts";

// The posting relay's forced path through L1 against a live Postgres
// (docs/spec/posting-relay.md, Forced through L1, Depositing and Pruning;
// ADR 0042, rule 5): a posting out of the L2's safe head for
// POSTING_FORCE_AFTER is deposited only on a fresh L1 head, by the deposit
// cutoff and outside every Capacity interval (T-50, T-54); at most one L1
// transaction of the key is pending; each deposit's reserve is counted
// within the budget and replaced by its receipt once final (T-52); a
// deposit waiting too long, or whose posting's entry is gone, is cancelled
// (T-18, T-54); and a landed deposit is never sent again.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const CLOSES_AT = 1_900_000_000n;
const BOUND = 3_600n;
const CONSTANTS = { forcedInclusion: PINNED_FORCED_INCLUSION, margin: PINNED_MARGIN };
const WINDOWS = postingWindows(CLOSES_AT, BOUND, CONSTANTS);
const C_F = WINDOWS.deposit;
// Sent at NOW; due a deposit from DUE.
const NOW = 1_850_000_000;
const DUE = NOW + Number(POSTING_FORCE_AFTER);
const FEE_CAP = 1_000_000n;
const L1_FEE_CAP = 100n;
const GAS = 500_000n;
const COSTS: PostingCosts = { l1DataFee: 7_000n, deposit: 90_000n };
const MOST = GAS * FEE_CAP + COSTS.l1DataFee + COSTS.deposit;
const ESTIMATE = 1_000_000n;
const L1_GAS = 1_250_000n;
const RESERVE = L1_GAS * L1_FEE_CAP + POSTING_CANCEL_GAS * 2n * L1_FEE_CAP;

let db: TestDb;
let app: Sql;
beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
});
afterAll(() => db?.close());
beforeEach(async () => {
  for (const t of [
    "posting_deposits",
    "posting_in_flight",
    "posting_sent",
    "posting_ballots",
    "posting_spend",
  ])
    await db.admin.unsafe(`DELETE FROM ${t}`);
});

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const bytes32 = () => new Uint8Array(randomBytes(32));

/** The posting key on L2, as the ledger's own tests fake it, reduced to what these need. */
class FakeKey implements PostingKeyChain {
  count = 0n;
  receipts = new Map<string, PostingReceipt>();
  onBoardFinal = new Set<string>();
  async nonce() {
    return this.count;
  }
  async costs() {
    return COSTS;
  }
  async sign(): Promise<PostingSigned> {
    return {
      tx: new Uint8Array(randomBytes(120)),
      hash: bytes32(),
      maxFee: FEE_CAP,
      priorityFee: 1n,
    };
  }
  async broadcast() {
    return "sent" as const;
  }
  async receipt(hash: Uint8Array) {
    return this.receipts.get(hex(hash));
  }
  async posted() {
    return false;
  }
  async postedFinal(posting: Uint8Array) {
    return this.onBoardFinal.has(hex(posting));
  }
}

type DepositOptions = Parameters<PostingDepositChain["signDeposit"]>[2];
type CancelOptions = Parameters<PostingDepositChain["signCancel"]>[0];

/** A fake posting key on L1, with the L2's safe head: records what it was asked, and can be told to fail. */
class FakeL1 implements PostingDepositChain {
  count = 0n;
  estimateOf: bigint | undefined = ESTIMATE;
  fees = { maxFee: 72n, priorityFee: 8n };
  /** L2 transactions, and postings, in hex, at the L2's safe head. */
  safe = new Set<string>();
  postedAtSafe = new Set<string>();
  deposits: { options: DepositOptions; hash: Uint8Array; tx: Uint8Array }[] = [];
  cancels: { options: CancelOptions; hash: Uint8Array; tx: Uint8Array }[] = [];
  broadcasts: Uint8Array[] = [];
  receipts = new Map<string, PostingL1Receipt>();
  estimates = 0;
  fail: Partial<Record<"nonce" | "estimate" | "sign" | "receipt" | "safe", Error>> = {};

  async includedSafe(hash: Uint8Array) {
    if (this.fail.safe) throw this.fail.safe;
    return this.safe.has(hex(hash));
  }
  async postedSafe(posting: Uint8Array) {
    if (this.fail.safe) throw this.fail.safe;
    return this.postedAtSafe.has(hex(posting));
  }
  async nonce() {
    if (this.fail.nonce) throw this.fail.nonce;
    return this.count;
  }
  async estimate() {
    this.estimates++;
    if (this.fail.estimate) throw this.fail.estimate;
    return this.estimateOf;
  }
  async signDeposit(_p: Uint8Array, _b: Uint8Array, options: DepositOptions) {
    if (this.fail.sign) throw this.fail.sign;
    const s = {
      tx: new Uint8Array(randomBytes(150)),
      hash: bytes32(),
      ...(options.fees ?? this.fees),
    };
    this.deposits.push({ options, hash: s.hash, tx: s.tx });
    return s;
  }
  async signCancel(options: CancelOptions) {
    if (this.fail.sign) throw this.fail.sign;
    const s = { tx: new Uint8Array(randomBytes(110)), hash: bytes32(), ...options.fees };
    this.cancels.push({ options, hash: s.hash, tx: s.tx });
    return s;
  }
  async broadcast(tx: Uint8Array) {
    this.broadcasts.push(tx);
    return "sent" as const;
  }
  async receipt(hash: Uint8Array) {
    if (this.fail.receipt) throw this.fail.receipt;
    return this.receipts.get(hex(hash));
  }
}

const ELECTION = bytes32();

function toSend(over: Partial<PostingToSend> = {}): PostingToSend {
  return {
    key: hex(bytes32()),
    posting: new Uint8Array(randomBytes(300)),
    ballot: new Uint8Array(randomBytes(900)),
    electionId: ELECTION,
    definitionHash: bytes32(),
    ballotHash: bytes32(),
    tier: 2,
    nullifier: BigInt(`0x${hex(bytes32())}`),
    gasLimit: GAS,
    closesAt: CLOSES_AT,
    l1InclusionBound: BOUND,
    ...over,
  };
}

const l2 = new FakeKey();
const ledger = (o: { now?: number; chain?: FakeKey } = {}) =>
  new PostgresPostingLedger({
    sql: app,
    chain: o.chain ?? l2,
    budget: 10n ** 18n,
    feeCap: FEE_CAP,
    now: () => o.now ?? NOW,
  });

function deposits(
  chain: FakeL1,
  o: {
    now?: number | (() => number);
    budget?: bigint;
    times?: readonly PostingElectionTimes[] | undefined;
    sql?: Sql;
  } = {},
) {
  const now = o.now;
  return new PostgresPostingDeposits({
    sql: o.sql ?? app,
    chain,
    elections: { times: async () => ("times" in o ? o.times : []) },
    budget: o.budget ?? 10n ** 18n,
    l1FeeCap: L1_FEE_CAP,
    now: typeof now === "function" ? now : () => now ?? DUE,
  });
}

/** Fresh L1 heads at `at`. */
const heads = (at: number | bigint, finalized = 0n) => ({
  latest: { number: 100n, timestamp: BigInt(at) },
  finalized: { number: finalized, timestamp: 0n },
});

const report = (over: Partial<PostingDepositReport> = {}): PostingDepositReport => ({
  deposited: 0,
  held: 0,
  rebroadcast: 0,
  replaced: 0,
  cancelled: 0,
  landed: 0,
  failed: 0,
  unsettled: 0,
  final: 0,
  consumed: 0,
  released: 0,
  unjudged: 0,
  errors: 0,
  ...over,
});

async function sent(p: PostingToSend = toSend()) {
  const outcome = await ledger().send(p);
  if (!outcome.sent) throw new Error("not sent");
  return { p, l2Hash: outcome.transaction };
}

const spent = async (election = ELECTION) => {
  const [r] = await db.admin`SELECT spent::text FROM posting_spend WHERE election_id = ${election}`;
  return r === undefined ? undefined : BigInt(r["spent"] as string);
};
const record = async (p: PostingToSend) => ledger().sent(p.key);
const rows = () => db.admin`SELECT * FROM posting_deposits ORDER BY nonce`;
const entryOf = async (p: PostingToSend) => {
  const [r] = await db.admin`
    SELECT cost::text, deposit::text FROM posting_in_flight WHERE posting_key = ${Buffer.from(p.key, "hex")}`;
  return r;
};

describe("values", () => {
  test("a deposit's gas limit is its estimate times 5/4, rounded up", () => {
    expect(postingDepositGasLimit(ESTIMATE)).toBe(L1_GAS);
    expect(postingDepositGasLimit(4n)).toBe(5n);
    expect(postingDepositGasLimit(5n)).toBe(7n);
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 1n << 64n }), (e) => {
        const g = postingDepositGasLimit(e);
        expect(4n * g >= 5n * e && 4n * (g - 1n) < 5n * e).toBe(true);
      }),
      { numRuns },
    );
  });

  test("a reserve is the gas limit at the L1 fee cap and a cancellation at twice it", () => {
    expect(postingDepositReserve(L1_GAS, L1_FEE_CAP)).toBe(RESERVE);
  });

  test("a deposit's first fee is the largest whose rise by an eighth is within the cap", () => {
    expect(postingDepositFeeCap(100n)).toBe(88n);
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 1n << 80n }), (cap) => {
        const f = postingDepositFeeCap(cap);
        const raised = (x: bigint) => x + (x + 7n) / 8n;
        expect(raised(f) <= cap && raised(f + 1n) > cap).toBe(true);
      }),
      { numRuns },
    );
  });

  test("an election's intervals are c_I to c_D and t_D + W_C to c_K, half-open", () => {
    const t = { closesAt: CLOSES_AT, l1InclusionBound: BOUND };
    const { delivery, complaint } = deliveryDeadlines(CLOSES_AT, BOUND);
    expect(postingCapacityIntervals(t, CONSTANTS)).toEqual([
      { from: intakeCutoff(CLOSES_AT, BOUND, CONSTANTS), to: delivery - PINNED_FORCED_INCLUSION },
      { from: delivery + CONTRACT_EVENT_WINDOW, to: complaint - PINNED_FORCED_INCLUSION },
    ]);
  });

  test("a landing span is clear of an interval only if they share no second", () => {
    const i = { from: 1_000n, to: 2_000n };
    expect(postingLandingClear(1_000n - POSTING_DEPOSIT_SPAN, [i])).toBe(true);
    expect(postingLandingClear(1_001n - POSTING_DEPOSIT_SPAN, [i])).toBe(false);
    expect(postingLandingClear(1_999n, [i])).toBe(false);
    expect(postingLandingClear(2_000n, [i])).toBe(true);
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000n }),
        fc.bigInt({ min: 0n, max: 10_000n }),
        fc.bigInt({ min: 0n, max: 2_000n }),
        (T, from, length) => {
          const clear = postingLandingClear(T, [{ from, to: from + length }]);
          let meets = false;
          for (let s = T; s < T + POSTING_DEPOSIT_SPAN; s++)
            if (s >= from && s < from + length) meets = true;
          expect(clear).toBe(!meets);
        },
      ),
      { numRuns: Math.min(numRuns, 200) },
    );
  });
});

describe("depositing", () => {
  test("a posting out of the safe head for POSTING_FORCE_AFTER is deposited, its reserve counted", async () => {
    const { p } = await sent();
    const chain = new FakeL1();
    chain.count = 4n;
    expect(await deposits(chain, { now: DUE - 1 }).tend(heads(DUE - 1))).toEqual(report());
    expect(await deposits(chain).tend(heads(DUE))).toEqual(report({ deposited: 1 }));
    expect(chain.deposits.map((d) => d.options)).toEqual([
      { nonce: 4n, gasLimit: GAS, l1GasLimit: L1_GAS, feeCap: postingDepositFeeCap(L1_FEE_CAP) },
    ]);
    const d = chain.deposits[0]!;
    expect(chain.broadcasts).toEqual([d.tx]);
    // The first deposit raises the reserve its first send counted to its own.
    expect(await spent()).toBe(MOST - COSTS.deposit + RESERVE);
    expect(await entryOf(p)).toEqual({
      cost: String(MOST - COSTS.deposit + RESERVE),
      deposit: String(RESERVE),
    });
    expect(await record(p)).toEqual({ transaction: d.hash, layer: "l1" });
    const [row] = await rows();
    expect(row).toMatchObject({
      nonce: "4",
      l1_gas_limit: String(L1_GAS),
      landing_from: String(DUE),
      reserve: String(RESERVE),
      max_fee: "72",
      priority_fee: "8",
      signed_at: String(DUE),
      broadcast_at: String(DUE),
      settled_in: null,
      final: false,
    });
    expect(new Uint8Array(row!["signed"])).toEqual(d.tx);
  });

  test("nothing is deposited for a posting at the safe head, its call or its event", async () => {
    const a = await sent();
    const b = await sent();
    const chain = new FakeL1();
    chain.safe.add(hex(a.l2Hash));
    chain.postedAtSafe.add(hex(b.p.posting));
    expect(await deposits(chain).tend(heads(DUE))).toEqual(report());
    expect(chain.deposits).toHaveLength(0);
  });

  test("a deposit is judged only on an L1 head within POSTING_HEAD_AGE and never ahead of the clock", async () => {
    await sent();
    const chain = new FakeL1();
    const late = DUE + POSTING_HEAD_AGE + 1;
    expect(await deposits(chain, { now: late }).tend(heads(DUE))).toEqual(report());
    expect(await deposits(chain).tend(heads(DUE + 1))).toEqual(report());
    expect(chain.deposits).toHaveLength(0);
    expect(await deposits(chain, { now: DUE + POSTING_HEAD_AGE }).tend(heads(DUE))).toEqual(
      report({ deposited: 1 }),
    );
  });

  test("a deposit's landing span must end by the deposit cutoff", async () => {
    await sent();
    const chain = new FakeL1();
    const edge = Number(C_F - POSTING_DEPOSIT_SPAN);
    expect(await deposits(chain, { now: edge + 1 }).tend(heads(edge + 1))).toEqual(report());
    expect(await deposits(chain, { now: edge }).tend(heads(edge))).toEqual(
      report({ deposited: 1 }),
    );
  });

  test("a posting due inside any election's interval waits for its end", async () => {
    await sent();
    const chain = new FakeL1();
    // Another election whose receipt interval starts inside the span.
    const other = { closesAt: CLOSES_AT - 10n ** 6n, l1InclusionBound: BOUND };
    const [receipts] = postingCapacityIntervals(other, CONSTANTS);
    const T = Number(receipts.from) - 1;
    expect(await deposits(chain, { now: T, times: [other] }).tend(heads(T))).toEqual(report());
    expect(chain.estimates).toBe(0);
    const after = Number(receipts.to);
    if (BigInt(after) + POSTING_DEPOSIT_SPAN > C_F)
      throw new Error("the fixture's interval ends too late");
    expect(await deposits(chain, { now: after, times: [other] }).tend(heads(after))).toEqual(
      report({ deposited: 1 }),
    );
  });

  test("an election whose times can't be read stops every deposit", async () => {
    await sent();
    const chain = new FakeL1();
    expect(await deposits(chain, { times: undefined }).tend(heads(DUE))).toEqual(
      report({ unjudged: 1 }),
    );
    expect(chain.estimates).toBe(0);
    expect(chain.deposits).toHaveLength(0);
  });

  test("an estimate that reverts or passes EIP-7825's cap sends no deposit", async () => {
    await sent();
    const chain = new FakeL1();
    chain.estimateOf = undefined;
    expect(await deposits(chain).tend(heads(DUE))).toEqual(report());
    // The largest estimate within the cap, and the next.
    const largest = (POSTING_L1_GAS_LIMIT_MAX * 4n) / 5n;
    expect(postingDepositGasLimit(largest) <= POSTING_L1_GAS_LIMIT_MAX).toBe(true);
    chain.estimateOf = largest + 1n;
    expect(postingDepositGasLimit(largest + 1n) > POSTING_L1_GAS_LIMIT_MAX).toBe(true);
    expect(await deposits(chain).tend(heads(DUE))).toEqual(report());
    expect(chain.deposits).toHaveLength(0);
    chain.estimateOf = largest;
    expect(await deposits(chain).tend(heads(DUE))).toEqual(report({ deposited: 1 }));
    expect(chain.deposits[0]!.options.l1GasLimit).toBe(postingDepositGasLimit(largest));
  });

  test("the budget holds a deposit it can't cover, its edge included", async () => {
    await sent();
    const chain = new FakeL1();
    const edge = MOST - COSTS.deposit + RESERVE;
    expect(await deposits(chain, { budget: edge - 1n }).tend(heads(DUE))).toEqual(
      report({ held: 1 }),
    );
    expect(await spent()).toBe(MOST);
    expect(await deposits(chain, { budget: edge }).tend(heads(DUE))).toEqual(
      report({ deposited: 1 }),
    );
  });

  test("at most one L1 transaction of the key is pending, the oldest posting first", async () => {
    const a = await sent();
    const b = await sent();
    const chain = new FakeL1();
    await deposits(chain).tend(heads(DUE));
    expect(await deposits(chain, { now: DUE + 1 }).tend(heads(DUE + 1))).toEqual(report());
    expect(chain.deposits).toHaveLength(1);
    expect(await record(a.p)).toMatchObject({ layer: "l1" });
    expect(await record(b.p)).toMatchObject({ layer: "l2" });
  });

  test("two tends at once sign one deposit", async () => {
    await sent();
    await sent();
    const chain = new FakeL1();
    const second = await db.as("abolish_app");
    await Promise.all([
      deposits(chain).tend(heads(DUE)),
      deposits(chain, { sql: second }).tend(heads(DUE)),
    ]);
    expect(chain.deposits).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
  });

  test("a node failure leaves nothing signed or recorded", async () => {
    const { p } = await sent();
    for (const k of ["nonce", "estimate", "sign", "safe"] as const) {
      const chain = new FakeL1();
      chain.fail[k] = new Error("node https://key@example down");
      expect(await deposits(chain).tend(heads(DUE))).toEqual(report({ errors: 1 }));
      expect(chain.broadcasts).toHaveLength(0);
    }
    expect(await rows()).toHaveLength(0);
    expect(await spent()).toBe(MOST);
    expect(await record(p)).toMatchObject({ layer: "l2" });
  });

  test("refuses heads and settings out of range", async () => {
    const chain = new FakeL1();
    await expect(deposits(chain).tend(heads(-1n))).rejects.toThrow(RangeError);
    expect(
      () =>
        new PostgresPostingDeposits({
          sql: app,
          chain,
          elections: { times: async () => [] },
          budget: 1n,
          l1FeeCap: 0n,
          now: () => DUE,
        }),
    ).toThrow(RangeError);
  });
});

describe("tending", () => {
  /** A posting deposited at DUE at nonce 0. */
  async function deposited() {
    const s = await sent();
    const chain = new FakeL1();
    await deposits(chain).tend(heads(DUE));
    chain.broadcasts = [];
    return { ...s, chain, deposit: chain.deposits[0]! };
  }
  const at = (chain: FakeL1, t: number, finalized = 0n) =>
    deposits(chain, { now: t }).tend(heads(t, finalized));

  test("a pending deposit is rebroadcast every POSTING_RESEND and replaced after twice that", async () => {
    const { p, chain, deposit } = await deposited();
    const R = Number(POSTING_RESEND);
    expect(await at(chain, DUE + R - 1)).toEqual(report());
    expect(await at(chain, DUE + R)).toEqual(report({ rebroadcast: 1 }));
    expect(chain.broadcasts).toEqual([deposit.tx]);
    expect(await at(chain, DUE + 2 * R)).toEqual(report({ replaced: 1 }));
    const replacement = chain.deposits[1]!;
    expect(replacement.options).toMatchObject({
      nonce: 0n,
      fees: { maxFee: 81n, priorityFee: 9n },
    });
    expect(chain.broadcasts).toEqual([deposit.tx, replacement.tx]);
    expect(await record(p)).toEqual({ transaction: replacement.hash, layer: "l1" });
    // Raised once more it could no longer be replaced within the cap and
    // cancelled above it: only rebroadcast.
    expect(await at(chain, DUE + 4 * R)).toEqual(report({ rebroadcast: 1 }));
    expect(chain.deposits).toHaveLength(2);
  });

  test("a deposit not in an L1 block POSTING_DEPOSIT_PATIENCE after its head is cancelled, by the clock or the head", async () => {
    const { p, chain, deposit } = await deposited();
    const P = Number(POSTING_DEPOSIT_PATIENCE);
    // The head stalled: the clock decides.
    expect(await deposits(chain, { now: DUE + P }).tend(heads(DUE))).toEqual(
      report({ cancelled: 1 }),
    );
    expect(chain.cancels.map((c) => c.options)).toEqual([
      { nonce: 0n, fees: { maxFee: 81n, priorityFee: 9n } },
    ]);
    expect(chain.broadcasts).toEqual([chain.cancels[0]!.tx]);
    // Still racing the deposit: the record names it until the nonce settles.
    expect(await record(p)).toEqual({ transaction: deposit.hash, layer: "l1" });
    // Its replacements go up to twice the L1 fee cap.
    const R = Number(POSTING_RESEND);
    let t = DUE + P;
    for (let i = 0; i < 12; i++) await at(chain, (t += 2 * R));
    const fees = chain.cancels.map((c) => c.options.fees.maxFee);
    expect(fees.every((f) => f <= 2n * L1_FEE_CAP)).toBe(true);
    expect(fees.at(-1)! + (fees.at(-1)! + 7n) / 8n > 2n * L1_FEE_CAP).toBe(true);
  });

  test("a landed deposit stays named and is never sent again, whatever lands on L2", async () => {
    const { p, l2Hash, chain, deposit } = await deposited();
    chain.receipts.set(hex(deposit.hash), {
      success: true,
      gasUsed: 900_000n,
      effectiveGasPrice: 30n,
      block: 90n,
    });
    chain.count = 1n;
    expect(await at(chain, DUE + 1)).toEqual(report({ landed: 1 }));
    expect(await record(p)).toEqual({ transaction: deposit.hash, layer: "l1" });
    // Its L2 call lands too: the record still names the deposit.
    const key = new FakeKey();
    key.count = 1n;
    key.receipts.set(hex(l2Hash), { gasUsed: 400_000n, effectiveGasPrice: 2n, l1Fee: 5n });
    await ledger({ chain: key, now: DUE + 2 }).tend({ number: 1n, timestamp: BigInt(DUE + 2) });
    expect(await record(p)).toEqual({ transaction: deposit.hash, layer: "l1" });
    // Its call left the safe head, and later heads: never deposited again.
    expect(await at(chain, DUE + 1000)).toEqual(report());
    expect(chain.deposits).toHaveLength(1);
  });

  test("a reverted deposit names the L2 call again and may be deposited again, its reserve added whole", async () => {
    const { p, l2Hash, chain, deposit } = await deposited();
    chain.receipts.set(hex(deposit.hash), {
      success: false,
      gasUsed: 50_000n,
      effectiveGasPrice: 30n,
      block: 90n,
    });
    chain.count = 1n;
    expect(await at(chain, DUE + 1)).toEqual(report({ failed: 1, deposited: 1 }));
    expect(chain.deposits.map((d) => d.options.nonce)).toEqual([0n, 1n]);
    // Named the L2 call between them; now the new deposit.
    expect(await record(p)).toEqual({ transaction: chain.deposits[1]!.hash, layer: "l1" });
    expect(await spent()).toBe(MOST - COSTS.deposit + 2n * RESERVE);
    expect(l2Hash).toHaveLength(32);
  });

  test("a mined cancellation settles the nonce as failed and names the L2 call", async () => {
    const { p, l2Hash, chain } = await deposited();
    await at(chain, DUE + Number(POSTING_DEPOSIT_PATIENCE));
    chain.receipts.set(hex(chain.cancels[0]!.hash), {
      success: true,
      gasUsed: 21_000n,
      effectiveGasPrice: 90n,
      block: 91n,
    });
    chain.count = 1n;
    // Past c_F nothing is deposited again.
    const late = Number(C_F);
    expect(await at(chain, late)).toEqual(report({ failed: 1, released: 0 }));
    expect(await record(p)).toEqual({ transaction: l2Hash, layer: "l2" });
  });

  test("once final, a nonce's reserve is replaced by its receipt; a block that leaves the head unsettles it", async () => {
    const { p, chain, deposit } = await deposited();
    const receipt = { success: true, gasUsed: 900_000n, effectiveGasPrice: 30n, block: 90n };
    chain.receipts.set(hex(deposit.hash), receipt);
    chain.count = 1n;
    await at(chain, DUE + 1);
    // Reorganised away before it was final: pending again.
    chain.receipts.delete(hex(deposit.hash));
    expect(await at(chain, DUE + 2)).toEqual(report({ unsettled: 1 }));
    chain.receipts.set(hex(deposit.hash), receipt);
    expect(await at(chain, DUE + 3, 89n)).toEqual(report({ landed: 1 }));
    expect(await at(chain, DUE + 4, 89n)).toEqual(report());
    expect(await spent()).toBe(MOST - COSTS.deposit + RESERVE);
    expect(await at(chain, DUE + 5, 90n)).toEqual(report({ final: 1 }));
    expect(await spent()).toBe(MOST - COSTS.deposit + 27_000_000n);
    expect(await entryOf(p)).toEqual({ cost: String(MOST - COSTS.deposit), deposit: "0" });
    expect(await at(chain, DUE + 6, 90n)).toEqual(report());
  });

  test("a nonce another transaction took settles with nothing paid, its reserve released", async () => {
    const { p, l2Hash, chain } = await deposited();
    chain.count = 1n;
    const late = Number(C_F);
    expect(await at(chain, late)).toEqual(report({ consumed: 1 }));
    expect(await spent()).toBe(MOST - COSTS.deposit);
    expect(await record(p)).toEqual({ transaction: l2Hash, layer: "l2" });
  });

  test("a reserve no deposit used is released once the L1 head passes c_F", async () => {
    const { p } = await sent();
    const chain = new FakeL1();
    chain.estimateOf = undefined;
    const edge = Number(C_F);
    expect(await deposits(chain, { now: edge }).tend(heads(edge))).toEqual(report());
    expect(await spent()).toBe(MOST);
    // Never on a head ahead of the clock.
    expect(await deposits(chain, { now: edge }).tend(heads(edge + 1))).toEqual(report());
    expect(await deposits(chain, { now: edge + 1 }).tend(heads(edge + 1))).toEqual(
      report({ released: 1 }),
    );
    expect(await spent()).toBe(MOST - COSTS.deposit);
    expect(await entryOf(p)).toEqual({ cost: String(MOST - COSTS.deposit), deposit: "0" });
  });

  test("a posting final on L2 drops its signed deposit, which is cancelled at once, and the nonce once final", async () => {
    const { p, chain, deposit } = await deposited();
    const key = new FakeKey();
    key.count = 1n;
    key.onBoardFinal.add(hex(p.posting));
    const pruned = await ledger({ chain: key, now: DUE + 10 }).prune({
      number: 1n,
      timestamp: BigInt(DUE),
    });
    expect(pruned.final).toBe(1);
    const [row] = await rows();
    expect(row!["signed"]).toBeNull();
    // Its nonce holds its reserve; nothing else of the entry's is left.
    expect(await spent()).toBe(MOST - COSTS.deposit + RESERVE);
    expect(await at(chain, DUE + 11)).toEqual(report({ cancelled: 1 }));
    expect(chain.broadcasts).toEqual([chain.cancels[0]!.tx]);
    chain.receipts.set(hex(deposit.hash), {
      success: true,
      gasUsed: 900_000n,
      effectiveGasPrice: 30n,
      block: 90n,
    });
    chain.count = 1n;
    expect(await at(chain, DUE + 12, 90n)).toEqual(report({ landed: 1 }));
    expect(await at(chain, DUE + 13, 90n)).toEqual(report({ final: 1 }));
    expect(await rows()).toHaveLength(0);
    expect(await spent()).toBe(MOST - COSTS.deposit + 27_000_000n);
  });

  test("a failing node leaves a nonce as it was and counts it", async () => {
    const { chain, deposit } = await deposited();
    chain.fail.receipt = new Error("down");
    expect(await at(chain, DUE + Number(POSTING_DEPOSIT_PATIENCE))).toEqual(report({ errors: 1 }));
    expect(chain.cancels).toHaveLength(0);
    const [row] = await rows();
    expect(new Uint8Array(row!["signed"])).toEqual(deposit.tx);
  });

  test("whatever settles, the spend is what the entries and the nonces count", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.constantFrom("land", "revert", "cancel", "consume", "final", "unsettle", "wait"),
          {
            maxLength: 8,
          },
        ),
        async (steps) => {
          for (const t of [
            "posting_deposits",
            "posting_in_flight",
            "posting_sent",
            "posting_ballots",
            "posting_spend",
          ])
            await db.admin.unsafe(`DELETE FROM ${t}`);
          await sent();
          const chain = new FakeL1();
          let t = DUE;
          let block = 10n;
          for (const step of steps) {
            const [row] =
              await db.admin`SELECT * FROM posting_deposits WHERE settled_in IS NULL AND NOT final`;
            if (row !== undefined) {
              const deposit = new Uint8Array(row["deposits"]).subarray(-32);
              const cancels = new Uint8Array(row["cancels"]);
              if (step === "land" || step === "revert")
                chain.receipts.set(hex(deposit), {
                  success: step === "land",
                  gasUsed: 100_000n,
                  effectiveGasPrice: 7n,
                  block: block++,
                });
              if (step === "cancel" && cancels.length > 0)
                chain.receipts.set(hex(cancels.subarray(-32)), {
                  success: true,
                  gasUsed: 21_000n,
                  effectiveGasPrice: 7n,
                  block: block++,
                });
              if (step === "consume") chain.count++;
            }
            if (step === "unsettle") chain.receipts.clear();
            if (step === "land" || step === "revert" || step === "cancel") chain.count++;
            t += 200;
            await deposits(chain, { now: t }).tend(heads(t, step === "final" ? block : 0n));
          }
          // The spend is the entry's L2 most cost, what its final nonces
          // paid, and its counted reserve, which its unfinal nonces hold
          // whole once it has any.
          const [entry] = await db.admin`SELECT cost::text, deposit::text FROM posting_in_flight`;
          const nonces = await rows();
          const cost = BigInt(entry!["cost"]);
          const counted = BigInt(entry!["deposit"]);
          const sum = (f: (r: (typeof nonces)[number]) => boolean, c: string) =>
            nonces.filter(f).reduce((a, r) => a + BigInt(r[c]), 0n);
          const held = sum((r) => !r["final"], "reserve");
          if (nonces.length > 0) expect(counted).toBe(held);
          expect(await spent()).toBe(cost - counted + sum((r) => r["final"], "paid") + counted);
        },
      ),
      { numRuns: Math.min(numRuns, 50) },
    );
  });
});
