// The account tables' timer (src/node/prune.ts) against Postgres as the app
// role: an expired e-mail or phone code is gone after a run, a live one
// stays, as do the last two hours' reaction counts and not earlier ones,
// phone-hash chains are extended to the current key where the phone service
// is configured, a Tier 0 token record whose key stopped redeeming is marked
// dead, the moderation notices due are sent where the e-mail service is
// configured, with a push to the account's browsers where web push is, and a
// failed run is logged by kind and retried on the next tick.

import {
  type EmailMessage,
  emailKeys,
  MAX_NOTICE_BATCH,
  newAccountId,
  parseKeyring,
  type PushOutcome,
  requestEmailCode,
  subscribePush,
  requestPhoneCode,
  verifyEmailCode,
  verifyPhoneCode,
} from "@abolishus/core";
import { type TestDb, testDb } from "@abolishus/core/test-db";
import { tier0TokenKeyPeriod } from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

import { NOTICE_BATCHES, startAccountPrune } from "../src/node/prune.ts";

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
    locale: "en-US",
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
  const pastHour = await reactedAt(new Date("2026-10-22T10:00:00Z"));
  const lastHour = await reactedAt(new Date("2026-10-22T11:00:00Z"));
  const lines: { error: string }[] = [];
  const prune = startAccountPrune({ sql, log: (l) => lines.push(l), everyMs: 20, now: () => now });
  await new Promise((r) => setTimeout(r, 60));
  await prune.stop();
  expect(await codes()).toContain(live);
  expect(await codes()).not.toContain(expired);
  expect(await phoneCodes()).toContain(livePhone);
  expect(await phoneCodes()).not.toContain(expiredPhone);
  expect(await reactionHours()).toContain(lastHour);
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
    locale: "en-US",
    now,
  });
  await verifyEmailCode(sql, account, sent[0]!, { keys: one, locale: "en-US", now });
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

/** An account whose address `address` is verified under `keys`. */
async function verifiedAt(address: string, at: Date): Promise<string> {
  const account = await newAccount();
  const codes: string[] = [];
  await requestEmailCode(sql, account, address, {
    keys,
    sender: {
      send: async (m) => {
        if (m.kind === "email-code") codes.push(m.code);
        return "sent";
      },
    },
    turnstile: { verify: async () => "passed" },
    token: "t",
    locale: "en-US",
    now: at,
  });
  await verifyEmailCode(sql, account, codes[0]!, { keys, locale: "en-US", now: at });
  return account;
}

const notify = async (account: string, due: Date) => {
  await sql`INSERT INTO account_notices (user_id, not_before) VALUES (${account}, ${due.toISOString()})`;
};

const notices = async () =>
  new Map(
    (await sql`SELECT user_id, tries FROM account_notices`).map((r) => [
      r["user_id"] as string,
      r["tries"] as number,
    ]),
  );

test("sends the notices due to verified addresses, only where configured", async () => {
  const now = new Date("2026-10-23T00:05:00Z");
  const due = await verifiedAt("due@example.org", now);
  const later = await verifiedAt("later@example.org", now);
  await notify(due, new Date("2026-10-23T00:00:00Z"));
  await notify(later, new Date("2026-10-24T00:00:00Z"));
  const sent: EmailMessage[] = [];
  const run = async (noticeSender?: { send: (m: EmailMessage) => Promise<"sent"> }) => {
    const lines: { error: string }[] = [];
    const prune = startAccountPrune({
      sql,
      log: (l) => lines.push(l),
      emailKeys: keys,
      ...(noticeSender === undefined ? {} : { noticeSender }),
      now: () => now,
    });
    await prune.stop();
    // Rows other tests made under other keys are only ever reported missing.
    return lines.filter((l) => l.error !== "EmailKeyMissing");
  };
  // Keys without a sender: nothing is sent.
  expect(await run()).toEqual([]);
  expect((await notices()).get(due)).toBe(0);
  expect(
    await run({
      send: async (m) => {
        sent.push(m);
        return "sent";
      },
    }),
  ).toEqual([]);
  expect(sent).toEqual([{ kind: "notice", to: "due@example.org", locale: "en-US" }]);
  expect((await notices()).has(due)).toBe(false);
  expect((await notices()).get(later)).toBe(0);
  await sql`DELETE FROM account_notices`;
});

test("logs a refusal by kind only and keeps the notice for its next try", async () => {
  const now = new Date("2026-10-23T00:05:00Z");
  const account = await verifiedAt("refused@example.org", now);
  await notify(account, new Date("2026-10-23T00:00:00Z"));
  const lines: { error: string }[] = [];
  const prune = startAccountPrune({
    sql,
    log: (l) => lines.push(l),
    emailKeys: keys,
    noticeSender: { send: async () => "unavailable" },
    now: () => now,
  });
  await prune.stop();
  expect(lines.filter((l) => l.error !== "EmailKeyMissing")).toEqual([
    { error: "AccountNoticeRefused" },
  ]);
  expect((await notices()).get(account)).toBe(1);
  await sql`DELETE FROM account_notices`;
});

test("logs a sender that throws by kind only, and keeps the run's other work", async () => {
  const now = new Date("2026-10-23T00:05:00Z");
  const account = await verifiedAt("throws@example.org", now);
  await notify(account, new Date("2026-10-23T00:00:00Z"));
  const lines: { error: string }[] = [];
  const prune = startAccountPrune({
    sql,
    log: (l) => lines.push(l),
    emailKeys: keys,
    noticeSender: {
      send: async () => {
        throw new Error("provider gone for throws@example.org");
      },
    },
    now: () => now,
  });
  await prune.stop();
  expect(lines.filter((l) => l.error !== "EmailKeyMissing")).toEqual([
    { error: "AccountNoticeSendFailed" },
  ]);
  // Claimed with its first try; a later run tries again once its lease ends.
  expect((await notices()).get(account)).toBe(1);
  await sql`DELETE FROM account_notices`;
});

test("drains a backlog larger than one batch in a single run", async () => {
  expect(NOTICE_BATCHES).toBeGreaterThan(1);
  const now = new Date("2026-10-23T00:05:00Z");
  // Accounts with no verified address: each notice is claimed and dropped.
  const accounts = await Promise.all(
    Array.from({ length: MAX_NOTICE_BATCH + 50 }, () => newAccount()),
  );
  for (const account of accounts) await notify(account, new Date("2026-10-23T00:00:00Z"));
  const lines: { error: string }[] = [];
  const prune = startAccountPrune({
    sql,
    log: (l) => lines.push(l),
    emailKeys: keys,
    noticeSender: { send: async () => "sent" },
    now: () => now,
  });
  await prune.stop();
  expect(lines.filter((l) => l.error !== "EmailKeyMissing")).toEqual([]);
  expect((await notices()).size).toBe(0);
});

test("pushes to the account's browsers beside a notice's e-mail, logging a refused push by kind only", async () => {
  const now = new Date("2026-10-23T00:05:00Z");
  const account = await verifiedAt("pushed@example.org", now);
  const [ok, refused] = [
    "https://fcm.googleapis.com/fcm/send/prune-ok",
    "https://updates.push.services.mozilla.com/wpush/v2/prune-refused",
  ];
  await subscribePush(sql, account, ok, now);
  await subscribePush(sql, account, refused, now);
  await notify(account, new Date("2026-10-23T00:00:00Z"));
  const pushed: string[] = [];
  const lines: { error: string }[] = [];
  const prune = startAccountPrune({
    sql,
    log: (l) => lines.push(l),
    emailKeys: keys,
    noticeSender: { send: async () => "sent" },
    pushSender: {
      send: async (endpoint): Promise<PushOutcome> => {
        pushed.push(endpoint);
        return endpoint === ok ? "sent" : "unavailable";
      },
    },
    now: () => now,
  });
  await prune.stop();
  expect(pushed.sort()).toEqual([ok, refused].sort());
  // T-76: the log names the kind, never the endpoint or the account.
  expect(lines.filter((l) => l.error !== "EmailKeyMissing")).toEqual([
    { error: "AccountPushRefused" },
  ]);
  expect((await notices()).has(account)).toBe(false);
  await sql`DELETE FROM account_push_subscriptions WHERE user_id = ${account}`;
});
