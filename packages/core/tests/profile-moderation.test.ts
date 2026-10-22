import { encodeElectionDefinition } from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  accountProfileAppeals,
  addModerator,
  AppealError,
  askedBy,
  decideProfileAppeal,
  deleteProfile,
  fileProfileAppeal,
  makeProfile,
  MAX_MODERATION_PAGE,
  MAX_PROFILE_APPEAL_QUEUE,
  MAX_REPORT_QUEUE,
  moderate,
  moderateProfile,
  ModerationError,
  moderationStatus,
  newAccountId,
  newProfileHandle,
  profileModerationActions,
  type ProfileModerationDecision,
  profileModerationStatus,
  profileReports,
  readModerationLog,
  readProfile,
  readProfileAppealQueue,
  readProfileModeration,
  readProfileModerationLog,
  readProfileReportQueue,
  readPublicModerationLog,
  REMOVAL_REASONS,
  type RemovalReason,
  renameProfile,
  reportProfile,
  RESTORE_REASONS,
  retireModerator,
  reviewProfileReports,
  showOnProfile,
  storeDefinition,
} from "../src/index.ts";
import { type TestDb, testDb, typical } from "./db.ts";

// Moderation of creator profiles (migrations/0034_profile_moderation.sql,
// src/profile-moderation.ts; [[0040-creator-profiles]], Moderation of names;
// P2-27 part 1c): a profile is reported, hidden or restored and appealed as a
// poll is, in the same log, and while hidden shows only the ground and names
// no poll's author (T-68, T-75, T-10).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

let db: TestDb;
let app: Sql;
let owner: Sql;
const mods = new Map<string, string>();
beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
  owner = await db.as("abolish_migrator");
  for (const handle of ["mod-1", "mod-2", "mod-3"]) {
    const account = await newAccount();
    await addModerator(app, handle, account);
    mods.set(handle, account);
  }
});
afterAll(() => db?.close());

const at = { now: new Date("2026-10-22T12:00:00Z") };

/** An account with a stand-in for a verified phone, so it can make a profile. */
async function newAccount(): Promise<string> {
  const id = newAccountId();
  await app`
    INSERT INTO account_users VALUES (${id}, ${`${newAccountId()}@account.invalid`},
      false, '', NULL, now(), now())`;
  await app`INSERT INTO account_phones VALUES (${id}, ${randomBytes(32)}, 'p1', '2026-10-01T00:00:00Z')`;
  return id;
}

/** A fresh account and its profile. */
async function profiled(user?: string) {
  const u = user ?? (await newAccount());
  return { user: u, handle: await makeProfile(app, u, "Riverside Neighbours", at) };
}

/** An open poll of `user`'s, stored and registered, shown on their profile. */
async function shownPoll(user: string) {
  const id = newAccountId();
  const electionId = new Uint8Array(randomBytes(32));
  await app`
    INSERT INTO account_polls (id, user_id, state, draft, created_at, updated_at, submitted_at,
      creator_address, create_tx_hash, election_id, created_block, l1_origin_timestamp,
      anchors_checked_block, electorate, stub_hash, ceremony_tx_hash, register_tx_hash,
      registered_block)
    VALUES (${id}, ${user}, 'open', '{}', now(), now(), now(), ${randomBytes(20)},
      ${randomBytes(32)}, ${electionId}, 1, 1, 1, '[]', ${randomBytes(32)}, ${randomBytes(32)},
      ${randomBytes(32)}, 2)`;
  await storeDefinition(app, encodeElectionDefinition({ ...typical, election_id: electionId }));
  await showOnProfile(app, user, id, true);
  return { id, electionId };
}

const hide = (reason: RemovalReason = "impersonation", moderator = "mod-1") =>
  ({ action: "hide", reason, moderator }) as const;
const restore = (moderator = "mod-1") =>
  ({ action: "restore", reason: "error", moderator }) as const;

const code = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => "ok",
    (e: unknown) => {
      if (e instanceof AppealError || e instanceof ModerationError) return e.code;
      throw e;
    },
  );

async function failsWith(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
  } catch (e) {
    return (e as { code?: string }).code ?? "no code";
  }
  throw new Error("query succeeded");
}

const logRows = async (handle: string) =>
  (
    await app`SELECT count(*)::int AS n FROM profile_moderation_actions WHERE handle = ${handle}`
  )[0]!["n"] as number;

describe("schema", () => {
  test("the Drizzle tables match the migrated ones", async () => {
    for (const table of [
      profileModerationActions,
      profileReports,
      accountProfileAppeals,
    ] as PgTable[]) {
      const config = getTableConfig(table);
      const cols = await db.admin`
        SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = ${db.schema} AND table_name = ${config.name} ORDER BY ordinal_position`;
      expect(cols.map((c) => [c["column_name"], c["data_type"], c["is_nullable"]])).toEqual(
        config.columns.map((c) => [c.name, c.getSQLType(), c.notNull ? "NO" : "YES"]),
      );
    }
  });

  test("the log is append-only, for the app role and the table's owner", async () => {
    const { handle } = await profiled();
    await moderateProfile(app, handle, hide());
    for (const sql of [app, owner]) {
      expect(await failsWith(sql`UPDATE profile_moderation_actions SET reason = 'spam'`)).toBe(
        "42501",
      );
      expect(await failsWith(sql`DELETE FROM profile_moderation_actions`)).toBe("42501");
      expect(await failsWith(sql`TRUNCATE profile_moderation_actions`)).toBe("42501");
    }
    expect(await logRows(handle)).toBe(1);
  });

  test("a profile decision takes the poll log's next number, whatever the insert says", async () => {
    const { handle } = await profiled();
    const [poll] = await app`SELECT max(seq) AS m FROM moderation_actions`;
    const [row] = await app`
      INSERT INTO profile_moderation_actions (seq, handle, action, reason, moderator, decided_at)
      VALUES (1, ${handle}, 'hide', 'spam', 'mod-1', now()) RETURNING seq`;
    expect(BigInt(row!["seq"])).toBeGreaterThan(BigInt(poll!["m"] ?? 0));
    const [next] = await app`
      INSERT INTO moderation_actions (election_id, action, reason, moderator, decided_at)
      VALUES (${randomBytes(32)}, 'delist', 'spam', 'mod-1', now()) RETURNING seq`;
    expect(BigInt(next!["seq"])).toBeGreaterThan(BigInt(row!["seq"]));
  });

  test("the log holds only hides and restores, with a reason of their kind", async () => {
    const { handle } = await profiled();
    for (const [action, reason] of [
      ["delist", "spam"],
      ["hide", "error"],
      ["restore", "spam"],
    ])
      expect(
        await failsWith(app`
          INSERT INTO profile_moderation_actions (seq, handle, action, reason, moderator, decided_at)
          VALUES (0, ${handle}, ${action!}, ${reason!}, 'mod-1', now())`),
      ).toBe("23514");
  });

  test("reports are counted, never deleted, and keep nothing about the reporter", async () => {
    const cols = await db.admin`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${db.schema} AND table_name = 'profile_reports' ORDER BY ordinal_position`;
    expect(cols.map((c) => c["column_name"])).toEqual([
      "handle",
      "reason",
      "total",
      "pending",
      "pending_since",
    ]);
    const privs = await db.admin`
      SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS p
      FROM information_schema.table_privileges
      WHERE table_schema = ${db.schema} AND grantee = 'abolish_app'
        AND table_name IN ('profile_moderation_actions', 'profile_reports', 'account_profile_appeals')
      GROUP BY table_name ORDER BY table_name`;
    expect(privs.map((r) => [r["table_name"], r["p"]])).toEqual([
      ["account_profile_appeals", "INSERT,SELECT"],
      ["profile_moderation_actions", "INSERT,SELECT"],
      ["profile_reports", "INSERT,SELECT,UPDATE"],
    ]);
    const cols2 = await db.admin`
      SELECT column_name FROM information_schema.column_privileges
      WHERE table_schema = ${db.schema} AND grantee = 'abolish_app' AND privilege_type = 'UPDATE'
        AND table_name = 'account_profile_appeals' ORDER BY column_name`;
    expect(cols2.map((c) => c["column_name"])).toEqual(["outcome", "reviewed_at", "reviewer"]);
  });

  test("a reviewed appeal never changes, even by the table's owner", async () => {
    const { user, handle } = await profiled();
    const { seq } = await moderateProfile(app, handle, hide());
    await fileProfileAppeal(app, user);
    await decideProfileAppeal(app, seq, "rejected", "mod-2");
    await expect(
      owner`UPDATE account_profile_appeals SET outcome = 'upheld' WHERE decision_seq = ${seq.toString()}`,
    ).rejects.toThrow(/reviewed once/);
    await expect(
      app`UPDATE account_profile_appeals SET filed_at = now() WHERE decision_seq = ${seq.toString()}`,
    ).rejects.toThrow(/permission denied/);
  });
});

describe("decisions", () => {
  test("a hide withholds the name and polls, and every 'Asked by'; a restore brings them back", async () => {
    const { user, handle } = await profiled();
    const poll = await shownPoll(user);
    const hidden = await moderateProfile(app, handle, hide("impersonation"));
    expect(hidden.state).toBe("hidden");
    expect(await readProfile(app, handle)).toEqual({
      handle,
      state: "hidden",
      reason: "impersonation",
    });
    expect(await askedBy(app, poll.electionId)).toBeUndefined();
    // A hide leaves the author's polls as they were: they're moderated as polls.
    expect((await moderationStatus(app, poll.electionId)).state).toBe("visible");
    // No rename while it stands, so an upheld appeal or a restore shows the
    // name a moderator judged.
    const tomorrow = { now: new Date("2026-10-23T12:00:00Z") };
    await expect(renameProfile(app, user, "Someone else", tomorrow)).rejects.toMatchObject({
      code: "hidden",
    });
    expect((await readProfile(app, handle))?.state).toBe("hidden");
    const restored = await moderateProfile(app, handle, restore());
    await renameProfile(app, user, "Someone else", tomorrow);
    expect(restored).toEqual({ seq: restored.seq, state: "visible" });
    expect(restored.seq).toBeGreaterThan(hidden.seq);
    expect(await readProfile(app, handle)).toEqual({
      handle,
      state: "visible",
      name: "Someone else",
      polls: [poll.electionId],
    });
    expect(await askedBy(app, poll.electionId)).toEqual({ handle, name: "Someone else" });
    const status = await profileModerationStatus(app, handle);
    expect(status.state).toBe("visible");
    expect(status.latest).toMatchObject({ seq: restored.seq, action: "restore", reason: "error" });
    expect(status.latest!.decidedAt).toBeInstanceOf(Date);
  });

  test("refuses, writing nothing: malformed decisions and an upheld appeal outside a review", async () => {
    const { handle } = await profiled();
    for (const d of [
      { action: "delist", reason: "spam", moderator: "mod-1" },
      { action: "hide", reason: "error", moderator: "mod-1" },
      { action: "restore", reason: "spam", moderator: "mod-1" },
      { action: "hide", reason: "spam", moderator: "Mod 1" },
      { action: "hide", reason: "spam" },
      null,
    ])
      expect(await code(moderateProfile(app, handle, d as ProfileModerationDecision))).toBe(
        "invalid",
      );
    await moderateProfile(app, handle, hide());
    expect(
      await code(
        moderateProfile(app, handle, {
          action: "restore",
          reason: "appeal-upheld",
          moderator: "mod-1",
        }),
      ),
    ).toBe("appeal-only");
    expect(await logRows(handle)).toBe(1);
    await expect(moderateProfile(app, "not-a-handle", hide())).rejects.toThrow(TypeError);
  });

  test("refuses a handle no profile has, a moderator who isn't one, and the moderator's own profile", async () => {
    expect(await code(moderateProfile(app, newProfileHandle(), hide()))).toBe("unknown-profile");
    const { user, handle } = await profiled();
    await deleteProfile(app, user);
    expect(await code(moderateProfile(app, handle, hide()))).toBe("unknown-profile");
    const other = await profiled();
    expect(await code(moderateProfile(app, other.handle, hide("spam", "nobody")))).toBe(
      "unknown-moderator",
    );
    const retiring = await newAccount();
    await addModerator(app, "retired-p", retiring);
    await retireModerator(app, "retired-p");
    expect(await code(moderateProfile(app, other.handle, hide("spam", "retired-p")))).toBe(
      "unknown-moderator",
    );
    const own = await profiled(mods.get("mod-3"));
    expect(await code(moderateProfile(app, own.handle, hide("spam", "mod-3")))).toBe("own-profile");
    expect(await code(moderateProfile(app, own.handle, hide("spam", "mod-1")))).toBe("ok");
    expect(await logRows(other.handle)).toBe(0);
  });

  test("a decision changes the state or cites a new ground (fast-check model)", async () => {
    const decision = fc.oneof(
      fc.constantFrom(...REMOVAL_REASONS).map((reason) => hide(reason)),
      fc
        .constantFrom(...RESTORE_REASONS.filter((r) => r !== "appeal-upheld"))
        .map((reason) => ({ action: "restore", reason, moderator: "mod-1" }) as const),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(decision, { maxLength: 12 }), async (decisions) => {
        const { handle } = await profiled();
        let state: "visible" | "hidden" = "visible";
        let cited = new Set<string>();
        let written = 0;
        for (const d of decisions) {
          const after = d.action === "hide" ? "hidden" : "visible";
          const noChange = after === state && (d.action === "restore" || cited.has(d.reason));
          const got = await code(moderateProfile(app, handle, d));
          expect(got).toBe(noChange ? "no-change" : "ok");
          if (noChange) continue;
          written++;
          if (after !== state) cited = new Set();
          cited.add(d.reason);
          state = after;
        }
        expect((await profileModerationStatus(app, handle)).state).toBe(state);
        expect((await readProfile(app, handle))?.state).toBe(state);
        expect(await logRows(handle)).toBe(written);
      }),
      { numRuns: Math.min(numRuns, 50) },
    );
  });

  test("decisions about polls and profiles share one numbering, in commit order", async () => {
    const a = await profiled();
    const b = await profiled();
    const poll = await shownPoll(a.user);
    const seqs = await Promise.all([
      moderateProfile(app, a.handle, hide()),
      moderate(app, poll.electionId, { action: "delist", reason: "spam", moderator: "mod-2" }),
      moderateProfile(app, b.handle, hide("spam")),
    ]);
    expect(new Set(seqs.map((s) => s.seq)).size).toBe(3);
    const after = seqs.reduce((m, s) => (s.seq < m ? s.seq : m), seqs[0]!.seq) - 1n;
    const merged = [
      ...(await readModerationLog(app, after, MAX_MODERATION_PAGE)).map((e) => e.seq),
      ...(await readProfileModerationLog(app, after, MAX_MODERATION_PAGE)).map((e) => e.seq),
    ].sort((x, y) => (x < y ? -1 : 1));
    expect(merged).toEqual(seqs.map((s) => s.seq).sort((x, y) => (x < y ? -1 : 1)));
  });
});

describe("the public log", () => {
  test("pages profile decisions oldest first, with no moderator", async () => {
    const { handle } = await profiled();
    const first = await moderateProfile(app, handle, hide("spam"));
    const second = await moderateProfile(app, handle, hide("harassment", "mod-2"));
    const page = await readProfileModerationLog(app, first.seq - 1n, 2);
    expect(page.map((e) => e.seq)).toEqual([first.seq, second.seq]);
    expect(page[0]).toEqual({
      seq: first.seq,
      handle,
      action: "hide",
      reason: "spam",
      decidedAt: page[0]!.decidedAt,
    });
    expect(Object.keys(page[1]!)).not.toContain("moderator");
    expect(await readProfileModerationLog(app, second.seq, 10)).toEqual([]);
    expect(await readProfileModerationLog(app, (1n << 63n) - 1n, 10)).toEqual([]);
    await expect(readProfileModerationLog(app, -1n, 10)).rejects.toThrow(TypeError);
    await expect(readProfileModerationLog(app, 0n, 0)).rejects.toThrow(TypeError);
    await expect(readProfileModerationLog(app, 0n, MAX_MODERATION_PAGE + 1)).rejects.toThrow(
      TypeError,
    );
    // The polls' log never carries a profile's decision.
    expect(
      (await readModerationLog(app, first.seq - 1n, 10)).some((e) => e.seq === first.seq),
    ).toBe(false);
  });

  test("the whole log merges both targets by number, and pages through them", async () => {
    const { user, handle } = await profiled();
    const poll = await shownPoll(user);
    const a = await moderate(app, poll.electionId, {
      action: "delist",
      reason: "spam",
      moderator: "mod-2",
    });
    const b = await moderateProfile(app, handle, hide("spam"));
    const c = await moderateProfile(app, handle, restore());
    const d = await moderate(app, poll.electionId, {
      action: "restore",
      reason: "error",
      moderator: "mod-2",
    });
    const all = await readPublicModerationLog(app, a.seq - 1n, MAX_MODERATION_PAGE);
    expect(all.map((e) => e.seq)).toEqual([a.seq, b.seq, c.seq, d.seq]);
    expect(all[0]).toEqual({
      target: "poll",
      seq: a.seq,
      electionId: poll.electionId,
      action: "delist",
      reason: "spam",
      decidedAt: all[0]!.decidedAt,
    });
    expect(all[1]).toEqual({
      target: "profile",
      seq: b.seq,
      handle,
      action: "hide",
      reason: "spam",
      decidedAt: all[1]!.decidedAt,
    });
    for (const e of all) expect(Object.keys(e)).not.toContain("moderator");
    // A page holds `limit` entries of both kinds, never more, whichever half
    // has more after the cursor.
    expect((await readPublicModerationLog(app, a.seq - 1n, 3)).map((e) => e.seq)).toEqual([
      a.seq,
      b.seq,
      c.seq,
    ]);
    expect((await readPublicModerationLog(app, b.seq, 1)).map((e) => e.seq)).toEqual([c.seq]);
    expect(await readPublicModerationLog(app, d.seq, 10)).toEqual([]);
    expect(await readPublicModerationLog(app, (1n << 63n) - 1n, 10)).toEqual([]);
    await expect(readPublicModerationLog(app, -1n, 10)).rejects.toThrow(TypeError);
    await expect(readPublicModerationLog(app, 0n, 0)).rejects.toThrow(TypeError);
    await expect(readPublicModerationLog(app, 0n, MAX_MODERATION_PAGE + 1)).rejects.toThrow(
      TypeError,
    );
  });

  test("paging the whole log at any page size returns every decision once, in order (fast-check)", async () => {
    const { user, handle } = await profiled();
    const poll = await shownPoll(user);
    const start = (await readPublicModerationLog(app, 0n, MAX_MODERATION_PAGE)).at(-1)?.seq ?? 0n;
    // Alternating decisions on each target, interleaved at random below.
    const pollSteps = [
      { action: "delist", reason: "spam" },
      { action: "restore", reason: "error" },
    ] as const;
    const profileSteps = [hide(), restore()] as const;
    const written: bigint[] = [];
    let onPoll = 0;
    let onProfile = 0;
    for (const toPoll of [true, false, false, true, true, false, true, false]) {
      const { seq } = toPoll
        ? await moderate(app, poll.electionId, { ...pollSteps[onPoll++ % 2]!, moderator: "mod-2" })
        : await moderateProfile(app, handle, profileSteps[onProfile++ % 2]!);
      written.push(seq);
    }
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 9 }), async (limit) => {
        const seen: bigint[] = [];
        let after = start;
        for (;;) {
          const page = await readPublicModerationLog(app, after, limit);
          expect(page.length).toBeLessThanOrEqual(limit);
          seen.push(...page.map((e) => e.seq));
          if (page.length < limit) break;
          after = page.at(-1)!.seq;
        }
        expect(seen).toEqual(written);
      }),
      { numRuns: Math.min(numRuns, 20) },
    );
  });
});

describe("reports", () => {
  test("counts reports of a profile by ground, and refuses an unknown one", async () => {
    const { user, handle } = await profiled();
    await reportProfile(app, handle, "impersonation");
    await reportProfile(app, handle, "impersonation");
    await reportProfile(app, handle, "spam");
    const [row] = await app`
      SELECT total, pending FROM profile_reports WHERE handle = ${handle} AND reason = 'impersonation'`;
    expect([row!["total"], row!["pending"]]).toEqual(["2", "2"]);
    expect(await code(reportProfile(app, handle, "error" as RemovalReason))).toBe("invalid");
    expect(await code(reportProfile(app, newProfileHandle(), "spam"))).toBe("unknown-profile");
    await deleteProfile(app, user);
    expect(await code(reportProfile(app, handle, "spam"))).toBe("unknown-profile");
    await expect(reportProfile(app, "x", "spam")).rejects.toThrow(TypeError);
  });

  test("the queue pages the longest waiting first; reviewing clears only what was seen", async () => {
    const reported: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { handle } = await profiled();
      await reportProfile(app, handle, "harassment");
      reported.push(handle);
    }
    const all = [];
    let after: Parameters<typeof readProfileReportQueue>[2];
    for (;;) {
      const page = await readProfileReportQueue(app, 1, after);
      if (page.length === 0) break;
      all.push(...page);
      after = page[0]!;
    }
    const ours = all.filter((r) => reported.includes(r.handle));
    expect(ours.map((r) => r.handle).sort()).toEqual([...reported].sort());
    const target = ours[0]!;
    expect(target).toMatchObject({ reason: "harassment", pending: 1n, total: 1n });
    await reportProfile(app, target.handle, "harassment");
    expect(await reviewProfileReports(app, target.handle, "harassment", target.total)).toBe(1n);
    expect(await reviewProfileReports(app, target.handle, "harassment", 2n)).toBe(0n);
    const left = await readProfileReportQueue(app, MAX_REPORT_QUEUE);
    expect(left.some((r) => r.handle === target.handle)).toBe(false);
    expect(await code(reviewProfileReports(app, target.handle, "harassment", 3n))).toBe("invalid");
    expect(await code(reviewProfileReports(app, target.handle, "spam", 1n))).toBe("invalid");
    await expect(readProfileReportQueue(app, 0)).rejects.toThrow(TypeError);
  });
});

describe("appeals", () => {
  test("the author appeals a hide once; a reviewer other than the decider upholds it", async () => {
    const { user, handle } = await profiled();
    expect(await code(fileProfileAppeal(app, user))).toBe("not-appealable");
    const { seq } = await moderateProfile(app, handle, hide());
    expect(await readProfileModeration(app, user)).toMatchObject({
      handle,
      state: "hidden",
      appeals: [],
      appealable: true,
    });
    expect(await fileProfileAppeal(app, user)).toBe(seq);
    expect(await code(fileProfileAppeal(app, user))).toBe("already-appealed");
    const queued = (await readProfileAppealQueue(app, MAX_PROFILE_APPEAL_QUEUE)).find(
      (a) => a.decisionSeq === seq,
    );
    // The queue names the profile and the decision, never the author's account.
    expect(queued).toEqual({
      decisionSeq: seq,
      handle,
      reason: "impersonation",
      decidedAt: queued!.decidedAt,
      filedAt: queued!.filedAt,
    });
    expect(await code(decideProfileAppeal(app, seq, "upheld", "mod-1"))).toBe("same-moderator");
    const review = await decideProfileAppeal(app, seq, "upheld", "mod-2");
    expect(review).toMatchObject({ outcome: "upheld", state: "visible" });
    const [entry] = await readProfileModerationLog(app, review.restoreSeq! - 1n, 1);
    expect(entry).toMatchObject({ handle, action: "restore", reason: "appeal-upheld" });
    expect(await code(decideProfileAppeal(app, seq, "rejected", "mod-3"))).toBe("reviewed");
    const mine = await readProfileModeration(app, user);
    expect(mine).toMatchObject({ state: "visible", appealable: false });
    expect(mine!.appeals).toEqual([
      expect.objectContaining({ decisionSeq: seq, outcome: "upheld" }),
    ]);
    expect(Object.keys(mine!.appeals[0]!)).not.toContain("reviewer");
  });

  test("a rejected appeal leaves the log; a restore before review supersedes it", async () => {
    const { user, handle } = await profiled();
    const first = await moderateProfile(app, handle, hide("spam"));
    await fileProfileAppeal(app, user);
    const rows = await logRows(handle);
    expect(await decideProfileAppeal(app, first.seq, "rejected", "mod-2")).toEqual({
      outcome: "rejected",
      state: "hidden",
    });
    expect(await logRows(handle)).toBe(rows);
    // A re-cited hide is a new decision, appealable on its own.
    const second = await moderateProfile(app, handle, hide("harassment", "mod-3"));
    expect(await fileProfileAppeal(app, user)).toBe(second.seq);
    // Whoever re-cited the hide doesn't review the appeal against it.
    expect(await code(decideProfileAppeal(app, second.seq, "upheld", "mod-3"))).toBe(
      "same-moderator",
    );
    await moderateProfile(app, handle, restore("mod-3"));
    expect(await decideProfileAppeal(app, second.seq, "upheld", "mod-2")).toEqual({
      outcome: "superseded",
      state: "visible",
    });
    expect(await code(fileProfileAppeal(app, user))).toBe("not-appealable");
  });

  test("refuses the reviewer's own profile, an unknown appeal and malformed input", async () => {
    const { handle } = await profiled(mods.get("mod-2"));
    const { seq } = await moderateProfile(app, handle, hide("spam", "mod-1"));
    await fileProfileAppeal(app, mods.get("mod-2")!);
    expect(await code(decideProfileAppeal(app, seq, "upheld", "mod-2"))).toBe("own-profile");
    expect(await code(decideProfileAppeal(app, seq, "upheld", "nobody"))).toBe("unknown-moderator");
    expect(await code(decideProfileAppeal(app, (1n << 62n) + 7n, "upheld", "mod-3"))).toBe(
      "not-found",
    );
    for (const [s, d, m] of [
      [0n, "upheld", "mod-3"],
      [seq, "maybe", "mod-3"],
      [seq, "upheld", "Mod 3"],
    ] as const)
      expect(await code(decideProfileAppeal(app, s, d as "upheld", m))).toBe("invalid");
    expect(await code(fileProfileAppeal(app, "nope"))).toBe("invalid");
    expect(await code(fileProfileAppeal(app, newAccountId()))).toBe("not-found");
    expect(await readProfileModeration(app, newAccountId())).toBeUndefined();
    expect(await code(readProfileAppealQueue(app, 0))).toBe("invalid");
  });

  test("a poll's appeal and a profile's never stand for each other", async () => {
    const { user, handle } = await profiled();
    const poll = await shownPoll(user);
    const pollDecision = await moderate(app, poll.electionId, {
      action: "delist",
      reason: "spam",
      moderator: "mod-1",
    });
    // No profile appeal names a poll decision's number.
    expect(await code(decideProfileAppeal(app, pollDecision.seq, "upheld", "mod-2"))).toBe(
      "not-found",
    );
    const { seq } = await moderateProfile(app, handle, hide());
    await fileProfileAppeal(app, user);
    // Nor does a poll appeal name a profile decision's.
    expect(
      (await app`SELECT 1 FROM account_appeals WHERE decision_seq = ${seq.toString()}`).length,
    ).toBe(0);
  });

  test("deleting the profile, or its account, deletes its appeals", async () => {
    const { user, handle } = await profiled();
    const { seq } = await moderateProfile(app, handle, hide());
    await fileProfileAppeal(app, user);
    await deleteProfile(app, user);
    const left =
      await app`SELECT 1 FROM account_profile_appeals WHERE decision_seq = ${seq.toString()}`;
    expect(left.length).toBe(0);
    // The log keeps the decision: it is public and append-only.
    expect(await logRows(handle)).toBe(1);
    const again = await profiled();
    await moderateProfile(app, again.handle, hide());
    await fileProfileAppeal(app, again.user);
    await app`DELETE FROM account_users WHERE id = ${again.user}`;
    expect(
      (await app`SELECT 1 FROM account_profile_appeals WHERE handle = ${again.handle}`).length,
    ).toBe(0);
  });
});
