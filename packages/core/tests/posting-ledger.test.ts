import { DELIVERY_WINDOW, intakeCutoff } from "@abolishus/crypto";
import { PINNED_FORCED_INCLUSION, PINNED_MARGIN } from "@abolishus/verifier";
import { randomBytes } from "node:crypto";
import { getTableConfig } from "drizzle-orm/pg-core";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  POSTING_BALLOT_CAP,
  POSTING_CLIENT_MARGIN,
  POSTING_FINALITY,
  POSTING_FORCE_AFTER,
  POSTING_GAS_LIMIT_MAX,
  POSTING_RESEND,
  POSTING_SEND_MARGIN,
  postingBallots,
  type PostingCosts,
  postingInFlight,
  type PostingKeyChain,
  PostingLedgerError,
  postingMostCost,
  type PostingReceipt,
  postingSent,
  type PostingSigned,
  postingSpend,
  type PostingToSend,
  postingWindows,
  PostgresPostingLedger,
} from "../src/index.ts";
import { type TestDb, testDb } from "./db.ts";

// The posting relay's ledger against a live Postgres
// (docs/spec/posting-relay.md, Sending, steps 2, 5 and 6, Caps and In
// flight; ADR 0042, rules 4 and 5): a posting is paid for at most once, also
// by two ledgers at once (T-52); at most POSTING_BALLOT_CAP ballot hashes per
// election and (`tier`, `ν`) and the election budget bound the spend
// (T-13, T-52); the record is committed before anything is broadcast, and
// nothing rejects once it has been; a failure before that leaves nothing.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const CLOSES_AT = 1_900_000_000n;
const BOUND = 3_600n;
const T_D = CLOSES_AT + BOUND + DELIVERY_WINDOW;
const C_D = T_D - PINNED_FORCED_INCLUSION;
const C_I = intakeCutoff(CLOSES_AT, BOUND, {
  forcedInclusion: PINNED_FORCED_INCLUSION,
  margin: PINNED_MARGIN,
});
const C_P = C_D - POSTING_CLIENT_MARGIN;
const C_F = [C_I, C_P - PINNED_FORCED_INCLUSION - POSTING_FINALITY].reduce((a, b) =>
  a < b ? a : b,
);
const NOW = 1_850_000_000;
const FEE_CAP = 1_000_000n;
const GAS = 500_000n;
const COSTS: PostingCosts = { l1DataFee: 7_000n, deposit: 90_000n };
const MOST = GAS * FEE_CAP + COSTS.l1DataFee + COSTS.deposit;

let db: TestDb;
let app: Sql;
beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
});
afterAll(() => db?.close());
beforeEach(async () => {
  await db.admin`DELETE FROM posting_in_flight`;
  await db.admin`DELETE FROM posting_sent`;
  await db.admin`DELETE FROM posting_ballots`;
  await db.admin`DELETE FROM posting_spend`;
});

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const bytes32 = () => new Uint8Array(randomBytes(32));

type SignOptions = {
  nonce: bigint;
  gasLimit: bigint;
  feeCap: bigint;
  fees?: { maxFee: bigint; priorityFee: bigint };
};

/** A fake posting key: records what it was asked, and can be told to fail. */
class FakeKey implements PostingKeyChain {
  count = 0n;
  costsOf: PostingCosts = COSTS;
  fees = { maxFee: FEE_CAP, priorityFee: 1_000n };
  signed: SignOptions[] = [];
  /** Each signed transaction's hash, by its bytes in hex. */
  hashes = new Map<string, Uint8Array>();
  broadcasts: Uint8Array[] = [];
  /** Receipts at the latest head, by transaction hash in hex. */
  receipts = new Map<string, PostingReceipt>();
  /** Postings, in hex, in a `SharePosted` event at the latest head. */
  onBoard = new Set<string>();
  fail: Partial<Record<"nonce" | "costs" | "sign" | "broadcast" | "receipt" | "posted", Error>> =
    {};
  /** Fees a replacement is signed with, if not the ones asked for. */
  otherFees: { maxFee: bigint; priorityFee: bigint } | undefined;
  answer: "sent" | "refused" = "sent";
  onBroadcast: (() => Promise<void>) | undefined;

  async nonce() {
    if (this.fail.nonce) throw this.fail.nonce;
    return this.count;
  }
  async costs() {
    if (this.fail.costs) throw this.fail.costs;
    return this.costsOf;
  }
  async sign(_posting: Uint8Array, _ballot: Uint8Array, o: SignOptions): Promise<PostingSigned> {
    if (this.fail.sign) throw this.fail.sign;
    this.signed.push(o);
    const tx = new Uint8Array(randomBytes(120));
    const hash = bytes32();
    this.hashes.set(hex(tx), hash);
    const fees = o.fees === undefined ? this.fees : (this.otherFees ?? o.fees);
    return { tx, hash, ...fees };
  }
  async receipt(hash: Uint8Array) {
    if (this.fail.receipt) throw this.fail.receipt;
    return this.receipts.get(hex(hash));
  }
  async posted(posting: Uint8Array) {
    if (this.fail.posted) throw this.fail.posted;
    return this.onBoard.has(hex(posting));
  }
  async broadcast(tx: Uint8Array) {
    await this.onBroadcast?.();
    this.broadcasts.push(tx);
    if (this.fail.broadcast) throw this.fail.broadcast;
    return this.answer;
  }
}

function ledger(
  chain: PostingKeyChain,
  o: {
    budget?: bigint;
    now?: number | (() => number);
    sql?: Sql;
    chainTimeoutMs?: number;
    feeCap?: bigint;
  } = {},
) {
  const now = o.now;
  return new PostgresPostingLedger({
    sql: o.sql ?? app,
    chain,
    budget: o.budget ?? 10n ** 18n,
    feeCap: o.feeCap ?? FEE_CAP,
    now: typeof now === "function" ? now : () => now ?? NOW,
    ...(o.chainTimeoutMs === undefined ? {} : { chainTimeoutMs: o.chainTimeoutMs }),
  });
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

const counts = async () => {
  const [r] = await db.admin`
    SELECT (SELECT count(*) FROM posting_sent)::int AS sent,
      (SELECT count(*) FROM posting_ballots)::int AS ballots,
      (SELECT count(*) FROM posting_spend)::int AS spend,
      (SELECT count(*) FROM posting_in_flight)::int AS in_flight`;
  return r;
};
const spentOf = async (election: Uint8Array) => {
  const [r] = await db.admin`SELECT spent::text FROM posting_spend WHERE election_id = ${election}`;
  return r === undefined ? undefined : BigInt(r["spent"] as string);
};

describe("schema", () => {
  test("the Drizzle tables match the migrated ones", async () => {
    for (const table of [postingSent, postingBallots, postingSpend, postingInFlight]) {
      const config = getTableConfig(table);
      const cols = await db.admin`
        SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = ${db.schema} AND table_name = ${config.name} ORDER BY ordinal_position`;
      expect([
        config.name,
        cols.map((c) => [c["column_name"], c["data_type"], c["is_nullable"]]),
      ]).toEqual([
        config.name,
        config.columns.map((c) => [c.name, c.getSQLType(), c.notNull ? "NO" : "YES"]),
      ]);
    }
  });

  test("the app may read, write and delete the record, and nothing more", async () => {
    const grants = await db.admin`
      SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS p
      FROM information_schema.role_table_grants
      WHERE table_schema = ${db.schema} AND grantee = 'abolish_app' AND table_name LIKE 'posting_%'
      GROUP BY table_name ORDER BY table_name`;
    expect(grants.map((g) => [g["table_name"], g["p"]])).toEqual(
      ["posting_ballots", "posting_in_flight", "posting_sent", "posting_spend"].map((t) => [
        t,
        "DELETE,INSERT,SELECT,UPDATE",
      ]),
    );
  });

  test("two transactions in flight never share a nonce", async () => {
    const chain = new FakeKey();
    await ledger(chain).send(toSend());
    await expect(
      db.admin`INSERT INTO posting_in_flight
        SELECT ${bytes32()}, posting, ballot, election_id, intake_cutoff, contract_cutoff,
          delivery_ends, first_sent, nonce, gas_limit, max_fee, priority_fee, cost, signed, transactions,
          signed_at, broadcast_at, deposit, landed_in, paid
        FROM posting_in_flight`,
    ).rejects.toThrow(/posting_in_flight_nonce/);
  });
});

describe("windows and cost", () => {
  test("the windows follow from the election's close, its bound and the pinned F and R", () => {
    expect(
      postingWindows(CLOSES_AT, BOUND, {
        forcedInclusion: PINNED_FORCED_INCLUSION,
        margin: PINNED_MARGIN,
      }),
    ).toEqual({ delivery: T_D, contract: C_D, intake: C_I, deposit: C_F });
  });

  test("the deposit cutoff is the earlier of c_I and c_P − F − POSTING_FINALITY", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000n }),
        fc.bigInt({ min: 0n, max: 10_000n }),
        (forcedInclusion, margin) => {
          const w = postingWindows(CLOSES_AT, BOUND, { forcedInclusion, margin });
          const late = w.contract - POSTING_CLIENT_MARGIN - forcedInclusion - POSTING_FINALITY;
          expect(w.deposit).toBe(w.intake < late ? w.intake : late);
          expect(w.deposit <= w.intake && w.deposit <= late).toBe(true);
        },
      ),
      { numRuns },
    );
  });

  test("a deposit's cost counts only while the posting may be forced", () => {
    expect(postingMostCost(GAS, FEE_CAP, COSTS, true)).toBe(MOST);
    expect(postingMostCost(GAS, FEE_CAP, COSTS, false)).toBe(MOST - COSTS.deposit);
  });
});

describe("send", () => {
  test("records the posting, its ballot, the spend and the in-flight entry, then broadcasts", async () => {
    const chain = new FakeKey();
    chain.count = 7n;
    const l = ledger(chain);
    const p = toSend({ nullifier: 12345n });
    // The record is committed before the broadcast: another connection sees it.
    let seen;
    chain.onBroadcast = async () => {
      seen = await ledger(new FakeKey(), { sql: db.admin }).sent(p.key);
    };
    const outcome = await l.send(p);
    expect(outcome.sent).toBe(true);
    if (!outcome.sent) return;
    expect(outcome.layer).toBe("l2");
    expect(seen).toEqual({ transaction: outcome.transaction, layer: "l2" });
    expect(chain.signed).toEqual([{ nonce: 7n, gasLimit: GAS, feeCap: FEE_CAP }]);
    expect(chain.broadcasts).toHaveLength(1);
    expect(await l.sent(p.key)).toEqual({ transaction: outcome.transaction, layer: "l2" });
    expect(await spentOf(ELECTION)).toBe(MOST);
    const [row] = await db.admin`SELECT * FROM posting_in_flight`;
    expect(row).toMatchObject({
      intake_cutoff: String(C_I),
      contract_cutoff: String(C_D),
      delivery_ends: String(T_D),
      first_sent: String(NOW),
      nonce: "7",
      gas_limit: String(GAS),
      max_fee: String(FEE_CAP),
      priority_fee: "1000",
      cost: String(MOST),
      deposit: String(COSTS.deposit),
      signed_at: String(NOW),
      broadcast_at: String(NOW),
      landed_in: null,
      paid: null,
    });
    expect(new Uint8Array(row!["posting"])).toEqual(p.posting);
    expect(new Uint8Array(row!["ballot"])).toEqual(p.ballot);
    expect(new Uint8Array(row!["signed"])).toEqual(chain.broadcasts[0]);
    expect(new Uint8Array(row!["transactions"])).toEqual(outcome.transaction);
    const [ballot] = await db.admin`SELECT * FROM posting_ballots`;
    expect(new Uint8Array(ballot!["nullifier"])).toEqual(
      Uint8Array.from(Buffer.from(12345n.toString(16).padStart(64, "0"), "hex")),
    );
    expect(new Uint8Array(ballot!["ballot_hash"])).toEqual(p.ballotHash);
  });

  test("a posting already sent is answered with its transaction and never signed again", async () => {
    const chain = new FakeKey();
    const l = ledger(chain);
    const p = toSend();
    const first = await l.send(p);
    const again = await l.send({ ...p, gasLimit: GAS + 1n });
    expect(again).toEqual(first);
    expect(chain.signed).toHaveLength(1);
    expect(chain.broadcasts).toHaveLength(1);
    expect(await spentOf(ELECTION)).toBe(MOST);
  });

  test("two ledgers sending the same posting at once pay for it once", async () => {
    const a = new FakeKey();
    const b = new FakeKey();
    const other = await db.as("abolish_app");
    const p = toSend();
    const [x, y] = await Promise.all([ledger(a).send(p), ledger(b, { sql: other }).send(p)]);
    expect(x).toEqual(y);
    expect(a.signed.length + b.signed.length).toBe(1);
    expect(await counts()).toEqual({ sent: 1, ballots: 1, spend: 1, in_flight: 1 });
  });

  test("two ledgers sending different postings at once sign at different nonces", async () => {
    const a = new FakeKey();
    const b = new FakeKey();
    a.count = b.count = 3n;
    const other = await db.as("abolish_app");
    await Promise.all([ledger(a).send(toSend()), ledger(b, { sql: other }).send(toSend())]);
    expect(
      [...a.signed, ...b.signed].map((s) => s.nonce).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)),
    ).toEqual([3n, 4n]);
  });

  test("the nonce is past both the chain's count and every transaction in flight", async () => {
    const chain = new FakeKey();
    const l = ledger(chain);
    chain.count = 5n;
    await l.send(toSend());
    await l.send(toSend());
    chain.count = 20n;
    await l.send(toSend());
    chain.count = 0n;
    await l.send(toSend());
    expect(chain.signed.map((s) => s.nonce)).toEqual([5n, 6n, 20n, 21n]);
  });

  test("a broadcast that fails or is refused still answers sent, from the record", async () => {
    for (const set of [
      (c: FakeKey) => (c.fail.broadcast = new Error("node at https://key@example down")),
      (c: FakeKey) => (c.answer = "refused"),
    ]) {
      const chain = new FakeKey();
      set(chain);
      const p = toSend();
      const outcome = await ledger(chain).send(p);
      expect(outcome.sent).toBe(true);
      expect(await ledger(chain).sent(p.key)).toBeDefined();
    }
  });

  test("a failure before the record leaves nothing behind and rejects", async () => {
    for (const step of ["nonce", "costs", "sign"] as const) {
      const chain = new FakeKey();
      // The node's error is replaced: it can quote the node's URL (T-69).
      chain.fail[step] = new Error(`${step} at https://secret@node.example`);
      const error = await ledger(chain)
        .send(toSend())
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PostingLedgerError);
      expect(String((error as Error).message)).not.toContain("secret");
      expect(chain.broadcasts).toEqual([]);
      expect(await counts()).toEqual({ sent: 0, ballots: 0, spend: 0, in_flight: 0 });
    }
  });

  test("a node that never answers is given up on, leaving nothing behind", async () => {
    for (const step of ["nonce", "costs", "sign"] as const) {
      const chain = new FakeKey();
      chain[step] = () => new Promise<never>(() => {});
      await expect(ledger(chain, { chainTimeoutMs: 50 }).send(toSend())).rejects.toThrow(
        PostingLedgerError,
      );
      expect(await counts()).toEqual({ sent: 0, ballots: 0, spend: 0, in_flight: 0 });
    }
    // A broadcast that never answers still answers sent, from the record.
    const chain = new FakeKey();
    chain.broadcast = () => new Promise<never>(() => {});
    expect((await ledger(chain, { chainTimeoutMs: 50 }).send(toSend())).sent).toBe(true);
    expect(await counts()).toEqual({ sent: 1, ballots: 1, spend: 1, in_flight: 1 });
  });

  test("a store failure after signing broadcasts nothing, keeps nothing and quotes nothing", async () => {
    const chain = new FakeKey();
    const l = ledger(chain);
    await l.send(toSend());
    const p = toSend();
    const sign = chain.sign.bind(chain);
    chain.sign = async (posting, ballot, o) => {
      // A row that takes the chosen nonce, as only a write outside the
      // ledger could leave it, so this send's in-flight insert fails.
      await db.admin`INSERT INTO posting_in_flight
        SELECT ${bytes32()}, posting, ballot, election_id, intake_cutoff, contract_cutoff,
          delivery_ends, first_sent, ${o.nonce.toString()}, gas_limit, max_fee, priority_fee,
          cost, signed, transactions, signed_at, broadcast_at, deposit, landed_in, paid
        FROM posting_in_flight LIMIT 1`;
      return sign(posting, ballot, o);
    };
    const error = await l.send(p).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PostingLedgerError);
    expect((error as Error).cause).toBeUndefined();
    const { message } = error as Error;
    for (const secret of [hex(p.posting), p.key, hex(p.ballotHash)])
      expect(message).not.toContain(secret);
    expect(chain.broadcasts).toHaveLength(1);
    expect(await l.sent(p.key)).toBeUndefined();
    expect(await counts()).toEqual({ sent: 1, ballots: 1, spend: 1, in_flight: 2 });
  });

  test("a posting forced through L1 is answered with its deposit", async () => {
    const chain = new FakeKey();
    const l = ledger(chain);
    const p = toSend();
    await l.send(p);
    const deposit = bytes32();
    await db.admin`UPDATE posting_sent SET layer = 'l1', transaction = ${deposit}`;
    expect(await l.sent(p.key)).toEqual({ transaction: deposit, layer: "l1" });
    expect(await l.send(p)).toEqual({ sent: true, transaction: deposit, layer: "l1" });
    expect(chain.signed).toHaveLength(1);
  });

  test("a signature over the fee cap, or out of form, is never recorded or broadcast", async () => {
    const bad: Partial<PostingSigned>[] = [
      { maxFee: FEE_CAP + 1n },
      { priorityFee: FEE_CAP + 1n },
      { maxFee: -1n },
      { hash: new Uint8Array(31) },
      { tx: new Uint8Array(0) },
    ];
    for (const over of bad) {
      const chain = new FakeKey();
      const sign = chain.sign.bind(chain);
      chain.sign = async (...args) => ({ ...(await sign(...args)), ...over });
      await expect(ledger(chain).send(toSend())).rejects.toThrow(/out of form/);
      expect(chain.broadcasts).toEqual([]);
      expect(await counts()).toEqual({ sent: 0, ballots: 0, spend: 0, in_flight: 0 });
    }
  });

  test("a cost or nonce out of form rejects before anything is signed", async () => {
    for (const set of [
      (c: FakeKey) => (c.costsOf = { l1DataFee: -1n, deposit: 0n }),
      (c: FakeKey) => (c.costsOf = { l1DataFee: 0n, deposit: 1 as unknown as bigint }),
      (c: FakeKey) => (c.count = -1n),
      (c: FakeKey) => (c.count = 1n << 64n),
    ]) {
      const chain = new FakeKey();
      set(chain);
      await expect(ledger(chain).send(toSend())).rejects.toThrow(/out of form/);
      expect(chain.signed).toEqual([]);
    }
  });

  test("refuses inputs out of range before touching the database", async () => {
    const chain = new FakeKey();
    const l = ledger(chain);
    for (const over of [
      { key: "AB".repeat(32) },
      { key: "ab" },
      { electionId: new Uint8Array(31) },
      { ballotHash: new Uint8Array(33) },
      { tier: 256 },
      { tier: -1 },
      { tier: 1.5 },
      { nullifier: -1n },
      { nullifier: 1n << 256n },
      { gasLimit: 0n },
      { gasLimit: POSTING_GAS_LIMIT_MAX + 1n },
    ] as Partial<PostingToSend>[])
      await expect(l.send(toSend(over))).rejects.toThrow();
    await expect(l.sent("xyz")).rejects.toThrow();
    expect(chain.signed).toEqual([]);
  });

  test("refuses settings out of range", () => {
    const chain = new FakeKey();
    const base = { sql: app, chain, budget: 1n, feeCap: 1n, now: () => NOW };
    expect(() => new PostgresPostingLedger({ ...base, budget: -1n })).toThrow(RangeError);
    expect(() => new PostgresPostingLedger({ ...base, feeCap: 0n })).toThrow(RangeError);
    expect(() => new PostgresPostingLedger({ ...base, forcedInclusion: -1n })).toThrow(RangeError);
    expect(() => new PostgresPostingLedger({ ...base, margin: -1n })).toThrow(RangeError);
    expect(() => new PostgresPostingLedger({ ...base, chainTimeoutMs: 0 })).toThrow(RangeError);
  });
});

describe("caps", () => {
  test("at most POSTING_BALLOT_CAP ballot hashes per election and (tier, ν)", async () => {
    const chain = new FakeKey();
    const l = ledger(chain);
    const hashes = [bytes32(), bytes32(), bytes32()];
    const nullifier = 12345n;
    expect((await l.send(toSend({ ballotHash: hashes[0]!, nullifier }))).sent).toBe(true);
    expect((await l.send(toSend({ ballotHash: hashes[1]!, nullifier }))).sent).toBe(true);
    expect(await l.send(toSend({ ballotHash: hashes[2]!, nullifier }))).toEqual({
      sent: false,
      code: "ballot-cap",
    });
    // Another seat's posting of a ballot already paid for still passes.
    expect((await l.send(toSend({ ballotHash: hashes[0]!, nullifier }))).sent).toBe(true);
    // Another tier, nullifier or election counts apart.
    expect((await l.send(toSend({ ballotHash: hashes[2]!, nullifier, tier: 3 }))).sent).toBe(true);
    expect((await l.send(toSend({ ballotHash: hashes[2]!, nullifier: 1n }))).sent).toBe(true);
    expect(
      (await l.send(toSend({ ballotHash: hashes[2]!, nullifier, electionId: bytes32() }))).sent,
    ).toBe(true);
    expect(chain.signed).toHaveLength(6);
  });

  test("whatever ballots arrive, a (tier, ν) is paid for under at most two ballot hashes", async () => {
    let round = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.nat({ max: 4 }), { minLength: 1, maxLength: 10 }),
        async (picks) => {
          const chain = new FakeKey();
          const l = ledger(chain);
          const nullifier = BigInt(++round) << 128n;
          const hashes = Array.from({ length: 5 }, bytes32);
          const paid = new Set<number>();
          for (const pick of picks) {
            const outcome = await l.send(toSend({ ballotHash: hashes[pick]!, nullifier }));
            const expected = paid.has(pick) || paid.size < POSTING_BALLOT_CAP;
            expect(outcome.sent).toBe(expected);
            if (!outcome.sent) expect(outcome.code).toBe("ballot-cap");
            if (expected) paid.add(pick);
          }
          expect(chain.signed).toHaveLength(picks.filter((p) => paid.has(p)).length);
        },
      ),
      { numRuns: Math.min(numRuns, 50) },
    );
  });

  test("the budget bounds the election's spend, its edge included", async () => {
    const chain = new FakeKey();
    const l = ledger(chain, { budget: 2n * MOST });
    expect((await l.send(toSend())).sent).toBe(true);
    expect((await l.send(toSend())).sent).toBe(true);
    expect(await l.send(toSend())).toEqual({ sent: false, code: "budget" });
    // Another election has its own budget.
    expect((await l.send(toSend({ electionId: bytes32() }))).sent).toBe(true);
    expect(await spentOf(ELECTION)).toBe(2n * MOST);
    expect(chain.signed).toHaveLength(3);
  });

  test("a deposit's cost counts while POSTING_FORCE_AFTER from now is by the deposit cutoff", async () => {
    const edge = Number(C_F - POSTING_FORCE_AFTER);
    const a = bytes32();
    await ledger(new FakeKey(), { now: edge }).send(toSend({ electionId: a }));
    expect(await spentOf(a)).toBe(MOST);
    const b = bytes32();
    await ledger(new FakeKey(), { now: edge + 1 }).send(toSend({ electionId: b }));
    expect(await spentOf(b)).toBe(MOST - COSTS.deposit);
    // The entry keeps its deposit's reserve apart, for the tend.
    const reserves = await db.admin`
      SELECT election_id, deposit::text FROM posting_in_flight ORDER BY deposit DESC`;
    expect(reserves.map((r) => [new Uint8Array(r["election_id"]), r["deposit"]])).toEqual([
      [a, String(COSTS.deposit)],
      [b, "0"],
    ]);
  });

  test("a refused cap writes nothing", async () => {
    const chain = new FakeKey();
    const l = ledger(chain, { budget: MOST - 1n });
    expect(await l.send(toSend())).toEqual({ sent: false, code: "budget" });
    expect(await counts()).toEqual({ sent: 0, ballots: 0, spend: 0, in_flight: 0 });
    expect(chain.signed).toEqual([]);

    const capped = ledger(chain);
    const nullifier = 7n;
    await capped.send(toSend({ nullifier }));
    await capped.send(toSend({ nullifier }));
    const before = await counts();
    const spent = await spentOf(ELECTION);
    expect(await capped.send(toSend({ nullifier }))).toEqual({ sent: false, code: "ballot-cap" });
    expect(await counts()).toEqual(before);
    expect(await spentOf(ELECTION)).toBe(spent);
    expect(chain.signed).toHaveLength(2);
  });

  test("ledgers sending different ballots of one (tier, ν) at once still pay for two", async () => {
    const others = await Promise.all([db.as("abolish_app"), db.as("abolish_app")]);
    const chains = [new FakeKey(), new FakeKey(), new FakeKey()];
    const nullifier = 99n;
    const outcomes = await Promise.all(
      chains.map((c, i) => ledger(c, { sql: [app, ...others][i]! }).send(toSend({ nullifier }))),
    );
    expect(outcomes.filter((o) => o.sent)).toHaveLength(POSTING_BALLOT_CAP);
    expect(outcomes.filter((o) => !o.sent)).toEqual([{ sent: false, code: "ballot-cap" }]);
  });
});

// Tending what is in flight (docs/spec/posting-relay.md, Sending, after step
// 6): a pending transaction rebroadcast identical every POSTING_RESEND and
// replaced at its nonce with both fees raised by an eighth once pending
// twice as long, while the fee cap allows; the spend reduced to a receipt
// and restored if its block leaves the latest head; a nonce another
// transaction consumed judged by the posting's event (T-52).
describe("tend", () => {
  const HEAD = { number: 1n, timestamp: BigInt(NOW) };
  const RESEND = Number(POSTING_RESEND);
  const RECEIPT: PostingReceipt = { gasUsed: 300_000n, effectiveGasPrice: 2n, l1Fee: 5_000n };
  const RECEIPT_COST = 605_000n;
  const LOW_FEES = { maxFee: 800_000n, priorityFee: 1_000n };

  /** A ledger whose clock the test moves, with one posting sent at NOW. */
  async function sentOne(o: { chain?: FakeKey; budget?: bigint } = {}) {
    const chain = o.chain ?? new FakeKey();
    let t = NOW;
    const l = ledger(chain, {
      now: () => t,
      ...(o.budget === undefined ? {} : { budget: o.budget }),
    });
    const p = toSend();
    const outcome = await l.send(p);
    if (!outcome.sent) throw new Error("not sent");
    return {
      chain,
      l,
      p,
      first: outcome.transaction,
      at: (s: number) => {
        t = NOW + s;
      },
    };
  }
  const row = async () => {
    const [r] = await db.admin`SELECT * FROM posting_in_flight`;
    return r!;
  };
  const report = (over: Partial<Record<string, number>> = {}) => ({
    landed: 0,
    unlanded: 0,
    posted: 0,
    rebroadcast: 0,
    replaced: 0,
    resent: 0,
    held: 0,
    failed: 0,
    ...over,
  });

  test("a pending transaction is rebroadcast, identical, every POSTING_RESEND", async () => {
    const { chain, l, at } = await sentOne();
    const signed = chain.broadcasts[0]!;
    at(RESEND - 1);
    expect(await l.tend(HEAD)).toEqual(report());
    at(RESEND);
    expect(await l.tend(HEAD)).toEqual(report({ rebroadcast: 1 }));
    expect(chain.broadcasts).toEqual([signed, signed]);
    at(2 * RESEND - 1);
    expect(await l.tend(HEAD)).toEqual(report());
    // The fee cap leaves no room to replace it: rebroadcast again instead.
    at(2 * RESEND);
    expect(await l.tend(HEAD)).toEqual(report({ rebroadcast: 1 }));
    expect(chain.broadcasts).toEqual([signed, signed, signed]);
    expect(chain.signed).toHaveLength(1);
    expect((await row())["broadcast_at"]).toBe(String(NOW + 2 * RESEND));
  });

  test("one pending twice as long is replaced at its nonce, both fees raised by an eighth", async () => {
    const chain = new FakeKey();
    chain.fees = { maxFee: 800_000n, priorityFee: 9n };
    chain.count = 4n;
    const { l, p, first, at } = await sentOne({ chain });
    at(2 * RESEND);
    expect(await l.tend(HEAD)).toEqual(report({ replaced: 1 }));
    expect(chain.signed[1]).toEqual({
      nonce: 4n,
      gasLimit: GAS,
      feeCap: FEE_CAP,
      fees: { maxFee: 900_000n, priorityFee: 11n },
    });
    const replacement = chain.broadcasts[1]!;
    const hash = chain.hashes.get(hex(replacement))!;
    const r = await row();
    expect(r).toMatchObject({
      nonce: "4",
      max_fee: "900000",
      priority_fee: "11",
      signed_at: String(NOW + 2 * RESEND),
      broadcast_at: String(NOW + 2 * RESEND),
      cost: String(MOST),
    });
    expect(new Uint8Array(r["signed"])).toEqual(replacement);
    expect(new Uint8Array(r["transactions"])).toEqual(Uint8Array.from([...first, ...hash]));
    // The answer for a repeat names the replacement; the spend is unchanged,
    // the most cost being at the fee cap.
    expect(await l.sent(p.key)).toEqual({ transaction: hash, layer: "l2" });
    expect(await spentOf(ELECTION)).toBe(MOST);
    // The next raise would pass the fee cap: from then on it is rebroadcast.
    at(4 * RESEND);
    expect(await l.tend(HEAD)).toEqual(report({ rebroadcast: 1 }));
    expect(chain.broadcasts[2]).toEqual(replacement);
    expect(chain.signed).toHaveLength(2);
  });

  test("a replacement signed with other fees is never recorded or broadcast", async () => {
    const chain = new FakeKey();
    chain.fees = LOW_FEES;
    const { l, at } = await sentOne({ chain });
    chain.otherFees = { maxFee: 900_000n, priorityFee: 1_000n };
    const before = await row();
    at(2 * RESEND);
    expect(await l.tend(HEAD)).toEqual(report({ failed: 1 }));
    expect(chain.broadcasts).toHaveLength(1);
    expect(await row()).toEqual(before);
  });

  test("once landed, the spend is reduced to the receipt, and restored if its block leaves the head", async () => {
    const chain = new FakeKey();
    chain.fees = LOW_FEES;
    const { l, p, first, at } = await sentOne({ chain });
    at(2 * RESEND);
    await l.tend(HEAD);
    // The first transaction, not its replacement, is the one in a block.
    chain.receipts.set(hex(first), RECEIPT);
    at(3 * RESEND);
    expect(await l.tend(HEAD)).toEqual(report({ landed: 1 }));
    // The deposit's reserve stays counted until the deposit is settled.
    expect(await spentOf(ELECTION)).toBe(RECEIPT_COST + COSTS.deposit);
    expect(await l.sent(p.key)).toEqual({ transaction: first, layer: "l2" });
    const r = await row();
    expect(new Uint8Array(r["landed_in"])).toEqual(first);
    expect(r["paid"]).toBe(String(RECEIPT_COST));
    // Landed: nothing more is sent, however long it stays in flight.
    at(10 * RESEND);
    expect(await l.tend(HEAD)).toEqual(report());
    expect(chain.broadcasts).toHaveLength(2);
    // A reorganisation drops it: counted at its most cost again, then
    // tended as pending.
    chain.receipts.clear();
    expect(await l.tend(HEAD)).toEqual(report({ unlanded: 1 }));
    expect(await spentOf(ELECTION)).toBe(MOST);
    expect(await row()).toMatchObject({ landed_in: null, paid: null });
    expect(await l.tend(HEAD)).toEqual(report({ rebroadcast: 1 }));
  });

  test("a nonce another transaction consumed, with the posting on the board, sends nothing more", async () => {
    const { chain, l, p, at } = await sentOne();
    chain.count = 1n;
    chain.onBoard.add(hex(p.posting));
    at(RESEND);
    expect(await l.tend(HEAD)).toEqual(report({ posted: 1 }));
    // Nothing of it ran on L2; a deposit's reserve stays counted.
    expect(await spentOf(ELECTION)).toBe(COSTS.deposit);
    expect(await row()).toMatchObject({ landed_in: null, paid: "0" });
    at(10 * RESEND);
    expect(await l.tend(HEAD)).toEqual(report());
    expect(chain.signed).toHaveLength(1);
    expect(chain.broadcasts).toHaveLength(1);
  });

  test("a nonce another transaction consumed, without the posting, is signed again at the next nonce", async () => {
    const { chain, l, p, at } = await sentOne();
    // Another posting in flight at nonce 1; the chain has taken nonce 0.
    await l.send(toSend());
    chain.count = 1n;
    at(5);
    expect(await l.tend(HEAD)).toEqual(report({ resent: 1 }));
    expect(chain.signed.map((s) => s.nonce)).toEqual([0n, 1n, 2n]);
    const again = chain.broadcasts[2]!;
    const hash = chain.hashes.get(hex(again))!;
    const extra = GAS * FEE_CAP + COSTS.l1DataFee;
    expect(await spentOf(ELECTION)).toBe(2n * MOST + extra);
    expect(await l.sent(p.key)).toEqual({ transaction: hash, layer: "l2" });
    const [r] = await db.admin`
      SELECT nonce, cost::text, signed_at, transactions FROM posting_in_flight
      WHERE posting_key = ${Buffer.from(p.key, "hex")}`;
    expect(r).toMatchObject({
      nonce: "2",
      cost: String(MOST + extra),
      signed_at: String(NOW + 5),
    });
    expect(new Uint8Array(r!["transactions"]).subarray(32)).toEqual(hash);
  });

  test("a resend and the transaction it followed both landing are both counted", async () => {
    const { chain, l, p, first, at } = await sentOne();
    chain.count = 1n;
    at(5);
    expect(await l.tend(HEAD)).toEqual(report({ resent: 1 }));
    const again = chain.hashes.get(hex(chain.broadcasts[1]!))!;
    // The resend lands, and so, on a view that had lost it, did the first.
    chain.receipts.set(hex(again), RECEIPT);
    expect(await l.tend(HEAD)).toEqual(report({ landed: 1 }));
    expect(await spentOf(ELECTION)).toBe(RECEIPT_COST + COSTS.deposit);
    chain.receipts.set(hex(first), { ...RECEIPT, l1Fee: 1n });
    expect(await l.tend(HEAD)).toEqual(report({ landed: 1 }));
    expect(await spentOf(ELECTION)).toBe(RECEIPT_COST + 600_001n + COSTS.deposit);
    const r = await row();
    expect(new Uint8Array(r["landed_in"])).toEqual(Uint8Array.from([...first, ...again]));
    expect(await l.sent(p.key)).toEqual({ transaction: again, layer: "l2" });
    expect(await l.tend(HEAD)).toEqual(report());
  });

  test("a count that moves while the receipts and the event are read sends nothing", async () => {
    const { chain, l, p } = await sentOne();
    let reads = 0;
    chain.nonce = async () => (++reads === 1 ? 1n : 2n);
    expect(await l.tend(HEAD)).toEqual(report());
    chain.onBoard.add(hex(p.posting));
    reads = 0;
    expect(await l.tend(HEAD)).toEqual(report());
    expect(chain.signed).toHaveLength(1);
    expect(await spentOf(ELECTION)).toBe(MOST);
    expect(await row()).toMatchObject({ paid: null });
  });

  test("past the send cutoff, or past the budget, a consumed nonce sends nothing new", async () => {
    const late = await sentOne();
    late.chain.count = 1n;
    const cutoff = C_D - POSTING_SEND_MARGIN;
    expect(await late.l.tend({ number: 1n, timestamp: cutoff + 1n })).toEqual(report());
    expect(late.chain.signed).toHaveLength(1);
    // At the cutoff itself it may still be sent.
    expect(await late.l.tend({ number: 1n, timestamp: cutoff })).toEqual(report({ resent: 1 }));

    await db.admin`DELETE FROM posting_in_flight`;
    await db.admin`DELETE FROM posting_spend`;
    const poor = await sentOne({ budget: MOST });
    poor.chain.count = 1n;
    expect(await poor.l.tend(HEAD)).toEqual(report({ held: 1 }));
    expect(poor.chain.signed).toHaveLength(1);
    expect(await spentOf(ELECTION)).toBe(MOST);
  });

  test("a failing node leaves an entry as it was, quoting nothing, and goes on to the next", async () => {
    for (const which of ["nonce", "receipt", "posted", "costs", "sign"] as const) {
      await db.admin`DELETE FROM posting_in_flight`;
      await db.admin`DELETE FROM posting_spend`;
      const { chain, l, at } = await sentOne();
      chain.fees = LOW_FEES;
      if (which === "posted" || which === "costs" || which === "sign") chain.count = 1n;
      at(2 * RESEND);
      chain.fail[which] = new Error("node at https://key@example down");
      const before = await db.admin`SELECT * FROM posting_in_flight`;
      expect(await l.tend(HEAD)).toEqual(report({ failed: 1 }));
      expect(await db.admin`SELECT * FROM posting_in_flight`).toEqual(before);
      expect(await spentOf(ELECTION)).toBe(MOST);
      expect(chain.broadcasts).toHaveLength(1);
    }
  });

  test("a receipt or nonce out of form leaves the entry as it was", async () => {
    const { chain, l, first, at } = await sentOne();
    at(RESEND);
    chain.receipts.set(hex(first), { ...RECEIPT, gasUsed: -1n });
    expect(await l.tend(HEAD)).toEqual(report({ failed: 1 }));
    chain.receipts.clear();
    chain.count = -1n;
    expect(await l.tend(HEAD)).toEqual(report({ failed: 1 }));
    expect(await spentOf(ELECTION)).toBe(MOST);
    expect(chain.broadcasts).toHaveLength(1);
  });

  test("a broadcast that fails is kept and tried again after POSTING_RESEND", async () => {
    const { chain, l, at } = await sentOne();
    chain.fail.broadcast = new Error("down");
    at(RESEND);
    expect(await l.tend(HEAD)).toEqual(report({ rebroadcast: 1 }));
    delete chain.fail.broadcast;
    at(RESEND + 1);
    expect(await l.tend(HEAD)).toEqual(report());
    at(2 * RESEND);
    expect(await l.tend(HEAD)).toEqual(report({ rebroadcast: 1 }));
    expect(chain.broadcasts).toHaveLength(3);
  });

  test("two ledgers tending at once replace a transaction once", async () => {
    const chain = new FakeKey();
    chain.fees = LOW_FEES;
    const { l, at } = await sentOne({ chain });
    at(2 * RESEND);
    const other = await db.as("abolish_app");
    const second = ledger(chain, { sql: other, now: NOW + 2 * RESEND });
    const [x, y] = await Promise.all([l.tend(HEAD), second.tend(HEAD)]);
    expect(x.replaced + y.replaced).toBe(1);
    expect(x.rebroadcast + y.rebroadcast).toBe(0);
    expect(chain.signed).toHaveLength(2);
  });

  test("a store failure listing what is in flight rejects quoting nothing", async () => {
    const { chain } = await sentOne();
    const broken = await db.as("abolish_app");
    await broken.end();
    const err = await ledger(chain, { sql: broken })
      .tend(HEAD)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PostingLedgerError);
  });

  test("refuses a head out of range", async () => {
    await expect(ledger(new FakeKey()).tend({ number: 1n, timestamp: -1n })).rejects.toThrow(
      RangeError,
    );
  });

  test("whatever lands, leaves or is consumed, the spend is what each entry is counted at", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            pick: fc.nat({ max: 2 }),
            event: fc.constantFrom("land", "land-last", "drop", "consume", "board", "wait"),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        async (steps) => {
          await db.admin`DELETE FROM posting_in_flight`;
          await db.admin`DELETE FROM posting_spend`;
          const chain = new FakeKey();
          chain.fees = LOW_FEES;
          let t = NOW;
          const l = ledger(chain, { now: () => t });
          const sent = [toSend(), toSend(), toSend()];
          for (const p of sent) await l.send(p);
          for (const { pick, event } of steps) {
            const p = sent[pick]!;
            const r = await db.admin`
              SELECT nonce, transactions FROM posting_in_flight
              WHERE posting_key = ${Buffer.from(p.key, "hex")}`;
            const hashes = new Uint8Array(r[0]!["transactions"]);
            if (event === "land") chain.receipts.set(hex(hashes.subarray(0, 32)), RECEIPT);
            if (event === "land-last") chain.receipts.set(hex(hashes.subarray(-32)), RECEIPT);
            if (event === "drop") chain.receipts.clear();
            if (event === "consume") chain.count = BigInt(r[0]!["nonce"] as string) + 1n;
            if (event === "board") chain.onBoard.add(hex(p.posting));
            t += RESEND;
            await l.tend(HEAD);
            const [sum] = await db.admin`
              SELECT coalesce(sum(coalesce(paid + deposit, cost)), 0)::text AS s
              FROM posting_in_flight`;
            expect(await spentOf(ELECTION)).toBe(BigInt(sum!["s"] as string));
          }
        },
      ),
      { numRuns: Math.min(numRuns, 30) },
    );
    // Each run sends three postings and tends up to twelve times against
    // the database: past the default 5 s on a busy runner.
  }, 120_000);
});
