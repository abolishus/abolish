import {
  BN254_R,
  generateTier0TokenKeyPair,
  POSEIDON2_ZERO_ONE,
  tier0TokenBlind,
  tier0TokenEvaluate,
  tier0TokenFinalize,
  tier0TokenInfo,
  tier0TokenInput,
  tier0TokenKeyId,
  TOKEN_KEY_PERIOD,
} from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import fc from "fast-check";
import { Redis } from "ioredis";
import type { Sql } from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  commitmentKey,
  issueTier0Token,
  markDeadTier0Tokens,
  newAccountId,
  parseTier0IssuerKeys,
  reissueTier0Token,
  type Tier0ShowOutcome,
  TIER0_SHOWN_MARGIN,
  Tier0IssuanceError,
  type Tier0IssuanceErrorCode,
  type Tier0Issuer,
  tier0Issuer,
  type Tier0ListedKeys,
  tier0Keys,
  Tier0Registrations,
  type Tier0ReissueRequest,
  Tier0ReissueUnavailable,
  Tier0ShownList,
  type Turnstile,
} from "../src/index.ts";
import { type TestDb, testDb } from "./db.ts";

// Re-issuance against a dead token ([[tier0-token]], Keys; P2-30 part
// 3d-2b), against Postgres and Redis: only the account that blinded the dead
// token can show it, only once its key no longer redeems (retired early, or
// past `q + 1`, to the second), never twice, never for a `C` a redemption
// queued first, and a `C` it marks is never queued after; the record is
// replaced with the new request, which then retries as an ordinary
// issuance (T-01, T-10, T-74).

const redisUrl = process.env["REDIS_URL"];
if (!redisUrl) throw new Error("REDIS_URL is not set");
const runs = { numRuns: Math.min(Number(process.env["FC_NUM_RUNS"] ?? 100), 25) };

let db: TestDb;
let app: Sql;
let app2: Sql;
let redis: Redis;
let run = 0;
let prefix: string;

beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
  app2 = await db.as("abolish_app");
  redis = new Redis(redisUrl);
});
afterAll(async () => {
  await redis?.quit();
  await db?.close();
});
beforeEach(() => {
  prefix = `test-tier0-reissue-${process.pid}-${Date.now()}-${run++}`;
});
afterEach(async () => {
  const left = await redis.keys(`${prefix}:*`);
  if (left.length > 0) await redis.del(...left);
});

const Q = 682; // the current period, in 2026
// A token taken under period P is dead from the end of P + 1, the start of Q.
const P = Q - 2;
const at = (period: number, offset = 1000) => new Date((period * TOKEN_KEY_PERIOD + offset) * 1000);
const NOW = at(Q);
const seconds = (d: Date) => Math.floor(d.getTime() / 1000);

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const pairs = new Map([P, Q - 1, Q, Q + 1].map((q) => [q, generateTier0TokenKeyPair()]));
const keyIdOf = (q: number) => tier0TokenKeyId(q, pairs.get(q)!.publicKey);
const keysOf = (...periods: number[]) =>
  parseTier0IssuerKeys(periods.map((q) => `${q}:${hex(pairs.get(q)!.secretKey)}`).join(","));

const CHAIN_ID = 421_614n;
const REGISTRY = Uint8Array.from(randomBytes(20));
const GROUP_ID = 7n;
const issuerOf = (keys: ReturnType<typeof keysOf>, now: Date): Tier0Issuer =>
  tier0Issuer({
    keys,
    chainId: CHAIN_ID,
    groupRegistry: REGISTRY,
    groups: new Map([[0, GROUP_ID]]),
    now,
    phoneVerification: true,
  });
// The issuer that took the dead tokens, and today's, which holds no key
// that has stopped redeeming, as its start-up check requires.
const OLD = issuerOf(keysOf(P, Q - 1), at(P));
const NEW = issuerOf(keysOf(Q, Q + 1), NOW);
const INFO = tier0TokenInfo({ chainId: CHAIN_ID, groupRegistry: REGISTRY, groupId: GROUP_ID });

/** The deployment record's keys, by `key_id`: today's release lists Q - 1 to Q + 1. */
const listedOf = (retired: readonly number[] = []): Tier0ListedKeys =>
  new Map(
    [Q - 1, Q, Q + 1].map((q) => [hex(keyIdOf(q)), { period: q, retired: retired.includes(q) }]),
  );
const LISTED = listedOf();

async function newAccount({ phone = true } = {}): Promise<string> {
  const id = newAccountId();
  await app`
    INSERT INTO account_users VALUES (${id}, ${`${newAccountId()}@account.invalid`},
      false, '', NULL, now(), now())`;
  await app`
    INSERT INTO account_emails VALUES (${id}, ${randomBytes(32)}, 'h1', ${randomBytes(40)}, 'b1', now())`;
  if (phone)
    await app`
      INSERT INTO account_phones VALUES (${id}, ${randomBytes(32)}, 'p1',
        date_trunc('day', now(), 'UTC'))`;
  return id;
}

/** A commitment below `r` that isn't forbidden. */
const commitment = () => {
  const c = Uint8Array.from(randomBytes(32));
  c[0] = c[0]! & 0x0f;
  return c;
};
const valueOf = (c: Uint8Array) => BigInt(`0x${hex(c)}`);

/** The client's side of Issuance, step 1, under period `q`'s published key. */
function blind(q: number, c = commitment()) {
  const keyId = keyIdOf(q);
  const input = tier0TokenInput(keyId, c);
  const b = tier0TokenBlind(input, pairs.get(q)!.publicKey, INFO);
  return {
    q,
    keyId,
    c,
    input,
    ...b,
    request: { keyId, region: 0, blindedElement: b.blindedElement },
  };
}
type Blinded = ReturnType<typeof blind>;

/** An account holding a token taken under period `q`. */
async function holder(q = P) {
  const account = await newAccount();
  const token = blind(q);
  await issueTier0Token(app, account, token.request, { issuer: OLD, now: at(q) });
  return { account, token };
}

const showing = (dead: Blinded, next: Blinded): Tier0ReissueRequest => ({
  dead: { keyId: dead.keyId, commitment: dead.c, blind: dead.blind },
  next: next.request,
});

/** The shown list on this test's Redis, with an index refreshed at `now`. */
async function shownAt(now = NOW) {
  await redis.set(tier0Keys(prefix).indexed, String(seconds(now)));
  return new Tier0ShownList({ redis, now: () => seconds(now), prefix });
}

const reissue = async (
  account: string,
  request: Tier0ReissueRequest,
  {
    now = NOW,
    client = app,
    issuer = NEW,
    listed = LISTED,
    shown,
  }: {
    now?: Date;
    client?: Sql;
    issuer?: Tier0Issuer;
    listed?: Tier0ListedKeys;
    shown?: Pick<Tier0ShownList, "show">;
  } = {},
) =>
  reissueTier0Token(client, account, request, {
    issuer,
    listed,
    shown: shown ?? (await shownAt(now)),
    now,
  });

async function refusal(p: Promise<unknown>): Promise<Tier0IssuanceErrorCode> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Tier0IssuanceError) return e.code;
    throw e;
  }
  throw new Error("expected a Tier0IssuanceError");
}

const record = async (account: string) =>
  (await db.admin`SELECT * FROM account_tokens WHERE user_id = ${account}`)[0];
const issued = async (q: number) =>
  (
    await db.admin`
      SELECT issued FROM tier0_token_issuances WHERE key_id = ${keyIdOf(q)} AND info = ${INFO}`
  )[0]?.["issued"];
const marks = async () => {
  const flat = await redis.zrange(tier0Keys(prefix).shown, 0, -1, "WITHSCORES");
  const out: Record<string, number> = {};
  for (let i = 0; i < flat.length; i += 2) out[flat[i] as string] = Number(flat[i + 1]);
  return out;
};
/** The second a key of period `q`'s tokens stop redeeming: the end of `q + 1`. */
const lapseOf = (q: number) => TOKEN_KEY_PERIOD * (q + 2);

const passing: Turnstile = { verify: () => Promise.resolve("passed") };
const route = (now = NOW) =>
  new Tier0Registrations({
    redis,
    groups: new Map([[0, GROUP_ID]]),
    turnstile: passing,
    now: () => seconds(now),
    prefix,
  });
const register = (c: Uint8Array, now = NOW) =>
  route(now).register({ commitment: commitmentKey(valueOf(c)), region: "0", turnstile: "token" });

describe("reissueTier0Token", () => {
  test("re-issues against a token past q + 1, marked dead or not, and the new token finalises", async () => {
    for (const dead of [false, true]) {
      const { account, token } = await holder();
      if (dead) {
        await markDeadTier0Tokens(app, NOW);
        expect((await record(account))!["key_id"]).toBeNull();
      }
      const next = blind(Q);
      const answer = await reissue(account, showing(token, next));
      const finalised = tier0TokenFinalize({
        input: next.input,
        info: INFO,
        publicKey: pairs.get(Q)!.publicKey,
        blind: next.blind,
        blindedElement: next.blindedElement,
        ...answer,
      });
      expect(hex(finalised)).toBe(
        hex(tier0TokenEvaluate(pairs.get(Q)!.secretKey, next.input, INFO)),
      );
      const held = (await record(account))!;
      expect(hex(held["key_id"])).toBe(hex(keyIdOf(Q)));
      expect(Number(held["key_period"])).toBe(Q);
      expect(hex(held["blinded_element"])).toBe(hex(next.blindedElement));
      expect(Number(held["region"])).toBe(0);
      // Marked until the dead key's own lapse: P is unlisted today, and a
      // dead record's period is at most Q - 2, which is P.
      expect(await marks()).toMatchObject({ [commitmentKey(valueOf(token.c))]: lapseOf(P) });
      // A lost answer is retried as an ordinary issuance of B'.
      await expect(
        issueTier0Token(app, account, next.request, { issuer: NEW, now: NOW }),
      ).resolves.toBeDefined();
    }
    expect(Number(await issued(Q))).toBe(2);
  });

  test("a dead record's key, if today's release still lists it, marks to its own lapse", async () => {
    const { account, token } = await holder();
    await markDeadTier0Tokens(app, NOW);
    const listed: Tier0ListedKeys = new Map([
      ...LISTED,
      [hex(keyIdOf(P)), { period: P, retired: false }],
    ]);
    await reissue(account, showing(token, blind(Q)), { listed });
    expect(await marks()).toEqual({ [commitmentKey(valueOf(token.c))]: lapseOf(P) });
  });

  test("a key past q + 1 is dead at the end of q + 1 to the second, and not before", async () => {
    const { account, token } = await holder();
    // The last second of Q - 1, P + 1: P's key still redeems, and Q - 1 issues.
    const before = at(Q, -1);
    expect(
      await refusal(reissue(account, showing(token, blind(Q - 1)), { now: before, issuer: OLD })),
    ).toBe("reissue-refused");
    expect(await marks()).toEqual({});
    expect(hex((await record(account))!["key_id"])).toBe(hex(keyIdOf(P)));
    // The first second of Q.
    await reissue(account, showing(token, blind(Q)), { now: at(Q, 0) });
    expect(hex((await record(account))!["key_id"])).toBe(hex(keyIdOf(Q)));
  });

  test("a key retired early re-issues at once, marked to the end of its q + 1", async () => {
    const { account, token } = await holder(Q - 1);
    // Q - 1's key still redeems in Q, unless the release retired it.
    expect(await refusal(reissue(account, showing(token, blind(Q))))).toBe("reissue-refused");
    expect(await marks()).toEqual({});
    await reissue(account, showing(token, blind(Q)), { listed: listedOf([Q - 1]) });
    expect(await marks()).toEqual({ [commitmentKey(valueOf(token.c))]: lapseOf(Q - 1) });
    expect(hex((await record(account))!["key_id"])).toBe(hex(keyIdOf(Q)));
  });

  test("refuses another account's dead token, bought or borrowed", async () => {
    const seller = await holder();
    const buyer = await holder();
    const before = (await record(buyer.account))!;
    expect(await refusal(reissue(buyer.account, showing(seller.token, blind(Q))))).toBe(
      "reissue-refused",
    );
    expect(await marks()).toEqual({});
    expect(await record(buyer.account)).toEqual(before);
  });

  test("one dead token is shown once: again, or twice at once, the record is already replaced", async () => {
    const { account, token } = await holder();
    await reissue(account, showing(token, blind(Q)));
    expect(await refusal(reissue(account, showing(token, blind(Q))))).toBe("reissue-refused");

    const racer = await holder();
    const shown = await shownAt();
    const count = Number(await issued(Q));
    const results = await Promise.allSettled([
      reissue(racer.account, showing(racer.token, blind(Q)), { shown }),
      reissue(racer.account, showing(racer.token, blind(Q)), { shown, client: app2 }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const [failed] = results.filter((r) => r.status === "rejected");
    expect((failed as PromiseRejectedResult).reason).toBeInstanceOf(Tier0IssuanceError);
    expect(((failed as PromiseRejectedResult).reason as Tier0IssuanceError).code).toBe(
      "reissue-refused",
    );
    // Counted once, for the one that replaced the record (T-74).
    expect(Number(await issued(Q))).toBe(count + 1);
  });

  test("a retirement crossing a redemption in flight: whichever reaches the queue first wins", async () => {
    // The redemption queued C first: the re-issuance is refused, and the record stands.
    const first = await holder(Q - 1);
    await shownAt();
    await register(first.token.c);
    const before = (await record(first.account))!;
    expect(
      await refusal(
        reissue(first.account, showing(first.token, blind(Q)), { listed: listedOf([Q - 1]) }),
      ),
    ).toBe("reissue-refused");
    expect(await record(first.account)).toEqual(before);

    // The re-issuance marked C first: the redemption is answered as accepted and never queued.
    const second = await holder(Q - 1);
    await reissue(second.account, showing(second.token, blind(Q)), { listed: listedOf([Q - 1]) });
    await expect(register(second.token.c)).resolves.toBe(undefined);
    expect(
      await redis.hexists(tier0Keys(prefix).queue, commitmentKey(valueOf(second.token.c))),
    ).toBe(0);
    // Still dropped at the margin's edge on this clock.
    const late = new Date((lapseOf(Q - 1) + TIER0_SHOWN_MARGIN - 1) * 1000);
    await redis.set(tier0Keys(prefix).indexed, String(seconds(late)));
    await expect(register(second.token.c, late)).resolves.toBe(undefined);
    expect(
      await redis.hexists(tier0Keys(prefix).queue, commitmentKey(valueOf(second.token.c))),
    ).toBe(0);
  });

  test("a commitment ever added to a Tier 0 group, or in flight, is refused", async () => {
    for (const set of ["live", "inflight"] as const) {
      const { account, token } = await holder();
      const shown = await shownAt();
      await redis.sadd(tier0Keys(prefix)[set], commitmentKey(valueOf(token.c)));
      expect(await refusal(reissue(account, showing(token, blind(Q)), { shown }))).toBe(
        "reissue-refused",
      );
      expect(hex((await record(account))!["key_id"])).toBe(hex(keyIdOf(P)));
    }
  });

  test("a lagging index or a failed Redis marks and replaces nothing, and can be repeated", async () => {
    const { account, token } = await holder();
    const before = (await record(account))!;
    const lagging = new Tier0ShownList({ redis, now: () => seconds(NOW), prefix });
    await expect(
      reissue(account, showing(token, blind(Q)), { shown: lagging }),
    ).rejects.toBeInstanceOf(Tier0ReissueUnavailable);
    const failing = { show: (): Promise<Tier0ShowOutcome> => Promise.resolve("unavailable") };
    await expect(
      reissue(account, showing(token, blind(Q)), { shown: failing }),
    ).rejects.toBeInstanceOf(Tier0ReissueUnavailable);
    expect(await marks()).toEqual({});
    expect(await record(account)).toEqual(before);
    await reissue(account, showing(token, blind(Q)));
  });

  test("a record write that fails after the mark leaves C marked, and the same C repeats", async () => {
    const { account, token } = await holder();
    const shown = await shownAt();
    // A shown list whose answer arrives after the account was deleted and
    // re-created can't replace a record that isn't there: modelled by a
    // mark that succeeds and a transaction that then fails.
    const failing = {
      show: async (c: bigint, period: number) => {
        const outcome = await shown.show(c, period);
        throw Object.assign(new Error("connection lost"), { outcome });
      },
    };
    await expect(reissue(account, showing(token, blind(Q)), { shown: failing })).rejects.toThrow(
      "connection lost",
    );
    expect(Object.keys(await marks())).toEqual([commitmentKey(valueOf(token.c))]);
    expect(hex((await record(account))!["key_id"])).toBe(hex(keyIdOf(P)));
    await reissue(account, showing(token, blind(Q)), { shown });
    expect(hex((await record(account))!["key_id"])).toBe(hex(keyIdOf(Q)));
  });

  test("checks the new request as issuance does, before the dead token", async () => {
    const { account, token } = await holder();
    const shown = { show: () => Promise.reject(new Error("never reached")) };
    const unverified = await newAccount({ phone: false });
    expect(await refusal(reissue(unverified, showing(token, blind(Q)), { shown }))).toBe("account");
    // Q + 1 doesn't issue yet, and Q - 1 issues no more, though it redeems.
    for (const q of [Q + 1, Q - 1])
      expect(
        await refusal(
          reissue(account, showing(token, blind(q)), {
            shown,
            issuer: issuerOf(keysOf(Q - 1, Q, Q + 1), NOW),
          }),
        ),
      ).toBe("key-not-issuing");
    const elsewhere = { ...blind(Q), request: { ...blind(Q).request, region: 1 } };
    expect(await refusal(reissue(account, showing(token, elsewhere), { shown }))).toBe(
      "region-unknown",
    );
    const badB = {
      ...blind(Q),
      request: { ...blind(Q).request, blindedElement: new Uint8Array(32) },
    };
    expect(await refusal(reissue(account, showing(token, badB), { shown }))).toBe(
      "blinded-element",
    );
  });

  test("refuses an account with no record, or whose record's key still redeems", async () => {
    const none = await newAccount();
    const { token } = await holder();
    expect(await refusal(reissue(none, showing(token, blind(Q))))).toBe("reissue-refused");
    const live = await newAccount();
    const current = blind(Q);
    await issueTier0Token(app, live, current.request, { issuer: NEW, now: NOW });
    expect(await refusal(reissue(live, showing(current, blind(Q))))).toBe("reissue-refused");
    expect(await marks()).toEqual({});
  });

  test("refuses a dead token shown with any other key_id, C or blind, or a bad encoding", async () => {
    const { account, token } = await holder();
    await markDeadTier0Tokens(app, NOW);
    const r = BN254_R;
    const be = (v: bigint) => Buffer.from(v.toString(16).padStart(64, "0"), "hex");
    const cases: Tier0ReissueRequest["dead"][] = [
      { keyId: keyIdOf(Q - 1), commitment: token.c, blind: token.blind },
      { keyId: token.keyId, commitment: commitment(), blind: token.blind },
      { keyId: token.keyId, commitment: token.c, blind: blind(P).blind },
      { keyId: token.keyId, commitment: token.c, blind: new Uint8Array(32) },
      { keyId: token.keyId, commitment: be(r), blind: token.blind },
      { keyId: token.keyId, commitment: be(POSEIDON2_ZERO_ONE), blind: token.blind },
      { keyId: token.keyId, commitment: token.c, blind: token.blind.subarray(1) },
      { keyId: token.keyId.subarray(1), commitment: token.c, blind: token.blind },
    ];
    for (const dead of cases)
      expect(await refusal(reissue(account, { dead, next: blind(Q).request }))).toBe(
        "reissue-refused",
      );
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 95 }),
        fc.integer({ min: 1, max: 255 }),
        async (i, x) => {
          const parts = [token.keyId, token.c, token.blind].map((b) => Uint8Array.from(b));
          parts[Math.floor(i / 32)]![i % 32]! ^= x;
          const [keyId, c, b] = parts as [Uint8Array, Uint8Array, Uint8Array];
          expect(
            await refusal(
              reissue(account, {
                dead: { keyId, commitment: c, blind: b },
                next: blind(Q).request,
              }),
            ),
          ).toBe("reissue-refused");
        },
      ),
      runs,
    );
    expect(await marks()).toEqual({});
    expect((await record(account))!["key_id"]).toBeNull();
  }, 60_000);
});
