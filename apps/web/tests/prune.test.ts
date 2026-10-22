// The account tables' timer (src/node/prune.ts) against Postgres as the app
// role: an expired e-mail code is gone after a run, a live one stays, and a
// failed run is logged by kind and retried on the next tick.

import { emailKeys, newAccountId, parseKeyring, requestEmailCode } from "@abolishus/core";
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

/** An account with a code sent at `at`. */
async function codeSentAt(at: Date): Promise<string> {
  const account = newAccountId();
  await sql`
    INSERT INTO account_users VALUES (${account}, ${`${newAccountId()}@account.invalid`},
      false, '', NULL, now(), now())`;
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

test("deletes expired codes and keeps live ones, every tick", async () => {
  const now = new Date("2026-10-22T12:00:00Z");
  const expired = await codeSentAt(new Date(now.getTime() - 60 * 60 * 1000));
  const live = await codeSentAt(new Date(now.getTime() - 60 * 1000));
  const lines: { error: string }[] = [];
  const prune = startAccountPrune({ sql, log: (l) => lines.push(l), everyMs: 20, now: () => now });
  await new Promise((r) => setTimeout(r, 60));
  await prune.stop();
  expect(await codes()).toContain(live);
  expect(await codes()).not.toContain(expired);
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
