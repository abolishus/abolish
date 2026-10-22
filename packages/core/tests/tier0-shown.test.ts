import { BN254_R, POSEIDON2_ZERO_ONE, TOKEN_KEY_PERIOD } from "@abolishus/crypto";
import fc from "fast-check";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  commitmentKey,
  TIER0_INDEX_MAX_LAG,
  TIER0_INDEX_MAX_SKEW,
  TIER0_SHOWN_MARGIN,
  tier0Keys,
  Tier0Registrations,
  Tier0ShownList,
  type Turnstile,
} from "../src/index.ts";

// Re-issuance's check-and-mark of a shown commitment against a live Redis
// (docs/spec/tier0-token.md, Keys, item 4; docs/spec/registration.md, Queue):
// a commitment ever added to a Tier 0 group, in flight or queued is refused,
// a lagging index marks nothing, a mark is idempotent and lapses, the route
// never queues a marked commitment, and the mark and the route's queueing
// are one serialised step (T-10, T-74).

const redisUrl = process.env["REDIS_URL"];
if (!redisUrl) throw new Error("REDIS_URL is not set");
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const GROUP = 7n;
// A dead key's period, the second its mark lapses (the end of `Q + 1`), and
// a clock a day before that.
const Q = 700;
const LAPSE = TOKEN_KEY_PERIOD * (Q + 2);
const NOW = LAPSE - 86_400;

let redis: Redis;
let run = 0;
let prefix: string;
beforeAll(() => {
  redis = new Redis(redisUrl);
});
afterAll(async () => {
  await redis.quit();
});
beforeEach(() => {
  prefix = `test-tier0-shown-${process.pid}-${Date.now()}-${run++}`;
});
afterEach(async () => {
  const left = await allKeys();
  if (left.length > 0) await redis.del(...left);
});

async function allKeys() {
  const found: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", `${prefix}:*`, "COUNT", 1000);
    cursor = next;
    found.push(...batch);
  } while (cursor !== "0");
  return found.sort();
}

const commitmentArb = fc
  .bigInt({ min: 2n, max: BN254_R - 1n })
  .filter((v) => v !== POSEIDON2_ZERO_ONE);

const keys = () => tier0Keys(prefix);
const fresh = (at = NOW) => redis.set(keys().indexed, String(at));
const shown = (now = NOW) => new Tier0ShownList({ redis, now: () => now, prefix });

const passing: Turnstile = { verify: () => Promise.resolve("passed") };
const route = (now = NOW) =>
  new Tier0Registrations({
    redis,
    groups: new Map([[0, GROUP]]),
    turnstile: passing,
    now: () => now,
    prefix,
  });
const register = (c: bigint, now = NOW) =>
  route(now).register({ commitment: commitmentKey(c), region: "0", turnstile: "token" });

const marks = async () => {
  const flat = await redis.zrange(keys().shown, 0, -1, "WITHSCORES");
  const out: Record<string, number> = {};
  for (let i = 0; i < flat.length; i += 2) out[flat[i] as string] = Number(flat[i + 1]);
  return out;
};

describe("Tier0ShownList", () => {
  test("marks a commitment never added, in flight or queued, and the route then never queues it", async () => {
    await fc.assert(
      fc.asyncProperty(commitmentArb, async (c) => {
        prefix = `test-tier0-shown-${process.pid}-${Date.now()}-${run++}`;
        await fresh();
        expect(await shown().show(c, Q)).toBe("shown");
        expect(await marks()).toEqual({ [commitmentKey(c)]: LAPSE });
        // The route answers as for any accepted commitment, and queues nothing.
        await expect(register(c)).resolves.toBe(undefined);
        expect(await redis.exists(keys().queue)).toBe(0);
        expect(await redis.exists(keys().sizes)).toBe(0);
        await redis.del(...(await allKeys()));
      }),
      { numRuns: Math.min(numRuns, 100) },
    );
  });

  test("refuses a commitment in the index, an in-flight batch or the queue, and marks nothing", async () => {
    await fc.assert(
      fc.asyncProperty(
        commitmentArb,
        // The index is every Tier 0 addition, so `live` covers a commitment
        // removed since, and a self-paid one. An in-flight batch whose
        // unfinalized addition a reorg dropped from the index stays in
        // `inflight` until final, so it is still refused.
        fc.constantFrom("live", "inflight", "inflight-reorged", "queued-here", "queued-elsewhere"),
        async (c, state) => {
          prefix = `test-tier0-shown-${process.pid}-${Date.now()}-${run++}`;
          await fresh();
          const k = keys();
          const key = commitmentKey(c);
          if (state === "live") await redis.sadd(k.live, key);
          if (state === "inflight")
            await redis.sadd(k.inflight, key).then(() => redis.sadd(k.live, key));
          if (state === "inflight-reorged") await redis.sadd(k.inflight, key);
          if (state === "queued-here") await redis.hset(k.queue, key, GROUP.toString());
          if (state === "queued-elsewhere") await redis.hset(k.queue, key, "9");
          expect(await shown().show(c, Q)).toBe("registered");
          expect(await redis.exists(k.shown)).toBe(0);
          await redis.del(...(await allKeys()));
        },
      ),
      { numRuns: Math.min(numRuns, 100) },
    );
  });

  test("a commitment queued by the route is refused, and one marked first is never queued", async () => {
    const [a, b] = [11n, 12n];
    await fresh();
    await register(a);
    expect(await shown().show(a, Q)).toBe("registered");
    expect(await shown().show(b, Q)).toBe("shown");
    await register(b);
    expect(await redis.hkeys(keys().queue)).toEqual([commitmentKey(a)]);
  });

  test("the mark and the route's queueing are one serialised step", async () => {
    await fc.assert(
      fc.asyncProperty(commitmentArb, fc.boolean(), async (c, markFirst) => {
        prefix = `test-tier0-shown-${process.pid}-${Date.now()}-${run++}`;
        await fresh();
        const [first, second] = markFirst
          ? [() => shown().show(c, Q), () => register(c)]
          : [() => register(c), () => shown().show(c, Q)];
        const outcomes = await Promise.all([first(), second()]);
        const outcome = outcomes.find((o) => o !== undefined);
        const queued = (await redis.hexists(keys().queue, commitmentKey(c))) === 1;
        // Exactly one wins: marked and never queued, or queued and refused.
        expect(queued).toBe(outcome === "registered");
        expect(await redis.exists(keys().shown)).toBe(queued ? 0 : 1);
        await redis.del(...(await allKeys()));
      }),
      { numRuns: Math.min(numRuns, 100) },
    );
  });

  test("a lagging, missing, malformed or early index marks nothing", async () => {
    const c = 21n;
    expect(await shown().show(c, Q)).toBe("unavailable");
    for (const at of [
      String(NOW - TIER0_INDEX_MAX_LAG - 1),
      String(NOW + TIER0_INDEX_MAX_SKEW + 1),
      "",
      "12a",
      "-1",
      "1".repeat(16),
    ]) {
      await redis.set(keys().indexed, at);
      expect(await shown().show(c, Q)).toBe("unavailable");
    }
    expect(await redis.exists(keys().shown)).toBe(0);
    // At either edge it is current.
    await fresh(NOW - TIER0_INDEX_MAX_LAG);
    expect(await shown().show(c, Q)).toBe("shown");
    await fresh(NOW + TIER0_INDEX_MAX_SKEW);
    expect(await shown().show(22n, Q)).toBe("shown");
  });

  test("a repeated mark succeeds, and never shortens its lapse", async () => {
    const c = 31n;
    await fresh();
    expect(await shown().show(c, Q)).toBe("shown");
    expect(await shown().show(c, Q - 1)).toBe("shown");
    expect(await marks()).toEqual({ [commitmentKey(c)]: LAPSE });
    expect(await shown().show(c, Q + 1)).toBe("shown");
    expect(await marks()).toEqual({ [commitmentKey(c)]: LAPSE + TOKEN_KEY_PERIOD });
  });

  test("a mark lapses at the end of its key's period q + 1 and is kept TIER0_SHOWN_MARGIN past it, then the route queues it again and the next mark prunes it", async () => {
    const [c, d] = [41n, 42n];
    const M = TIER0_SHOWN_MARGIN;
    await fresh();
    expect(await shown().show(c, Q)).toBe("shown");
    expect(await marks()).toEqual({ [commitmentKey(c)]: LAPSE });
    // Past its lapse, but inside the margin: a redemption checked before
    // the lapse and queued after it is still dropped.
    for (const at of [LAPSE + 10, LAPSE - 1 + M]) {
      await fresh(at);
      await register(c, at);
    }
    expect(await redis.exists(keys().queue)).toBe(0);
    // A mark inside the margin isn't pruned.
    expect(await shown(LAPSE - 1 + M).show(d, Q + 1)).toBe("shown");
    expect(Object.keys(await marks()).sort()).toEqual([c, d].map(commitmentKey).sort());
    await fresh(LAPSE + M);
    await register(c, LAPSE + M);
    expect(await redis.hkeys(keys().queue)).toEqual([commitmentKey(c)]);
    await redis.del(keys().queue, keys().sizes);
    expect(await shown(LAPSE + M).show(d, Q + 1)).toBe("shown");
    expect(await marks()).toEqual({ [commitmentKey(d)]: LAPSE + TOKEN_KEY_PERIOD });
  });

  test("an issuer's clock ahead of the service's at the boundary still marks, and prunes no mark the service keeps", async () => {
    // The issuer marks just after the lapse on its own clock, while the
    // service's clock is still before it, so the dead key still redeems
    // there: the route must drop the commitment.
    const [c, other] = [51n, 52n];
    await fresh();
    expect(await shown().show(other, Q)).toBe("shown");
    const ahead = LAPSE + 60;
    await fresh(ahead);
    expect(await shown(ahead).show(c, Q)).toBe("shown");
    expect(await marks()).toEqual({ [commitmentKey(c)]: LAPSE, [commitmentKey(other)]: LAPSE });
    await fresh(LAPSE - 1);
    await register(c, LAPSE - 1);
    await register(other, LAPSE - 1);
    expect(await redis.exists(keys().queue)).toBe(0);
    // A past lapse is checked as any other.
    await fresh(ahead);
    await redis.sadd(keys().live, commitmentKey(53n));
    expect(await shown(ahead).show(53n, Q)).toBe("registered");
  });

  test("Redis keeps the commitment and its lapse and nothing else", async () => {
    await fresh();
    const before = await allKeys();
    await shown().show(61n, Q);
    expect(await allKeys()).toEqual([...before, keys().shown].sort());
    expect(await marks()).toEqual({ [commitmentKey(61n)]: LAPSE });
  });

  test("refuses a non-canonical or forbidden commitment and a period that isn't a u32 with an exact lapse", async () => {
    const list = shown();
    for (const c of [-1n, BN254_R, 0n, 1n, POSEIDON2_ZERO_ONE])
      await expect(list.show(c, Q)).rejects.toThrow(RangeError);
    for (const period of [-1, 1.5, Number.NaN, 2 ** 32, 2 ** 32 - 1])
      await expect(list.show(71n, period)).rejects.toThrow(RangeError);
    expect(await allKeys()).toEqual([]);
  });

  test("a Redis failure answers unavailable, without quoting the commitment", async () => {
    const c = 81n;
    const failing = new Tier0ShownList({
      redis: { eval: (...args) => Promise.reject(new Error(`ERR ${args.join(" ")}`)) },
      now: () => NOW,
      prefix,
    });
    await expect(failing.show(c, Q)).resolves.toBe("unavailable");
    const odd = new Tier0ShownList({
      redis: { eval: () => Promise.resolve(1) },
      now: () => NOW,
      prefix,
    });
    await expect(odd.show(c, Q)).resolves.toBe("unavailable");
  });
});
