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
  postingBallots,
  type PostingCosts,
  postingInFlight,
  type PostingKeyChain,
  postingMostCost,
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

/** A fake posting key: records what it was asked, and can be told to fail. */
class FakeKey implements PostingKeyChain {
  count = 0n;
  costsOf: PostingCosts = COSTS;
  fees = { maxFee: FEE_CAP, priorityFee: 1_000n };
  signed: { nonce: bigint; gasLimit: bigint; feeCap: bigint }[] = [];
  broadcasts: Uint8Array[] = [];
  fail: Partial<Record<"nonce" | "costs" | "sign" | "broadcast", Error>> = {};
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
  async sign(
    _posting: Uint8Array,
    _ballot: Uint8Array,
    o: { nonce: bigint; gasLimit: bigint; feeCap: bigint },
  ): Promise<PostingSigned> {
    if (this.fail.sign) throw this.fail.sign;
    this.signed.push(o);
    const tx = new Uint8Array(randomBytes(120));
    return { tx, hash: bytes32(), ...this.fees };
  }
  async broadcast(tx: Uint8Array) {
    await this.onBroadcast?.();
    this.broadcasts.push(tx);
    if (this.fail.broadcast) throw this.fail.broadcast;
    return this.answer;
  }
}

function ledger(chain: PostingKeyChain, o: { budget?: bigint; now?: number; sql?: Sql } = {}) {
  return new PostgresPostingLedger({
    sql: o.sql ?? app,
    chain,
    budget: o.budget ?? 10n ** 18n,
    feeCap: FEE_CAP,
    now: () => o.now ?? NOW,
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
          delivery_ends, first_sent, nonce, gas_limit, max_fee, priority_fee, cost, signed, transactions
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
      chain.fail[step] = new Error(step);
      await expect(ledger(chain).send(toSend())).rejects.toThrow(step);
      expect(chain.broadcasts).toEqual([]);
      expect(await counts()).toEqual({ sent: 0, ballots: 0, spend: 0, in_flight: 0 });
    }
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
  });

  test("a refused cap writes nothing", async () => {
    const chain = new FakeKey();
    const l = ledger(chain, { budget: MOST - 1n });
    expect(await l.send(toSend())).toEqual({ sent: false, code: "budget" });
    expect(await counts()).toEqual({ sent: 0, ballots: 0, spend: 0, in_flight: 0 });
    expect(chain.signed).toEqual([]);
  });
});
