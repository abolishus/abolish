import { encodeElectionDefinition } from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  MAX_REPORT_QUEUE,
  ModerationError,
  type ModerationErrorCode,
  moderationReports,
  moderationStatus,
  readModerationLog,
  readReportQueue,
  REMOVAL_REASONS,
  report,
  reviewReports,
  storeDefinition,
} from "../src/index.ts";
import { type TestDb, testDb, typical } from "./db.ts";

// Reports (migrations/0003_moderation_reports.sql, src/reports.ts;
// docs/moderation-policy.md, Reports): a report keeps its poll and ground and
// nothing about the reporter, counts instead of growing the table (T-52), and
// never moderates anything by itself (T-68).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

let db: TestDb;
let app: Sql;
beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
});
afterAll(() => db?.close());

async function election(): Promise<Uint8Array> {
  const id = new Uint8Array(randomBytes(32));
  await storeDefinition(app, encodeElectionDefinition({ ...typical, election_id: id }));
  return id;
}

async function refusedWith(p: Promise<unknown>): Promise<ModerationErrorCode> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ModerationError) return e.code;
    throw e;
  }
  throw new Error("report accepted");
}

async function failsWith(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
  } catch (e) {
    return (e as { code?: string }).code ?? "no code";
  }
  throw new Error("query succeeded");
}

const sameId = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const queueFor = async (id: Uint8Array) =>
  (await readReportQueue(app, MAX_REPORT_QUEUE)).filter((r) => sameId(r.electionId, id));

describe("schema", () => {
  test("the Drizzle table matches the migrated one", async () => {
    const cols = await db.admin`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = ${db.schema} AND table_name = 'moderation_reports'
      ORDER BY ordinal_position`;
    const config = getTableConfig(moderationReports);
    expect(cols.map((c) => [c["column_name"], c["data_type"], c["is_nullable"]])).toEqual(
      config.columns.map((c) => [c.name, c.getSQLType(), c.notNull ? "NO" : "YES"]),
    );
  });

  test("keeps the poll, the ground, two counts and an hour: nothing about the reporter", async () => {
    // T-10, T-11, T-17: no column for an account, an address, contact details or text.
    const cols = await db.admin`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${db.schema} AND table_name = 'moderation_reports'
      ORDER BY ordinal_position`;
    expect(cols.map((c) => c["column_name"])).toEqual([
      "election_id",
      "reason",
      "total",
      "pending",
      "pending_since",
    ]);
  });

  test("the app role holds SELECT, INSERT and UPDATE, and can't delete a report", async () => {
    const privs = await db.admin`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = ${db.schema} AND table_name = 'moderation_reports'
        AND grantee = 'abolish_app'
      ORDER BY privilege_type`;
    expect(privs.map((p) => p["privilege_type"])).toEqual(["INSERT", "SELECT", "UPDATE"]);
    const id = await election();
    await report(app, id, "spam");
    expect(await failsWith(app`DELETE FROM moderation_reports WHERE election_id = ${id}`)).toBe(
      "42501",
    );
    expect(await failsWith(app`TRUNCATE moderation_reports`)).toBe("42501");
    expect(await queueFor(id)).toHaveLength(1);
  });

  test("the table refuses rows outside the policy's grounds and counts", async () => {
    const id = new Uint8Array(randomBytes(32));
    const at = new Date().toISOString();
    const insert = (
      election: Uint8Array,
      reason: string,
      total: number,
      pending: number,
      since: string | null = at,
    ) =>
      app`INSERT INTO moderation_reports (election_id, reason, total, pending, pending_since)
        VALUES (${election}, ${reason}, ${total}, ${pending}, ${since})`;
    expect(await failsWith(insert(id, "unpopular", 1, 1))).toBe("23514");
    expect(await failsWith(insert(id, "error", 1, 1))).toBe("23514");
    expect(await failsWith(insert(id, "spam", 0, 0))).toBe("23514");
    expect(await failsWith(insert(id, "spam", 1, 2))).toBe("23514");
    expect(await failsWith(insert(id, "spam", 1, -1))).toBe("23514");
    expect(await failsWith(insert(id.subarray(1), "spam", 1, 1))).toBe("23514");
    expect(await failsWith(insert(id, "spam", 1, 1, null))).toBe("23514");
    expect(await failsWith(insert(id, "spam", 1, 0))).toBe("23514");
  });
});

describe("report", () => {
  test("counts reports per poll and ground, one row each however many arrive", async () => {
    const id = await election();
    for (let i = 0; i < 5; i++) await report(app, id, "spam");
    await report(app, id, "threat");
    const queue = await queueFor(id);
    expect(queue.map((r) => [r.reason, r.pending, r.total])).toEqual(
      expect.arrayContaining([
        ["spam", 5n, 5n],
        ["threat", 1n, 1n],
      ]),
    );
    expect(queue).toHaveLength(2);
    const [{ n }] = (await app`
      SELECT count(*)::int AS n FROM moderation_reports WHERE election_id = ${id}`) as unknown as [
      { n: number },
    ];
    expect(n).toBe(2);
  });

  test("concurrent reports are all counted", async () => {
    const id = await election();
    const clients = await Promise.all([1, 2, 3, 4].map(() => db.as("abolish_app")));
    await Promise.all(clients.flatMap((c) => [1, 2, 3].map(() => report(c, id, "harassment"))));
    expect((await queueFor(id)).map((r) => [r.pending, r.total])).toEqual([[12n, 12n]]);
  });

  test("keeps only the hour the oldest pending report arrived, from the database clock (T-11)", async () => {
    const id = await election();
    await report(app, id, "spam");
    const [r] = await queueFor(id);
    const [clock] = await app`SELECT now()::text AS now`;
    const now = new Date(clock!["now"] as string);
    expect(r!.pendingSince.getTime() % 3_600_000).toBe(0);
    expect(now.getTime() - r!.pendingSince.getTime()).toBeLessThan(3_600_000 + 60_000);
    expect(now.getTime()).toBeGreaterThanOrEqual(r!.pendingSince.getTime());
  });

  test("reporting a poll again never moves it back in the queue (T-68)", async () => {
    const id = await election();
    await report(app, id, "spam");
    await db.admin`UPDATE moderation_reports SET pending_since = pending_since - interval '3 days'
      WHERE election_id = ${id}`;
    const [before] = await queueFor(id);
    await report(app, id, "spam");
    const [after] = await queueFor(id);
    expect(after!.pendingSince).toEqual(before!.pendingSince);
    expect(after!.pending).toBe(2n);
  });

  test("refuses an election with no stored definition, with nothing written", async () => {
    const id = new Uint8Array(randomBytes(32));
    expect(await refusedWith(report(app, id, "spam"))).toBe("unknown-election");
    expect(await queueFor(id)).toEqual([]);
  });

  test("refuses a ground outside the policy's removal reasons", async () => {
    const id = await election();
    for (const reason of ["error", "appeal-upheld", "unpopular", "", "SPAM", 1, null])
      expect(await refusedWith(report(app, id, reason as never))).toBe("invalid");
    expect(await queueFor(id)).toEqual([]);
  });

  test("refuses an election ID that isn't 32 real bytes", async () => {
    await expect(report(app, new Uint8Array(31), "spam")).rejects.toThrow(TypeError);
    await expect(report(app, Array(32).fill(0) as never, "spam")).rejects.toThrow(TypeError);
  });

  test("never moderates: reports leave the poll's state and the public log alone", async () => {
    // Report volume is never a ground (docs/moderation-policy.md, Reports).
    const id = await election();
    const log = await readModerationLog(app, 0n, 1000);
    for (const reason of REMOVAL_REASONS) for (let i = 0; i < 3; i++) await report(app, id, reason);
    expect(await moderationStatus(app, id)).toEqual({ state: "visible" });
    expect(await readModerationLog(app, 0n, 1000)).toEqual(log);
  });
});

describe("the queue and reviews", () => {
  test("reviewing clears the reports the moderator saw, and only those", async () => {
    const id = await election();
    await report(app, id, "impersonation");
    await report(app, id, "impersonation");
    const [seen] = await queueFor(id);
    expect([seen!.pending, seen!.total]).toEqual([2n, 2n]);
    // A report arrives after the moderator read the queue.
    await report(app, id, "impersonation");
    expect(await reviewReports(app, id, "impersonation", seen!.total)).toBe(1n);
    const [left] = await queueFor(id);
    expect([left!.pending, left!.total]).toEqual([1n, 3n]);
    expect(left!.pendingSince).toEqual(seen!.pendingSince);
    expect(await reviewReports(app, id, "impersonation", 3n)).toBe(0n);
    expect(await queueFor(id)).toEqual([]);
    const [row] = await app`SELECT pending_since FROM moderation_reports WHERE election_id = ${id}`;
    expect(row!["pending_since"]).toBeNull();
    // A stale review never brings reports back.
    expect(await reviewReports(app, id, "impersonation", 1n)).toBe(0n);
    expect(await queueFor(id)).toEqual([]);
  });

  test("refuses a review of more reports than were made, or of a ground never reported", async () => {
    const id = await election();
    await report(app, id, "spam");
    expect(await refusedWith(reviewReports(app, id, "spam", 2n))).toBe("invalid");
    expect(await refusedWith(reviewReports(app, id, "threat", 1n))).toBe("invalid");
    expect(await refusedWith(reviewReports(app, id, "error" as never, 1n))).toBe("invalid");
    await expect(reviewReports(app, id, "spam", 0n)).rejects.toThrow(TypeError);
    await expect(reviewReports(app, id, "spam", 1 as never)).rejects.toThrow(TypeError);
    await expect(reviewReports(app, id, "spam", 1n << 63n)).rejects.toThrow(TypeError);
    expect((await queueFor(id)).map((r) => r.pending)).toEqual([1n]);
  });

  test("lists the longest-waiting reports first, within its bounds", async () => {
    const [a, b] = [await election(), await election()];
    await report(app, a, "spam");
    await report(app, b, "spam");
    // Back-date a's report: the queue orders by how long reports have waited.
    await db.admin`UPDATE moderation_reports SET pending_since = pending_since - interval '2 hours'
      WHERE election_id = ${a}`;
    const queue = await readReportQueue(app, MAX_REPORT_QUEUE);
    const at = (id: Uint8Array) => queue.findIndex((r) => sameId(r.electionId, id));
    expect(at(a)).toBeGreaterThanOrEqual(0);
    expect(at(a)).toBeLessThan(at(b));
    expect(await readReportQueue(app, 1)).toHaveLength(1);
    for (const limit of [0, -1, 1.5, MAX_REPORT_QUEUE + 1])
      await expect(readReportQueue(app, limit)).rejects.toThrow(TypeError);
  });

  test("pending is always the reports made since the newest review that saw them", async () => {
    // A model of the counters: any interleaving of reports and reviews of
    // some earlier total leaves pending = total − (largest total reviewed).
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.oneof(fc.constant("report" as const), fc.nat(20)), { maxLength: 25 }),
        async (steps) => {
          const id = await election();
          let total = 0n;
          let reviewed = 0n;
          for (const step of steps) {
            if (step === "report") {
              await report(app, id, "spam");
              total++;
            } else if (total > 0n) {
              const seen = (BigInt(step) % total) + 1n;
              const left = await reviewReports(app, id, "spam", seen);
              if (seen > reviewed) reviewed = seen;
              expect(left).toBe(total - reviewed);
            }
          }
          const queue = await queueFor(id);
          if (total === reviewed) expect(queue).toEqual([]);
          else expect(queue.map((r) => [r.pending, r.total])).toEqual([[total - reviewed, total]]);
        },
      ),
      { numRuns: Math.min(numRuns, 50) },
    );
  });
});

test("pages through the whole queue, each pending pair once, in order", async () => {
  const ids = await Promise.all([1, 2, 3].map(() => election()));
  for (const id of ids)
    for (const reason of ["spam", "threat"] as const) await report(app, id, reason);
  const all = await readReportQueue(app, MAX_REPORT_QUEUE);
  const paged = [];
  let page = await readReportQueue(app, 2);
  while (page.length > 0) {
    paged.push(...page);
    page = await readReportQueue(app, 2, page.at(-1));
  }
  expect(paged).toEqual(all);
  for (const id of ids) expect(paged.filter((r) => sameId(r.electionId, id))).toHaveLength(2);
  const cursor = all[0]!;
  await expect(
    readReportQueue(app, 1, { ...cursor, pendingSince: new Date(Number.NaN) }),
  ).rejects.toThrow(TypeError);
  await expect(readReportQueue(app, 1, { ...cursor, reason: "error" as never })).rejects.toThrow(
    TypeError,
  );
  await expect(
    readReportQueue(app, 1, { ...cursor, electionId: new Uint8Array(3) }),
  ).rejects.toThrow(TypeError);
});

describe("never results", () => {
  test("the reports module names no result-bearing table, and none of those modules names it", () => {
    const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
    const reports = src("reports.ts");
    expect(reports).not.toMatch(/boardEntries|board_entries|appendEntry|storeDefinition/);
    expect(reports).not.toMatch(/electionDefinitions|moderationActions|\.delete\(/);
    for (const f of ["board.ts", "definitions.ts", "moderation.ts"])
      expect(src(f)).not.toMatch(/report/i);
  });
});
