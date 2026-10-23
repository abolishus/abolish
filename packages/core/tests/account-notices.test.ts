import { encodeElectionDefinition } from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  accountNotices,
  decideAppeal,
  decideProfileAppeal,
  type EmailKeys,
  emailKeys,
  type EmailMessage,
  type EmailSender,
  fileAppeal,
  fileProfileAppeal,
  makeProfile,
  MAX_NOTICE_BATCH,
  moderate,
  moderateProfile,
  newAccountId,
  type Notice,
  NOTICE_TRIES,
  NOTICE_WAIT_SECONDS,
  parseKeyring,
  REMOVAL_REASONS,
  renderEmail,
  requestEmailCode,
  RESTORE_REASONS,
  sendNotices,
  storeDefinition,
  verifyEmailCode,
} from "../src/index.ts";
import { addModerators, newAccount, type TestDb, testDb, typical } from "./db.ts";

// Moderation notices (migrations/0040_account_notices.sql,
// src/account-notices.ts; P2-27 part 3): every decision on an author's poll
// or profile, and every appeal turned down, queues one notice in its own
// transaction; each is sent to the verified address at most once per
// claim, deleted once sent, retried on a refusal and dropped after
// `NOTICE_TRIES`; and none names a poll or a profile (T-10, T-52, T-73).

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
const ring = (id: string) => parseKeyring(`${id}:${randomBytes(32).toString("hex")}`);
const KEYS: EmailKeys = emailKeys(ring("h1"), ring("b1"));
const SECOND = 1000;

/** A sender that records each message and answers from `outcomes`, then `sent`. */
function recorder(...outcomes: ("sent" | "unavailable")[]) {
  const messages: EmailMessage[] = [];
  const sender: EmailSender = {
    send: async (m) => (messages.push(m), outcomes.shift() ?? "sent"),
  };
  return { messages, sender };
}

/** Verifies a fresh address for `account` through the code, as the website does. */
async function verified(account: string): Promise<string> {
  const address = `${newAccountId().toLowerCase()}@example.org`;
  const { messages, sender } = recorder();
  await requestEmailCode(app, account, address, {
    keys: KEYS,
    sender,
    turnstile: { verify: async () => "passed" },
    token: "t",
    now: NOW,
  });
  const [message] = messages;
  if (message?.kind !== "email-code") throw new Error("no code sent");
  await verifyEmailCode(app, account, message.code, { keys: KEYS, now: NOW });
  return address;
}

/** A stored poll whose creator record names `author`, or none without one. */
async function poll(author?: string): Promise<Uint8Array> {
  const electionId = new Uint8Array(randomBytes(32));
  await storeDefinition(app, encodeElectionDefinition({ ...typical, election_id: electionId }));
  if (author !== undefined)
    await app`
      INSERT INTO account_polls (id, user_id, state, draft, created_at, updated_at, submitted_at,
        creator_address, create_tx_hash, election_id, created_block, l1_origin_timestamp,
        anchors_checked_block, electorate, stub_hash, ceremony_tx_hash, register_tx_hash,
        registered_block)
      VALUES (${newAccountId()}, ${author}, 'open', '{}', now(), now(), now(), ${randomBytes(20)},
        ${randomBytes(32)}, ${electionId}, 1, 1, 1, '[]', ${randomBytes(32)}, ${randomBytes(32)},
        ${randomBytes(32)}, 2)`;
  return electionId;
}

const noticesOf = async (account: string) =>
  (
    await db.admin`
      SELECT subject, event, reason, tries, not_before FROM account_notices
      WHERE user_id = ${account} ORDER BY id`
  ).map((r) => ({ ...r }));

const notices = async (account: string) =>
  (await noticesOf(account)).map(({ subject, event, reason }) => ({ subject, event, reason }));

/** Every notice that is due now, sent with `sender` and `now`, run after run. */
async function drain(sender: EmailSender, now = new Date(Date.now() + 60 * SECOND)) {
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

async function failsWith(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
  } catch (e) {
    return (e as { code?: string }).code ?? "no code";
  }
  throw new Error("query succeeded");
}

const ALL_NOTICES: Notice[] = [
  ...(["delist", "hide", "appeal-rejected"] as const).flatMap((event) =>
    REMOVAL_REASONS.map((reason): Notice => ({ subject: "poll", event, reason })),
  ),
  ...(["hide", "appeal-rejected"] as const).flatMap((event) =>
    REMOVAL_REASONS.map((reason): Notice => ({ subject: "profile", event, reason })),
  ),
  ...(["poll", "profile"] as const).flatMap((subject) =>
    RESTORE_REASONS.map((reason): Notice => ({ subject, event: "restore", reason })),
  ),
];

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

  test("the table's reasons are exactly the moderation log's", () => {
    const sql = readFileSync(
      new URL("../src/db/migrations/0040_account_notices.sql", import.meta.url),
      "utf8",
    );
    const list = /reason IN \(([^)]*)\)/.exec(sql)?.[1];
    expect(list?.split(",").map((s) => s.trim().replaceAll("'", ""))).toEqual([
      ...REMOVAL_REASONS,
      ...RESTORE_REASONS,
    ]);
  });

  test("the table holds exactly the combinations a Notice names", async () => {
    const account = await newAccount(app);
    const named = new Set(ALL_NOTICES.map((n) => `${n.subject}/${n.event}/${n.reason}`));
    for (const subject of ["poll", "profile"])
      for (const event of ["delist", "hide", "restore", "appeal-rejected"])
        for (const reason of [...REMOVAL_REASONS, ...RESTORE_REASONS]) {
          const insert = app`
            INSERT INTO account_notices (user_id, subject, event, reason, not_before)
            VALUES (${account}, ${subject}, ${event}, ${reason}, now())`;
          if (named.has(`${subject}/${event}/${reason}`)) await insert;
          else expect(await failsWith(insert)).toBe("23514");
        }
    expect(await noticesOf(account)).toHaveLength(named.size);
    await clear();
  });

  test("names no poll, profile, decision or ballot", async () => {
    const cols = await db.admin`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${db.schema} AND table_name = 'account_notices' ORDER BY column_name`;
    expect(cols.map((c) => c["column_name"])).toEqual([
      "event",
      "id",
      "not_before",
      "reason",
      "subject",
      "tries",
      "user_id",
    ]);
    const keys = await db.admin`
      SELECT confrelid::regclass::text AS target FROM pg_constraint
      WHERE conrelid = ${`"${db.schema}".account_notices`}::regclass AND contype = 'f'`;
    expect(keys.map((k) => k["target"])).toEqual(["account_users"]);
  });

  test("the app role updates only a notice's tries and due time, and never truncates", async () => {
    const cols = await db.admin`
      SELECT column_name FROM information_schema.column_privileges
      WHERE table_schema = ${db.schema} AND grantee = 'abolish_app' AND privilege_type = 'UPDATE'
        AND table_name = 'account_notices'
      ORDER BY column_name`;
    expect(cols.map((c) => c["column_name"])).toEqual(["not_before", "tries"]);
    const account = await newAccount(app);
    await app`
      INSERT INTO account_notices (user_id, subject, event, reason, not_before)
      VALUES (${account}, 'poll', 'hide', 'spam', now())`;
    expect(await failsWith(app`UPDATE account_notices SET reason = 'illegal'`)).toBe("42501");
    expect(await failsWith(app`UPDATE account_notices SET tries = 6`)).toBe("23514");
    expect(await failsWith(app`TRUNCATE account_notices`)).toBe("42501");
    await clear();
  });

  test("deleting an account deletes its notices", async () => {
    const account = await newAccount(app);
    await app`
      INSERT INTO account_notices (user_id, subject, event, reason, not_before)
      VALUES (${account}, 'profile', 'hide', 'spam', now())`;
    await app`DELETE FROM account_users WHERE id = ${account}`;
    expect(await noticesOf(account)).toEqual([]);
  });
});

describe("queueing", () => {
  test("every decision on an author's poll queues its notice, dated by the decision", async () => {
    const author = await newAccount(app);
    const id = await poll(author);
    await moderate(app, id, { action: "delist", reason: "spam", moderator: "mod-1" });
    await moderate(app, id, { action: "hide", reason: "illegal", moderator: "mod-1" });
    await moderate(app, id, { action: "restore", reason: "error", moderator: "mod-2" });
    expect(await notices(author)).toEqual([
      { subject: "poll", event: "delist", reason: "spam" },
      { subject: "poll", event: "hide", reason: "illegal" },
      { subject: "poll", event: "restore", reason: "error" },
    ]);
    const log = await db.admin`
      SELECT decided_at FROM moderation_actions WHERE election_id = ${id} ORDER BY seq`;
    expect((await noticesOf(author)).map((n) => n["not_before"])).toEqual(
      log.map((r) => r["decided_at"]),
    );
    expect((await noticesOf(author)).every((n) => n["tries"] === 0)).toBe(true);
  });

  test("a poll with no author's account, and a refused decision, queue nothing", async () => {
    await clear();
    const author = await newAccount(app);
    await moderate(app, await poll(), { action: "delist", reason: "spam", moderator: "mod-1" });
    const id = await poll(author);
    await expect(
      moderate(app, id, { action: "restore", reason: "error", moderator: "mod-1" }),
    ).rejects.toMatchObject({ code: "no-change" });
    // The author can't moderate their own poll either.
    const own = await poll(mods.get("mod-1"));
    await expect(
      moderate(app, own, { action: "delist", reason: "spam", moderator: "mod-1" }),
    ).rejects.toMatchObject({ code: "own-poll" });
    expect((await db.admin`SELECT count(*)::int AS n FROM account_notices`)[0]!["n"]).toBe(0);
  });

  test("an appeal turned down tells the author the ground it stands on; one upheld, the restore", async () => {
    const author = await newAccount(app);
    const id = await poll(author);
    const [pollRow] = await app`SELECT id FROM account_polls WHERE election_id = ${id}`;
    const pollId = pollRow!["id"] as string;
    await moderate(app, id, { action: "delist", reason: "impersonation", moderator: "mod-1" });
    await decideAppeal(app, await fileAppeal(app, author, pollId), "rejected", "mod-2");
    // Re-cited under a second ground, then appealed and upheld.
    const { seq } = await moderate(app, id, {
      action: "delist",
      reason: "harassment",
      moderator: "mod-2",
    });
    // Neither moderator who keeps the removal in place may judge its appeal.
    await decideAppeal(app, await fileAppeal(app, author, pollId), "upheld", "mod-3");
    expect(seq).toBeGreaterThan(0n);
    expect(await notices(author)).toEqual([
      { subject: "poll", event: "delist", reason: "impersonation" },
      { subject: "poll", event: "appeal-rejected", reason: "impersonation" },
      { subject: "poll", event: "delist", reason: "harassment" },
      { subject: "poll", event: "restore", reason: "appeal-upheld" },
    ]);
  });

  test("a superseded appeal queues nothing beyond the decision that superseded it", async () => {
    const author = await newAccount(app);
    const id = await poll(author);
    const [pollRow] = await app`SELECT id FROM account_polls WHERE election_id = ${id}`;
    await moderate(app, id, { action: "delist", reason: "spam", moderator: "mod-1" });
    const appeal = await fileAppeal(app, author, pollRow!["id"] as string);
    await moderate(app, id, { action: "restore", reason: "error", moderator: "mod-1" });
    expect((await decideAppeal(app, appeal, "rejected", "mod-2")).outcome).toBe("superseded");
    expect(await notices(author)).toEqual([
      { subject: "poll", event: "delist", reason: "spam" },
      { subject: "poll", event: "restore", reason: "error" },
    ]);
  });

  test("a profile's decisions and its appeals turned down queue notices to its author", async () => {
    const author = await newAccount(app);
    // Only an account with a verified number makes a profile.
    await app`INSERT INTO account_phones VALUES (${author}, ${randomBytes(32)}, 'p1', '2026-10-01T00:00:00Z')`;
    const handle = await makeProfile(app, author, "Sam Example", { now: NOW });
    await moderateProfile(app, handle, { action: "hide", reason: "spam", moderator: "mod-1" });
    await decideProfileAppeal(app, await fileProfileAppeal(app, author), "rejected", "mod-2");
    await moderateProfile(app, handle, {
      action: "hide",
      reason: "impersonation",
      moderator: "mod-2",
    });
    await decideProfileAppeal(app, await fileProfileAppeal(app, author), "upheld", "mod-3");
    expect(await notices(author)).toEqual([
      { subject: "profile", event: "hide", reason: "spam" },
      { subject: "profile", event: "appeal-rejected", reason: "spam" },
      { subject: "profile", event: "hide", reason: "impersonation" },
      { subject: "profile", event: "restore", reason: "appeal-upheld" },
    ]);
  });

  test("a decision that rolls back takes its notice with it", async () => {
    const author = await newAccount(app);
    const id = await poll(author);
    // The notice's insert fails, inside the decision's transaction.
    await db.admin.unsafe(
      `CREATE FUNCTION "${db.schema}".refuse_notice() RETURNS trigger LANGUAGE plpgsql AS
         $$ BEGIN RAISE EXCEPTION 'refused'; END $$;
       CREATE TRIGGER refuse BEFORE INSERT ON "${db.schema}".account_notices
         FOR EACH ROW EXECUTE FUNCTION "${db.schema}".refuse_notice()`,
    );
    try {
      await expect(
        moderate(app, id, { action: "delist", reason: "spam", moderator: "mod-1" }),
      ).rejects.toMatchObject({ cause: { message: "refused" } });
    } finally {
      await db.admin.unsafe(
        `DROP TRIGGER refuse ON "${db.schema}".account_notices;
         DROP FUNCTION "${db.schema}".refuse_notice()`,
      );
    }
    expect(
      (
        await db.admin`SELECT count(*)::int AS n FROM moderation_actions WHERE election_id = ${id}`
      )[0]!["n"],
    ).toBe(0);
    expect(await noticesOf(author)).toEqual([]);
  });
});

describe("sending", () => {
  test("sends each due notice once, to the author's verified address, and deletes it", async () => {
    await clear();
    const author = await newAccount(app);
    const address = await verified(author);
    const id = await poll(author);
    await moderate(app, id, { action: "hide", reason: "personal-data", moderator: "mod-1" });
    const { messages, sender } = recorder();
    expect(await drain(sender)).toEqual({ sent: 1, retrying: 0, dropped: 0 });
    expect(messages).toEqual([
      {
        kind: "notice",
        to: address,
        notice: { subject: "poll", event: "hide", reason: "personal-data" },
      },
    ]);
    expect(await noticesOf(author)).toEqual([]);
    expect(await drain(sender)).toEqual({ sent: 0, retrying: 0, dropped: 0 });
  });

  test("a notice not yet due waits", async () => {
    await clear();
    const author = await newAccount(app);
    await verified(author);
    await app`
      INSERT INTO account_notices (user_id, subject, event, reason, not_before)
      VALUES (${author}, 'poll', 'hide', 'spam', ${NOW.toISOString()})`;
    const { messages, sender } = recorder();
    const early = new Date(NOW.getTime() - SECOND);
    expect(await sendNotices(app, { sender, keys: KEYS, now: early })).toEqual({
      sent: 0,
      retrying: 0,
      dropped: 0,
    });
    expect(messages).toEqual([]);
    expect(await sendNotices(app, { sender, keys: KEYS, now: NOW })).toMatchObject({ sent: 1 });
  });

  test("an account with no verified address has its notices dropped unsent", async () => {
    await clear();
    const author = await newAccount(app);
    await moderate(app, await poll(author), {
      action: "delist",
      reason: "spam",
      moderator: "mod-1",
    });
    const { messages, sender } = recorder();
    expect(await drain(sender)).toEqual({ sent: 0, retrying: 0, dropped: 1 });
    expect(messages).toEqual([]);
    expect(await noticesOf(author)).toEqual([]);
  });

  test("a refused notice waits out each step, and is dropped after its last try", async () => {
    await clear();
    const author = await newAccount(app);
    await verified(author);
    await app`
      INSERT INTO account_notices (user_id, subject, event, reason, not_before)
      VALUES (${author}, 'profile', 'hide', 'threat', ${NOW.toISOString()})`;
    const { messages, sender } = recorder(
      ...Array<"unavailable">(NOTICE_TRIES).fill("unavailable"),
    );
    let now = NOW;
    for (let t = 1; t < NOTICE_TRIES; t++) {
      expect(await sendNotices(app, { sender, keys: KEYS, now })).toEqual({
        sent: 0,
        retrying: 1,
        dropped: 0,
      });
      const next = new Date(now.getTime() + NOTICE_WAIT_SECONDS[t - 1]! * SECOND);
      expect(await noticesOf(author)).toEqual([
        { subject: "profile", event: "hide", reason: "threat", tries: t, not_before: next },
      ]);
      // Not a moment before it is due.
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
    });
    expect(messages).toHaveLength(NOTICE_TRIES);
    expect(await noticesOf(author)).toEqual([]);
  });

  test("a final try that never reported back is dropped once its wait is over", async () => {
    await clear();
    const author = await newAccount(app);
    await app`
      INSERT INTO account_notices (user_id, subject, event, reason, not_before, tries)
      VALUES (${author}, 'poll', 'hide', 'spam', ${NOW.toISOString()}, ${NOTICE_TRIES})`;
    const { messages, sender } = recorder();
    const early = new Date(NOW.getTime() - SECOND);
    expect(await sendNotices(app, { sender, keys: KEYS, now: early })).toMatchObject({
      dropped: 0,
    });
    expect(await sendNotices(app, { sender, keys: KEYS, now: NOW })).toEqual({
      sent: 0,
      retrying: 0,
      dropped: 1,
    });
    expect(messages).toEqual([]);
  });

  test("a box this deployment can't open is retried, never sent elsewhere", async () => {
    await clear();
    const author = await newAccount(app);
    await verified(author);
    await moderate(app, await poll(author), {
      action: "delist",
      reason: "spam",
      moderator: "mod-1",
    });
    const { messages, sender } = recorder();
    const other = emailKeys(ring("h1"), ring("b1"));
    const now = new Date(Date.now() + 60 * SECOND);
    expect(await sendNotices(app, { sender, keys: other, now })).toEqual({
      sent: 0,
      retrying: 1,
      dropped: 0,
    });
    expect(messages).toEqual([]);
  });

  test("two runs side by side never send one notice twice", async () => {
    await clear();
    const accounts = await Promise.all(Array.from({ length: 6 }, () => newAccount(app)));
    for (const a of accounts) {
      await verified(a);
      for (const reason of ["spam", "threat", "illegal"] as const)
        await app`
          INSERT INTO account_notices (user_id, subject, event, reason, not_before)
          VALUES (${a}, 'poll', 'hide', ${reason}, ${NOW.toISOString()})`;
    }
    const sent: EmailMessage[] = [];
    // A slow provider, so the two runs overlap.
    const sender: EmailSender = {
      send: async (m) => {
        await new Promise((r) => setTimeout(r, 5));
        sent.push(m);
        return "sent";
      },
    };
    const runs = await Promise.all(
      [app, app2].map((client) => sendNotices(client, { sender, keys: KEYS, now: NOW, limit: 10 })),
    );
    expect(runs.reduce((n, r) => n + r.sent, 0)).toBe(sent.length);
    expect(await drain(sender, NOW)).toMatchObject({ retrying: 0, dropped: 0 });
    expect(sent).toHaveLength(18);
    const keyed = sent.map((m) => (m.kind === "notice" ? `${m.to}/${m.notice.reason}` : ""));
    expect(new Set(keyed).size).toBe(18);
  });

  test("takes oldest first, at most the limit, and refuses a limit out of range", async () => {
    await clear();
    const author = await newAccount(app);
    await verified(author);
    for (const [i, reason] of (["spam", "threat", "illegal"] as const).entries())
      await app`
        INSERT INTO account_notices (user_id, subject, event, reason, not_before)
        VALUES (${author}, 'poll', 'hide', ${reason}, ${new Date(NOW.getTime() - (3 - i) * SECOND).toISOString()})`;
    const { messages, sender } = recorder();
    expect(await sendNotices(app, { sender, keys: KEYS, now: NOW, limit: 2 })).toMatchObject({
      sent: 2,
    });
    expect(messages.map((m) => (m.kind === "notice" ? m.notice.reason : ""))).toEqual([
      "spam",
      "threat",
    ]);
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
          await app`
            INSERT INTO account_notices (user_id, subject, event, reason, not_before)
            VALUES (${author}, 'poll', 'delist', 'spam', ${NOW.toISOString()})`;
          const { messages, sender } = recorder(
            ...taken.map((ok) => (ok ? ("sent" as const) : ("unavailable" as const))),
          );
          // Far enough ahead of every wait that each run finds it due.
          let total = { sent: 0, dropped: 0 };
          for (let i = 0; i <= NOTICE_TRIES; i++) {
            const now = new Date(NOW.getTime() + i * 86_400 * SECOND);
            const run = await sendNotices(app, { sender, keys: KEYS, now });
            total = { sent: total.sent + run.sent, dropped: total.dropped + run.dropped };
          }
          const first = taken.indexOf(true);
          expect(total).toEqual(first === -1 ? { sent: 0, dropped: 1 } : { sent: 1, dropped: 0 });
          expect(messages).toHaveLength(first === -1 ? NOTICE_TRIES : first + 1);
          expect(await noticesOf(author)).toEqual([]);
        },
      ),
      { numRuns: Math.min(numRuns, 50) },
    );
  });
});

describe("rendering", () => {
  test("every notice renders, in words that name no poll or profile and hold no link", () => {
    const subjects = new Set<string>();
    for (const notice of ALL_NOTICES) {
      const { subject, text } = renderEmail({ kind: "notice", to: "a@example.org", notice });
      subjects.add(`${notice.subject}/${notice.event}/${subject}`);
      expect(subject).not.toMatch(/\n/);
      expect(`${subject}\n${text}`).not.toMatch(/https?:|www\.|@|\/p\/|\/by\//);
      expect(text).toContain("whatever your notification settings");
      // The ground, or the restore's reason, in everyday words, never its code.
      expect(text).not.toMatch(/personal-data|legal-notice|appeal-|notice-withdrawn/);
    }
    // One subject per subject and event, whatever the reason.
    expect(subjects.size).toBe(7);
  });

  test("a removal says which ground, and how to appeal", () => {
    const { text } = renderEmail({
      kind: "notice",
      to: "a@example.org",
      notice: { subject: "poll", event: "hide", reason: "personal-data" },
    });
    expect(text).toContain("a private person's personal data");
    expect(text).toContain("appeal");
  });
});
