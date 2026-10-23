import { getTableConfig } from "drizzle-orm/pg-core";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  accountPushSubscriptions,
  MAX_PUSH_SUBSCRIPTIONS,
  pushSubscribed,
  subscribePush,
  unsubscribePush,
} from "../src/index.ts";
import { newAccount, type TestDb, testDb } from "./db.ts";

// Push subscriptions (migrations/0043_account_push_subscriptions.sql,
// src/account-push.ts; P2-27 part 4): only a known push service's endpoint
// is kept, one account holds an endpoint at a time, an account holds at most
// `MAX_PUSH_SUBSCRIPTIONS`, and a row names nothing but the account, the
// endpoint and when it was added (T-10, T-52, T-76).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

let db: TestDb;
let app: Sql;
let app2: Sql;
beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
  app2 = await db.as("abolish_app");
});
afterAll(() => db?.close());

const NOW = new Date("2026-10-23T09:00:00Z");
const SECOND = 1000;
let n = 0;
const endpoint = () => `https://fcm.googleapis.com/fcm/send/e${++n}:APA91b`;

const endpointsOf = async (account: string) =>
  (
    await db.admin`
      SELECT endpoint FROM account_push_subscriptions WHERE user_id = ${account}
      ORDER BY created_at, endpoint`
  ).map((r) => r["endpoint"] as string);

async function failsWith(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
  } catch (e) {
    return (e as { code?: string }).code ?? "no code";
  }
  throw new Error("query succeeded");
}

describe("schema", () => {
  test("the Drizzle table matches the migrated one", async () => {
    const config = getTableConfig(accountPushSubscriptions);
    const cols = await db.admin`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = ${db.schema} AND table_name = ${config.name} ORDER BY ordinal_position`;
    expect(cols.map((c) => [c["column_name"], c["data_type"], c["is_nullable"]])).toEqual(
      config.columns.map((c) => [c.name, c.getSQLType(), c.notNull ? "NO" : "YES"]),
    );
  });

  test("names only the account, the endpoint and when, and keys only the account", async () => {
    const cols = await db.admin`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${db.schema} AND table_name = 'account_push_subscriptions'
      ORDER BY column_name`;
    expect(cols.map((c) => c["column_name"])).toEqual(["created_at", "endpoint", "user_id"]);
    const keys = await db.admin`
      SELECT confrelid::regclass::text AS target FROM pg_constraint
      WHERE conrelid = ${`"${db.schema}".account_push_subscriptions`}::regclass AND contype = 'f'`;
    expect(keys.map((k) => k["target"])).toEqual(["account_users"]);
  });

  test("the app role never updates or truncates, and the table refuses a non-https or long endpoint", async () => {
    const account = await newAccount(app);
    const e = endpoint();
    expect(await subscribePush(app, account, e, NOW)).toBe("subscribed");
    expect(await failsWith(app`UPDATE account_push_subscriptions SET user_id = ${account}`)).toBe(
      "42501",
    );
    expect(await failsWith(app`TRUNCATE account_push_subscriptions`)).toBe("42501");
    const insert = (e: string) =>
      app`INSERT INTO account_push_subscriptions VALUES (${e}, ${account}, now())`;
    expect(await failsWith(insert("http://fcm.googleapis.com/x"))).toBe("23514");
    expect(await failsWith(insert(`https://fcm.googleapis.com/${"a".repeat(1000)}`))).toBe("23514");
  });

  test("deleting an account deletes its subscriptions", async () => {
    const account = await newAccount(app);
    await subscribePush(app, account, endpoint(), NOW);
    await app`DELETE FROM account_users WHERE id = ${account}`;
    expect(await endpointsOf(account)).toEqual([]);
  });
});

describe("subscribing", () => {
  test("keeps a push service's endpoint, and refuses any other", async () => {
    const account = await newAccount(app);
    const e = endpoint();
    expect(await subscribePush(app, account, e, NOW)).toBe("subscribed");
    for (const bad of [
      "https://169.254.169.254/latest/meta-data/",
      "http://fcm.googleapis.com/fcm/send/x",
      "https://fcm.googleapis.com:8443/fcm/send/x",
      "https://example.com/push",
    ])
      expect(await subscribePush(app, account, bad, NOW), bad).toBe("invalid-endpoint");
    expect(await endpointsOf(account)).toEqual([e]);
  });

  test("subscribing again renews the endpoint without a second row", async () => {
    const account = await newAccount(app);
    const e = endpoint();
    await subscribePush(app, account, e, NOW);
    await subscribePush(app, account, e, new Date(NOW.getTime() + SECOND));
    const rows = await db.admin`
      SELECT created_at FROM account_push_subscriptions WHERE endpoint = ${e}`;
    expect(rows.map((r) => r["created_at"])).toEqual([new Date(NOW.getTime() + SECOND)]);
  });

  test("an endpoint subscribed for another account moves to it", async () => {
    const [a, b] = [await newAccount(app), await newAccount(app)];
    const e = endpoint();
    await subscribePush(app, a, e, NOW);
    await subscribePush(app, b, e, NOW);
    expect(await endpointsOf(a)).toEqual([]);
    expect(await endpointsOf(b)).toEqual([e]);
  });

  test(`keeps an account's newest ${MAX_PUSH_SUBSCRIPTIONS}, dropping the oldest`, async () => {
    const account = await newAccount(app);
    const all = Array.from({ length: MAX_PUSH_SUBSCRIPTIONS + 2 }, endpoint);
    for (const [i, e] of all.entries())
      await subscribePush(app, account, e, new Date(NOW.getTime() + i * SECOND));
    expect(await endpointsOf(account)).toEqual(all.slice(2));
  });

  test("an account's cap leaves other accounts' subscriptions alone", async () => {
    const [a, b] = [await newAccount(app), await newAccount(app)];
    const theirs = endpoint();
    await subscribePush(app, b, theirs, NOW);
    for (let i = 0; i < MAX_PUSH_SUBSCRIPTIONS + 1; i++)
      await subscribePush(app, a, endpoint(), new Date(NOW.getTime() + i * SECOND));
    expect(await endpointsOf(b)).toEqual([theirs]);
  });

  test("subscribes side by side never pass the cap, and one endpoint raced for two accounts lands once", async () => {
    const clients = [
      app,
      app2,
      ...(await Promise.all([1, 2, 3, 4].map(() => db.as("abolish_app")))),
    ];
    for (let round = 0; round < 5; round++) {
      const account = await newAccount(app);
      const many = Array.from({ length: MAX_PUSH_SUBSCRIPTIONS * 4 }, endpoint);
      await Promise.all(
        many.map((e, i) => subscribePush(clients[i % clients.length]!, account, e, NOW)),
      );
      expect(await endpointsOf(account)).toHaveLength(MAX_PUSH_SUBSCRIPTIONS);
    }
    const [a, b] = [await newAccount(app), await newAccount(app)];
    const e = endpoint();
    expect(
      await Promise.all([subscribePush(app, a, e, NOW), subscribePush(app2, b, e, NOW)]),
    ).toEqual(["subscribed", "subscribed"]);
    expect([...(await endpointsOf(a)), ...(await endpointsOf(b))]).toEqual([e]);
  });

  test("refuses a time that is no time, keeping nothing", async () => {
    const account = await newAccount(app);
    await expect(subscribePush(app, account, endpoint(), new Date(Number.NaN))).rejects.toThrow(
      "now is no time",
    );
    expect(await endpointsOf(account)).toEqual([]);
  });

  test("an account that is gone is unknown, and nothing is kept", async () => {
    const e = endpoint();
    expect(await subscribePush(app, "no-such-account", e, NOW)).toBe("unknown-account");
    const rows = await db.admin`SELECT 1 FROM account_push_subscriptions WHERE endpoint = ${e}`;
    expect(rows).toHaveLength(0);
  });

  test("any sequence of subscribes keeps each account's newest, at most the cap, each endpoint once", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.nat(2), fc.nat(7)), { minLength: 1, maxLength: 20 }),
        async (steps) => {
          const accounts = [await newAccount(app), await newAccount(app), await newAccount(app)];
          const base = ++n;
          const ep = (i: number) => `https://web.push.apple.com/p${base}-${i}`;
          // The model: each endpoint's account and time, then each account's newest.
          const model = new Map<string, { account: string; at: number }>();
          for (const [i, [who, which]] of steps.entries()) {
            const account = accounts[who]!;
            await subscribePush(app, account, ep(which), new Date(NOW.getTime() + i * SECOND));
            model.set(ep(which), { account, at: i });
            const mine = [...model].filter(([, v]) => v.account === account);
            mine.sort((x, y) => y[1].at - x[1].at);
            for (const [e] of mine.slice(MAX_PUSH_SUBSCRIPTIONS)) model.delete(e);
          }
          for (const account of accounts) {
            const want = [...model]
              .filter(([, v]) => v.account === account)
              .sort((x, y) => x[1].at - y[1].at)
              .map(([e]) => e);
            expect(await endpointsOf(account)).toEqual(want);
          }
        },
      ),
      { numRuns: Math.min(numRuns, 50) },
    );
  });
});

describe("unsubscribing", () => {
  test("removes the account's own endpoint, and never another account's", async () => {
    const [a, b] = [await newAccount(app), await newAccount(app)];
    const [ea, eb] = [endpoint(), endpoint()];
    await subscribePush(app, a, ea, NOW);
    await subscribePush(app, b, eb, NOW);
    expect(await unsubscribePush(app, a, eb)).toBe(false);
    expect(await endpointsOf(b)).toEqual([eb]);
    expect(await unsubscribePush(app, a, ea)).toBe(true);
    expect(await unsubscribePush(app, a, ea)).toBe(false);
    expect(await endpointsOf(a)).toEqual([]);
  });
});

describe("reading", () => {
  test("an endpoint is subscribed only for the account that last subscribed it", async () => {
    const [a, b] = [await newAccount(app), await newAccount(app)];
    const e = endpoint();
    expect(await pushSubscribed(app, a, e)).toBe(false);
    await subscribePush(app, a, e, NOW);
    expect(await pushSubscribed(app, a, e)).toBe(true);
    expect(await pushSubscribed(app, b, e)).toBe(false);
    await subscribePush(app, b, e, NOW);
    expect(await pushSubscribed(app, a, e)).toBe(false);
    expect(await pushSubscribed(app, b, e)).toBe(true);
    await unsubscribePush(app, b, e);
    expect(await pushSubscribed(app, b, e)).toBe(false);
  });
});
