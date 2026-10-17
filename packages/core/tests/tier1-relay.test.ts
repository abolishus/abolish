import { readFileSync } from "node:fs";
import {
  decodeTier1Addition,
  encodeTier1Addition,
  type Tier1Addition,
  VOUCH_LENGTH,
  VOUCH_ROOT_INTERVAL,
  VOUCH_ROOT_WINDOW,
} from "@abolishus/crypto";
import fc from "fast-check";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  parseTier1Index,
  parseTier1Request,
  recordKey,
  TIER1_INDEX_MAX_LAG,
  TIER1_INDEX_MAX_SKEW,
  TIER1_MAX_CONCURRENT,
  TIER1_RECORD_HEX,
  TIER1_RELAY_MARGIN,
  TIER1_RELAY_QUEUE_MAX,
  tier1IndexValue,
  tier1Keys,
  Tier1Relay,
  Tier1RelayError,
  type Turnstile,
  type TurnstileAction,
  type TurnstileVerdict,
  TURNSTILE_ACTION_TIER1,
} from "../src/index.ts";

// The Tier 1 relay's route and queue against a live Redis
// (docs/spec/tier1-relay.md, Request, Answers and Queue): the checks run in
// the spec's order and spend no token before step 7, the queue's size is
// read only after the solve, no answer depends on the commitment's state,
// the queue never passes its bound, and Redis keeps nothing but records
// under their hashes (T-10, T-11, T-13, T-25, T-52).
//
// Records are docs/spec/vectors/vouch.json's: its verdicts for checks 1 to 6
// are written from docs/spec/vouching.md, not from the code under test. The
// route verifies no proof, so a record moved onto the root grid (which
// breaks its proofs) stands for one that passes steps 3 to 6.

const redisUrl = process.env["REDIS_URL"];
if (!redisUrl) throw new Error("REDIS_URL is not set");
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

interface Addition {
  readonly id: string;
  readonly groupId: string;
  readonly record: string;
  readonly valid: boolean;
  readonly error?: string;
  readonly vouch?: number;
}
const vectors = JSON.parse(
  readFileSync(new URL("../../../docs/spec/vectors/vouch.json", import.meta.url), "utf8"),
) as {
  readonly additions: readonly Addition[];
  readonly decode: readonly { readonly name: string; readonly record: string }[];
};

const fromHex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const honest = vectors.additions.find((a) => a.id === "honest");
if (honest === undefined) throw new Error("vouch.json has no honest addition");
const decoded = decodeTier1Addition(fromHex(honest.record));
if (!decoded.ok) throw new Error("vouch.json's honest addition doesn't decode");
const HONEST: Tier1Addition = decoded.value;
const GROUP = HONEST.groupId;

/** The root grid block every vouch names by default, and the index's blocks around it. */
const ROOT = 1000n * VOUCH_ROOT_INTERVAL;
const SAFE = ROOT + 10n;
const LATEST = ROOT + 20n;
const NOW = 1_800_000_000;

// The honest record encoded once on the grid; others are patched from it,
// since each encoding decodes and subgroup-checks six proofs again, which
// for the dozens of records a test makes would outlast its timeout on CI.
const BASE = encodeTier1Addition({
  ...HONEST,
  vouches: HONEST.vouches.map((v) => ({ ...v, rootBlock: ROOT })),
});
const u64At = (bytes: Uint8Array, at: number, value: bigint) =>
  new DataView(bytes.buffer, bytes.byteOffset).setBigUint64(at, value);

/** The honest record with its vouches' root blocks (on the grid unless given), as hex. */
function record(rootBlocks: readonly bigint[] = [ROOT, ROOT, ROOT], groupId = GROUP): string {
  const bytes = new Uint8Array(BASE);
  // `u64(group_id)` first, then each vouch's `u64(root_block)` after its
  // `u64(tier2_group_id)` (docs/spec/vouching.md, Tier 1 addition record).
  u64At(bytes, 0, groupId);
  for (const [i, block] of rootBlocks.entries()) u64At(bytes, 41 + VOUCH_LENGTH * i + 8, block);
  return toHex(bytes);
}

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
  prefix = `test-tier1-${process.pid}-${Date.now()}-${run++}`;
});
afterEach(async () => {
  const left = await allKeys();
  if (left.length > 0) await redis.del(...left);
});

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

function service(options: { verdict?: TurnstileVerdict; turnstile?: Turnstile } = {}) {
  const stub = stubTurnstile(options.verdict);
  const relay = new Tier1Relay({
    redis,
    groups: new Map([[0, GROUP]]),
    turnstile: options.turnstile ?? stub.turnstile,
    now: () => NOW,
    prefix,
  });
  return { relay, calls: stub.calls };
}

const keys = () => tier1Keys(prefix);
const index = (at = NOW, latest = LATEST, safe = SAFE) =>
  redis.set(keys().index, tier1IndexValue({ at, latest, safe }));
const request = (hex: string, turnstile = "token") => ({ record: hex, turnstile });

async function refusal(promise: Promise<unknown>) {
  const e = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(e).toBeInstanceOf(Tier1RelayError);
  const err = e as Tier1RelayError;
  if (err.malformed === undefined) return err.code;
  return err.vouch === undefined
    ? `${err.code}:${err.malformed}`
    : `${err.code}:${err.malformed}:${err.vouch}`;
}

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

/** `n` distinct records for the honest commitment, each a different grid root for vouch 0. */
const distinct = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) =>
    record([ROOT - BigInt(from + i + 1) * VOUCH_ROOT_INTERVAL, ROOT, ROOT]),
  );

describe("values", () => {
  test("match docs/spec/tier1-relay.md, Values, and the record's length", () => {
    const spec = readFileSync(
      new URL("../../../docs/spec/tier1-relay.md", import.meta.url),
      "utf8",
    );
    const value = (name: string) =>
      new RegExp(`^\\| \`${name}\`\\s*\\| ([^|]+?)\\s*\\|`, "m").exec(spec)?.[1];
    expect(value("TIER1_RELAY_QUEUE_MAX")).toBe(TIER1_RELAY_QUEUE_MAX.toLocaleString("en-US"));
    expect(value("TIER1_RELAY_MARGIN")).toBe(TIER1_RELAY_MARGIN.toLocaleString("en-US"));
    expect(value("TURNSTILE_ACTION_TIER1")).toBe(`\`${TURNSTILE_ACTION_TIER1}\``);
    expect(TIER1_INDEX_MAX_LAG).toBe(60);
    // Answers, step 2: exactly 3,838 hex digits.
    expect(TIER1_RECORD_HEX).toBe(3838);
    expect(honest.record).toHaveLength(TIER1_RECORD_HEX);
  });
});

describe("keys and the index", () => {
  test("every key shares one hash tag, and a prefix can't change it", () => {
    for (const key of Object.values(tier1Keys("abolish:x")))
      expect(/\{([^}]*)\}/.exec(key)?.[1]).toBe("tier1-relay");
    for (const bad of ["", "{a}", "a{", "}"]) expect(() => tier1Keys(bad)).toThrow(RangeError);
  });

  test("a record's key is the SHA-256 of its bytes", () => {
    // SHA-256 of the empty string, FIPS 180-2.
    expect(recordKey(new Uint8Array())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("an index value reads back as written", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10 ** 15 - 1 }),
        fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }),
        fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }),
        (at, a, b) => {
          const [safe, latest] = a <= b ? [a, b] : [b, a];
          expect(parseTier1Index(tier1IndexValue({ at, latest, safe }))).toEqual({
            at,
            latest,
            safe,
          });
        },
      ),
      { numRuns },
    );
  });

  test("only values the writer writes are read", () => {
    for (const bad of [
      undefined,
      "",
      "1 2",
      "1 2 3 4",
      "1  2 1",
      "01 2 1",
      "1 02 1",
      "1 2 01",
      "-1 2 1",
      "1 2 3",
      "1.5 2 1",
      `1 ${1n << 64n} 1`,
      `${"9".repeat(16)} 2 1`,
      " 1 2 1",
      "1 2 1\n",
    ])
      expect(parseTier1Index(bad)).toBeUndefined();
    expect(() => tier1IndexValue({ at: NOW, latest: 1n, safe: 2n })).toThrow(RangeError);
    expect(() => tier1IndexValue({ at: -1, latest: 1n, safe: 1n })).toThrow(RangeError);
    expect(() => tier1IndexValue({ at: 10 ** 15, latest: 1n, safe: 1n })).toThrow(RangeError);
    expect(() => tier1IndexValue({ at: NOW, latest: 1n << 64n, safe: 1n })).toThrow(RangeError);
  });
});

describe("parseTier1Request", () => {
  test("a patched record is the record encoded with those fields", () => {
    const blocks = [ROOT, ROOT - VOUCH_ROOT_INTERVAL, ROOT + 1n];
    expect(record(blocks, GROUP + 5n)).toBe(
      toHex(
        encodeTier1Addition({
          ...HONEST,
          groupId: GROUP + 5n,
          vouches: HONEST.vouches.map((v, i) => ({ ...v, rootBlock: blocks[i] ?? ROOT })),
        }),
      ),
    );
  });

  test("accepts a record on the root grid", () => {
    const hex = record();
    const parsed = parseTier1Request(request(hex, "tok"));
    expect(parsed.hex).toBe(hex);
    expect(toHex(parsed.record)).toBe(hex);
    expect(parsed.addition.commitment).toBe(HONEST.commitment);
    expect(parsed.turnstile).toBe("tok");
  });

  test.each(vectors.additions)("vector $id: checks 1 to 6, then the root grid", (a) => {
    const outcome = (() => {
      try {
        parseTier1Request(request(a.record));
        return "ok";
      } catch (e) {
        expect(e).toBeInstanceOf(Tier1RelayError);
        const err = e as Tier1RelayError;
        return `${err.malformed ?? ""}${err.vouch === undefined ? "" : `:${err.vouch}`}`;
      }
    })();
    // Every vector names root block 1,234,567, off the grid: whatever passes
    // checks 1 to 6 (a proof failure among them, unchecked here) fails the
    // grid at its first vouch.
    if (a.valid || a.error === "proof") expect(outcome).toBe("root-grid:0");
    else expect(outcome).toBe(`${a.error}${a.vouch === undefined ? "" : `:${a.vouch}`}`);
  });

  test.each(vectors.decode)("decode vector $name: form or decode", (d) => {
    const want = d.record.length === TIER1_RECORD_HEX ? "malformed" : "form";
    expect(() => parseTier1Request(request(d.record))).toThrow(
      expect.objectContaining({ code: want }),
    );
    if (want === "malformed")
      expect(() => parseTier1Request(request(d.record))).toThrow(
        expect.objectContaining({ malformed: "decode" }),
      );
  });

  test("the root grid names the first vouch off it", () => {
    for (const i of [0, 1, 2]) {
      const blocks = [ROOT, ROOT, ROOT];
      blocks[i] = ROOT + 1n;
      expect(() => parseTier1Request(request(record(blocks)))).toThrow(
        expect.objectContaining({ malformed: "root-grid", vouch: i }),
      );
    }
    expect(() => parseTier1Request(request(record([0n, 0n, 0n])))).not.toThrow();
  });

  test("refuses records that aren't 3,838 lowercase hex digits, and tokens out of form", () => {
    const hex = record();
    for (const r of ["", hex.slice(2), `${hex}00`, hex.toUpperCase(), `0x${hex.slice(2)}`])
      expect(() => parseTier1Request(request(r))).toThrow(
        expect.objectContaining({ code: "form" }),
      );
    for (const t of ["", " ", "a b", "é", "\x7f", "a".repeat(2049)])
      expect(() => parseTier1Request(request(hex, t))).toThrow(
        expect.objectContaining({ code: "form" }),
      );
    expect(parseTier1Request(request(hex, "a".repeat(2048))).turnstile).toHaveLength(2048);
  });

  test("arbitrary bytes of a record's length are refused or accepted, never thrown past", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1919, maxLength: 1919 }), (bytes) => {
        try {
          parseTier1Request(request(toHex(bytes)));
        } catch (e) {
          expect(e).toBeInstanceOf(Tier1RelayError);
        }
      }),
      { numRuns },
    );
  });
});

// Each request decodes its record's six proofs at step 3, so the tests that
// send dozens get a longer timeout than the default, which a loaded CI
// runner outlasts.
describe("Tier1Relay", () => {
  test("serves region 0 only, with one published group", () => {
    const { turnstile } = stubTurnstile();
    const make = (groups: Map<number, bigint>) => () =>
      new Tier1Relay({ redis, groups, turnstile, now: () => NOW, prefix });
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

  test("queues a record under its hash, solved for tier1-relay", async () => {
    await index();
    const { relay, calls } = service();
    const hex = record();
    await relay.relay(request(hex, "tok.en-1_"));
    expect(calls).toEqual([{ token: "tok.en-1_", action: "tier1-relay" }]);
    expect(await redis.hgetall(keys().queue)).toEqual({ [recordKey(fromHex(hex))]: hex });
  });

  test("answers each step's failure in the spec's order, spending no token before step 7", async () => {
    const hex = record();
    {
      const { relay, calls } = service();
      // Steps 2 to 4 need nothing from Redis.
      expect(await refusal(relay.relay(request("zz")))).toBe("form");
      expect(await refusal(relay.relay(request(record([ROOT + 1n, ROOT, ROOT]))))).toBe(
        "malformed:root-grid:0",
      );
      expect(await refusal(relay.relay(request(record(undefined, GROUP + 1n))))).toBe(
        "group-unknown",
      );
      // Step 5: the index was never brought up.
      expect(await refusal(relay.relay(request(hex)))).toBe("unavailable");
      // Step 5 before step 6, whose window this record fails.
      expect(await refusal(relay.relay(request(record([ROOT + VOUCH_ROOT_INTERVAL]))))).toBe(
        "unavailable",
      );
      expect(calls).toEqual([]);
    }
    // Step 5: an index more than a minute behind.
    await index(NOW - TIER1_INDEX_MAX_LAG - 1);
    {
      const { relay, calls } = service();
      expect(await refusal(relay.relay(request(hex)))).toBe("unavailable");
      expect(calls).toEqual([]);
    }
    // Step 6, before the token.
    await index(NOW - TIER1_INDEX_MAX_LAG);
    {
      const { relay, calls } = service();
      expect(
        await refusal(relay.relay(request(record([ROOT, ROOT, ROOT + VOUCH_ROOT_INTERVAL])))),
      ).toBe("vouch-window");
      expect(calls).toEqual([]);
    }
    // Step 7.
    for (const [verdict, code] of [
      ["refused", "challenge-refused"],
      ["unavailable", "challenge-unavailable"],
    ] as const) {
      const { relay, calls } = service({ verdict });
      expect(await refusal(relay.relay(request(hex)))).toBe(code);
      expect(calls).toHaveLength(1);
    }
    expect(await redis.exists(keys().queue)).toBe(0);
    // An index exactly a minute old is current.
    await service().relay.relay(request(hex));
    expect(await redis.hlen(keys().queue)).toBe(1);
  });

  test(
    "a full queue is read only after the solve: busy, with the token spent",
    { timeout: 60_000 },
    async () => {
      await index();
      await redis.hset(
        keys().queue,
        Object.fromEntries(distinct(TIER1_RELAY_QUEUE_MAX).map((h) => [recordKey(fromHex(h)), h])),
      );
      for (const hex of [record(), distinct(1)[0] as string]) {
        const { relay, calls } = service();
        // Already queued or not, a full queue answers busy, and only once
        // Turnstile has passed the token.
        expect(await refusal(relay.relay(request(hex)))).toBe("busy");
        expect(calls).toHaveLength(1);
      }
      // Refused at any step before 8, a full queue says nothing.
      {
        const { relay, calls } = service({ verdict: "refused" });
        expect(await refusal(relay.relay(request(record())))).toBe("challenge-refused");
        expect(calls).toHaveLength(1);
      }
      expect(await redis.hlen(keys().queue)).toBe(TIER1_RELAY_QUEUE_MAX);
    },
  );

  test("step 6: each vouch's root at or below the safe head, with the margin left in its window", async () => {
    // Exactly at the safe head, and with exactly the margin left, is queued.
    const edge = SAFE - (SAFE % VOUCH_ROOT_INTERVAL);
    await index(NOW, edge + VOUCH_ROOT_WINDOW - TIER1_RELAY_MARGIN, edge);
    await service().relay.relay(request(record([edge, edge, edge])));
    expect(await redis.hlen(keys().queue)).toBe(1);
    // One block less of window, at any vouch.
    await index(NOW, edge + VOUCH_ROOT_WINDOW - TIER1_RELAY_MARGIN + 1n, edge);
    expect(await refusal(service().relay.relay(request(record([edge, edge, edge]))))).toBe(
      "vouch-window",
    );
    // A root one grid block past the safe head, at any vouch.
    await index(NOW, edge + VOUCH_ROOT_INTERVAL, edge + VOUCH_ROOT_INTERVAL - 1n);
    for (const i of [0, 1, 2]) {
      const blocks = [edge, edge, edge];
      blocks[i] = edge + VOUCH_ROOT_INTERVAL;
      expect(await refusal(service().relay.relay(request(record(blocks))))).toBe("vouch-window");
    }
    await index(NOW, edge + VOUCH_ROOT_INTERVAL, edge + VOUCH_ROOT_INTERVAL);
    await service().relay.relay(request(record([edge, edge, edge + VOUCH_ROOT_INTERVAL])));
    expect(await redis.hlen(keys().queue)).toBe(2);
  });

  test("refuses a malformed index rather than reading it as current", async () => {
    for (const value of ["", "abc", `${NOW}`, `${NOW} 2 3`, `${NOW}.5 2 1`]) {
      await redis.set(keys().index, value);
      expect(await refusal(service().relay.relay(request(record())))).toBe("unavailable");
    }
  });

  test("refuses an index time ahead of our clock by more than the skew", async () => {
    await index(NOW + TIER1_INDEX_MAX_SKEW + 1);
    expect(await refusal(service().relay.relay(request(record())))).toBe("unavailable");
    await index(NOW + TIER1_INDEX_MAX_SKEW);
    await service().relay.relay(request(record()));
    expect(await redis.hlen(keys().queue)).toBe(1);
  });

  test("a Redis failure answers unavailable, without quoting the request", async () => {
    const hex = record();
    const failing = { eval: () => Promise.reject(new Error(`ERR something about ${hex}`)) };
    const relay = new Tier1Relay({
      redis: failing,
      groups: new Map([[0, GROUP]]),
      turnstile: stubTurnstile().turnstile,
      now: () => NOW,
      prefix,
    });
    const e = await relay.relay(request(hex)).catch((e: unknown) => e);
    expect(e).toMatchObject({ code: "unavailable" });
    expect(String(e)).not.toContain(hex.slice(0, 64));
  });

  test(
    "past TIER1_MAX_CONCURRENT requests at once, answers unavailable before Redis",
    { timeout: 60_000 },
    async () => {
      await index();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const calls: string[] = [];
      const turnstile: Turnstile = {
        async verify(token) {
          calls.push(token ?? "");
          await gate;
          return "passed";
        },
      };
      const { relay } = service({ turnstile });
      const records = distinct(TIER1_MAX_CONCURRENT + 1);
      const held = records.slice(0, -1).map((h) => relay.relay(request(h)));
      while (calls.length < TIER1_MAX_CONCURRENT) await new Promise((r) => setTimeout(r, 5));
      const last = records.at(-1) as string;
      expect(await refusal(relay.relay(request(last)))).toBe("unavailable");
      expect(calls).toHaveLength(TIER1_MAX_CONCURRENT);
      release();
      await Promise.all(held);
      // Slots are given back, whatever the outcome.
      await relay.relay(request(last));
      expect(await redis.hlen(keys().queue)).toBe(TIER1_MAX_CONCURRENT + 1);
    },
  );

  test("answers alike whether a record is new or already queued, and keys by record, not commitment", async () => {
    await index();
    const [a, b] = distinct(2) as [string, string];
    const { relay } = service();
    await relay.relay(request(a));
    await expect(relay.relay(request(a))).resolves.toBeUndefined();
    expect(await redis.hlen(keys().queue)).toBe(1);
    // Another record for the same commitment is queued beside it (T-25).
    await expect(relay.relay(request(b))).resolves.toBeUndefined();
    expect(await redis.hgetall(keys().queue)).toEqual({
      [recordKey(fromHex(a))]: a,
      [recordKey(fromHex(b))]: b,
    });
  });

  test(
    "never queues past the bound, however many requests pass step 7 together",
    { timeout: 60_000 },
    async () => {
      await index();
      const room = 5;
      await redis.hset(
        keys().queue,
        Object.fromEntries(
          distinct(TIER1_RELAY_QUEUE_MAX - room).map((h) => [recordKey(fromHex(h)), h]),
        ),
      );
      // One service per request, as many servers would be: each server's own
      // concurrency cap mustn't be what keeps the queue in bounds.
      const outcomes = await Promise.allSettled(
        distinct(40, TIER1_RELAY_QUEUE_MAX).map((h) => service().relay.relay(request(h))),
      );
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(room);
      for (const o of outcomes)
        if (o.status === "rejected") expect(o.reason).toMatchObject({ code: "busy" });
      expect(await redis.hlen(keys().queue)).toBe(TIER1_RELAY_QUEUE_MAX);
    },
  );

  test("Redis keeps the records under their hashes and nothing else of a request", async () => {
    await index();
    const { relay } = service();
    const records = distinct(3);
    for (const [i, h] of records.entries()) await relay.relay(request(h, `secret-token-${i}`));
    const k = keys();
    // No key per record or per request: only the fixed keys.
    expect(await allKeys()).toEqual([k.index, k.queue].sort());
    expect(await redis.ttl(k.queue)).toBe(-1);
    expect(await redis.hgetall(k.queue)).toEqual(
      Object.fromEntries(records.map((h) => [recordKey(fromHex(h)), h])),
    );
    // The token reaches no key or value.
    const dump = JSON.stringify([await allKeys(), await redis.hgetall(k.queue)]);
    expect(dump).not.toContain("secret-token");
  });

  test("errors never quote the request", async () => {
    const hex = record([ROOT, ROOT + 1n, ROOT]);
    const e = await service()
      .relay.relay(request(hex))
      .catch((e: unknown) => e);
    expect((e as Error).message).toBe("relay refused: malformed (root-grid at vouch 1)");
    expect(String(e)).not.toContain(hex.slice(0, 64));
  });
});
