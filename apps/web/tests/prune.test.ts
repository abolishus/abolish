// The account tables' timer (src/node/prune.ts) against Postgres as the app
// role: an expired e-mail or phone code is gone after a run, a live one
// stays, as do this hour's reaction counts and not earlier hours',
// phone-hash chains are extended to the current key where the phone service
// is configured, a Tier 0 token record whose key stopped redeeming is marked
// dead, and a failed run is logged by kind and retried on the next tick.

import {
  emailKeys,
  newAccountId,
  parseKeyring,
  requestEmailCode,
  requestPhoneCode,
  verifyEmailCode,
  verifyPhoneCode,
} from "@abolishus/core";
import { type TestDb, testDb } from "@abolishus/core/test-db";
import { tier0TokenKeyPeriod } from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

import { startAccountPrune } from "../src/node/prune.ts";

let db: TestDb;
let sql: Sql;

beforeAll(async () => {
  db = await testDb();
  sql = await db.as("abolish_app");
});
afterAll(() => db?.close());

const ring = (id: string) => parseKeyring(`${id}:${randomBytes(32).toString("hex")}`);
const keys = emailKeys(ring("h1"), ring("b1"));

async function newAccount(): Promise<string> {
  const account = newAccountId();
  await sql`
    INSERT INTO account_users VALUES (${account}, ${`${newAccountId()}@account.invalid`},
      false, '', NULL, now(), now())`;
  return account;
}

/** An account with a code sent at `at`. */
async function codeSentAt(at: Date): Promise<string> {
  const account = await newAccount();
  await requestEmailCode(sql, account, `${account}@example.org`, {
    keys,
    sender: { send: async () => "sent" },
    turnstile: { verify: async () => "passed" },
    token: "t",
    now: at,
  });
  return account;
}

const codes = async () =>
  (await sql`SELECT user_id FROM account_email_codes`).map((r) => r["user_id"] as string);

let numbers = 0;

/** An account with a phone code sent at `at`. */
async function phoneCodeSentAt(at: Date): Promise<string> {
  const account = await newAccount();
  await requestPhoneCode(sql, account, `+1415${3_000_000 + ++numbers}`, {
    keys: ring("p1"),
    verifier: {
      lookup: async (number) => ({ number, country: "US", lineType: "mobile" }),
      start: async () => "sent",
      check: async () => "wrong",
    },
    turnstile: { verify: async () => "passed" },
    token: "t",
    dailyCeiling: 1000,
    now: at,
  });
  return account;
}

/** An account with a reaction change counted in the hour `at`. */
async function reactedAt(at: Date): Promise<string> {
  const account = await newAccount();
  await sql`INSERT INTO account_reaction_hours VALUES (${account}, ${at.toISOString()}, 1)`;
  return account;
}

const reactionHours = async () =>
  (await sql`SELECT user_id FROM account_reaction_hours`).map((r) => r["user_id"] as string);

const phoneCodes = async () =>
  (await sql`SELECT user_id FROM account_phone_codes`).map((r) => r["user_id"] as string);

test("deletes expired codes and keeps live ones, every tick", async () => {
  const now = new Date("2026-10-22T12:00:00Z");
  const expired = await codeSentAt(new Date(now.getTime() - 60 * 60 * 1000));
  const live = await codeSentAt(new Date(now.getTime() - 60 * 1000));
  const expiredPhone = await phoneCodeSentAt(new Date(now.getTime() - 60 * 60 * 1000));
  const livePhone = await phoneCodeSentAt(new Date(now.getTime() - 60 * 1000));
  const pastHour = await reactedAt(new Date("2026-10-22T11:00:00Z"));
  const thisHour = await reactedAt(new Date("2026-10-22T12:00:00Z"));
  const lines: { error: string }[] = [];
  const prune = startAccountPrune({ sql, log: (l) => lines.push(l), everyMs: 20, now: () => now });
  await new Promise((r) => setTimeout(r, 60));
  await prune.stop();
  expect(await codes()).toContain(live);
  expect(await codes()).not.toContain(expired);
  expect(await phoneCodes()).toContain(livePhone);
  expect(await phoneCodes()).not.toContain(expiredPhone);
  expect(await reactionHours()).toContain(thisHour);
  expect(await reactionHours()).not.toContain(pastHour);
  expect(lines).toEqual([]);
});

test("logs a failed run by kind only, and tries again on the next tick", async () => {
  let calls = 0;
  const lines: { error: string }[] = [];
  const prune = startAccountPrune({
    sql,
    log: (l) => lines.push(l),
    everyMs: 20,
    now: () => {
      calls++;
      throw new Error("clock gone at 2026-10-22");
    },
  });
  await new Promise((r) => setTimeout(r, 70));
  await prune.stop();
  expect(calls).toBeGreaterThan(1);
  expect(lines[0]).toEqual({ error: "AccountPruneFailed" });
});

test("extends verified numbers' chains to the current phone-hash key, only where configured", async () => {
  const k1 = randomBytes(32).toString("hex");
  const k2 = randomBytes(32).toString("hex");
  const one = parseKeyring(`q1:${k1}`);
  const two = parseKeyring(`q1:${k1},q2:${k2}`);
  const account = await newAccount();
  const number = `+1415${3_000_000 + ++numbers}`;
  const verifier = {
    lookup: async (n: string) => ({ number: n, country: "US", lineType: "mobile" }),
    start: async () => "sent" as const,
    check: async () => "approved" as const,
  };
  const now = new Date("2026-10-22T12:00:00Z");
  await requestPhoneCode(sql, account, number, {
    keys: one,
    verifier,
    turnstile: { verify: async () => "passed" },
    token: "t",
    dailyCeiling: 1000,
    now,
  });
  await verifyPhoneCode(sql, account, number, "123456", { keys: one, verifier, now });
  const keyOf = async () =>
    (await sql`SELECT hash_key FROM account_phones WHERE user_id = ${account}`)[0]?.["hash_key"];
  const run = async (phoneKeys?: typeof two) => {
    const lines: { error: string }[] = [];
    const prune = startAccountPrune({
      sql,
      log: (l) => lines.push(l),
      ...(phoneKeys === undefined ? {} : { phoneKeys }),
      now: () => now,
    });
    await prune.stop();
    return lines;
  };
  expect(await run()).toEqual([]);
  expect(await keyOf()).toBe("q1");
  // A row under a key this keyring lacks, which it can't rotate.
  await sql`
    INSERT INTO account_phone_holds (phone_hash, hash_key, freed_on)
    VALUES (${randomBytes(32)}, 'gone', '2026-10-22T00:00:00Z')`;
  expect(await run(two)).toEqual([{ error: "PhoneHashKeyMissing" }]);
  expect(await keyOf()).toBe("q2");
});

test("marks dead the Tier 0 token records whose key stopped redeeming", async () => {
  const now = new Date("2026-10-22T12:00:00Z");
  const current = tier0TokenKeyPeriod(now.getTime() / 1000);
  const withToken = async (period: number) => {
    const account = await newAccount();
    await sql`
      INSERT INTO account_tokens VALUES (${account}, 1, ${randomBytes(20)}, 0,
        ${randomBytes(32)}, ${period}, ${randomBytes(32)})`;
    return account;
  };
  const dead = await withToken(current - 2);
  const redeeming = await withToken(current - 1);
  const lines: { error: string }[] = [];
  const prune = startAccountPrune({ sql, log: (l) => lines.push(l), everyMs: 20, now: () => now });
  await new Promise((r) => setTimeout(r, 60));
  await prune.stop();
  const period = async (account: string) =>
    (await sql`SELECT key_period FROM account_tokens WHERE user_id = ${account}`)[0]?.[
      "key_period"
    ];
  expect(await period(dead)).toBeNull();
  expect(await period(redeeming)).toBe(String(current - 1));
  expect(lines).toEqual([]);
});

test("re-hashes and re-seals verified addresses under the current e-mail keys, only where configured", async () => {
  const [h1, h2, b1, b2] = [0, 0, 0, 0].map(() => randomBytes(32).toString("hex"));
  const one = emailKeys(parseKeyring(`e1:${h1}`), parseKeyring(`f1:${b1}`));
  const two = emailKeys(parseKeyring(`e1:${h1},e2:${h2}`), parseKeyring(`f1:${b1},f2:${b2}`));
  const account = await newAccount();
  const sent: string[] = [];
  const now = new Date("2026-10-22T12:00:00Z");
  await requestEmailCode(sql, account, `${account}@example.org`, {
    keys: one,
    sender: {
      send: async (m) => {
        if (m.kind === "email-code") sent.push(m.code);
        return "sent";
      },
    },
    turnstile: { verify: async () => "passed" },
    token: "t",
    now,
  });
  await verifyEmailCode(sql, account, sent[0]!, { keys: one, now });
  const keysOf = async () =>
    (await sql`SELECT hash_key, box_key FROM account_emails WHERE user_id = ${account}`)[0];
  const run = async (emailKeys?: typeof two) => {
    const lines: { error: string }[] = [];
    const prune = startAccountPrune({
      sql,
      log: (l) => lines.push(l),
      ...(emailKeys === undefined ? {} : { emailKeys }),
      now: () => now,
    });
    await prune.stop();
    return lines;
  };
  expect(await run()).toEqual([]);
  expect(await keysOf()).toEqual({ hash_key: "e1", box_key: "f1" });
  // Rows other tests made under other keys are only ever reported missing.
  expect((await run(two)).filter((l) => l.error !== "EmailKeyMissing")).toEqual([]);
  expect(await keysOf()).toEqual({ hash_key: "e2", box_key: "f2" });
});
