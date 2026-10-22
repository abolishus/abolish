import { DELIVERY_WINDOW } from "@abolishus/crypto";
import { PINNED_FORCED_INCLUSION } from "@abolishus/verifier";
import { keccak_256 } from "@noble/hashes/sha3.js";
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
  parsePostingPair,
  POSTING_INDEX_MAX_LAG,
  POSTING_INDEX_MAX_SKEW,
  POSTING_MAX_CONCURRENT,
  POSTING_MAX_DATA,
  POSTING_QUEUE_MAX,
  POSTING_SEND_MARGIN,
  POSTING_WORKER_REFUSALS,
  postingCalldataLength,
  postingIndexValue,
  postingKey,
  postingKeys,
  type PostingOutcome,
  postingOutcomeValue,
  postingPairValue,
  type PostingRedis,
  PostingRelay,
  PostingRelayError,
  recordRegistration,
  storeDefinition,
} from "../src/index.ts";
import { type TestDb, testDb } from "./db.ts";

// The posting relay's route and queue against a live Redis and Postgres
// (docs/spec/posting-relay.md, Request, Answers and Queue): the checks run
// in the spec's order, only a pair that passes the public check takes a
// queue place, the queue never passes its bound, Redis keeps nothing but
// each pair under its posting's keccak256, and the route answers what the
// worker wrote, or busy (T-10, T-11, T-13, T-18, T-52). The election's
// ceremony is run by packages/verifier's tests/receipt-poll.ts, whose
// ballots are encrypted there to its seats, so honest postings pass.

const redisUrl = process.env["REDIS_URL"];
if (!redisUrl) throw new Error("REDIS_URL is not set");
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const NOW = 1_800_000_000;
const clock = { epoch: definition.opens_at - 7_200n, period: 3_600n };
// `c_D = t_D − F`, by the spec's formulas (docs/spec/delivery.md, Windows).
const C_D =
  definition.closes_at +
  BigInt(definition.l1_inclusion_bound) +
  DELIVERY_WINDOW -
  PINNED_FORCED_INCLUSION;
const LAST = C_D - POSTING_SEND_MARGIN;

const first = postedBallot(ballots[0] as (typeof ballots)[number]);
const second = postedBallot(ballots[1] as (typeof ballots)[number]);
const honest = (seat = 1, ballot = first) => ({
  posting: toHex(postingFor(ballot, seat)),
  ballot: toHex(ballot.payload),
});

let redis: Redis;
let prefix: string;
let run = 0;
let db: TestDb;
let app: Sql;
beforeAll(async () => {
  redis = new Redis(redisUrl);
  // One schema for every test: the election, registered, never changes.
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
  // Each test its own key prefix, so runs sharing a Redis never meet.
  prefix = `test-posting-${process.pid}-${Date.now()}-${run++}`;
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

/** The index as the worker writes it: read at `at`, with the L2's latest block at `l2Time`. */
const setIndex = (l2Time = LAST, at = NOW) =>
  redis.set(keys().index, postingIndexValue({ at, l2Time }));

interface RelayOptions {
  readonly sql?: Sql;
  readonly redis?: PostingRedis;
  readonly admissions?: BallotAdmissions;
  readonly now?: number;
  /** Runs on each of the route's waits, as the worker would in the meantime. */
  readonly meanwhile?: () => Promise<unknown>;
}

function relayWith(o: RelayOptions = {}) {
  return new PostingRelay({
    sql: o.sql ?? app,
    redis: o.redis ?? redis,
    admissions: o.admissions ?? new BallotAdmissions({ panels: [panel], clock }),
    now: () => o.now ?? NOW,
    waitMs: 0,
    sleep: async () => {
      await o.meanwhile?.();
    },
    prefix,
  });
}

/** The answer as a string: `sent:<layer>`, or the error's code with its detail. */
async function answer(relay: PostingRelay, input: { posting: string; ballot: string }) {
  try {
    const sent = await relay.relay(input);
    return `sent:${sent.layer}:${toHex(sent.transaction)}`;
  } catch (e) {
    if (!(e instanceof PostingRelayError)) throw e;
    const detail = e.malformed ?? e.refusal;
    return detail === undefined ? e.code : `${e.code}:${detail}`;
  }
}

const TX = new Uint8Array(32).fill(0xab);
const writeOutcome = (posting: string, outcome: PostingOutcome) =>
  redis.set(keys().outcome(postingKey(Buffer.from(posting, "hex"))), postingOutcomeValue(outcome));

describe("an honest posting", { timeout: 60_000 }, () => {
  test("is queued under its keccak256, alone, and is busy until the worker answers", async () => {
    await setIndex();
    const input = honest();
    expect(await answer(relayWith(), input)).toBe("busy");
    const posting = Buffer.from(input.posting, "hex");
    const key = toHex(keccak_256(posting));
    expect(postingKey(posting)).toBe(key);
    // The pair and nothing else: no arrival time, order or count (T-11, T-13).
    expect(await redis.hgetall(keys().queue)).toEqual({
      [key]: `${input.posting} ${input.ballot}`,
    });
    expect((await keysUnder()).sort()).toEqual([keys().index, keys().queue].sort());
    expect(parsePostingPair(await redis.hget(keys().queue, key))).toEqual({
      posting: new Uint8Array(posting),
      ballot: first.payload,
    });
  });

  test("answers what the worker writes while the route waits", async () => {
    await setIndex();
    for (const [outcome, expected] of [
      [{ sent: true, transaction: TX, layer: "l2" }, `sent:l2:${toHex(TX)}`],
      [{ sent: true, transaction: TX, layer: "l1" }, `sent:l1:${toHex(TX)}`],
      [{ sent: false, code: "ballot-cap" }, "refused:ballot-cap"],
      [{ sent: false, code: "simulation" }, "refused:simulation"],
    ] as const) {
      const left = (await keysUnder()).filter((k) => k !== keys().index);
      if (left.length > 0) await redis.del(...left);
      const input = honest(2);
      const relay = relayWith({ meanwhile: () => writeOutcome(input.posting, outcome) });
      expect(await answer(relay, input)).toBe(expected);
    }
  });

  test("a posting with an outcome gets it at once, and isn't queued again", async () => {
    await setIndex();
    const input = honest(3);
    await writeOutcome(input.posting, { sent: true, transaction: TX, layer: "l2" });
    let waits = 0;
    const relay = relayWith({ meanwhile: async () => void waits++ });
    expect(await answer(relay, input)).toBe(`sent:l2:${toHex(TX)}`);
    expect(waits).toBe(0);
    expect(await redis.hlen(keys().queue)).toBe(0);
  });

  test("the same posting sent twice is queued once", async () => {
    await setIndex();
    const relay = relayWith();
    expect(await answer(relay, honest(1))).toBe("busy");
    expect(await answer(relay, honest(1))).toBe("busy");
    expect(await answer(relay, honest(1, second))).toBe("busy");
    expect(await redis.hlen(keys().queue)).toBe(2);
  });

  test("an outcome the store holds in any other form is unavailable, never an answer", async () => {
    await setIndex();
    const input = honest();
    await redis.set(keys().outcome(postingKey(Buffer.from(input.posting, "hex"))), "sent l2 00");
    expect(await answer(relayWith(), input)).toBe("unavailable");
  });
});

describe("step 2: the fields' forms", () => {
  test.each([
    ["uppercase hex", { ...honest(), posting: honest().posting.toUpperCase() }],
    ["a 0x prefix", { ...honest(), ballot: `0x${honest().ballot}` }],
    ["half a byte", { ...honest(), posting: `${honest().posting}0` }],
    ["an empty posting", { ...honest(), posting: "" }],
    ["an empty ballot", { ...honest(), ballot: "" }],
    ["a non-hex digit", { ...honest(), ballot: `${honest().ballot.slice(0, -2)}zz` }],
  ])("%s is refused", async (_, input) => {
    expect(await answer(relayWith(), input)).toBe("form");
  });

  test("calldata over POSTING_MAX_DATA is refused, and within it the records are read", async () => {
    // The longest ballot whose calldata beside the posting is within the
    // bound, then one byte more, which takes another word past it.
    const p = postingFor(first, 1).length;
    const room = Math.floor((POSTING_MAX_DATA - 132 - Math.ceil(p / 32) * 32) / 32) * 32;
    expect(postingCalldataLength(p, room)).toBeLessThanOrEqual(POSTING_MAX_DATA);
    expect(postingCalldataLength(p, room + 1)).toBeGreaterThan(POSTING_MAX_DATA);
    const at = { posting: honest().posting, ballot: "00".repeat(room) };
    expect(await answer(relayWith(), at)).toBe("malformed:ballot-decode");
    const over = { posting: honest().posting, ballot: "00".repeat(room + 1) };
    expect(await answer(relayWith(), over)).toBe("form");
  });

  test("the calldata length is submitPosting's ABI encoding", () => {
    fc.assert(
      fc.property(fc.nat({ max: 200_000 }), fc.nat({ max: 200_000 }), (p, b) => {
        const words = (n: number) => Math.ceil(n / 32);
        // selector, two offsets, two lengths, two padded tails.
        expect(postingCalldataLength(p, b)).toBe(4 + 32 * (2 + 2 + words(p) + words(b)));
      }),
      { numRuns },
    );
  });
});

describe("step 3: the records alone", () => {
  // Judged before Postgres or Redis is touched, so neither is reachable here.
  const offline = () =>
    relayWith({
      sql: new Proxy({} as Sql, {
        get() {
          throw new Error("Postgres was read");
        },
      }),
      redis: { eval: () => Promise.reject(new Error("no redis")) },
    });

  test.each([
    ["a ballot that doesn't decode", { ...honest(), ballot: "0002" }, "malformed:ballot-decode"],
    [
      "a ballot of a version not relayed yet",
      { ...honest(), ballot: `000204${honest().ballot.slice(6)}` },
      "malformed:unsupported-version",
    ],
    ["a posting that doesn't decode", { ...honest(), posting: "000d01" }, "malformed:decode"],
    [
      "a posting of another definition",
      { ...honest(), posting: toHex(postingFor(first, 1, { definitionHash: new Uint8Array(32) })) },
      "malformed:posting-definition",
    ],
    [
      "a posting of another ballot",
      { ...honest(), posting: toHex(postingFor(first, 1, { ballotHash: second.hash })) },
      "malformed:posting-ballot",
    ],
  ])("%s is malformed", async (_, input, expected) => {
    expect(await answer(offline(), input)).toBe(expected);
  });
});

describe("step 4: the election and the relay's clock", { timeout: 60_000 }, () => {
  test("a definition no recorded registration carries is unknown, stored or not", async () => {
    const own = await testDb();
    try {
      const other = await own.as("abolish_app");
      await storeDefinition(other, definitionBytes);
      await appendEntry(other, electionId, 0, transcript, { first: true });
      await setIndex();
      expect(await answer(relayWith({ sql: other }), honest())).toBe("unknown-election");
      expect(await redis.hlen(keys().queue)).toBe(0);
    } finally {
      await own.close();
    }
  });

  test("a registered election whose definition isn't stored is unknown", async () => {
    const own = await testDb();
    try {
      const other = await own.as("abolish_app");
      await recordRegistration(other, { electionId, definitionHash, l2Block: 1n, logIndex: 0 });
      await setIndex();
      expect(await answer(relayWith({ sql: other }), honest())).toBe("unknown-election");
    } finally {
      await own.close();
    }
  });

  test("an election under no panel this release pins is unknown", async () => {
    await setIndex();
    const elsewhere = { threshold: panel.threshold, keys: [...panel.keys].reverse() };
    const admissions = new BallotAdmissions({ panels: [elsewhere], clock });
    expect(await answer(relayWith({ admissions }), honest())).toBe("unknown-election");
  });

  test("an index never written, unreadable, a minute stale or ahead of our clock is unavailable", async () => {
    expect(await answer(relayWith(), honest())).toBe("unavailable");
    await redis.set(keys().index, `${NOW} 01`);
    expect(await answer(relayWith(), honest())).toBe("unavailable");
    await setIndex(LAST, NOW - POSTING_INDEX_MAX_LAG - 1);
    expect(await answer(relayWith(), honest())).toBe("unavailable");
    await setIndex(LAST, NOW + POSTING_INDEX_MAX_SKEW + 1);
    expect(await answer(relayWith(), honest())).toBe("unavailable");
    expect(await redis.hlen(keys().queue)).toBe(0);
    await setIndex(LAST, NOW - POSTING_INDEX_MAX_LAG);
    expect(await answer(relayWith(), honest())).toBe("busy");
    await setIndex(LAST, NOW + POSTING_INDEX_MAX_SKEW);
    expect(await answer(relayWith(), honest(2))).toBe("busy");
  });

  test("the latest block past c_D − POSTING_SEND_MARGIN is too late, at it the pair is queued", async () => {
    await setIndex(LAST + 1n);
    expect(await answer(relayWith(), honest())).toBe("too-late");
    expect(await redis.hlen(keys().queue)).toBe(0);
    await setIndex(LAST);
    expect(await answer(relayWith(), honest())).toBe("busy");
  });

  test("Redis failing is unavailable", async () => {
    const broken = { eval: () => Promise.reject(new Error(`quoting ${honest().posting}`)) };
    const e = await relayWith({ redis: broken })
      .relay(honest())
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PostingRelayError);
    // The store's error never surfaces: it can quote the pair (T-11, T-18).
    expect((e as Error).message).toBe("posting refused: unavailable");
  });
});

describe("step 5: the public check", { timeout: 60_000 }, () => {
  test.each([
    [
      "another seat's ML-KEM message",
      { m: first.messages[1] as Uint8Array },
      "posting-encapsulation",
    ],
    ["another seat's ciphertext", { ciphertextOf: 2 }, "posting-hash"],
    ["a seat outside the key set", { seat: definition.panel_size + 1 }, "posting-seat"],
  ] as const)("%s is refused and takes no queue place", async (_, fields, code) => {
    await setIndex();
    const input = { ...honest(), posting: toHex(postingFor(first, 1, fields)) };
    expect(await answer(relayWith(), input)).toBe(`refused:${code}`);
    expect(await redis.hlen(keys().queue)).toBe(0);
  });
});

describe("step 6: the queue's bound", { timeout: 60_000 }, () => {
  test("a full queue answers busy, and a pair already queued is still answered", async () => {
    await setIndex();
    const relay = relayWith();
    expect(await answer(relay, honest(1))).toBe("busy");
    const fill: Record<string, string> = {};
    for (let i = 1; i < POSTING_QUEUE_MAX; i++)
      fill[toHex(keccak_256(Uint8Array.of(i)))] = postingPairValue(Uint8Array.of(i), first.payload);
    await redis.hset(keys().queue, fill);
    expect(await redis.hlen(keys().queue)).toBe(POSTING_QUEUE_MAX);
    // A new pair finds no place; the one queued finds its own.
    expect(await answer(relay, honest(2))).toBe("busy");
    expect(await redis.hlen(keys().queue)).toBe(POSTING_QUEUE_MAX);
    const outcome = { sent: true, transaction: TX, layer: "l2" } as const;
    const waiting = relayWith({ meanwhile: () => writeOutcome(honest(1).posting, outcome) });
    expect(await answer(waiting, honest(1))).toBe(`sent:l2:${toHex(TX)}`);
  });

  test("past POSTING_MAX_CONCURRENT requests at once, the next is busy before it is read further", async () => {
    await setIndex();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const relay = relayWith({ meanwhile: () => held });
    const pending = Array.from({ length: POSTING_MAX_CONCURRENT }, (_, i) =>
      answer(relay, honest((i % definition.panel_size) + 1, i < 4 ? first : second)),
    );
    // Let every one reach its wait.
    for (let i = 0; i < 50 && (await redis.hlen(keys().queue)) < POSTING_MAX_CONCURRENT; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(await answer(relay, honest(1))).toBe("busy");
    release();
    expect(await Promise.all(pending)).toEqual(pending.map(() => "busy"));
    expect(await answer(relay, honest(1))).toBe("busy");
  });
});

describe("the stored forms", () => {
  test("an index round-trips, and nothing else reads as one", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10 ** 15 - 1 }),
        fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }),
        (at, l2Time) => {
          expect(parsePostingIndex(postingIndexValue({ at, l2Time }))).toEqual({ at, l2Time });
        },
      ),
      { numRuns },
    );
    for (const bad of [
      "",
      "1",
      "01 2",
      "1 02",
      "1  2",
      "1 2 ",
      "-1 2",
      "1 18446744073709551616",
      1,
    ])
      expect(parsePostingIndex(bad)).toBeUndefined();
    expect(() => postingIndexValue({ at: -1, l2Time: 0n })).toThrow(RangeError);
    expect(() => postingIndexValue({ at: 0, l2Time: 1n << 64n })).toThrow(RangeError);
  });

  test("an outcome round-trips, and nothing else reads as one", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.record({
            sent: fc.constant(true as const),
            transaction: fc.uint8Array({ minLength: 32, maxLength: 32 }),
            layer: fc.constantFrom("l1" as const, "l2" as const),
          }),
          fc.record({
            sent: fc.constant(false as const),
            code: fc.constantFrom(...POSTING_WORKER_REFUSALS),
          }),
        ),
        (outcome: PostingOutcome) => {
          expect(parsePostingOutcome(postingOutcomeValue(outcome))).toEqual(outcome);
        },
      ),
      { numRuns },
    );
    for (const bad of ["", "sent l3 " + "00".repeat(32), "sent l2 00", "refused other", "refused"])
      expect(parsePostingOutcome(bad)).toBeUndefined();
  });

  test("a pair round-trips, and nothing else reads as one", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1 }), fc.uint8Array({ minLength: 1 }), (p, b) => {
        expect(parsePostingPair(postingPairValue(p, b))).toEqual({ posting: p, ballot: b });
      }),
      { numRuns },
    );
    for (const bad of ["", "00", "00 ", " 00", "00 0", "0A 00", "00  00"])
      expect(parsePostingPair(bad)).toBeUndefined();
  });

  test("every key shares one hash tag, and a prefix can't change it", () => {
    const k = postingKeys("p");
    const key = "ab".repeat(32);
    for (const name of [k.queue, k.index, k.outcome(key)])
      expect(name).toMatch(/^p:\{posting-relay\}:/);
    expect(() => postingKeys("a{b")).toThrow(RangeError);
    expect(() => postingKeys("")).toThrow(RangeError);
    expect(() => k.outcome("AB".repeat(32))).toThrow(RangeError);
  });
});
