// The account tables' timer (src/node/prune.ts) against Postgres as the app
// role: an expired e-mail or phone code is gone after a run, a live one
// stays, phone-hash chains are extended to the current key where the phone
// service is configured, and a failed run is logged by kind and retried on
// the next tick.

import {
  emailKeys,
  newAccountId,
  parseKeyring,
  requestEmailCode,
  requestPhoneCode,
  verifyPhoneCode,
} from "@abolishus/core";
import { type TestDb, testDb } from "@abolishus/core/test-db";
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

const phoneCodes = async () =>
  (await sql`SELECT user_id FROM account_phone_codes`).map((r) => r["user_id"] as string);

test("deletes expired codes and keeps live ones, every tick", async () => {
  const now = new Date("2026-10-22T12:00:00Z");
  const expired = await codeSentAt(new Date(now.getTime() - 60 * 60 * 1000));
  const live = await codeSentAt(new Date(now.getTime() - 60 * 1000));
  const expiredPhone = await phoneCodeSentAt(new Date(now.getTime() - 60 * 60 * 1000));
  const livePhone = await phoneCodeSentAt(new Date(now.getTime() - 60 * 1000));
  const lines: { error: string }[] = [];
  const prune = startAccountPrune({ sql, log: (l) => lines.push(l), everyMs: 20, now: () => now });
  await new Promise((r) => setTimeout(r, 60));
  await prune.stop();
  expect(await codes()).toContain(live);
  expect(await codes()).not.toContain(expired);
  expect(await phoneCodes()).toContain(livePhone);
  expect(await phoneCodes()).not.toContain(expiredPhone);
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
