import { decodeElectionDefinition, encodeElectionDefinition } from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  accountAppeals,
  accountModerators,
  addModerator,
  AppealError,
  decideAppeal,
  fileAppeal,
  listPollAppeals,
  MAX_APPEAL_QUEUE,
  moderate,
  ModerationError,
  moderationStatus,
  newAccountId,
  readAppealQueue,
  readModerationLog,
  retireModerator,
  storeDefinition,
} from "../src/index.ts";
import { addModerators, newAccount, type TestDb, testDb } from "./db.ts";

// Moderators' accounts and creators' appeals (migrations/0014, src/appeals.ts;
// docs/moderation-policy.md, Appeals and Moderators; T-68, T-10): a creator
// appeals each removal of their poll once, a different moderator who didn't
// create the poll reviews it, and only an upheld appeal writes the log.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const typical = decodeElectionDefinition(
  Buffer.from(
    JSON.parse(
      readFileSync(
        new URL("../../../docs/spec/vectors/election-definition.json", import.meta.url),
        "utf8",
      ),
    ).vectors.find((v: { id: string }) => v.id === "definition-typical").encoding,
    "hex",
  ),
);

let db: TestDb;
let app: Sql;
let owner: Sql;
let mods: Map<string, string>;
beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
  owner = await db.as("abolish_migrator");
  mods = await addModerators(app, "mod-1", "mod-2", "mod-3");
});
afterAll(() => db?.close());

/**
 * A stored, closed poll whose creator record names `author` (a fresh
 * account by default), as the worker leaves it once the poll is set up.
 */
async function poll(author?: string) {
  const user = author ?? (await newAccount(app));
  const electionId = new Uint8Array(randomBytes(32));
  await storeDefinition(app, encodeElectionDefinition({ ...typical, election_id: electionId }));
  const id = newAccountId();
  await app`
    INSERT INTO account_polls (id, user_id, state, draft, created_at, updated_at, submitted_at,
      creator_address, create_tx_hash, election_id, created_block)
    VALUES (${id}, ${user}, 'open', '{}', now(), now(), now(), ${randomBytes(20)},
      ${randomBytes(32)}, ${electionId}, 1)`;
  return { id, user, electionId };
}

const code = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => "ok",
    (e: unknown) => {
      if (e instanceof AppealError || e instanceof ModerationError) return e.code;
      throw e;
    },
  );

const appealRows = async (pollId: string) =>
  (await app`SELECT count(*)::int AS n FROM account_appeals WHERE poll_id = ${pollId}`)[0]![
    "n"
  ] as number;

describe("schema", () => {
  test("the Drizzle tables match the migrated ones", async () => {
    for (const table of [accountModerators, accountAppeals] as PgTable[]) {
      const config = getTableConfig(table);
      const cols = await db.admin`
        SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = ${db.schema} AND table_name = ${config.name} ORDER BY ordinal_position`;
      expect(cols.map((c) => [c["column_name"], c["data_type"], c["is_nullable"]])).toEqual(
        config.columns.map((c) => [c.name, c.getSQLType(), c.notNull ? "NO" : "YES"]),
      );
    }
  });

  test("the app role updates only the columns a retirement and a review write", async () => {
    const cols = await db.admin`
      SELECT table_name, column_name FROM information_schema.column_privileges
      WHERE table_schema = ${db.schema} AND grantee = 'abolish_app' AND privilege_type = 'UPDATE'
        AND table_name IN ('account_moderators', 'account_appeals')
      ORDER BY table_name, column_name`;
    expect(cols.map((c) => `${c["table_name"]}.${c["column_name"]}`)).toEqual([
      "account_appeals.outcome",
      "account_appeals.reviewed_at",
      "account_appeals.reviewer",
      "account_moderators.user_id",
    ]);
    for (const [table, column, value] of [
      ["account_moderators", "handle", "x"],
      ["account_appeals", "poll_id", "x"],
      ["account_appeals", "decision_seq", 9],
    ] as const)
      await expect(app.unsafe(`UPDATE ${table} SET ${column} = $1`, [value])).rejects.toThrow(
        /permission denied/,
      );
    await expect(app`DELETE FROM account_moderators`).rejects.toThrow(/permission denied/);
    await expect(app`DELETE FROM account_appeals`).rejects.toThrow(/permission denied/);
  });

  test("a handle is never rebound, even by the table's owner", async () => {
    const a = await newAccount(app);
    const b = await newAccount(app);
    await addModerator(app, "rebind", a);
    await expect(
      owner`UPDATE account_moderators SET user_id = ${b} WHERE handle = 'rebind'`,
    ).rejects.toThrow(/can only be retired/);
    await expect(
      owner`UPDATE account_moderators SET added_at = now() WHERE handle = 'rebind'`,
    ).rejects.toThrow(/can only be retired/);
    // Deleting the account retires the handle (ON DELETE SET NULL passes the trigger).
    await app`DELETE FROM account_users WHERE id = ${a}`;
    const [row] = await app`SELECT user_id FROM account_moderators WHERE handle = 'rebind'`;
    expect(row!["user_id"]).toBeNull();
    expect(await code(addModerator(app, "rebind", b))).toBe("handle-taken");
    await expect(
      owner`UPDATE account_moderators SET user_id = ${b} WHERE handle = 'rebind'`,
    ).rejects.toThrow(/can only be retired/);
  });

  test("a reviewed appeal never changes, even by the table's owner", async () => {
    const p = await poll();
    await moderate(app, p.electionId, { action: "hide", reason: "threat", moderator: "mod-1" });
    const seq = await fileAppeal(app, p.user, p.id);
    await decideAppeal(app, seq, "rejected", "mod-2");
    await expect(
      owner`UPDATE account_appeals SET outcome = 'upheld' WHERE decision_seq = ${String(seq)}`,
    ).rejects.toThrow(/reviewed once/);
    await expect(
      owner`UPDATE account_appeals SET outcome = NULL, reviewer = NULL, reviewed_at = NULL
        WHERE decision_seq = ${String(seq)}`,
    ).rejects.toThrow(/reviewed once/);
  });

  test("the checks", async () => {
    const p = await poll();
    const bad = [
      app`INSERT INTO account_moderators VALUES ('Jane Doe', NULL, now())`,
      app`INSERT INTO account_moderators VALUES ('mod-', NULL, now())`,
      app`INSERT INTO account_appeals (decision_seq, poll_id, filed_at) VALUES (0, ${p.id}, now())`,
      app`INSERT INTO account_appeals (decision_seq, poll_id, filed_at, outcome)
        VALUES (99, ${p.id}, now(), 'upheld')`,
      app`INSERT INTO account_appeals VALUES (99, ${p.id}, now(), 'maybe', 'mod-2', now())`,
      app`INSERT INTO account_appeals VALUES (99, ${p.id}, now(), 'upheld', 'Mod 2', now())`,
    ];
    for (const q of bad) await expect(q).rejects.toThrow(/check constraint/);
  });
});

describe("moderators", () => {
  test("adding a moderator", async () => {
    const a = await newAccount(app);
    expect(await code(addModerator(app, "mod-1", a))).toBe("handle-taken");
    expect(await code(addModerator(app, "fresh", mods.get("mod-1")!))).toBe("already-moderator");
    expect(await code(addModerator(app, "fresh", newAccountId()))).toBe("unknown-account");
    for (const [h, acct] of [
      ["Jane", a],
      ["", a],
      ["a".repeat(33), a],
      ["ok", "short"],
      ["ok", 7],
    ] as const)
      expect(await code(addModerator(app, h, acct as string))).toBe("invalid");
    await addModerator(app, "fresh", a);
    const [row] = await app`SELECT user_id FROM account_moderators WHERE handle = 'fresh'`;
    expect(row!["user_id"]).toBe(a);
  });

  test("a retired handle decides nothing more", async () => {
    await addModerators(app, "short-lived");
    const p = await poll();
    await moderate(app, p.electionId, {
      action: "delist",
      reason: "spam",
      moderator: "short-lived",
    });
    await retireModerator(app, "short-lived");
    expect(await code(retireModerator(app, "short-lived"))).toBe("unknown-moderator");
    expect(await code(retireModerator(app, "never-was"))).toBe("unknown-moderator");
    expect(
      await code(
        moderate(app, p.electionId, { action: "hide", reason: "threat", moderator: "short-lived" }),
      ),
    ).toBe("unknown-moderator");
    expect(
      await code(
        moderate(app, p.electionId, { action: "hide", reason: "threat", moderator: "nobody" }),
      ),
    ).toBe("unknown-moderator");
    expect((await moderationStatus(app, p.electionId)).state).toBe("delisted");
  });

  test("a moderator doesn't decide on a poll their account created", async () => {
    const p = await poll(mods.get("mod-1"));
    for (const decision of [
      { action: "hide", reason: "threat", moderator: "mod-1" },
      { action: "delist", reason: "spam", moderator: "mod-1" },
    ] as const)
      expect(await code(moderate(app, p.electionId, decision))).toBe("own-poll");
    await moderate(app, p.electionId, { action: "delist", reason: "spam", moderator: "mod-2" });
    expect(
      await code(
        moderate(app, p.electionId, { action: "restore", reason: "error", moderator: "mod-1" }),
      ),
    ).toBe("own-poll");
    const log =
      await app`SELECT action, moderator FROM moderation_actions WHERE election_id = ${p.electionId}`;
    expect(log.map((r) => [r["action"], r["moderator"]])).toEqual([["delist", "mod-2"]]);
  });

  test("only an appeal's review cites appeal-upheld", async () => {
    const p = await poll();
    await moderate(app, p.electionId, { action: "delist", reason: "spam", moderator: "mod-1" });
    expect(
      await code(
        moderate(app, p.electionId, {
          action: "restore",
          reason: "appeal-upheld",
          moderator: "mod-2",
        }),
      ),
    ).toBe("appeal-only");
    expect((await moderationStatus(app, p.electionId)).state).toBe("delisted");
  });
});

describe("appeals", () => {
  test("upheld: a restore citing appeal-upheld, by the reviewer", async () => {
    const p = await poll();
    const { seq } = await moderate(app, p.electionId, {
      action: "hide",
      reason: "personal-data",
      moderator: "mod-1",
    });
    expect(await fileAppeal(app, p.user, p.id)).toBe(seq);
    const queue = await readAppealQueue(app, MAX_APPEAL_QUEUE);
    const open = queue.find((a) => a.decisionSeq === seq)!;
    expect(open).toMatchObject({
      electionId: p.electionId,
      action: "hide",
      reason: "personal-data",
    });
    // The queue names the poll and the decision, never the creator.
    expect(Object.keys(open).sort()).toEqual(
      ["action", "decidedAt", "decisionSeq", "electionId", "filedAt", "reason"].sort(),
    );
    const review = await decideAppeal(app, seq, "upheld", "mod-2");
    expect(review).toMatchObject({ outcome: "upheld", state: "visible" });
    expect(await moderationStatus(app, p.electionId)).toMatchObject({
      state: "visible",
      latest: { seq: review.restoreSeq, action: "restore", reason: "appeal-upheld" },
    });
    const [row] =
      await app`SELECT moderator FROM moderation_actions WHERE seq = ${String(review.restoreSeq)}`;
    expect(row!["moderator"]).toBe("mod-2");
    expect(await listPollAppeals(app, p.user, p.id)).toEqual([
      {
        decisionSeq: seq,
        filedAt: expect.any(Date),
        outcome: "upheld",
        reviewedAt: expect.any(Date),
      },
    ]);
    expect((await readAppealQueue(app, MAX_APPEAL_QUEUE)).map((a) => a.decisionSeq)).not.toContain(
      seq,
    );
    expect(await code(decideAppeal(app, seq, "rejected", "mod-3"))).toBe("reviewed");
  });

  test("rejected: the poll and the log stay as they are", async () => {
    const p = await poll();
    const { seq } = await moderate(app, p.electionId, {
      action: "delist",
      reason: "spam",
      moderator: "mod-1",
    });
    await fileAppeal(app, p.user, p.id);
    const before = await readModerationLog(app, 0n, MAX_APPEAL_QUEUE);
    expect(await decideAppeal(app, seq, "rejected", "mod-2")).toEqual({
      outcome: "rejected",
      state: "delisted",
    });
    expect(await readModerationLog(app, 0n, MAX_APPEAL_QUEUE)).toEqual(before);
    expect(await code(fileAppeal(app, p.user, p.id))).toBe("already-appealed");
    // A new removal can be appealed in its turn.
    const next = await moderate(app, p.electionId, {
      action: "hide",
      reason: "threat",
      moderator: "mod-1",
    });
    expect(await fileAppeal(app, p.user, p.id)).toBe(next.seq);
  });

  test("superseded: a later decision closes the appeal, whatever the reviewer chose", async () => {
    const p = await poll();
    const { seq } = await moderate(app, p.electionId, {
      action: "delist",
      reason: "spam",
      moderator: "mod-1",
    });
    await fileAppeal(app, p.user, p.id);
    await moderate(app, p.electionId, { action: "hide", reason: "threat", moderator: "mod-1" });
    const before = await readModerationLog(app, 0n, MAX_APPEAL_QUEUE);
    expect(await decideAppeal(app, seq, "upheld", "mod-2")).toEqual({
      outcome: "superseded",
      state: "hidden",
    });
    expect(await readModerationLog(app, 0n, MAX_APPEAL_QUEUE)).toEqual(before);
    expect((await listPollAppeals(app, p.user, p.id))[0]!.outcome).toBe("superseded");
  });

  test("who may review", async () => {
    const p = await poll(mods.get("mod-3"));
    const { seq } = await moderate(app, p.electionId, {
      action: "hide",
      reason: "illegal",
      moderator: "mod-1",
    });
    await fileAppeal(app, p.user, p.id);
    expect(await code(decideAppeal(app, seq, "upheld", "mod-1"))).toBe("same-moderator");
    expect(await code(decideAppeal(app, seq, "upheld", "mod-3"))).toBe("own-poll");
    expect(await code(decideAppeal(app, seq, "upheld", "nobody"))).toBe("unknown-moderator");
    expect(await code(decideAppeal(app, seq + 1000n, "upheld", "mod-2"))).toBe("not-found");
    for (const [s, d, m] of [
      [0n, "upheld", "mod-2"],
      [1n << 63n, "upheld", "mod-2"],
      [1, "upheld", "mod-2"],
      [seq, "restore", "mod-2"],
      [seq, "upheld", "Mod 2"],
    ] as const)
      expect(await code(decideAppeal(app, s as bigint, d as "upheld", m))).toBe("invalid");
    // Nothing was written by any refusal.
    expect((await listPollAppeals(app, p.user, p.id))[0]!.outcome).toBeUndefined();
    expect((await moderationStatus(app, p.electionId)).state).toBe("hidden");
    expect((await decideAppeal(app, seq, "upheld", "mod-2")).outcome).toBe("upheld");
  });

  test("what can be appealed, and by whom", async () => {
    const p = await poll();
    const other = await newAccount(app);
    expect(await code(fileAppeal(app, p.user, p.id))).toBe("not-appealable");
    await moderate(app, p.electionId, { action: "delist", reason: "spam", moderator: "mod-1" });
    expect(await code(fileAppeal(app, other, p.id))).toBe("not-found");
    expect(await code(fileAppeal(app, p.user, newAccountId()))).toBe("not-found");
    expect(await code(fileAppeal(app, p.user, "x"))).toBe("invalid");
    expect(await code(fileAppeal(app, "x", p.id))).toBe("invalid");
    expect(await listPollAppeals(app, other, p.id)).toEqual([]);
    await moderate(app, p.electionId, { action: "restore", reason: "error", moderator: "mod-2" });
    expect(await code(fileAppeal(app, p.user, p.id))).toBe("not-appealable");
    // A draft has no election, so nothing to appeal.
    const draft = newAccountId();
    await app`
      INSERT INTO account_polls (id, user_id, state, draft, created_at, updated_at)
      VALUES (${draft}, ${p.user}, 'drafted', '{}', now(), now())`;
    expect(await code(fileAppeal(app, p.user, draft))).toBe("not-appealable");
    expect(await appealRows(p.id)).toBe(0);
  });

  test("concurrent appeals of one decision record one", async () => {
    const p = await poll();
    const { seq } = await moderate(app, p.electionId, {
      action: "hide",
      reason: "threat",
      moderator: "mod-1",
    });
    const clients = await Promise.all(Array.from({ length: 4 }, () => db.as("abolish_app")));
    const results = await Promise.all(clients.map((c) => code(fileAppeal(c, p.user, p.id))));
    expect(results.sort()).toEqual([
      "already-appealed",
      "already-appealed",
      "already-appealed",
      "ok",
    ]);
    const reviews = await Promise.all(
      clients.map((c, i) => code(decideAppeal(c, seq, i % 2 ? "upheld" : "rejected", "mod-2"))),
    );
    expect(reviews.filter((r) => r === "ok")).toHaveLength(1);
    expect(reviews.filter((r) => r === "reviewed")).toHaveLength(3);
    const restores =
      await app`SELECT count(*)::int AS n FROM moderation_actions WHERE election_id = ${p.electionId} AND reason = 'appeal-upheld'`;
    expect(restores[0]!["n"]).toBeLessThanOrEqual(1);
  });

  test("deleting the creator's account deletes their appeals", async () => {
    const p = await poll();
    await moderate(app, p.electionId, { action: "delist", reason: "spam", moderator: "mod-1" });
    await fileAppeal(app, p.user, p.id);
    await app`DELETE FROM account_users WHERE id = ${p.user}`;
    expect(await appealRows(p.id)).toBe(0);
    expect((await moderationStatus(app, p.electionId)).state).toBe("delisted");
  });

  test("the queue pages in order and refuses bad bounds", async () => {
    const seqs: bigint[] = [];
    for (let i = 0; i < 5; i++) {
      const p = await poll();
      const { seq } = await moderate(app, p.electionId, {
        action: "delist",
        reason: "spam",
        moderator: "mod-1",
      });
      await fileAppeal(app, p.user, p.id);
      seqs.push(seq);
    }
    const all = (await readAppealQueue(app, MAX_APPEAL_QUEUE)).map((a) => a.decisionSeq);
    const seen: bigint[] = [];
    let after = 0n;
    for (;;) {
      const page = await readAppealQueue(app, 2, after);
      seen.push(...page.map((a) => a.decisionSeq));
      if (page.length < 2) break;
      after = page.at(-1)!.decisionSeq;
    }
    expect(seen).toEqual(all);
    expect(all).toEqual([...all].sort((a, b) => (a < b ? -1 : 1)));
    expect(all).toEqual(expect.arrayContaining(seqs));
    expect(await readAppealQueue(app, 10, (1n << 63n) - 1n)).toEqual([]);
    for (const [limit, a] of [
      [0, 0n],
      [MAX_APPEAL_QUEUE + 1, 0n],
      [1.5, 0n],
      [1, -1n],
      [1, 1],
    ] as const)
      expect(await code(readAppealQueue(app, limit, a as bigint))).toBe("invalid");
  });

  test("the outcome follows the model: upheld only while the decision stands", async () => {
    // Random interleavings of removals, restores, appeals and reviews on one
    // poll: an appeal is accepted only against a standing removal, and a
    // review upholds only while its decision is still the newest.
    type Step =
      | { kind: "remove"; action: "delist" | "hide" }
      | { kind: "restore" }
      | { kind: "appeal" }
      | { kind: "review"; decision: "upheld" | "rejected" };
    const step: fc.Arbitrary<Step> = fc.oneof(
      fc.record({
        kind: fc.constant("remove" as const),
        action: fc.constantFrom("delist" as const, "hide" as const),
      }),
      fc.record({ kind: fc.constant("restore" as const) }),
      fc.record({ kind: fc.constant("appeal" as const) }),
      fc.record({
        kind: fc.constant("review" as const),
        decision: fc.constantFrom("upheld" as const, "rejected" as const),
      }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(step, { maxLength: 8 }), async (steps) => {
        const p = await poll();
        let newest: { seq: bigint; removal: boolean } | undefined;
        const open: bigint[] = [];
        const appealed = new Set<bigint>();
        let reason = 0;
        const grounds = ["spam", "threat", "personal-data", "harassment", "impersonation"] as const;
        for (const s of steps) {
          if (s.kind === "remove") {
            const r = await code(
              moderate(app, p.electionId, {
                action: s.action,
                // A fresh ground each time, so a removal is always recorded.
                reason: grounds[reason++ % grounds.length]!,
                moderator: "mod-1",
              }).then((d) => {
                newest = { seq: d.seq, removal: true };
              }),
            );
            if (r !== "ok") expect(r).toBe("no-change");
          } else if (s.kind === "restore") {
            const r = await code(
              moderate(app, p.electionId, {
                action: "restore",
                reason: "error",
                moderator: "mod-1",
              }).then((d) => {
                newest = { seq: d.seq, removal: false };
              }),
            );
            expect(r).toBe(newest?.removal === true || r === "ok" ? "ok" : "no-change");
          } else if (s.kind === "appeal") {
            const r = await code(fileAppeal(app, p.user, p.id));
            if (newest === undefined || !newest.removal) expect(r).toBe("not-appealable");
            else if (appealed.has(newest.seq)) expect(r).toBe("already-appealed");
            else {
              expect(r).toBe("ok");
              appealed.add(newest.seq);
              open.push(newest.seq);
            }
          } else if (open.length > 0) {
            const seq = open.shift()!;
            const review = await decideAppeal(app, seq, s.decision, "mod-2");
            const stands = newest?.seq === seq;
            expect(review.outcome).toBe(stands ? s.decision : "superseded");
            if (review.restoreSeq !== undefined)
              newest = { seq: review.restoreSeq, removal: false };
          }
          const state = (await moderationStatus(app, p.electionId)).state;
          expect(state === "visible").toBe(newest === undefined || !newest.removal);
        }
      }),
      { numRuns: Math.min(numRuns, 30) },
    );
  });
});

describe("T-10", () => {
  test("the appeals module names nothing from the ballot path", () => {
    const src = readFileSync(new URL("../src/appeals.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/board|ballot|identity|nullifier|receipt/i);
  });
});
