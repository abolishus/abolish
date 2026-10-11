import { decodeElectionDefinition, encodeElectionDefinition } from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  appendEntry,
  MAX_MODERATION_PAGE,
  moderate,
  type ModerationDecision,
  ModerationError,
  type ModerationErrorCode,
  type ModerationState,
  moderationActions,
  moderationStatus,
  OPEN_POLL_HIDE_REASONS,
  readBoard,
  readDefinition,
  readModerationLog,
  REMOVAL_REASONS,
  RESTORE_REASONS,
  storeDefinition,
} from "../src/index.ts";
import { type TestDb, testDb } from "./db.ts";

// The moderation log (migrations/0002_moderation.sql, src/moderation.ts;
// docs/moderation-policy.md; T-68): decisions are append-only and public,
// each one changes a poll's state, they carry no free text, and they never
// reach a result: the board and the definition read back byte for byte.

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
beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
  owner = await db.as("abolish_migrator");
});
afterAll(() => db?.close());

/**
 * A stored election under a fresh ID. The typical vector's poll closed in
 * January 2026; `closesAt` moves the close.
 */
async function election(closesAt = typical.closes_at): Promise<Uint8Array> {
  const id = new Uint8Array(randomBytes(32));
  const opensAt = typical.opens_at < closesAt ? typical.opens_at : closesAt - 1n;
  await storeDefinition(
    app,
    encodeElectionDefinition({
      ...typical,
      election_id: id,
      opens_at: opensAt,
      closes_at: closesAt,
    }),
  );
  return id;
}

const hide = (reason: (typeof REMOVAL_REASONS)[number] = "personal-data"): ModerationDecision => ({
  action: "hide",
  reason,
  moderator: "mod-1",
});
const delist = (reason: (typeof REMOVAL_REASONS)[number] = "spam"): ModerationDecision => ({
  action: "delist",
  reason,
  moderator: "mod-1",
});
const restore = (
  reason: (typeof RESTORE_REASONS)[number] = "appeal-upheld",
): ModerationDecision => ({
  action: "restore",
  reason,
  moderator: "mod-2",
});

async function refusedWith(p: Promise<unknown>): Promise<ModerationErrorCode> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ModerationError) return e.code;
    throw e;
  }
  throw new Error("decision recorded");
}

async function failsWith(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
  } catch (e) {
    return (e as { code?: string }).code ?? "no code";
  }
  throw new Error("query succeeded");
}

const count = async () =>
  (await app`SELECT count(*)::int AS n FROM moderation_actions`)[0]!["n"] as number;

describe("schema", () => {
  test("the Drizzle table matches the migrated one", async () => {
    const cols = await db.admin`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = ${db.schema} AND table_name = 'moderation_actions'
      ORDER BY ordinal_position`;
    const config = getTableConfig(moderationActions);
    expect(cols.map((c) => [c["column_name"], c["data_type"], c["is_nullable"]])).toEqual(
      config.columns.map((c) => [c.name, c.getSQLType(), c.notNull ? "NO" : "YES"]),
    );
  });

  test("holds no free text: every text column is bounded by a check to codes or a handle", async () => {
    // T-17: a note field would let personal data into the log.
    const cols = await db.admin`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${db.schema} AND table_name = 'moderation_actions'
      ORDER BY ordinal_position`;
    expect(cols.map((c) => c["column_name"])).toEqual([
      "seq",
      "election_id",
      "action",
      "reason",
      "moderator",
      "decided_at",
    ]);
  });

  test("the app role holds SELECT and INSERT and nothing else", async () => {
    const privs = await db.admin`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = ${db.schema} AND table_name = 'moderation_actions'
        AND grantee = 'abolish_app'
      ORDER BY privilege_type`;
    expect(privs.map((p) => p["privilege_type"])).toEqual(["INSERT", "SELECT"]);
  });

  for (const [role, client] of [
    ["app", () => app],
    ["owner", () => owner],
  ] as const) {
    for (const [op, run] of Object.entries({
      update: (sql: Sql, e: Uint8Array) =>
        sql`UPDATE moderation_actions SET action = 'restore', reason = 'error' WHERE election_id = ${e}`,
      delete: (sql: Sql, e: Uint8Array) =>
        sql`DELETE FROM moderation_actions WHERE election_id = ${e}`,
      truncate: (sql: Sql) => sql`TRUNCATE moderation_actions`,
    })) {
      test(`${op} fails as the ${role}: a decision is reversed by a later one, never erased`, async () => {
        const id = await election();
        await moderate(app, id, hide());
        expect(await failsWith(run(client(), id))).toBe("42501");
        expect((await moderationStatus(app, id)).state).toBe("hidden");
      });
    }
  }

  test("the owner can't switch triggers off for its session", async () => {
    expect(await failsWith(owner`SET session_replication_role = replica`)).toBe("42501");
  });

  test("the app role can't disable the triggers or drop the table", async () => {
    expect(await failsWith(app`ALTER TABLE moderation_actions DISABLE TRIGGER USER`)).toBe("42501");
    expect(await failsWith(app`DROP TABLE moderation_actions`)).toBe("42501");
  });

  test("the table refuses rows outside the policy's codes, handles and lengths", async () => {
    const id = new Uint8Array(randomBytes(32));
    const at = new Date().toISOString();
    const insert = (election: Uint8Array, action: string, reason: string, moderator: string) =>
      app`INSERT INTO moderation_actions (election_id, action, reason, moderator, decided_at)
        VALUES (${election}, ${action}, ${reason}, ${moderator}, ${at})`;
    expect(await failsWith(insert(id, "erase", "spam", "mod"))).toBe("23514");
    expect(await failsWith(insert(id, "hide", "error", "mod"))).toBe("23514");
    expect(await failsWith(insert(id, "restore", "spam", "mod"))).toBe("23514");
    expect(await failsWith(insert(id, "hide", "unpopular", "mod"))).toBe("23514");
    expect(await failsWith(insert(id, "hide", "spam", "Jane Doe"))).toBe("23514");
    expect(await failsWith(insert(id, "hide", "spam", "-mod"))).toBe("23514");
    expect(await failsWith(insert(id, "hide", "spam", "m".repeat(33)))).toBe("23514");
    expect(await failsWith(insert(id.subarray(1), "hide", "spam", "mod"))).toBe("23514");
    expect(
      await failsWith(
        app`INSERT INTO moderation_actions (seq, election_id, action, reason, moderator, decided_at)
          VALUES (1, ${id}, 'hide', 'spam', 'mod', ${at})`,
      ),
    ).toBe("428C9");
  });
});

describe("moderate", () => {
  test("hides, then restores, a poll's display text", async () => {
    const id = await election();
    expect(await moderationStatus(app, id)).toEqual({ state: "visible" });
    const hid = await moderate(app, id, hide("threat"));
    expect(hid.state).toBe("hidden");
    expect(await moderationStatus(app, id)).toMatchObject({
      state: "hidden",
      latest: { seq: hid.seq, action: "hide", reason: "threat" },
    });
    const back = await moderate(app, id, restore("error"));
    expect(back).toEqual({ seq: back.seq, state: "visible" });
    expect(back.seq).toBeGreaterThan(hid.seq);
    expect((await moderationStatus(app, id)).latest).toMatchObject({
      action: "restore",
      reason: "error",
    });
  });

  test("delisting can be escalated to hiding and back", async () => {
    const id = await election();
    expect((await moderate(app, id, delist())).state).toBe("delisted");
    expect((await moderate(app, id, hide("spam"))).state).toBe("hidden");
    expect((await moderate(app, id, delist("spam"))).state).toBe("delisted");
  });

  test("refuses an action that changes nothing, with nothing written", async () => {
    const id = await election();
    const before = await count();
    expect(await refusedWith(moderate(app, id, restore()))).toBe("no-change");
    await moderate(app, id, hide());
    expect(await refusedWith(moderate(app, id, hide()))).toBe("no-change");
    expect(await count()).toBe(before + 1);
  });

  test("hides a poll that hasn't closed only for illegal content, personal data or a threat", async () => {
    // Hiding stops voting through our client, so for other grounds an open
    // poll is delisted (docs/moderation-policy.md, Actions; T-68).
    const bound = BigInt(typical.l1_inclusion_bound);
    const nowSec = () => BigInt(Math.floor(Date.now() / 1000));
    for (const reason of REMOVAL_REASONS) {
      // Closed, but ballots may still land until the inclusion bound after it.
      const landing = await election(nowSec() - bound + 60n);
      const done = await election(nowSec() - bound - 60n);
      if ((OPEN_POLL_HIDE_REASONS as readonly string[]).includes(reason)) {
        expect((await moderate(app, landing, hide(reason))).state).toBe("hidden");
      } else {
        expect(await refusedWith(moderate(app, landing, hide(reason)))).toBe("open-poll");
        expect((await moderate(app, landing, delist(reason))).state).toBe("delisted");
        expect((await moderate(app, done, hide(reason))).state).toBe("hidden");
      }
    }
  });

  test("dates a decision by the database clock, whatever time the caller passes", async () => {
    // A caller-chosen time could date a hide past the close (T-68).
    const id = await election(BigInt(Math.floor(Date.now() / 1000)) + 3600n);
    const forged = { ...hide("spam"), decidedAt: new Date("2100-01-01T00:00:00Z") };
    expect(await refusedWith(moderate(app, id, forged))).toBe("open-poll");
    const before = Date.now();
    await moderate(app, id, { ...forged, action: "delist" } as ModerationDecision);
    const { latest } = await moderationStatus(app, id);
    expect(latest!.decidedAt.getTime()).toBeGreaterThanOrEqual(before - 5000);
    expect(latest!.decidedAt.getTime()).toBeLessThanOrEqual(Date.now() + 5000);
  });

  test("refuses an election with no stored definition", async () => {
    const before = await count();
    expect(await refusedWith(moderate(app, new Uint8Array(randomBytes(32)), hide()))).toBe(
      "unknown-election",
    );
    expect(await count()).toBe(before);
  });

  test("re-cites a removal under another ground, but never repeats one", async () => {
    const id = await election();
    await moderate(app, id, hide("spam"));
    expect(await refusedWith(moderate(app, id, hide("spam")))).toBe("no-change");
    expect((await moderate(app, id, hide("personal-data"))).state).toBe("hidden");
    expect((await moderationStatus(app, id)).latest?.reason).toBe("personal-data");
    // Alternating back to a ground already cited since the state began is a no-op.
    expect(await refusedWith(moderate(app, id, hide("spam")))).toBe("no-change");
    await moderate(app, id, restore("error"));
    expect(await refusedWith(moderate(app, id, restore("appeal-upheld")))).toBe("no-change");
  });

  test("refuses malformed decisions", async () => {
    const id = await election();
    const bad: unknown[] = [
      { ...hide(), reason: "error" },
      { ...restore(), reason: "spam" },
      { ...hide(), reason: "unpopular-opinion" },
      { ...hide(), action: "erase" },
      { ...hide(), moderator: "Jane Doe" },
      { ...hide(), moderator: "" },
      { ...hide(), moderator: "a".repeat(33) },
      { ...hide(), moderator: "mod-" },
      { ...hide(), note: undefined, moderator: 7 },
      null,
    ];
    for (const d of bad)
      expect(await refusedWith(moderate(app, id, d as ModerationDecision))).toBe("invalid");
    expect(await moderationStatus(app, id)).toEqual({ state: "visible" });
  });

  test("refuses an election ID that isn't 32 real bytes", async () => {
    await expect(moderate(app, new Uint8Array(31), hide())).rejects.toThrow(TypeError);
    await expect(moderate(app, "x".repeat(32) as never, hide())).rejects.toThrow(TypeError);
    await expect(moderationStatus(app, new Uint8Array(33))).rejects.toThrow(TypeError);
  });

  test("concurrent identical decisions record exactly one", async () => {
    const id = await election();
    const clients = await Promise.all(Array.from({ length: 6 }, () => db.as("abolish_app")));
    const results = await Promise.allSettled(
      clients.map((c) => moderate(c, id, { action: "hide", reason: "spam", moderator: "m" })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results)
      if (r.status === "rejected") expect((r.reason as ModerationError).code).toBe("no-change");
    const rows =
      await app`SELECT count(*)::int AS n FROM moderation_actions WHERE election_id = ${id}`;
    expect(rows[0]!["n"]).toBe(1);
  });

  test("the state is always the newest decision's, and only changes are recorded", async () => {
    // A model of the policy's state machine against the database: a decision
    // is recorded when it changes the state, or when it re-cites a removal
    // under a reason not yet cited since the state began. A small pool of
    // reasons makes repeats likely.
    const decision: fc.Arbitrary<ModerationDecision> = fc.oneof(
      fc.record({
        action: fc.constantFrom("delist" as const, "hide" as const),
        reason: fc.constantFrom("spam" as const, "threat" as const, "personal-data" as const),
        moderator: fc.constant("mod-1"),
      }),
      fc.record({
        action: fc.constant("restore" as const),
        reason: fc.constantFrom(...RESTORE_REASONS),
        moderator: fc.constant("mod-2"),
      }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(decision, { maxLength: 10 }), async (decisions) => {
        const id = await election();
        let model: ModerationState = "visible";
        let cited = new Set<string>();
        let recorded = 0;
        for (const d of decisions) {
          const next = ({ delist: "delisted", hide: "hidden", restore: "visible" } as const)[
            d.action
          ];
          if (next === model && (d.action === "restore" || cited.has(d.reason))) {
            expect(await refusedWith(moderate(app, id, d))).toBe("no-change");
          } else {
            expect((await moderate(app, id, d)).state).toBe(next);
            if (next !== model) cited = new Set();
            cited.add(d.reason);
            model = next;
            recorded++;
          }
          expect((await moderationStatus(app, id)).state).toBe(model);
        }
        const rows =
          await app`SELECT count(*)::int AS n FROM moderation_actions WHERE election_id = ${id}`;
        expect(rows[0]!["n"]).toBe(recorded);
      }),
      { numRuns: Math.min(numRuns, 50) },
    );
  });
});

describe("never results", () => {
  test("moderating a poll leaves its board and definition byte for byte", async () => {
    const id = await election();
    for (let i = 0; i < 3; i++) await appendEntry(app, id, 0, Uint8Array.of(0x00, 0x02, 1, i));
    const board = await readBoard(app, id);
    const definition = await readDefinition(app, id);
    await moderate(app, id, hide("illegal"));
    await moderate(app, id, delist());
    expect(await readBoard(app, id)).toEqual(board);
    expect(await readDefinition(app, id)).toEqual(definition);
    // The board still takes entries: hiding the text closes nothing.
    await appendEntry(app, id, 0, Uint8Array.of(0x00, 0x02, 1, 9));
    expect(await readBoard(app, id)).toHaveLength(4);
  });

  test("the moderation module names no result-bearing table, and none of those modules names it", () => {
    // A structural guard (T-68): moderation reads and writes its own table and
    // checks that a definition exists; it never writes the board or a
    // definition, and the board and definition code never read moderation.
    const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
    const moderation = src("moderation.ts");
    expect(moderation).not.toMatch(/boardEntries|board_entries|appendEntry|storeDefinition/);
    expect(moderation).not.toMatch(/\.insert\(electionDefinitions\)|\.update\(|\.delete\(/);
    for (const f of ["board.ts", "definitions.ts"]) expect(src(f)).not.toMatch(/moderation/i);
  });
});

describe("readModerationLog", () => {
  test("pages through every decision in order, without the moderator", async () => {
    const [a, b] = [await election(), await election()];
    const start = (await readModerationLog(app, 0n, MAX_MODERATION_PAGE)).at(-1)?.seq ?? 0n;
    const d1 = hide("harassment");
    const d2 = delist("impersonation");
    const d3 = restore("notice-withdrawn");
    await moderate(app, a, d1);
    await moderate(app, b, d2);
    await moderate(app, a, d3);
    const first = await readModerationLog(app, start, 2);
    expect(first.map((e) => [e.electionId, e.action, e.reason])).toEqual([
      [a, "hide", "harassment"],
      [b, "delist", "impersonation"],
    ]);
    expect(first[0]!.decidedAt.getTime()).toBeLessThanOrEqual(first[1]!.decidedAt.getTime());
    const rest = await readModerationLog(app, first.at(-1)!.seq, 2);
    expect(rest.map((e) => [e.electionId, e.action, e.reason])).toEqual([
      [a, "restore", "notice-withdrawn"],
    ]);
    for (const e of [...first, ...rest])
      expect(Object.keys(e).sort()).toEqual(["action", "decidedAt", "electionId", "reason", "seq"]);
    expect(await readModerationLog(app, rest[0]!.seq, 10)).toEqual([]);
  });

  test("refuses pages outside its bounds", async () => {
    await expect(readModerationLog(app, -1n, 1)).rejects.toThrow(TypeError);
    await expect(readModerationLog(app, 0 as never, 1)).rejects.toThrow(TypeError);
    await expect(readModerationLog(app, 0n, 0)).rejects.toThrow(TypeError);
    await expect(readModerationLog(app, 0n, MAX_MODERATION_PAGE + 1)).rejects.toThrow(TypeError);
    await expect(readModerationLog(app, 0n, 1.5)).rejects.toThrow(TypeError);
  });
});
