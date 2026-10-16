import { readFileSync } from "node:fs";
import { BN254_R, POSEIDON2_ZERO_ONE } from "@abolishus/crypto";
import fc from "fast-check";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  parseTier0Request,
  REGISTRATION_QUEUE_MAX,
  TIER0_INDEX_MAX_LAG,
  tier0Keys,
  Tier0RegistrationError,
  Tier0Registrations,
  type Tier0RequestInput,
  type Turnstile,
  type TurnstileAction,
  type TurnstileVerdict,
  TURNSTILE_ACTION_TIER0,
} from "../src/index.ts";

// Tier 0 registration's route and queue against a live Redis
// (docs/spec/registration.md, Request, Answers and Queue): the checks run in
// the spec's order and spend no token before step 7, no answer depends on
// the commitment's own state, the queue never passes its bound or holds a
// commitment for two groups, and Redis keeps nothing but commitments and
// their groups (T-10, T-11, T-13, T-16, T-52).

const redisUrl = process.env["REDIS_URL"];
if (!redisUrl) throw new Error("REDIS_URL is not set");
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const GROUP = 7n;
const NOW = 1_800_000_000;

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
  // Each test its own key prefix, so runs sharing a Redis never meet.
  prefix = `test-tier0-${process.pid}-${Date.now()}-${run++}`;
});
afterEach(async () => {
  const left = await allKeys();
  if (left.length > 0) await redis.del(...left);
});

const hex = (v: bigint) => v.toString(16).padStart(64, "0");

/** A commitment the route accepts: below `r`, and none of the forbidden values. */
const commitmentArb = fc
  .bigInt({ min: 2n, max: BN254_R - 1n })
  .filter((v) => v !== POSEIDON2_ZERO_ONE)
  .map(hex);

const tokenArb = fc
  .array(fc.integer({ min: 0x21, max: 0x7e }), { minLength: 1, maxLength: 64 })
  .map((cs) => String.fromCharCode(...cs));

/** A Turnstile stand-in that answers `verdict` and records every call. */
function stubTurnstile(verdict: TurnstileVerdict = "passed") {
  const calls: { token: string | null; action: TurnstileAction }[] = [];
  const turnstile: Turnstile = {
    verify(token, action) {
      calls.push({ token, action });
      return Promise.resolve(verdict);
    },
  };
  return { calls, turnstile };
}

function service(
  options: { verdict?: TurnstileVerdict; now?: number; groups?: Map<number, bigint> } = {},
) {
  const stub = stubTurnstile(options.verdict);
  const registrations = new Tier0Registrations({
    redis,
    groups: options.groups ?? new Map([[0, GROUP]]),
    turnstile: stub.turnstile,
    now: () => options.now ?? NOW,
    prefix,
  });
  return { registrations, calls: stub.calls };
}

const keys = () => tier0Keys(prefix);
const fresh = () => redis.set(keys().indexed, String(NOW));

async function refusal(promise: Promise<unknown>) {
  const e = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(e).toBeInstanceOf(Tier0RegistrationError);
  const err = e as Tier0RegistrationError;
  return err.malformed === undefined ? err.code : `${err.code}:${err.malformed}`;
}

const request = (commitment: string, over: Partial<Tier0RequestInput> = {}) => ({
  commitment,
  region: "0",
  turnstile: "token",
  ...over,
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

describe("values", () => {
  test("match docs/spec/registration.md, Values", () => {
    const spec = readFileSync(
      new URL("../../../docs/spec/registration.md", import.meta.url),
      "utf8",
    );
    const value = (name: string) =>
      new RegExp(`^\\| \`${name}\`\\s*\\| ([^|]+?)\\s*\\|`, "m").exec(spec)?.[1];
    expect(value("REGISTRATION_QUEUE_MAX")).toBe(REGISTRATION_QUEUE_MAX.toLocaleString("en-US"));
    expect(value("TURNSTILE_ACTION_TIER0")).toBe(`\`${TURNSTILE_ACTION_TIER0}\``);
    expect(TIER0_INDEX_MAX_LAG).toBe(60);
  });
});

describe("parseTier0Request", () => {
  test("accepts every commitment below r but the forbidden ones, any u32 region and any token", () => {
    fc.assert(
      fc.property(commitmentArb, fc.integer({ min: 0, max: 2 ** 32 - 1 }), tokenArb, (c, r, t) => {
        expect(parseTier0Request({ commitment: c, region: String(r), turnstile: t })).toEqual({
          commitment: c,
          region: r,
          turnstile: t,
        });
      }),
      { numRuns },
    );
  });

  test("refuses commitments that aren't 64 lowercase hex digits", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 80 }).filter((s) => !/^[0-9a-f]{64}$/.test(s)),
        (c) => {
          expect(() => parseTier0Request(request(c))).toThrow(
            expect.objectContaining({ code: "malformed", malformed: "commitment" }),
          );
        },
      ),
      { numRuns },
    );
    for (const c of [`0x${"1".repeat(62)}`, "A".repeat(64), "1".repeat(63), "1".repeat(65)])
      expect(() => parseTier0Request(request(c))).toThrow(
        expect.objectContaining({ malformed: "commitment" }),
      );
  });

  test("refuses commitments at or above r as non-canonical", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: BN254_R, max: (1n << 256n) - 1n }), (v) => {
        expect(() => parseTier0Request(request(hex(v)))).toThrow(
          expect.objectContaining({ code: "malformed", malformed: "non-canonical" }),
        );
      }),
      { numRuns },
    );
  });

  test("refuses the forbidden commitments 0, 1 and Poseidon2(0, 1)", () => {
    for (const v of [0n, 1n, POSEIDON2_ZERO_ONE])
      expect(() => parseTier0Request(request(hex(v)))).toThrow(
        expect.objectContaining({ code: "malformed", malformed: "forbidden-commitment" }),
      );
  });

  test("refuses regions that aren't canonical decimal u32s", () => {
    for (const r of ["", "-1", "+1", "01", "00", "1.0", " 1", "4294967296", "99999999999", "1e3"])
      expect(() => parseTier0Request(request(hex(5n), { region: r }))).toThrow(
        expect.objectContaining({ malformed: "region" }),
      );
    expect(parseTier0Request(request(hex(5n), { region: "4294967295" })).region).toBe(2 ** 32 - 1);
  });

  test("refuses tokens outside 1 to 2,048 characters from 0x21 to 0x7e", () => {
    for (const t of ["", " ", "a b", "é", "\x7f", "a".repeat(2049)])
      expect(() => parseTier0Request(request(hex(5n), { turnstile: t }))).toThrow(
        expect.objectContaining({ malformed: "turnstile" }),
      );
    expect(parseTier0Request(request(hex(5n), { turnstile: "a".repeat(2048) })).turnstile).toBe(
      "a".repeat(2048),
    );
  });
});

describe("Tier0Registrations", () => {
  test("serves region 0 only, with one published group", () => {
    const { turnstile } = stubTurnstile();
    const make = (groups: Map<number, bigint>) => () =>
      new Tier0Registrations({ redis, groups, turnstile, now: () => NOW, prefix });
    expect(make(new Map())).toThrow(RangeError);
    expect(make(new Map([[1, 1n]]))).toThrow(RangeError);
    expect(
      make(
        new Map([
          [0, 1n],
          [1, 2n],
        ]),
      ),
    ).toThrow(RangeError);
    expect(make(new Map([[0, -1n]]))).toThrow(RangeError);
    expect(make(new Map([[0, 1n << 64n]]))).toThrow(RangeError);
    expect(make(new Map([[0, (1n << 64n) - 1n]]))).not.toThrow();
  });

  test("queues a new commitment for its region's group, solved for tier0-register", async () => {
    await fresh();
    const { registrations, calls } = service();
    await registrations.register(request(hex(5n), { turnstile: "tok.en-1_" }));
    expect(calls).toEqual([{ token: "tok.en-1_", action: "tier0-register" }]);
    expect(await redis.hgetall(keys().queue)).toEqual({ [hex(5n)]: "7" });
    expect(await redis.hgetall(keys().sizes)).toEqual({ "7": "1" });
  });

  test("answers each step's failure in the spec's order, spending no token before step 7", async () => {
    const commitment = hex(5n);
    // Steps 2 to 4 need nothing from Redis.
    {
      const { registrations, calls } = service();
      expect(await refusal(registrations.register(request("zz")))).toBe("malformed:commitment");
      expect(await refusal(registrations.register(request(hex(1n))))).toBe(
        "malformed:forbidden-commitment",
      );
      expect(await refusal(registrations.register(request(commitment, { region: "1" })))).toBe(
        "region-unknown",
      );
      // Step 6 before a token is spent: the index was never brought up to date.
      expect(await refusal(registrations.register(request(commitment)))).toBe("unavailable");
      expect(calls).toEqual([]);
    }
    // Step 6: an index more than a minute behind.
    await redis.set(keys().indexed, String(NOW - TIER0_INDEX_MAX_LAG - 1));
    {
      const { registrations, calls } = service();
      expect(await refusal(registrations.register(request(commitment)))).toBe("unavailable");
      expect(calls).toEqual([]);
    }
    await redis.set(keys().indexed, String(NOW - TIER0_INDEX_MAX_LAG));
    // Step 5 comes before step 6, and before the token.
    await redis.hset(keys().sizes, "7", String(REGISTRATION_QUEUE_MAX));
    await redis.set(keys().indexed, "");
    {
      const { registrations, calls } = service();
      expect(await refusal(registrations.register(request(commitment)))).toBe("busy");
      expect(calls).toEqual([]);
    }
    await redis.del(keys().sizes);
    await redis.set(keys().indexed, String(NOW - TIER0_INDEX_MAX_LAG));
    // Step 7.
    for (const [verdict, code] of [
      ["refused", "challenge-refused"],
      ["unavailable", "challenge-unavailable"],
    ] as const) {
      const { registrations, calls } = service({ verdict });
      expect(await refusal(registrations.register(request(commitment)))).toBe(code);
      expect(calls).toHaveLength(1);
    }
    expect(await redis.exists(keys().queue)).toBe(0);
    // An index exactly a minute old is current.
    await service().registrations.register(request(commitment));
    expect(await redis.hget(keys().queue, commitment)).toBe("7");
  });

  test("refuses a malformed index time rather than reading it as current", async () => {
    for (const indexed of ["", "abc", "1e9", "-1", `${NOW}.5`, "9".repeat(16)]) {
      await redis.set(keys().indexed, indexed);
      expect(await refusal(service().registrations.register(request(hex(5n))))).toBe("unavailable");
    }
  });

  test("answers alike whether a commitment is new, queued, live or in flight, and queues only a new one", async () => {
    await fc.assert(
      fc.asyncProperty(
        commitmentArb,
        fc.constantFrom("new", "queued-here", "queued-elsewhere", "live", "inflight"),
        async (commitment, state) => {
          prefix = `test-tier0-${process.pid}-${Date.now()}-${run++}`;
          await fresh();
          const k = keys();
          if (state === "queued-here") await redis.hset(k.queue, commitment, "7");
          if (state === "queued-elsewhere") await redis.hset(k.queue, commitment, "9");
          if (state === "queued-here" || state === "queued-elsewhere")
            await redis.hset(k.sizes, state === "queued-here" ? "7" : "9", "1");
          if (state === "live") await redis.sadd(k.live, commitment);
          if (state === "inflight") await redis.sadd(k.inflight, commitment);
          const before = await redis.hgetall(k.queue);
          await expect(service().registrations.register(request(commitment))).resolves.toBe(
            undefined,
          );
          const after = await redis.hgetall(k.queue);
          // Queued for the group it was first queued for, once; never queued
          // when the index or a batch already holds it.
          if (state === "new") expect(after).toEqual({ [commitment]: "7" });
          else expect(after).toEqual(before);
          const sizes = await redis.hgetall(k.sizes);
          const counted: Record<string, number> = {};
          for (const g of Object.values(after)) counted[g] = (counted[g] ?? 0) + 1;
          expect(Object.fromEntries(Object.entries(sizes).map(([g, n]) => [g, Number(n)]))).toEqual(
            counted,
          );
          await redis.del(...Object.values(k));
        },
      ),
      { numRuns: Math.min(numRuns, 200) },
    );
  });

  test("never queues past the bound, however many requests pass step 5 together", async () => {
    await fresh();
    const room = 5;
    await redis.hset(keys().sizes, "7", String(REGISTRATION_QUEUE_MAX - room));
    const { registrations } = service();
    const outcomes = await Promise.allSettled(
      Array.from({ length: 40 }, (_, i) => registrations.register(request(hex(1000n + BigInt(i))))),
    );
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(room);
    for (const o of outcomes)
      if (o.status === "rejected") expect(o.reason).toMatchObject({ code: "busy" });
    expect(await redis.hget(keys().sizes, "7")).toBe(String(REGISTRATION_QUEUE_MAX));
    expect(await redis.hlen(keys().queue)).toBe(room);
  });

  test("answers busy for a full queue whatever the commitment's state", async () => {
    await fresh();
    await redis.hset(keys().sizes, "7", String(REGISTRATION_QUEUE_MAX));
    await redis.sadd(keys().live, hex(5n));
    for (const c of [hex(5n), hex(6n)])
      expect(await refusal(service().registrations.register(request(c)))).toBe("busy");
  });

  test("busy at step 8 if the queue filled during the Turnstile check, with the token spent", async () => {
    await fresh();
    const calls: string[] = [];
    const turnstile: Turnstile = {
      async verify(token) {
        calls.push(token ?? "");
        await redis.hset(keys().sizes, "7", String(REGISTRATION_QUEUE_MAX));
        return "passed";
      },
    };
    const registrations = new Tier0Registrations({
      redis,
      groups: new Map([[0, GROUP]]),
      turnstile,
      now: () => NOW,
      prefix,
    });
    expect(await refusal(registrations.register(request(hex(5n))))).toBe("busy");
    expect(calls).toEqual(["token"]);
    expect(await redis.exists(keys().queue)).toBe(0);
  });

  test("Redis keeps the commitments and their group and nothing else of a request", async () => {
    await fresh();
    const { registrations } = service();
    const commitments = [hex(11n), hex(12n), hex(13n)];
    for (const [i, c] of commitments.entries())
      await registrations.register(request(c, { turnstile: `secret-token-${i}` }));
    const k = keys();
    // No key per commitment or per request: only the fixed keys.
    expect(await allKeys()).toEqual([k.indexed, k.queue, k.sizes].sort());
    for (const key of [k.queue, k.sizes]) expect(await redis.ttl(key)).toBe(-1);
    expect(await redis.hgetall(k.queue)).toEqual(
      Object.fromEntries(commitments.map((c) => [c, "7"])),
    );
    expect(await redis.hgetall(k.sizes)).toEqual({ "7": "3" });
    // The token reaches no key or value.
    const dump = JSON.stringify([
      await allKeys(),
      await redis.hgetall(k.queue),
      await redis.hgetall(k.sizes),
      await redis.get(k.indexed),
    ]);
    expect(dump).not.toContain("secret-token");
  });

  test("errors never quote the request", async () => {
    const { registrations } = service();
    const commitment = hex(BN254_R);
    const e = await registrations.register(request(commitment, { region: "12" })).catch((e) => e);
    expect(String(e)).not.toContain(commitment);
    expect((e as Error).message).toBe("registration refused: malformed (non-canonical)");
  });
});
