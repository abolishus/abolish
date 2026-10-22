import {
  generateTier0TokenKeyPair,
  GROUP_ORDER,
  Tier0TokenError,
  tier0TokenBlind,
  tier0TokenEvaluate,
  tier0TokenFinalize,
  tier0TokenInfo,
  tier0TokenInput,
  tier0TokenKeyId,
  TOKEN_KEY_PERIOD,
} from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { getTableConfig } from "drizzle-orm/pg-core";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { accountTokens, tier0TokenIssuances } from "../src/db/schema/index.ts";
import {
  issueTier0Token,
  markDeadTier0Tokens,
  newAccountId,
  parseTier0IssuerKeys,
  Tier0IssuanceError,
  type Tier0IssuanceErrorCode,
  type Tier0Issuer,
  tier0Issuer,
  type Tier0IssuerKeys,
} from "../src/index.ts";
import { type TestDb, testDb } from "./db.ts";

// The Tier 0 token issuer ([[tier0-token]], Keys and Issuance; P2-30 part
// 3a): one token per account and deployment, only to a verified account,
// under the key that issues now; retries of a lost answer and nothing else;
// a refused evaluation leaves no record; the dead mark; the counts per key
// and group (T-01, T-10, T-11, T-74).

// Lets one test make an evaluation fail as `skS + m = 0` would, which no
// key can be chosen to hit without the RFC's HashToScalar, calling through
// to the real one otherwise.
const { blindEvaluate } = vi.hoisted(() => ({ blindEvaluate: vi.fn() }));
vi.mock("@abolishus/crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@abolishus/crypto")>();
  blindEvaluate.mockImplementation(actual.tier0TokenBlindEvaluate);
  return { ...actual, tier0TokenBlindEvaluate: blindEvaluate };
});

const runs = { numRuns: Number(process.env["FC_NUM_RUNS"] ?? 100) };

let db: TestDb;
let app: Sql;
let app2: Sql;

beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
  app2 = await db.as("abolish_app");
});
afterAll(() => db?.close());

const Q = 682; // a period in 2026
const at = (period: number, offset = 1000) => new Date((period * TOKEN_KEY_PERIOD + offset) * 1000);
const NOW = at(Q);

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const pairs = new Map([Q - 1, Q, Q + 1].map((q) => [q, generateTier0TokenKeyPair()]));
const KEYS: Tier0IssuerKeys = parseTier0IssuerKeys(
  [...pairs].map(([q, p]) => `${q}:${hex(p.secretKey)}`).join(","),
);
const keyIdOf = (q: number) => tier0TokenKeyId(q, pairs.get(q)!.publicKey);

const CHAIN_ID = 421_614n;
const REGISTRY = Uint8Array.from(randomBytes(20));
const GROUP_ID = 7n;
const ISSUER: Tier0Issuer = tier0Issuer({
  keys: KEYS,
  chainId: CHAIN_ID,
  groupRegistry: REGISTRY,
  groups: new Map([[0, GROUP_ID]]),
  now: NOW,
});
const INFO = tier0TokenInfo({ chainId: CHAIN_ID, groupRegistry: REGISTRY, groupId: GROUP_ID });

async function newAccount({ email = true, phone = true } = {}): Promise<string> {
  const id = newAccountId();
  await app`
    INSERT INTO account_users VALUES (${id}, ${`${newAccountId()}@account.invalid`},
      false, '', NULL, now(), now())`;
  if (email)
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

/** The client's side of Issuance, step 1, under period `q`'s published key. */
function blind(q = Q, c = commitment()) {
  const keyId = keyIdOf(q);
  const input = tier0TokenInput(keyId, c);
  const b = tier0TokenBlind(input, pairs.get(q)!.publicKey, INFO);
  return { q, keyId, input, ...b, request: { keyId, region: 0, blindedElement: b.blindedElement } };
}

const issue = (
  account: string,
  request: Parameters<typeof issueTier0Token>[2],
  { now = NOW, client = app, issuer = ISSUER } = {},
) => issueTier0Token(client, account, request, { issuer, now });

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
const issued = async (q = Q) =>
  (
    await db.admin`
      SELECT issued FROM tier0_token_issuances WHERE key_id = ${keyIdOf(q)} AND info = ${INFO}`
  )[0]?.["issued"];

describe("schema", () => {
  test("the Drizzle tables match the migrated ones", async () => {
    for (const table of [accountTokens, tier0TokenIssuances]) {
      const config = getTableConfig(table);
      const cols = await db.admin`
        SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = ${db.schema} AND table_name = ${config.name} ORDER BY ordinal_position`;
      expect([
        config.name,
        cols.map((c) => [c["column_name"], c["data_type"], c["is_nullable"]]),
      ]).toEqual([
        config.name,
        config.columns.map((c) => [
          c.name,
          c.getSQLType().replace(/\(.*\)$/, ""),
          c.notNull ? "NO" : "YES",
        ]),
      ]);
    }
  });

  test("no record keeps a time (T-11, T-13)", async () => {
    const cols = await db.admin`
      SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = ${db.schema}
        AND table_name IN ('account_tokens', 'tier0_token_issuances')`;
    expect(cols.length).toBeGreaterThan(0);
    expect(
      cols.filter((c) => /time|date|_at$/.test(`${c["column_name"]} ${c["data_type"]}`)),
    ).toEqual([]);
  });

  test("the app role updates a record's key and B, never its account, deployment or region", async () => {
    const cols = await db.admin`
      SELECT column_name FROM information_schema.column_privileges
      WHERE table_schema = ${db.schema} AND table_name = 'account_tokens'
        AND grantee = 'abolish_app' AND privilege_type = 'UPDATE' ORDER BY column_name`;
    expect(cols.map((c) => c["column_name"])).toEqual(["blinded_element", "key_id", "key_period"]);
    const [counts] = await db.admin`
      SELECT string_agg(privilege_type, ',' ORDER BY privilege_type) AS p
      FROM information_schema.role_table_grants
      WHERE table_schema = ${db.schema} AND grantee = 'abolish_app'
        AND table_name = 'tier0_token_issuances'`;
    // Counts only ever grow.
    expect(counts!["p"]).toBe("INSERT,SELECT,UPDATE");
  });

  test("a key and its period are cleared together or not at all", async () => {
    const account = await newAccount();
    const owner = await db.as("abolish_migrator");
    const insert = (keyId: Buffer | null, period: number | null) =>
      owner`INSERT INTO account_tokens VALUES (${account}, 1, ${randomBytes(20)}, 0,
        ${keyId}, ${period}, ${randomBytes(32)})`;
    await expect(insert(randomBytes(32), null)).rejects.toThrow(/check constraint/);
    await expect(insert(null, Q)).rejects.toThrow(/check constraint/);
    await expect(insert(null, null)).resolves.toBeDefined();
  });
});

describe("parseTier0IssuerKeys", () => {
  test("holds each key by its identifier, periods ascending", () => {
    expect(KEYS.keys.map((k) => k.period)).toEqual([Q - 1, Q, Q + 1]);
    for (const [q, p] of pairs) {
      const key = KEYS.byKeyId(keyIdOf(q));
      expect(key?.period).toBe(q);
      expect(hex(key!.publicKey)).toBe(hex(p.publicKey));
    }
    expect(KEYS.byKeyId(new Uint8Array(32))).toBeUndefined();
  });

  test("refuses malformed entries without quoting them", () => {
    const sk = hex(generateTier0TokenKeyPair().secretKey);
    const le = (n: bigint) => Buffer.from(n.toString(16).padStart(64, "0"), "hex").reverse();
    for (const text of [
      "",
      `${Q}`,
      `${Q}:${sk.slice(2)}`,
      `${Q}:${sk.toUpperCase()}`,
      `0${Q}:${sk}`,
      `-1:${sk}`,
      `4294967296:${sk}`,
      `${Q}:${"00".repeat(32)}`,
      `${Q}:${hex(le(GROUP_ORDER))}`,
      `${Q}:${sk},`,
      ` ${Q}:${sk}`,
    ]) {
      let message = "";
      try {
        parseTier0IssuerKeys(text);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, text).toMatch(/^issuer key entry \d+ /);
      expect(message).not.toContain(sk);
    }
  });

  test("refuses a period listed twice", () => {
    const a = hex(generateTier0TokenKeyPair().secretKey);
    const b = hex(generateTier0TokenKeyPair().secretKey);
    expect(() => parseTier0IssuerKeys(`${Q}:${a},${Q}:${b}`)).toThrow(
      "issuer key entry 2 repeats a period",
    );
  });
});

describe("tier0Issuer", () => {
  test("refuses a deployment it can't compute info for", () => {
    const groups = new Map([[0, GROUP_ID]]);
    const base = { keys: KEYS, chainId: CHAIN_ID, groupRegistry: REGISTRY, groups, now: NOW };
    expect(() => tier0Issuer({ ...base, chainId: 1n << 64n })).toThrow(RangeError);
    expect(() => tier0Issuer({ ...base, chainId: -1n })).toThrow(RangeError);
    expect(() => tier0Issuer({ ...base, groupRegistry: new Uint8Array(19) })).toThrow(RangeError);
    expect(() => tier0Issuer({ ...base, groups: new Map([[0, 1n << 64n]]) })).toThrow(RangeError);
    // One token per account for one group (T-16): region 0 only, until regions are recorded.
    expect(() => tier0Issuer({ ...base, groups: new Map([[1, GROUP_ID]]) })).toThrow(RangeError);
    expect(() =>
      tier0Issuer({
        ...base,
        groups: new Map([
          [0, GROUP_ID],
          [1, GROUP_ID + 1n],
        ]),
      }),
    ).toThrow(RangeError);
  });

  test("refuses at load a key whose redemption window has ended (T-74)", () => {
    const base = {
      keys: KEYS,
      chainId: CHAIN_ID,
      groupRegistry: REGISTRY,
      groups: new Map([[0, GROUP_ID]]),
    };
    // Q - 1 still redeems during Q, to its last second, and not a second after.
    expect(() => tier0Issuer({ ...base, now: at(Q, TOKEN_KEY_PERIOD - 1) })).not.toThrow();
    expect(() => tier0Issuer({ ...base, now: at(Q + 1, 0) })).toThrow(
      `the issuer key of period ${Q - 1} no longer redeems`,
    );
    // Keys held ahead are kept.
    expect(() => tier0Issuer({ ...base, now: at(Q - 1) })).not.toThrow();
  });
});

describe("issuance", () => {
  // Each run makes an account in the database and evaluates and finalizes a
  // token in bigint arithmetic: about 2 s in all locally, past the 5 s default
  // on a loaded CI runner.
  test("answers an evaluation the client finalizes into the token redemption expects", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constant(null), async () => {
        const account = await newAccount();
        const c = blind();
        const answer = await issue(account, c.request);
        const token = tier0TokenFinalize({
          input: c.input,
          info: INFO,
          publicKey: pairs.get(Q)!.publicKey,
          blind: c.blind,
          blindedElement: c.blindedElement,
          ...answer,
        });
        expect(hex(token)).toBe(hex(tier0TokenEvaluate(pairs.get(Q)!.secretKey, c.input, INFO)));
      }),
      { numRuns: Math.min(runs.numRuns, 50) },
    );
  }, 60_000);

  test("records the region, key and B with no commitment, token or blind (T-10)", async () => {
    const account = await newAccount();
    const c = blind();
    await issue(account, c.request);
    const row = await record(account);
    expect(row).toEqual({
      user_id: account,
      chain_id: CHAIN_ID.toString(),
      group_registry: Buffer.from(REGISTRY),
      region: "0",
      key_id: Buffer.from(c.keyId),
      key_period: String(Q),
      blinded_element: Buffer.from(c.blindedElement),
    });
  });

  test("refuses an account not verified by both e-mail and phone, before any other check", async () => {
    for (const verified of [
      { email: false, phone: false },
      { email: true, phone: false },
      { email: false, phone: true },
    ]) {
      const account = await newAccount(verified);
      const c = blind();
      expect(await refusal(issue(account, c.request))).toBe("account");
      expect(
        await refusal(issue(account, { ...c.request, keyId: new Uint8Array(32), region: 9 })),
      ).toBe("account");
      expect(await record(account)).toBeUndefined();
    }
  });

  test("checks the phone inside issuance's transaction, waiting on a move in flight (T-01)", async () => {
    const account = await newAccount();
    let issuing: Promise<Tier0IssuanceErrorCode> | undefined;
    let settled = false;
    // A number moved to another account deletes this account's row; until
    // that commits, issuance waits for it rather than reading the old row.
    await app2.begin(async (tx) => {
      await tx`DELETE FROM account_phones WHERE user_id = ${account}`;
      issuing = refusal(issue(account, blind().request)).finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(settled).toBe(false);
    });
    expect(await issuing).toBe("account");
    expect(await record(account)).toBeUndefined();
  });

  test("refuses an account deleted mid-request, without deadlocking with its cascade", async () => {
    const account = await newAccount();
    let issuing: Promise<Tier0IssuanceErrorCode> | undefined;
    await app2.begin(async (tx) => {
      await tx`DELETE FROM account_users WHERE id = ${account}`;
      issuing = refusal(issue(account, blind().request));
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(await issuing).toBe("account");
    expect(await record(account)).toBeUndefined();
  });

  test("refuses a key that isn't the one issuing now", async () => {
    const account = await newAccount();
    // Unknown, next period's (held ahead) and last period's (still redeeming, but no record).
    expect(await refusal(issue(account, { ...blind().request, keyId: new Uint8Array(32) }))).toBe(
      "key-not-issuing",
    );
    expect(await refusal(issue(account, blind(Q + 1).request))).toBe("key-not-issuing");
    expect(await refusal(issue(account, blind(Q - 1).request))).toBe("key-not-issuing");
    expect(await refusal(issue(account, { ...blind().request, keyId: new Uint8Array(31) }))).toBe(
      "key-not-issuing",
    );
    expect(await record(account)).toBeUndefined();
  });

  test("refuses a key that only redeems before the region and B, unless it is the recorded one", async () => {
    const account = await newAccount();
    const bad = { region: 9, blindedElement: new Uint8Array(32) };
    expect(await refusal(issue(account, { ...blind(Q - 1).request, ...bad }))).toBe(
      "key-not-issuing",
    );
    await issue(account, blind().request);
    expect(await refusal(issue(account, { ...blind().request, ...bad }, { now: at(Q + 1) }))).toBe(
      "region-unknown",
    );
  });

  test("the app role can't delete a record, which would free a second token (T-01)", async () => {
    const account = await newAccount();
    await issue(account, blind().request);
    await expect(app`DELETE FROM account_tokens WHERE user_id = ${account}`).rejects.toThrow(
      /permission denied/,
    );
  });

  test("the issuer's secret keys never print", () => {
    const shown = `${JSON.stringify(ISSUER.keys.keys)} ${inspect(ISSUER, { depth: 10 })}`;
    expect(shown).not.toContain("secretKey");
    for (const p of pairs.values()) expect(shown).not.toContain(hex(p.secretKey));
    expect(KEYS.keys.every((k) => k.secretKey.length === 32)).toBe(true);
  });

  test("refuses a region with no published group", async () => {
    const account = await newAccount();
    for (const region of [1, -1, 0.5, Number.NaN, 2 ** 32])
      expect(await refusal(issue(account, { ...blind().request, region }))).toBe("region-unknown");
    expect(await record(account)).toBeUndefined();
  });

  test("refuses a B that isn't a canonical element other than the identity", async () => {
    const account = await newAccount();
    const good = blind().request.blindedElement;
    const bad = [
      new Uint8Array(32),
      new Uint8Array(31),
      Uint8Array.of(...good, 0),
      Uint8Array.from({ length: 32 }, () => 0xff),
    ];
    for (const blindedElement of bad)
      expect(await refusal(issue(account, { ...blind().request, blindedElement }))).toBe(
        "blinded-element",
      );
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 32, maxLength: 32 }), async (b) => {
        try {
          await issue(account, { ...blind().request, blindedElement: b });
          // A random encoding that decodes took the account's token: only once.
          expect(await refusal(issue(account, blind().request))).toBe("token-taken");
        } catch (e) {
          expect(e).toBeInstanceOf(Tier0IssuanceError);
        }
      }),
      { numRuns: Math.min(runs.numRuns, 50) },
    );
  });

  test("answers a retry of the recorded request, and nothing else (T-01)", async () => {
    const account = await newAccount();
    const c = blind();
    const first = await issue(account, c.request);
    const again = await issue(account, c.request);
    // Z is the key's, so the same; the proof's randomness is fresh.
    expect(hex(again.evaluationElement)).toBe(hex(first.evaluationElement));
    expect(await refusal(issue(account, blind().request))).toBe("token-taken");
    // Any number of retries, each answered alike.
    expect(hex((await issue(account, c.request)).evaluationElement)).toBe(
      hex(first.evaluationElement),
    );
    expect(hex((await record(account))!["blinded_element"])).toBe(hex(c.blindedElement));
  });

  test("answers a retry in the next period while the key redeems, never after", async () => {
    const account = await newAccount();
    const c = blind();
    await issue(account, c.request);
    await expect(issue(account, c.request, { now: at(Q + 1) })).resolves.toBeDefined();
    // Under the next period's key the account has its token already.
    expect(await refusal(issue(account, blind(Q + 1).request, { now: at(Q + 1) }))).toBe(
      "token-taken",
    );
    expect(await refusal(issue(account, c.request, { now: at(Q + 2) }))).toBe("key-not-issuing");
    // In q + 1, another B under the old key is no retry.
    expect(await refusal(issue(account, blind().request, { now: at(Q + 1) }))).toBe(
      "key-not-issuing",
    );
  });

  test("counts each first issuance per key and group, never a retry (T-74)", async () => {
    const before = Number((await issued()) ?? 0);
    const a = await newAccount();
    const b = await newAccount();
    const ca = blind();
    await issue(a, ca.request);
    await issue(a, ca.request);
    await issue(b, blind().request);
    await refusal(issue(b, blind().request));
    expect(Number(await issued())).toBe(before + 2);
  });

  test("of two concurrent first requests with different B, one is recorded (T-01)", async () => {
    for (let i = 0; i < 5; i++) {
      const account = await newAccount();
      const before = Number((await issued()) ?? 0);
      const [x, y] = [blind(), blind()];
      const results = await Promise.allSettled([
        issue(account, x.request, { client: app }),
        issue(account, y.request, { client: app2 }),
      ]);
      const ok = results.filter((r) => r.status === "fulfilled");
      const refused = results.flatMap((r) =>
        r.status === "rejected" && r.reason instanceof Tier0IssuanceError ? [r.reason.code] : [],
      );
      expect([ok.length, refused]).toEqual([1, ["token-taken"]]);
      expect(Number(await issued())).toBe(before + 1);
    }
  });

  test("keeps one token per deployment: a redeployed registry starts afresh", async () => {
    const account = await newAccount();
    await issue(account, blind().request);
    const registry = Uint8Array.from(randomBytes(20));
    const redeployed = tier0Issuer({
      keys: KEYS,
      chainId: CHAIN_ID,
      groupRegistry: registry,
      groups: new Map([[0, GROUP_ID]]),
      now: NOW,
    });
    const info = tier0TokenInfo({ chainId: CHAIN_ID, groupRegistry: registry, groupId: GROUP_ID });
    const keyId = keyIdOf(Q);
    const b = tier0TokenBlind(tier0TokenInput(keyId, commitment()), pairs.get(Q)!.publicKey, info);
    const req = { keyId, region: 0, blindedElement: b.blindedElement };
    await expect(issue(account, req, { issuer: redeployed })).resolves.toBeDefined();
    expect(await refusal(issue(account, blind().request))).toBe("token-taken");
  });

  test("an evaluation that fails as inverse leaves no record and no count", async () => {
    const account = await newAccount();
    const before = Number((await issued()) ?? 0);
    blindEvaluate.mockImplementationOnce(() => {
      throw new Tier0TokenError("inverse");
    });
    expect(await refusal(issue(account, blind().request))).toBe("inverse");
    expect(await record(account)).toBeUndefined();
    expect(Number((await issued()) ?? 0)).toBe(before);
    await expect(issue(account, blind().request)).resolves.toBeDefined();
  });

  test("deleting an account deletes its record", async () => {
    const account = await newAccount();
    await issue(account, blind().request);
    await app`DELETE FROM account_users WHERE id = ${account}`;
    expect(await record(account)).toBeUndefined();
  });
});

describe("markDeadTier0Tokens", () => {
  test("clears the key of every record whose key stopped redeeming, keeping B", async () => {
    const live = await newAccount();
    const old = await newAccount();
    const c = blind();
    await issue(live, c.request);
    await issue(old, blind(Q - 1).request, { now: at(Q - 1) });
    // q + 1 still redeems: nothing of period q - 1 is dead during q.
    await markDeadTier0Tokens(app, at(Q, TOKEN_KEY_PERIOD - 1));
    expect((await record(old))!["key_period"]).toBe(String(Q - 1));
    expect(await markDeadTier0Tokens(app, at(Q + 1, 0))).toBeGreaterThanOrEqual(1);
    const dead = await record(old);
    expect([dead!["key_id"], dead!["key_period"]]).toEqual([null, null]);
    expect(dead!["blinded_element"]).toHaveLength(32);
    expect((await record(live))!["key_period"]).toBe(String(Q));
    // A dead record matches no request: no retry, and no second token.
    expect(await refusal(issue(old, blind(Q + 1).request, { now: at(Q + 1) }))).toBe("token-taken");
  });
});
