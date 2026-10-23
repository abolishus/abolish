import { DELIVERY_WINDOW } from "@abolishus/crypto";
import { type BallotAdmission, PINNED_FORCED_INCLUSION } from "@abolishus/verifier";
import fc from "fast-check";
import { Redis } from "ioredis";
import type { Sql } from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  ballots,
  definition,
  definitionBytes,
  definitionHash,
  electionId,
  panel,
  postedBallot,
  postingFor,
  transcript,
} from "../../verifier/tests/receipt-poll.ts";
import {
  appendEntry,
  BallotAdmissions,
  parsePostingIndex,
  parsePostingOutcome,
  POSTING_GAS_LIMIT_MAX,
  POSTING_HEAD_AGE,
  POSTING_MAX_DATA,
  POSTING_SEND_MARGIN,
  POSTING_UNANSWERED_SPAN,
  POSTING_UNANSWERED_TICKS,
  POSTING_WAIT,
  postingCalldataLength,
  type PostingChain,
  postingGasLimit,
  postingKey,
  postingKeys,
  type PostingLedger,
  type PostingOutcome,
  postingPairValue,
  type PostingSimulation,
  type PostingToSend,
  PostingWorker,
  recordRegistration,
  storeDefinition,
} from "../src/index.ts";
import { type TestDb, testDb } from "./db.ts";

// The posting worker's checks before it pays, against a live Redis and
// Postgres (docs/spec/posting-relay.md, Queue and Sending, steps 1 to 4):
// each queued pair is judged in the spec's order and answered in the step
// that takes it out of the queue; a ballot the verifier's batched admission
// refuses is answered before any node call, so a pair made with a ballot no
// member made can't hold a queue place (T-52, T-13); only what passes
// reaches the ledger, with the fields it counts by recomputed; a node or
// ledger failing without a verdict keeps the pair only so long (T-52); and
// nothing of a pair stays in Redis but its expiring outcome (T-11, T-18).
//
// The fixture's ballots (packages/verifier's tests/receipt-poll.ts) carry
// postings that pass the public check but membership proofs made for
// another definition, so the verifier refuses them: the real admission
// shows the refusal, and a stand-in for `admitAll` that admits them shows
// the path past it.

const redisUrl = process.env["REDIS_URL"];
if (!redisUrl) throw new Error("REDIS_URL is not set");
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const clock = { epoch: definition.opens_at - 7_200n, period: 3_600n };
const C_D =
  definition.closes_at +
  BigInt(definition.l1_inclusion_bound) +
  DELIVERY_WINDOW -
  PINNED_FORCED_INCLUSION;
const LAST = C_D - POSTING_SEND_MARGIN;
// A day before the send cutoff, so a head at the clock is in time however
// far a test moves the clock.
const NOW = Number(LAST) - 86_400;
const TIER = 2;

const first = postedBallot(ballots[0] as (typeof ballots)[number]);
const second = postedBallot(ballots[1] as (typeof ballots)[number]);
const pairOf = (seat = 1, ballot = first) => ({
  posting: postingFor(ballot, seat),
  ballot: ballot.payload,
});

let redis: Redis;
let prefix: string;
let run = 0;
let db: TestDb;
let app: Sql;
beforeAll(async () => {
  redis = new Redis(redisUrl);
  db = await testDb();
  app = await db.as("abolish_app");
  await storeDefinition(app, definitionBytes);
  await appendEntry(app, electionId, 0, transcript, { first: true });
  await recordRegistration(app, { electionId, definitionHash, l2Block: 1n, logIndex: 0 });
});
afterAll(async () => {
  await redis.quit();
  await db.close();
});
beforeEach(() => {
  prefix = `test-posting-worker-${process.pid}-${Date.now()}-${run++}`;
});
afterEach(async () => {
  const left = await keysUnder();
  if (left.length > 0) await redis.del(...left);
});

const keys = () => postingKeys(prefix);

async function keysUnder(): Promise<string[]> {
  const found: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", `${prefix}:*`, "COUNT", 1000);
    found.push(...batch);
    cursor = next;
  } while (cursor !== "0");
  return found;
}

/** Queues a pair as the route's script does. */
async function queue(pair: { posting: Uint8Array; ballot: Uint8Array }): Promise<string> {
  const key = postingKey(pair.posting);
  await redis.hset(keys().queue, key, postingPairValue(pair.posting, pair.ballot));
  return key;
}

const outcomeOf = async (key: string) => parsePostingOutcome(await redis.get(keys().outcome(key)));

/** `admitAll` admitting the fixture's posted ballots, as the verifier would admit a member's. */
function admitting(tier = TIER, nullifierOffset = 0n): BallotAdmissions {
  const real = new BallotAdmissions({ panels: [panel], clock });
  const known = [first, second];
  return Object.assign(Object.create(real) as BallotAdmissions, {
    postings: async (sql: Sql, id: Uint8Array) => {
      const election = await real.postings(sql, id);
      if (election === undefined) return undefined;
      return {
        ...election,
        admitAll: (payloads: readonly Uint8Array[]): BallotAdmission[] => {
          batches.push(payloads.length);
          return payloads.map((p) => {
            const b = known.find((k) => toHex(k.payload) === toHex(p));
            if (b === undefined) return { ok: false, code: "membership-proof" };
            return {
              ok: true,
              ballotHash: b.hash,
              tier,
              nullifier: b.nullifier + nullifierOffset,
              message: new Uint8Array(32),
              l1RefNumber: 0n,
              l1RefHash: new Uint8Array(32),
            };
          });
        },
      };
    },
  });
}

let batches: number[] = [];
beforeEach(() => {
  batches = [];
});

interface Calls {
  simulated: number;
  sentLookups: number;
  sends: PostingToSend[];
}

interface WorkerOptions {
  readonly admissions?: Pick<BallotAdmissions, "postings">;
  readonly head?: () => Promise<{ number: bigint; timestamp: bigint }>;
  readonly simulate?: () => Promise<PostingSimulation>;
  readonly sent?: (key: string) => ReturnType<PostingLedger["sent"]>;
  readonly send?: (p: PostingToSend) => Promise<PostingOutcome>;
  readonly now?: () => number;
}

const TX = new Uint8Array(32).fill(0xab);
const GAS_USED = 500_000n;

function workerWith(o: WorkerOptions = {}) {
  const calls: Calls = { simulated: 0, sentLookups: 0, sends: [] };
  const now = o.now ?? (() => NOW);
  const chain: PostingChain = {
    // By default the latest block is as new as the clock.
    latest: o.head ?? (async () => ({ number: 10n, timestamp: BigInt(now()) })),
    simulate: async () => {
      calls.simulated++;
      return o.simulate === undefined ? { reverted: false, gasUsed: GAS_USED } : o.simulate();
    },
  };
  const ledger: PostingLedger = {
    sent: async (key) => {
      calls.sentLookups++;
      return o.sent === undefined ? undefined : o.sent(key);
    },
    send: async (p) => {
      calls.sends.push(p);
      return o.send === undefined ? { sent: true, transaction: TX, layer: "l2" } : o.send(p);
    },
  };
  const worker = new PostingWorker({
    sql: app,
    redis,
    chain,
    ledger,
    admissions: o.admissions ?? admitting(),
    now,
    prefix,
  });
  return { worker, calls };
}

/** A tick that ran: none overlaps in these tests. */
async function ticked(worker: PostingWorker) {
  const report = await worker.tick();
  if (report === null) throw new Error("a tick overlapped");
  return report;
}

describe("the index", { timeout: 60_000 }, () => {
  test("each tick writes when it read the L2's latest block, and that block's time", async () => {
    const timestamp = BigInt(NOW) - 5n;
    const { worker } = workerWith({ head: async () => ({ number: 7n, timestamp }) });
    const report = await ticked(worker);
    expect(report.chain).toBe(true);
    expect(parsePostingIndex(await redis.get(keys().index))).toEqual({
      at: NOW,
      l2Time: timestamp,
    });
  });

  test("a head older than POSTING_HEAD_AGE judges nothing and leaves the index unwritten", async () => {
    const key = await queue(pairOf());
    for (const [age, chain] of [
      [POSTING_HEAD_AGE + 1, false],
      [POSTING_HEAD_AGE, true],
    ] as const) {
      const { worker, calls } = workerWith({
        head: async () => ({ number: 7n, timestamp: BigInt(NOW - age) }),
      });
      const report = await ticked(worker);
      expect(report.chain).toBe(chain);
      const index = await redis.get(keys().index);
      if (chain)
        expect(parsePostingIndex(index)).toEqual({
          at: NOW,
          l2Time: BigInt(NOW - POSTING_HEAD_AGE),
        });
      else expect(index).toBeNull();
      expect(calls.sends).toHaveLength(chain ? 1 : 0);
      expect(calls.sentLookups).toBe(chain ? 1 : 0);
    }
    expect(await outcomeOf(key)).toEqual({ sent: true, transaction: TX, layer: "l2" });
  });

  test("a pair the tick reaches past POSTING_HEAD_AGE is kept for the next tick", async () => {
    const key = await queue(pairOf());
    let now = NOW;
    const { worker, calls } = workerWith({
      head: async () => ({ number: 7n, timestamp: BigInt(NOW) }),
      now: () => now,
      // The simulation outlasts the head's age.
      simulate: async () => {
        now += POSTING_HEAD_AGE + 1;
        return { reverted: false, gasUsed: GAS_USED };
      },
    });
    const report = await ticked(worker);
    expect(report.kept).toBe(1);
    expect(calls.sends).toHaveLength(0);
    expect(await redis.hkeys(keys().queue)).toEqual([key]);
  });

  test("a node that can't be read leaves the index and the queue as they were", async () => {
    const key = await queue(pairOf());
    const { worker, calls } = workerWith({
      head: async () => {
        throw new Error("https://node.example/key-in-url unreachable");
      },
    });
    const report = await ticked(worker);
    expect(report.chain).toBe(false);
    expect(report.kept).toBe(0);
    expect(await redis.get(keys().index)).toBeNull();
    expect(await redis.hkeys(keys().queue)).toEqual([key]);
    expect(calls.sentLookups + calls.simulated + calls.sends.length).toBe(0);
  });
});

describe("an honest pair", { timeout: 60_000 }, () => {
  test("reaches the ledger with what it counts by, and leaves only its expiring outcome", async () => {
    const pair = pairOf(2);
    const key = await queue(pair);
    const { worker, calls } = workerWith();
    const report = await ticked(worker);
    expect(report.answered.sent).toBe(1);
    expect(report.kept).toBe(0);
    expect(calls.sends).toHaveLength(1);
    const sent = calls.sends[0] as PostingToSend;
    expect(sent).toEqual({
      key,
      posting: pair.posting,
      ballot: pair.ballot,
      electionId,
      definitionHash,
      ballotHash: first.hash,
      tier: TIER,
      nullifier: first.nullifier,
      gasLimit: postingGasLimit(
        GAS_USED,
        postingCalldataLength(pair.posting.length, pair.ballot.length),
      ),
      closesAt: definition.closes_at,
      l1InclusionBound: BigInt(definition.l1_inclusion_bound),
    });
    expect(await outcomeOf(key)).toEqual({ sent: true, transaction: TX, layer: "l2" });
    // T-11, T-18: the pair is gone, its outcome expires with the route's wait.
    expect((await keysUnder()).sort()).toEqual([keys().index, keys().outcome(key)].sort());
    const ttl = await redis.ttl(keys().outcome(key));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(POSTING_WAIT);
  });

  test("the ledger's refusal is the answer", async () => {
    for (const code of ["ballot-cap", "budget", "too-late"] as const) {
      const key = await queue(pairOf(3));
      const { worker } = workerWith({ send: async () => ({ sent: false, code }) });
      const report = await ticked(worker);
      expect(report.answered[code]).toBe(1);
      expect(await outcomeOf(key)).toEqual({ sent: false, code });
      expect(await redis.hlen(keys().queue)).toBe(0);
    }
  });

  test("the ballots of one election's pairs are admitted in one batch", async () => {
    const queued = [
      await queue(pairOf(1, first)),
      await queue(pairOf(2, first)),
      await queue(pairOf(1, second)),
    ];
    const { worker, calls } = workerWith();
    const report = await ticked(worker);
    expect(batches).toEqual([3]);
    expect(report.answered.sent).toBe(3);
    expect(calls.sends.map((s) => s.key).sort()).toEqual(queued.sort());
  });
});

// The byte-flip property ticks the worker up to 200 times against Redis: about
// 15s alone, but over 60s on a CI runner shared with every package's tests.
describe("step 1: the bytes again", { timeout: 240_000 }, () => {
  test("a value that isn't a pair, or under another posting's key, is malformed", async () => {
    const pair = pairOf();
    const other = postingKey(pairOf(2).posting);
    await redis.hset(keys().queue, other, postingPairValue(pair.posting, pair.ballot));
    const garbled = postingKey(new Uint8Array([1, 2, 3]));
    await redis.hset(keys().queue, garbled, "not a pair");
    const { worker, calls } = workerWith();
    const report = await ticked(worker);
    expect(report.answered.malformed).toBe(2);
    for (const key of [other, garbled])
      expect(await outcomeOf(key)).toEqual({ sent: false, code: "malformed" });
    expect(await redis.hlen(keys().queue)).toBe(0);
    expect(calls.sentLookups + calls.simulated + calls.sends.length).toBe(0);
  });

  test("records that fail postingForm are malformed, whatever byte changed", async () => {
    const honest = pairOf();
    await fc.assert(
      fc.asyncProperty(
        fc.nat({ max: honest.posting.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        async (at, flip) => {
          const posting = honest.posting.slice();
          posting[at] = (posting[at] as number) ^ flip;
          const key = await queue({ posting, ballot: honest.ballot });
          const { worker, calls } = workerWith();
          const report = await ticked(worker);
          // A change in `m` or the ciphertext keeps the posting well formed:
          // the public check is the route's, so the worker passes it on to
          // admission and the simulation, which a real board refuses.
          const outcome = await outcomeOf(key);
          if (outcome?.sent === true) expect(calls.sends).toHaveLength(1);
          else {
            expect(outcome).toEqual({ sent: false, code: "malformed" });
            expect(report.answered.malformed).toBe(1);
            expect(calls.sentLookups + calls.simulated + calls.sends.length).toBe(0);
          }
          await redis.del(keys().outcome(key));
        },
      ),
      { numRuns: Math.min(numRuns, 200) },
    );
  });

  test("a field that can't be a posting's key is dropped, with no outcome", async () => {
    await redis.hset(keys().queue, "nonsense", "x");
    const { worker } = workerWith();
    const report = await ticked(worker);
    expect(report.kept).toBe(0);
    expect(Object.values(report.answered).every((n) => n === 0)).toBe(true);
    expect((await keysUnder()).sort()).toEqual([keys().index]);
  });
});

describe("step 2: a repeat", { timeout: 60_000 }, () => {
  test("a posting the relay already sent is answered with its transaction, nothing run", async () => {
    const key = await queue(pairOf());
    const L1 = new Uint8Array(32).fill(0xcd);
    const { worker, calls } = workerWith({
      sent: async (k) => (k === key ? { transaction: L1, layer: "l1" } : undefined),
      head: async () => ({ number: 10n, timestamp: LAST + 1n }),
    });
    const report = await ticked(worker);
    expect(report.answered.sent).toBe(1);
    // Even past the send cutoff: it was sent before it.
    expect(await outcomeOf(key)).toEqual({ sent: true, transaction: L1, layer: "l1" });
    expect(calls.simulated + calls.sends.length).toBe(0);
    expect(batches).toEqual([]);
  });
});

describe("step 3: the send cutoff", { timeout: 60_000 }, () => {
  test("the latest block past c_D − POSTING_SEND_MARGIN is too late, at it the pair goes on", async () => {
    for (const [timestamp, expected] of [
      [LAST + 1n, { sent: false, code: "too-late" }],
      [LAST, { sent: true, transaction: TX, layer: "l2" }],
    ] as const) {
      const key = await queue(pairOf());
      const { worker } = workerWith({ head: async () => ({ number: 10n, timestamp }) });
      await ticked(worker);
      expect(await outcomeOf(key)).toEqual(expected);
      await redis.del(keys().outcome(key));
    }
  });

  test("an election this worker can't judge is unavailable", async () => {
    const key = await queue(pairOf());
    const { worker, calls } = workerWith({ admissions: { postings: async () => undefined } });
    const report = await ticked(worker);
    expect(report.answered.unavailable).toBe(1);
    expect(await outcomeOf(key)).toEqual({ sent: false, code: "unavailable" });
    expect(calls.simulated + calls.sends.length).toBe(0);
  });
});

describe("step 4: admission, then the simulation", { timeout: 120_000 }, () => {
  test("a ballot the verifier refuses is answered before any node call (T-52)", async () => {
    // The real admission: the fixture's membership proofs were made for
    // another definition, so every pair here is one a queue filler makes.
    const queued = [await queue(pairOf(1, first)), await queue(pairOf(1, second))];
    const { worker, calls } = workerWith({
      admissions: new BallotAdmissions({ panels: [panel], clock }),
    });
    const report = await ticked(worker);
    expect(report.answered.simulation).toBe(2);
    for (const key of queued)
      expect(await outcomeOf(key)).toEqual({ sent: false, code: "simulation" });
    expect(calls.simulated + calls.sends.length).toBe(0);
    expect(await redis.hlen(keys().queue)).toBe(0);
  });

  test("a simulation that reverts is refused", async () => {
    const key = await queue(pairOf());
    const { worker, calls } = workerWith({ simulate: async () => ({ reverted: true }) });
    await ticked(worker);
    expect(await outcomeOf(key)).toEqual({ sent: false, code: "simulation" });
    expect(calls.sends).toHaveLength(0);
  });

  test("a gas limit over POSTING_GAS_LIMIT_MAX is too costly, at it the pair goes on", async () => {
    // 8,000,000 · 5/4 is exactly the maximum, above the calldata's floor.
    for (const [gasUsed, expected] of [
      [8_000_001n, { sent: false, code: "too-costly" }],
      [8_000_000n, { sent: true, transaction: TX, layer: "l2" }],
    ] as const) {
      const key = await queue(pairOf());
      const { worker, calls } = workerWith({
        simulate: async () => ({ reverted: false, gasUsed }),
      });
      await ticked(worker);
      expect(await outcomeOf(key)).toEqual(expected);
      if (expected.sent) expect(calls.sends[0]?.gasLimit).toBe(POSTING_GAS_LIMIT_MAX);
      await redis.del(keys().outcome(key));
    }
  });
});

describe("a pair with no verdict", { timeout: 60_000 }, () => {
  const failing = {
    simulation: { simulate: () => Promise.reject(new Error("node down")) },
    "ledger lookup": { sent: () => Promise.reject(new Error("db down")) },
    "ledger send": { send: () => Promise.reject(new Error("db down")) },
  } satisfies Record<string, WorkerOptions>;

  for (const [what, options] of Object.entries(failing))
    test(`is kept while the ${what} fails, then refused unavailable after ${POSTING_UNANSWERED_TICKS} ticks over a minute`, async () => {
      const key = await queue(pairOf());
      let now = NOW;
      const { worker } = workerWith({ ...options, now: () => now });
      const step = POSTING_UNANSWERED_SPAN / (POSTING_UNANSWERED_TICKS - 1);
      for (let i = 0; i < POSTING_UNANSWERED_TICKS - 1; i++) {
        const report = await ticked(worker);
        expect(report.kept).toBe(1);
        expect(await redis.hlen(keys().queue)).toBe(1);
        now += step;
      }
      const report = await ticked(worker);
      expect(report.answered.unavailable).toBe(1);
      expect(await outcomeOf(key)).toEqual({ sent: false, code: "unavailable" });
    });

  test("many failing ticks within a minute keep it", async () => {
    await queue(pairOf());
    let now = NOW;
    const { worker } = workerWith({ ...failing.simulation, now: () => now });
    for (let i = 0; i < 3 * POSTING_UNANSWERED_TICKS; i++) {
      const report = await ticked(worker);
      expect(report.kept).toBe(1);
      now += 2;
    }
  });

  test("a node that recovers sends it", async () => {
    const key = await queue(pairOf());
    let down = true;
    const { worker } = workerWith({
      simulate: async () => {
        if (down) throw new Error("node down");
        return { reverted: false, gasUsed: GAS_USED };
      },
    });
    expect((await ticked(worker)).kept).toBe(1);
    down = false;
    expect((await ticked(worker)).answered.sent).toBe(1);
    expect(await outcomeOf(key)).toEqual({ sent: true, transaction: TX, layer: "l2" });
  });
});

describe("postingGasLimit", () => {
  test("is the larger of the simulation's gas with headroom and the deposit's floor", () => {
    expect(postingGasLimit(0n, 0)).toBe(21_000n);
    expect(postingGasLimit(400_000n, 1_000)).toBe(500_000n);
    expect(postingGasLimit(1n, 0)).toBe(21_000n);
    expect(postingGasLimit(100_001n, 0)).toBe(125_002n);
    expect(postingGasLimit(0n, 120_000)).toBe(21_000n + 40n * 120_000n);
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 1n << 40n }), fc.nat({ max: 200_000 }), (used, d) => {
        const g = postingGasLimit(used, d);
        const floor = 21_000n + 40n * BigInt(d);
        expect(g >= floor).toBe(true);
        // At least used · 5/4, and less than a gas above it unless the floor rules.
        expect(4n * g >= 5n * used).toBe(true);
        if (g !== floor) expect(4n * (g - 1n) < 5n * used).toBe(true);
      }),
      { numRuns },
    );
  });

  test("refuses what isn't a gas amount or a length", () => {
    expect(() => postingGasLimit(-1n, 0)).toThrow(RangeError);
    expect(() => postingGasLimit(0n, -1)).toThrow(RangeError);
    expect(() => postingGasLimit(0n, 1.5)).toThrow(RangeError);
  });
});

describe("the review's edges", { timeout: 60_000 }, () => {
  test("a tick while another runs does nothing", async () => {
    await queue(pairOf());
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { worker, calls } = workerWith({
      simulate: async () => {
        await held;
        return { reverted: false, gasUsed: GAS_USED };
      },
    });
    const firstTick = worker.tick();
    // Let the first tick reach its simulation.
    while (calls.simulated === 0) await new Promise((r) => setTimeout(r, 5));
    expect(await worker.tick()).toBeNull();
    release();
    expect((await firstTick)?.answered.sent).toBe(1);
    expect(calls.sends).toHaveLength(1);
  });

  test("the index is written only once the queue is judged", async () => {
    const key = await queue(pairOf());
    const { worker } = workerWith({
      sent: async () => {
        expect(await redis.get(keys().index)).toBeNull();
        return undefined;
      },
    });
    await ticked(worker);
    expect(await outcomeOf(key)).toEqual({ sent: true, transaction: TX, layer: "l2" });
    expect(await redis.get(keys().index)).not.toBeNull();
  });

  test("a Redis failure throws an error that quotes nothing of the pair", async () => {
    const key = await queue(pairOf());
    const { worker } = workerWith();
    const failing = new PostingWorker({
      sql: app,
      redis: {
        eval: async (script: string, numkeys: number, ...args: string[]) => {
          throw new Error(`ERR in ${script.length} with ${numkeys} ${args.join(" ")}`);
        },
      },
      chain: {
        latest: async () => ({ number: 1n, timestamp: LAST }),
        simulate: async () => ({ reverted: true }),
      },
      ledger: { sent: async () => undefined, send: async () => ({ sent: false, code: "budget" }) },
      admissions: admitting(),
      now: () => NOW,
      prefix,
    });
    const error = await failing.tick().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(key);
    expect((error as Error).message).not.toContain(prefix);
    // The healthy worker still judges the pair afterwards.
    expect((await ticked(worker)).answered.sent).toBe(1);
  });

  test("calldata over POSTING_MAX_DATA is malformed, whoever queued it", async () => {
    const pair = pairOf();
    const ballot = new Uint8Array(POSTING_MAX_DATA);
    ballot.set(pair.ballot);
    const key = await queue({ posting: pair.posting, ballot });
    const { worker, calls } = workerWith();
    await ticked(worker);
    expect(await outcomeOf(key)).toEqual({ sent: false, code: "malformed" });
    expect(calls.sentLookups).toBe(0);
  });

  test("admission disagreeing with postingForm is malformed, never sent", async () => {
    const key = await queue(pairOf());
    const { worker, calls } = workerWith({ admissions: admitting(TIER, 1n) });
    await ticked(worker);
    expect(await outcomeOf(key)).toEqual({ sent: false, code: "malformed" });
    expect(calls.simulated + calls.sends.length).toBe(0);
  });

  test("a head whose time isn't a u64 judges nothing", async () => {
    await queue(pairOf());
    for (const timestamp of [-1n, 1n << 64n, 5 as unknown as bigint]) {
      const { worker, calls } = workerWith({ head: async () => ({ number: 1n, timestamp }) });
      const report = await ticked(worker);
      expect(report.chain).toBe(false);
      expect(calls.sentLookups).toBe(0);
      expect(await redis.get(keys().index)).toBeNull();
    }
  });

  test("a simulation answering no gas amount leaves the pair unanswered", async () => {
    for (const gasUsed of [-1n, 7 as unknown as bigint]) {
      await queue(pairOf());
      const { worker, calls } = workerWith({
        simulate: async () => ({ reverted: false, gasUsed }),
      });
      expect((await ticked(worker)).kept).toBe(1);
      expect(calls.sends).toHaveLength(0);
    }
  });

  test("fewer than POSTING_UNANSWERED_TICKS failing ticks keep it, however far apart", async () => {
    await queue(pairOf());
    let now = NOW;
    const { worker } = workerWith({ ...failingSimulation, now: () => now });
    for (let i = 0; i < POSTING_UNANSWERED_TICKS - 1; i++) {
      expect((await ticked(worker)).kept).toBe(1);
      now += 10 * POSTING_UNANSWERED_SPAN;
    }
  });

  test("a database failure on one election leaves that pair unanswered, not the others", async () => {
    const stuck = await queue(pairOf(1));
    const fine = await queue(pairOf(2));
    const real = admitting();
    const { worker } = workerWith({
      admissions: {
        postings: async (sql, id) => {
          if (current === stuck) throw new Error("connection lost");
          return real.postings(sql, id);
        },
      },
      sent: async (k) => {
        current = k;
        return undefined;
      },
    });
    let current = "";
    const report = await ticked(worker);
    expect(report.kept).toBe(1);
    expect(report.answered.sent).toBe(1);
    expect(await outcomeOf(fine)).toEqual({ sent: true, transaction: TX, layer: "l2" });
    expect(await redis.hkeys(keys().queue)).toEqual([stuck]);
  });
});

const failingSimulation: WorkerOptions = {
  simulate: () => Promise.reject(new Error("node down")),
};
