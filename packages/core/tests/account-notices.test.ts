import { encodeElectionDefinition } from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { getTableConfig } from "drizzle-orm/pg-core";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  accountNoticeChoices,
  accountNotices,
  decideAppeal,
  decideProfileAppeal,
  type EmailKeys,
  EMAIL_LOCALES,
  emailKeys,
  type EmailLocale,
  type EmailMessage,
  type EmailSender,
  fileAppeal,
  fileProfileAppeal,
  followResults,
  landResults,
  makeProfile,
  MAX_NOTICE_BATCH,
  moderate,
  moderateProfile,
  newAccountId,
  noticeChoices,
  noticeDue,
  NOTICE_TRIES,
  NOTICE_WAIT_SECONDS,
  parseKeyring,
  type PushOutcome,
  type PushSender,
  queueNotice,
  REMOVAL_REASONS,
  renderEmail,
  requestEmailCode,
  RESTORE_REASONS,
  sendNotices,
  setFollow,
  setNoticeChoices,
  storeDefinition,
  subscribePush,
  verifyEmailCode,
} from "../src/index.ts";
import { addModerators, newAccount, type TestDb, testDb, typical } from "./db.ts";

// Moderation notices (migrations/0040_account_notices.sql,
// src/account-notices.ts; P2-27 part 3): every decision on an author's poll
// or profile, and every appeal turned down, queues the author's one notice
// in its own transaction, due after the next UTC midnight; each is sent to
// the verified address, deleted once sent unless a decision renewed it,
// retried on a refusal and dropped after `NOTICE_TRIES`; and none says what
// was decided or about which poll or profile (T-10, T-52, T-73). Results of
// a followed poll ride the same notice (P2-25 part 4c), which then says so,
// still naming no poll.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

let db: TestDb;
let app: Sql;
let app2: Sql;
let mods: Map<string, string>;
beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
  app2 = await db.as("abolish_app");
  mods = await addModerators(app, "mod-1", "mod-2", "mod-3");
});
afterAll(() => db?.close());

const NOW = new Date("2026-10-23T09:00:00Z");
const DAY = 86_400_000;
const SECOND = 1000;
const ring = (id: string) => parseKeyring(`${id}:${randomBytes(32).toString("hex")}`);
const KEYS: EmailKeys = emailKeys(ring("h1"), ring("b1"));
/** A time past any notice a decision made now queues. */
const later = () => new Date(Date.now() + 2 * DAY);

/** A sender that records each message and answers from `outcomes`, then `sent`. */
function recorder(...outcomes: ("sent" | "unavailable")[]) {
  const messages: EmailMessage[] = [];
  const sender: EmailSender = {
    send: async (m) => (messages.push(m), outcomes.shift() ?? "sent"),
  };
  return { messages, sender };
}

/** Verifies a fresh address for `account` through the code, as the website does. */
async function verified(account: string, locale: EmailLocale = "en-US"): Promise<string> {
  const address = `${newAccountId().toLowerCase()}@example.org`;
  const { messages, sender } = recorder();
  await requestEmailCode(app, account, address, {
    keys: KEYS,
    sender,
    turnstile: { verify: async () => "passed" },
    token: "t",
    locale: "en-US",
    now: NOW,
  });
  const [message] = messages;
  if (message?.kind !== "email-code") throw new Error("no code sent");
  await verifyEmailCode(app, account, message.code, { keys: KEYS, locale, now: NOW });
  return address;
}

/** A stored poll whose creator record names `author`, or none without one. */
async function poll(author?: string): Promise<{ electionId: Uint8Array; pollId: string }> {
  const electionId = new Uint8Array(randomBytes(32));
  const pollId = newAccountId();
  await storeDefinition(app, encodeElectionDefinition({ ...typical, election_id: electionId }));
  if (author !== undefined)
    await app`
      INSERT INTO account_polls (id, user_id, state, draft, created_at, updated_at, submitted_at,
        creator_address, create_tx_hash, election_id, created_block, l1_origin_timestamp,
        anchors_checked_block, electorate, stub_hash, ceremony_tx_hash, register_tx_hash,
        registered_block)
      VALUES (${pollId}, ${author}, 'open', '{}', now(), now(), now(), ${randomBytes(20)},
        ${randomBytes(32)}, ${electionId}, 1, 1, 1, '[]', ${randomBytes(32)}, ${randomBytes(32)},
        ${randomBytes(32)}, 2)`;
  return { electionId, pollId };
}

/** A fresh account with a verified number, so it may make a profile, and its profile. */
async function profiled(): Promise<{ author: string; handle: string }> {
  const author = await newAccount(app);
  await app`INSERT INTO account_phones VALUES (${author}, ${randomBytes(32)}, 'p1', '2026-10-01T00:00:00Z')`;
  return { author, handle: await makeProfile(app, author, "Sam Example", { now: NOW }) };
}

const noticeOf = async (account: string) => {
  const [row] = await db.admin`
    SELECT not_before, tries FROM account_notices WHERE user_id = ${account}`;
  return row === undefined
    ? undefined
    : { notBefore: row["not_before"] as Date, tries: row["tries"] };
};

const insertNotice = (account: string, notBefore: Date, tries = 0) =>
  app`INSERT INTO account_notices VALUES (${account}, ${notBefore.toISOString()}, ${tries})`;

/** Every notice due at `now`, sent with `sender`, run after run. */
async function drain(sender: EmailSender, now = later()) {
  let total = { sent: 0, retrying: 0, dropped: 0 };
  for (;;) {
    const run = await sendNotices(app, { sender, keys: KEYS, now });
    total = {
      sent: total.sent + run.sent,
      retrying: total.retrying + run.retrying,
      dropped: total.dropped + run.dropped,
    };
    if (run.sent + run.retrying + run.dropped === 0) return total;
  }
}

/** Removes every queued notice, so a test sees only its own. */
const clear = () => db.admin`DELETE FROM account_notices`;
const count = async () =>
  (await db.admin`SELECT count(*)::int AS n FROM account_notices`)[0]!["n"] as number;

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
    const config = getTableConfig(accountNotices);
    const cols = await db.admin`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = ${db.schema} AND table_name = ${config.name} ORDER BY ordinal_position`;
    expect(cols.map((c) => [c["column_name"], c["data_type"], c["is_nullable"]])).toEqual(
      config.columns.map((c) => [c.name, c.getSQLType(), c.notNull ? "NO" : "YES"]),
    );
  });

  test("names no poll, profile, decision or ballot, and keys only the account", async () => {
    const cols = await db.admin`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${db.schema} AND table_name = 'account_notices' ORDER BY column_name`;
    // The flags say which words a notice goes in, never which poll or decision.
    expect(cols.map((c) => c["column_name"])).toEqual([
      "moderation",
      "not_before",
      "results",
      "tries",
      "user_id",
    ]);
    const keys = await db.admin`
      SELECT confrelid::regclass::text AS target FROM pg_constraint
      WHERE conrelid = ${`"${db.schema}".account_notices`}::regclass AND contype = 'f'`;
    expect(keys.map((k) => k["target"])).toEqual(["account_users"]);
  });

  test("the app role updates only a notice's tries, due time and flags, and never truncates", async () => {
    const cols = await db.admin`
      SELECT column_name FROM information_schema.column_privileges
      WHERE table_schema = ${db.schema} AND grantee = 'abolish_app' AND privilege_type = 'UPDATE'
        AND table_name = 'account_notices'
      ORDER BY column_name`;
    expect(cols.map((c) => c["column_name"])).toEqual([
      "moderation",
      "not_before",
      "results",
      "tries",
    ]);
    const account = await newAccount(app);
    await insertNotice(account, NOW);
    expect(await failsWith(app`UPDATE account_notices SET user_id = ${account}`)).toBe("42501");
    expect(await failsWith(app`UPDATE account_notices SET tries = 6`)).toBe("23514");
    // A notice is about something.
    expect(await failsWith(app`UPDATE account_notices SET moderation = false`)).toBe("23514");
    expect(await failsWith(app`TRUNCATE account_notices`)).toBe("42501");
    await clear();
  });

  test("deleting an account deletes its notice", async () => {
    const account = await newAccount(app);
    await insertNotice(account, NOW);
    await app`DELETE FROM account_users WHERE id = ${account}`;
    expect(await noticeOf(account)).toBeUndefined();
  });
});

describe("noticeDue", () => {
  test("is the UTC midnight after the decision, so a notice is dated to its day only", () => {
    expect(noticeDue(new Date("2026-10-23T09:00:00.123Z"))).toEqual(
      new Date("2026-10-24T00:00:00Z"),
    );
    expect(noticeDue(new Date("2026-10-23T00:00:00Z"))).toEqual(new Date("2026-10-24T00:00:00Z"));
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4_102_444_800_000 }), (t) => {
        const due = noticeDue(new Date(t)).getTime();
        expect(due % DAY).toBe(0);
        expect(due > t && due <= t + DAY).toBe(true);
        // Every time in one UTC day gives the same due time.
        expect(noticeDue(new Date(Math.floor(t / DAY) * DAY)).getTime()).toBe(due);
      }),
      { numRuns },
    );
  });
});

describe("queueing", () => {
  test("a decision on an author's poll queues their notice, due after its day", async () => {
    const author = await newAccount(app);
    const { electionId } = await poll(author);
    await moderate(app, electionId, { action: "delist", reason: "spam", moderator: "mod-1" });
    const [decided] = await db.admin`
      SELECT decided_at FROM moderation_actions WHERE election_id = ${electionId}`;
    expect(await noticeOf(author)).toEqual({
      notBefore: noticeDue(decided!["decided_at"] as Date),
      tries: 0,
    });
  });

  test("further decisions ride the one notice waiting", async () => {
    const author = await newAccount(app);
    const { electionId } = await poll(author);
    await moderate(app, electionId, { action: "delist", reason: "spam", moderator: "mod-1" });
    await moderate(app, electionId, { action: "hide", reason: "illegal", moderator: "mod-1" });
    await moderate(app, electionId, { action: "restore", reason: "error", moderator: "mod-2" });
    const [row] = await db.admin`
      SELECT count(*)::int AS n FROM account_notices WHERE user_id = ${author}`;
    expect(row!["n"]).toBe(1);
  });

  test("a decision renews a notice waiting or in flight: tries reset, due no sooner", async () => {
    const author = await newAccount(app);
    const lease = new Date(Date.now() + 3 * DAY);
    await insertNotice(author, lease, 3);
    const { electionId } = await poll(author);
    await moderate(app, electionId, { action: "delist", reason: "spam", moderator: "mod-1" });
    expect(await noticeOf(author)).toEqual({ notBefore: lease, tries: 0 });
    // One due sooner than the new decision's moves to the new day.
    await db.admin`UPDATE account_notices SET not_before = ${NOW.toISOString()}, tries = 2
      WHERE user_id = ${author}`;
    await moderate(app, electionId, { action: "restore", reason: "error", moderator: "mod-2" });
    expect((await noticeOf(author))!.notBefore.getTime()).toBe(noticeDue(new Date()).getTime());
  });

  test("a poll with no author's account, and a refused decision, queue nothing", async () => {
    await clear();
    const author = await newAccount(app);
    await moderate(app, (await poll()).electionId, {
      action: "delist",
      reason: "spam",
      moderator: "mod-1",
    });
    const { electionId } = await poll(author);
    await expect(
      moderate(app, electionId, { action: "restore", reason: "error", moderator: "mod-1" }),
    ).rejects.toMatchObject({ code: "no-change" });
    const own = await poll(mods.get("mod-1"));
    await expect(
      moderate(app, own.electionId, { action: "delist", reason: "spam", moderator: "mod-1" }),
    ).rejects.toMatchObject({ code: "own-poll" });
    expect(await count()).toBe(0);
  });

  test("an appeal turned down or upheld queues a notice; a superseded one doesn't", async () => {
    const author = await newAccount(app);
    const { electionId, pollId } = await poll(author);
    await moderate(app, electionId, { action: "delist", reason: "spam", moderator: "mod-1" });
    await clear();
    await decideAppeal(app, await fileAppeal(app, author, pollId), "rejected", "mod-2");
    expect(await noticeOf(author)).toMatchObject({ tries: 0 });
    await moderate(app, electionId, { action: "delist", reason: "threat", moderator: "mod-2" });
    const appeal = await fileAppeal(app, author, pollId);
    await clear();
    // Neither moderator who keeps the removal in place may judge it.
    await decideAppeal(app, appeal, "upheld", "mod-3");
    expect(await noticeOf(author)).toMatchObject({ tries: 0 });
    await moderate(app, electionId, { action: "hide", reason: "illegal", moderator: "mod-1" });
    const superseded = await fileAppeal(app, author, pollId);
    await moderate(app, electionId, { action: "restore", reason: "error", moderator: "mod-2" });
    await clear();
    expect((await decideAppeal(app, superseded, "rejected", "mod-3")).outcome).toBe("superseded");
    expect(await noticeOf(author)).toBeUndefined();
  });

  test("a profile's decisions and its appeals turned down queue its author's notice", async () => {
    const { author, handle } = await profiled();
    await moderateProfile(app, handle, { action: "hide", reason: "spam", moderator: "mod-1" });
    expect(await noticeOf(author)).toMatchObject({ tries: 0 });
    const appeal = await fileProfileAppeal(app, author);
    await clear();
    await decideProfileAppeal(app, appeal, "rejected", "mod-2");
    expect(await noticeOf(author)).toMatchObject({ tries: 0 });
    await clear();
    await moderateProfile(app, handle, { action: "restore", reason: "error", moderator: "mod-2" });
    expect(await noticeOf(author)).toMatchObject({ tries: 0 });
  });

  test("a decision that rolls back takes its notice with it", async () => {
    const author = await newAccount(app);
    const { electionId } = await poll(author);
    // The notice's insert fails, inside the decision's transaction.
    await db.admin.unsafe(
      `CREATE FUNCTION "${db.schema}".refuse_notice() RETURNS trigger LANGUAGE plpgsql AS
         $$ BEGIN RAISE EXCEPTION 'refused'; END $$;
       CREATE TRIGGER refuse BEFORE INSERT ON "${db.schema}".account_notices
         FOR EACH ROW EXECUTE FUNCTION "${db.schema}".refuse_notice()`,
    );
    try {
      await expect(
        moderate(app, electionId, { action: "delist", reason: "spam", moderator: "mod-1" }),
      ).rejects.toMatchObject({ cause: { message: "refused" } });
    } finally {
      await db.admin.unsafe(
        `DROP TRIGGER refuse ON "${db.schema}".account_notices;
         DROP FUNCTION "${db.schema}".refuse_notice()`,
      );
    }
    const [row] = await db.admin`
      SELECT count(*)::int AS n FROM moderation_actions WHERE election_id = ${electionId}`;
    expect(row!["n"]).toBe(0);
    expect(await noticeOf(author)).toBeUndefined();
  });
});

describe("sending", () => {
  test("sends a due notice once, to the author's verified address, and deletes it", async () => {
    await clear();
    const author = await newAccount(app);
    const address = await verified(author);
    const { electionId } = await poll(author);
    await moderate(app, electionId, { action: "hide", reason: "illegal", moderator: "mod-1" });
    const { messages, sender } = recorder();
    // Not before the next UTC midnight.
    expect(await drain(sender, new Date())).toEqual({ sent: 0, retrying: 0, dropped: 0 });
    expect(await drain(sender)).toEqual({ sent: 1, retrying: 0, dropped: 0 });
    expect(messages).toEqual([
      { kind: "notice", to: address, locale: "en-US", about: "moderation" },
    ]);
    expect(await noticeOf(author)).toBeUndefined();
    expect(await drain(sender)).toEqual({ sent: 0, retrying: 0, dropped: 0 });
  });

  test("writes a notice in the language its author verified the address in", async () => {
    await clear();
    const author = await newAccount(app);
    const address = await verified(author, "es-US");
    const { electionId } = await poll(author);
    await moderate(app, electionId, { action: "hide", reason: "illegal", moderator: "mod-1" });
    const { messages, sender } = recorder();
    expect(await drain(sender)).toEqual({ sent: 1, retrying: 0, dropped: 0 });
    expect(messages).toEqual([
      { kind: "notice", to: address, locale: "es-US", about: "moderation" },
    ]);
  });

  test("a notice waits until it is due", async () => {
    await clear();
    const author = await newAccount(app);
    await verified(author);
    await insertNotice(author, NOW);
    const { messages, sender } = recorder();
    const early = new Date(NOW.getTime() - SECOND);
    expect(await sendNotices(app, { sender, keys: KEYS, now: early })).toEqual({
      sent: 0,
      retrying: 0,
      dropped: 0,
      pushed: 0,
      pushFailed: 0,
    });
    expect(messages).toEqual([]);
    expect(await sendNotices(app, { sender, keys: KEYS, now: NOW })).toMatchObject({ sent: 1 });
  });

  test("an account with no verified address has its notice dropped unsent", async () => {
    await clear();
    const author = await newAccount(app);
    await insertNotice(author, NOW);
    const { messages, sender } = recorder();
    expect(await drain(sender)).toEqual({ sent: 0, retrying: 0, dropped: 1 });
    expect(messages).toEqual([]);
    expect(await noticeOf(author)).toBeUndefined();
  });

  test("a refused notice waits out each step, and is dropped after its last try", async () => {
    await clear();
    const author = await newAccount(app);
    await verified(author);
    await insertNotice(author, NOW);
    const { messages, sender } = recorder(
      ...Array<"unavailable">(NOTICE_TRIES).fill("unavailable"),
    );
    let now = NOW;
    for (let t = 1; t < NOTICE_TRIES; t++) {
      expect(await sendNotices(app, { sender, keys: KEYS, now })).toEqual({
        sent: 0,
        retrying: 1,
        dropped: 0,
        pushed: 0,
        pushFailed: 0,
      });
      const next = new Date(now.getTime() + NOTICE_WAIT_SECONDS[t - 1]! * SECOND);
      expect(await noticeOf(author)).toEqual({ notBefore: next, tries: t });
      const early = new Date(next.getTime() - SECOND);
      expect(await sendNotices(app, { sender, keys: KEYS, now: early })).toMatchObject({
        retrying: 0,
      });
      now = next;
    }
    expect(await sendNotices(app, { sender, keys: KEYS, now })).toEqual({
      sent: 0,
      retrying: 0,
      dropped: 1,
      pushed: 0,
      pushFailed: 0,
    });
    expect(messages).toHaveLength(NOTICE_TRIES);
    expect(await noticeOf(author)).toBeUndefined();
  });

  test("each lease outlasts a batch at the senders' timeouts", () => {
    // Each notice's e-mail (10 s) after its account's pushes, side by side (5 s).
    for (const wait of NOTICE_WAIT_SECONDS)
      expect(wait).toBeGreaterThan(MAX_NOTICE_BATCH * (10 + 5));
  });

  test("a final try that never reported back is dropped once its lease ends", async () => {
    await clear();
    const author = await newAccount(app);
    await insertNotice(author, NOW, NOTICE_TRIES);
    const { messages, sender } = recorder();
    const early = new Date(NOW.getTime() - SECOND);
    expect(await sendNotices(app, { sender, keys: KEYS, now: early })).toMatchObject({
      dropped: 0,
      pushed: 0,
      pushFailed: 0,
    });
    expect(await sendNotices(app, { sender, keys: KEYS, now: NOW })).toEqual({
      sent: 0,
      retrying: 0,
      dropped: 1,
      pushed: 0,
      pushFailed: 0,
    });
    expect(messages).toEqual([]);
  });

  test("a notice a decision renews while it is sent stays, to be sent again", async () => {
    await clear();
    const author = await newAccount(app);
    await verified(author);
    await insertNotice(author, NOW);
    const renewed = new Date(NOW.getTime() + 60 * SECOND);
    const sender: EmailSender = {
      send: async () => {
        await drizzle({ client: app2 }).transaction((tx) => queueNotice(tx, author, renewed));
        return "sent";
      },
    };
    expect(await sendNotices(app, { sender, keys: KEYS, now: NOW })).toMatchObject({ sent: 1 });
    expect(await noticeOf(author)).toEqual({
      notBefore: new Date(
        Math.max(NOW.getTime() + NOTICE_WAIT_SECONDS[0] * SECOND, noticeDue(renewed).getTime()),
      ),
      tries: 0,
    });
  });

  test("a box this deployment can't open is retried, never sent elsewhere", async () => {
    await clear();
    const author = await newAccount(app);
    await verified(author);
    await insertNotice(author, NOW);
    const { messages, sender } = recorder();
    const other = emailKeys(ring("h1"), ring("b1"));
    expect(await sendNotices(app, { sender, keys: other, now: NOW })).toEqual({
      sent: 0,
      retrying: 1,
      dropped: 0,
      pushed: 0,
      pushFailed: 0,
    });
    expect(messages).toEqual([]);
  });

  test("two runs side by side never send one notice twice", async () => {
    await clear();
    const addresses: string[] = [];
    for (let i = 0; i < 18; i++) {
      const a = await newAccount(app);
      addresses.push(await verified(a));
      await insertNotice(a, NOW);
    }
    const sent: string[] = [];
    // A slow provider, so the two runs overlap.
    const sender: EmailSender = {
      send: async (m) => {
        await new Promise((r) => setTimeout(r, 5));
        sent.push(m.to);
        return "sent";
      },
    };
    const runs = await Promise.all(
      [app, app2].map((client) => sendNotices(client, { sender, keys: KEYS, now: NOW, limit: 10 })),
    );
    expect(runs.reduce((n, r) => n + r.sent, 0)).toBe(18);
    expect(sent.sort()).toEqual(addresses.sort());
    expect(await count()).toBe(0);
  });

  test("takes oldest first, at most the limit, and refuses a limit out of range", async () => {
    await clear();
    const order: string[] = [];
    for (let i = 0; i < 3; i++) {
      const a = await newAccount(app);
      order.push(await verified(a));
      await insertNotice(a, new Date(NOW.getTime() - (3 - i) * SECOND));
    }
    const { messages, sender } = recorder();
    expect(await sendNotices(app, { sender, keys: KEYS, now: NOW, limit: 2 })).toMatchObject({
      sent: 2,
    });
    expect(messages.map((m) => m.to)).toEqual(order.slice(0, 2));
    for (const limit of [0, MAX_NOTICE_BATCH + 1, 1.5])
      await expect(sendNotices(app, { sender, keys: KEYS, now: NOW, limit })).rejects.toThrow(
        RangeError,
      );
    await expect(
      sendNotices(app, { sender, keys: KEYS, now: new Date(Number.NaN) }),
    ).rejects.toThrow(TypeError);
  });

  test("a notice is sent once if any of its tries is taken, and dropped if none is", async () => {
    const author = await newAccount(app);
    await verified(author);
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.boolean(), { minLength: NOTICE_TRIES, maxLength: NOTICE_TRIES }),
        async (taken) => {
          await clear();
          await insertNotice(author, NOW);
          const { messages, sender } = recorder(
            ...taken.map((ok) => (ok ? ("sent" as const) : ("unavailable" as const))),
          );
          // Each run two days on, past every wait.
          let total = { sent: 0, dropped: 0 };
          for (let i = 0; i <= NOTICE_TRIES; i++) {
            const now = new Date(NOW.getTime() + i * 2 * DAY);
            const run = await sendNotices(app, { sender, keys: KEYS, now });
            total = { sent: total.sent + run.sent, dropped: total.dropped + run.dropped };
          }
          const first = taken.indexOf(true);
          expect(total).toEqual(first === -1 ? { sent: 0, dropped: 1 } : { sent: 1, dropped: 0 });
          expect(messages).toHaveLength(first === -1 ? NOTICE_TRIES : first + 1);
          expect(await noticeOf(author)).toBeUndefined();
        },
      ),
      { numRuns: Math.min(numRuns, 50) },
    );
  });
});

describe("rendering", () => {
  test("a notice says neither what was decided nor about what, and holds no link", () => {
    const { subject, text } = renderEmail({
      kind: "notice",
      to: "a@example.org",
      locale: "en-US",
      about: "moderation",
    });
    const words = `${subject}\n${text}`.toLowerCase();
    expect(subject).not.toMatch(/\n/);
    expect(words).not.toMatch(/https?:|www\.|@|\/p\/|\/by\//);
    // No action, ground or restore reason, in its code or its everyday words.
    for (const word of [
      "delist",
      "hid",
      "restored",
      "turned down",
      "rejected",
      "upheld",
      ...REMOVAL_REASONS.map((r) => r.replace("-", " ")),
      ...RESTORE_REASONS.map((r) => r.replace("-", " ")),
      "personal data",
      "harass",
      "violence",
    ])
      expect(words).not.toContain(word);
    expect(text).toContain("Sign in to Abolish");
    expect(text).toContain("whatever your notification settings");
  });

  test("each kind of notice says what it carries, and names no poll (T-73)", () => {
    for (const locale of EMAIL_LOCALES) {
      const [moderation, results, both] = (["moderation", "results", "both"] as const).map(
        (about) => renderEmail({ kind: "notice", to: "a@example.org", locale, about }),
      );
      // Three distinct subjects and bodies, the joint one holding both.
      expect(new Set([moderation, results, both].map((r) => r!.subject)).size).toBe(3);
      expect(new Set([moderation, results, both].map((r) => r!.text)).size).toBe(3);
      for (const r of [results, both]) expect(r!.text).not.toMatch(/https?:|\/p\/|\/polls\//);
    }
    const en = (about: "results" | "both") =>
      renderEmail({ kind: "notice", to: "a@example.org", locale: "en-US", about }).text;
    expect(en("results")).toContain("Results are in for a poll you follow");
    expect(en("results")).not.toContain("moderator");
    expect(en("both")).toContain("A moderator made a decision");
    expect(en("both")).toContain("results are in for a poll you follow");
  });
});

describe("results notices (P2-25 part 4c)", () => {
  /** A fresh verified account following a fresh poll whose results then land. */
  async function told(locale: EmailLocale = "en-US") {
    const account = await newAccount(app);
    const address = await verified(account, locale);
    const { electionId } = await poll();
    await setFollow(app, account, electionId, true, { now: NOW });
    expect(await landResults(app, electionId, { now: NOW })).toBe(1);
    return { account, address, electionId };
  }

  test("a follower is told once, in its language, after the next UTC midnight", async () => {
    await clear();
    const en = await told();
    const es = await told("es-US");
    const { messages, sender } = recorder();
    expect(await drain(sender, new Date(noticeDue(NOW).getTime() - SECOND))).toEqual({
      sent: 0,
      retrying: 0,
      dropped: 0,
    });
    expect(await drain(sender, noticeDue(NOW))).toEqual({ sent: 2, retrying: 0, dropped: 0 });
    expect(messages).toHaveLength(2);
    expect(messages).toContainEqual({
      kind: "notice",
      to: en.address,
      locale: "en-US",
      about: "results",
    });
    expect(messages).toContainEqual({
      kind: "notice",
      to: es.address,
      locale: "es-US",
      about: "results",
    });
    expect(await noticeOf(en.account)).toBeUndefined();
    expect(await followResults(app, en.account)).toEqual([en.electionId]);
  });

  test("an author moderated the day a followed poll's results land gets one notice of both", async () => {
    await clear();
    const author = await newAccount(app);
    const address = await verified(author);
    const { electionId } = await poll(author);
    const followed = await poll();
    await setFollow(app, author, followed.electionId, true, { now: NOW });
    await moderate(app, electionId, { action: "hide", reason: "illegal", moderator: "mod-1" });
    await landResults(app, followed.electionId, { now: new Date() });
    const { messages, sender } = recorder();
    expect(await drain(sender)).toEqual({ sent: 1, retrying: 0, dropped: 0 });
    expect(messages).toEqual([{ kind: "notice", to: address, locale: "en-US", about: "both" }]);
  });

  test("results landing while a moderation notice is sent are sent after it, not lost", async () => {
    await clear();
    const author = await newAccount(app);
    const address = await verified(author);
    const { electionId } = await poll(author);
    const followed = await poll();
    await setFollow(app, author, followed.electionId, true, { now: NOW });
    await moderate(app, electionId, { action: "hide", reason: "illegal", moderator: "mod-1" });
    const messages: EmailMessage[] = [];
    let landed = false;
    const sender: EmailSender = {
      send: async (m) => {
        messages.push(m);
        // The results land while the provider takes the moderation notice.
        if (!landed) {
          landed = true;
          await landResults(app2, followed.electionId, { now: new Date() });
        }
        return "sent";
      },
    };
    expect(await drain(sender)).toEqual({ sent: 1, retrying: 0, dropped: 0 });
    // Kept, and due once the send's lease ends.
    expect(await noticeOf(author)).toMatchObject({ tries: 0 });
    expect(await drain(sender, new Date(Date.now() + 4 * DAY))).toEqual({
      sent: 1,
      retrying: 0,
      dropped: 0,
    });
    expect(messages).toEqual([
      { kind: "notice", to: address, locale: "en-US", about: "moderation" },
      { kind: "notice", to: address, locale: "en-US", about: "both" },
    ]);
  });
});

describe("notification choices (P2-27 part 3c-2a)", () => {
  /** A fresh verified account following a fresh poll. */
  async function following() {
    const account = await newAccount(app);
    const address = await verified(account);
    const { electionId } = await poll();
    await setFollow(app, account, electionId, true, { now: NOW });
    return { account, address, electionId };
  }

  test("the Drizzle table matches the migrated one, keyed only by the account", async () => {
    const config = getTableConfig(accountNoticeChoices);
    const cols = await db.admin`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = ${db.schema} AND table_name = ${config.name} ORDER BY ordinal_position`;
    expect(cols.map((c) => [c["column_name"], c["data_type"], c["is_nullable"]])).toEqual(
      config.columns.map((c) => [c.name, c.getSQLType(), c.notNull ? "NO" : "YES"]),
    );
    // A choice names no poll: only the account and what it chose.
    expect(cols.map((c) => c["column_name"])).toEqual(["user_id", "results"]);
    const keys = await db.admin`
      SELECT confrelid::regclass::text AS target FROM pg_constraint
      WHERE conrelid = ${`"${db.schema}".account_notice_choices`}::regclass AND contype = 'f'`;
    expect(keys.map((k) => k["target"])).toEqual(["account_users"]);
  });

  test("the app role changes only the choice, and never deletes or truncates", async () => {
    const cols = await db.admin`
      SELECT column_name FROM information_schema.column_privileges
      WHERE table_schema = ${db.schema} AND grantee = 'abolish_app' AND privilege_type = 'UPDATE'
        AND table_name = 'account_notice_choices'`;
    expect(cols.map((c) => c["column_name"])).toEqual(["results"]);
    const account = await newAccount(app);
    await setNoticeChoices(app, account, { results: false });
    const other = await newAccount(app);
    expect(
      await failsWith(
        app`UPDATE account_notice_choices SET user_id = ${other} WHERE user_id = ${account}`,
      ),
    ).toBe("42501");
    expect(await failsWith(app`DELETE FROM account_notice_choices`)).toBe("42501");
    expect(await failsWith(app`TRUNCATE account_notice_choices`)).toBe("42501");
  });

  test("an account that chose nothing is told of results, and the last choice stands", async () => {
    const account = await newAccount(app);
    const other = await newAccount(app);
    expect(await noticeChoices(app, account)).toEqual({ results: true });
    await fc.assert(
      fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 5 }), async (choices) => {
        for (const results of choices) await setNoticeChoices(app, account, { results });
        expect(await noticeChoices(app, account)).toEqual({ results: choices.at(-1) });
        // One account's choice is its own.
        expect(await noticeChoices(app, other)).toEqual({ results: true });
      }),
      { numRuns: Math.min(numRuns, 50) },
    );
  });

  test("with results off, a followed poll is listed when they land but no notice is queued", async () => {
    await clear();
    const off = await following();
    const on = await newAccount(app);
    const onAddress = await verified(on);
    await setFollow(app, on, off.electionId, true, { now: NOW });
    await setNoticeChoices(app, off.account, { results: false });
    // Only the account that kept them on is told.
    expect(await landResults(app, off.electionId, { now: NOW })).toBe(1);
    expect(await followResults(app, off.account)).toEqual([off.electionId]);
    expect(await noticeOf(off.account)).toBeUndefined();
    const { messages, sender } = recorder();
    expect(await drain(sender)).toEqual({ sent: 1, retrying: 0, dropped: 0 });
    expect(messages).toEqual([
      { kind: "notice", to: onAddress, locale: "en-US", about: "results" },
    ]);
  });

  test("with results off, a moderation notice waiting is still sent, saying only that", async () => {
    await clear();
    const author = await newAccount(app);
    const address = await verified(author);
    const { electionId } = await poll(author);
    const followed = await poll();
    await setFollow(app, author, followed.electionId, true, { now: NOW });
    await setNoticeChoices(app, author, { results: false });
    await moderate(app, electionId, { action: "hide", reason: "illegal", moderator: "mod-1" });
    await landResults(app, followed.electionId, { now: new Date() });
    const { messages, sender } = recorder();
    expect(await drain(sender)).toEqual({ sent: 1, retrying: 0, dropped: 0 });
    expect(messages).toEqual([
      { kind: "notice", to: address, locale: "en-US", about: "moderation" },
    ]);
  });

  test("turning results off takes them off a notice waiting, and drops one that held only them", async () => {
    await clear();
    const only = await following();
    expect(await landResults(app, only.electionId, { now: NOW })).toBe(1);
    const author = await newAccount(app);
    const address = await verified(author);
    const { electionId } = await poll(author);
    const followed = await poll();
    await setFollow(app, author, followed.electionId, true, { now: NOW });
    await moderate(app, electionId, { action: "hide", reason: "illegal", moderator: "mod-1" });
    await landResults(app, followed.electionId, { now: new Date() });
    const before = await noticeOf(author);

    await setNoticeChoices(app, only.account, { results: false });
    await setNoticeChoices(app, author, { results: false });
    expect(await noticeOf(only.account)).toBeUndefined();
    // Its due time and tries are untouched, so a sender holding it still deletes it.
    expect(await noticeOf(author)).toEqual(before);
    // The lists stay: only the e-mail is left out.
    expect(await followResults(app, only.account)).toEqual([only.electionId]);
    const { messages, sender } = recorder();
    expect(await drain(sender)).toEqual({ sent: 1, retrying: 0, dropped: 0 });
    expect(messages).toEqual([
      { kind: "notice", to: address, locale: "en-US", about: "moderation" },
    ]);
  });

  test("turning results back on tells of the next landing, not the ones left out", async () => {
    await clear();
    const { account, address, electionId } = await following();
    await setNoticeChoices(app, account, { results: false });
    expect(await landResults(app, electionId, { now: NOW })).toBe(0);
    await setNoticeChoices(app, account, { results: true });
    expect(await noticeOf(account)).toBeUndefined();
    const next = await poll();
    await setFollow(app, account, next.electionId, true, { now: NOW });
    expect(await landResults(app, next.electionId, { now: NOW })).toBe(1);
    const { messages, sender } = recorder();
    expect(await drain(sender)).toEqual({ sent: 1, retrying: 0, dropped: 0 });
    expect(messages).toEqual([{ kind: "notice", to: address, locale: "en-US", about: "results" }]);
  });

  test("a choice goes with its account", async () => {
    const account = await newAccount(app);
    await setNoticeChoices(app, account, { results: false });
    await db.admin`DELETE FROM account_users WHERE id = ${account}`;
    expect(
      await db.admin`SELECT 1 FROM account_notice_choices WHERE user_id = ${account}`,
    ).toHaveLength(0);
  });

  test("refuses a malformed account or choice, writing nothing", async () => {
    const account = await newAccount(app);
    await expect(noticeChoices(app, "Not-an-ID")).rejects.toThrow(RangeError);
    await expect(setNoticeChoices(app, "Not-an-ID", { results: true })).rejects.toThrow(RangeError);
    for (const bad of [undefined, null, {}, { results: "false" }, { results: 0 }])
      await expect(
        setNoticeChoices(app, account, bad as unknown as { results: boolean }),
      ).rejects.toThrow(TypeError);
    expect(await noticeChoices(app, account)).toEqual({ results: true });
  });
});

describe("web push", () => {
  let n = 0;
  const endpoint = () => `https://updates.push.services.mozilla.com/wpush/v2/n${++n}`;

  /** A push sender that records each endpoint and answers from `outcomes`, then `sent`. */
  function pusher(outcomes: Record<string, PushOutcome | Error> = {}) {
    const pushed: { endpoint: string; now: Date }[] = [];
    const push: PushSender = {
      send: async (endpoint, now) => {
        pushed.push({ endpoint, now });
        const o = outcomes[endpoint] ?? "sent";
        if (o instanceof Error) throw o;
        return o;
      },
    };
    return { pushed, push };
  }

  // Postgres' C collation and JavaScript agree on these ASCII endpoints.
  const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

  const subscriptions = async (account: string) =>
    (
      await db.admin`
        SELECT endpoint FROM account_push_subscriptions WHERE user_id = ${account}
        ORDER BY endpoint COLLATE "C"`
    ).map((r) => r["endpoint"] as string);

  test("a notice's first try wakes every browser the account subscribed, beside the e-mail", async () => {
    await clear();
    const author = await newAccount(app);
    const address = await verified(author);
    const [e1, e2] = [endpoint(), endpoint()];
    await subscribePush(app, author, e1, NOW);
    await subscribePush(app, author, e2, NOW);
    const other = await newAccount(app);
    await subscribePush(app, other, endpoint(), NOW);
    await insertNotice(author, NOW);
    const { messages, sender } = recorder();
    const { pushed, push } = pusher();
    expect(await sendNotices(app, { sender, keys: KEYS, push, now: NOW })).toEqual({
      sent: 1,
      retrying: 0,
      dropped: 0,
      pushed: 2,
      pushFailed: 0,
    });
    expect(messages).toEqual([
      { kind: "notice", to: address, locale: "en-US", about: "moderation" },
    ]);
    expect(pushed.map((p) => p.endpoint).sort(byCode)).toEqual([e1, e2].sort(byCode));
    expect(pushed.every((p) => p.now === NOW)).toBe(true);
  });

  test("an account with no verified address is still pushed to, once", async () => {
    await clear();
    const author = await newAccount(app);
    const e = endpoint();
    await subscribePush(app, author, e, NOW);
    await insertNotice(author, NOW);
    const { messages, sender } = recorder();
    const { pushed, push } = pusher();
    expect(await sendNotices(app, { sender, keys: KEYS, push, now: NOW })).toEqual({
      sent: 0,
      retrying: 0,
      dropped: 1,
      pushed: 1,
      pushFailed: 0,
    });
    expect(messages).toEqual([]);
    expect(pushed.map((p) => p.endpoint)).toEqual([e]);
  });

  test("a refused e-mail's later tries push nothing again, and a renewal pushes once more", async () => {
    await clear();
    const author = await newAccount(app);
    await verified(author);
    const e = endpoint();
    await subscribePush(app, author, e, NOW);
    await insertNotice(author, NOW);
    const { sender } = recorder("unavailable", "unavailable");
    const { pushed, push } = pusher();
    expect(await sendNotices(app, { sender, keys: KEYS, push, now: NOW })).toMatchObject({
      retrying: 1,
      pushed: 1,
    });
    const next = new Date(NOW.getTime() + NOTICE_WAIT_SECONDS[0] * SECOND);
    expect(await sendNotices(app, { sender, keys: KEYS, push, now: next })).toMatchObject({
      retrying: 1,
      pushed: 0,
    });
    expect(pushed).toHaveLength(1);
    // A decision renews the notice, its tries reset: the next try is a first one.
    await queueNotice(drizzle({ client: app }), author, NOW);
    const due = (await noticeOf(author))!.notBefore;
    expect(await sendNotices(app, { sender, keys: KEYS, push, now: due })).toMatchObject({
      sent: 1,
      pushed: 1,
    });
    expect(pushed).toHaveLength(2);
  });

  test("a subscription its push service says has ended is deleted; one that fails is kept", async () => {
    await clear();
    const author = await newAccount(app);
    await verified(author);
    const [gone, gone2, failing, throwing, fine] = Array.from({ length: 5 }, endpoint);
    for (const e of [gone, gone2, failing, throwing, fine])
      await subscribePush(app, author, e!, NOW);
    await insertNotice(author, NOW);
    const { messages, sender } = recorder();
    const { push } = pusher({
      [gone!]: "gone",
      [gone2!]: "gone",
      [failing!]: "unavailable",
      [throwing!]: new Error("boom"),
    });
    expect(await sendNotices(app, { sender, keys: KEYS, push, now: NOW })).toEqual({
      sent: 1,
      retrying: 0,
      dropped: 0,
      pushed: 1,
      pushFailed: 2,
    });
    // The e-mail went whatever the pushes did.
    expect(messages).toHaveLength(1);
    expect(await subscriptions(author)).toEqual([failing!, throwing!, fine!].sort(byCode));
  });

  test("a sender that throws at once, or a failed cleanup, still lets the e-mail and the batch go", async () => {
    await clear();
    const [first, second] = [await newAccount(app), await newAccount(app)];
    await verified(first);
    await verified(second);
    const [e1, e2] = [endpoint(), endpoint()];
    await subscribePush(app, first, e1, NOW);
    await subscribePush(app, second, e2, NOW);
    await insertNotice(first, NOW);
    await insertNotice(second, NOW);
    const push: PushSender = {
      send: (endpoint) => {
        if (endpoint === e1) throw new Error("thrown, not rejected");
        return Promise.resolve("gone");
      },
    };
    // The cleanup of the ended subscription fails: the app role may not delete.
    await db.admin.unsafe(
      `REVOKE DELETE ON "${db.schema}".account_push_subscriptions FROM abolish_app`,
    );
    try {
      const { messages, sender } = recorder();
      expect(await sendNotices(app, { sender, keys: KEYS, push, now: NOW })).toEqual({
        sent: 2,
        retrying: 0,
        dropped: 0,
        pushed: 0,
        pushFailed: 2,
      });
      expect(messages).toHaveLength(2);
    } finally {
      await db.admin.unsafe(
        `GRANT DELETE ON "${db.schema}".account_push_subscriptions TO abolish_app`,
      );
    }
  });

  test("an ended subscription moved to another account meanwhile stays with it", async () => {
    await clear();
    const [author, other] = [await newAccount(app), await newAccount(app)];
    const e = endpoint();
    await subscribePush(app, author, e, NOW);
    await insertNotice(author, NOW);
    const push: PushSender = {
      send: async () => {
        await subscribePush(app2, other, e, NOW);
        return "gone";
      },
    };
    await sendNotices(app, { sender: recorder().sender, keys: KEYS, push, now: NOW });
    expect(await subscriptions(other)).toEqual([e]);
  });

  test("without a push sender nothing is pushed and subscriptions stay", async () => {
    await clear();
    const author = await newAccount(app);
    const e = endpoint();
    await subscribePush(app, author, e, NOW);
    await insertNotice(author, NOW);
    expect(await drain(recorder().sender)).toEqual({ sent: 0, retrying: 0, dropped: 1 });
    expect(await subscriptions(author)).toEqual([e]);
  });
});
