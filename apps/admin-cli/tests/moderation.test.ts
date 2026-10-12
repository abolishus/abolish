import { report, storeDefinition } from "@abolishus/core";
import { type TestDb, testDb } from "@abolishus/core/test-db";
import { decodeElectionDefinition, encodeElectionDefinition } from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { run } from "../src/index.ts";

// The moderation commands against Postgres, as the app role: they read the
// queue a page at a time (T-52), review only what the moderator saw, record
// decisions through core's rules (T-68), and print the public log without the
// moderator.

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
beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
});
afterAll(() => db?.close());

/**
 * A stored election under a fresh ID, as hex. The typical vector's poll closed
 * in January 2026; `closesAt` moves the close.
 */
async function election(closesAt = typical.closes_at): Promise<string> {
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
  return Buffer.from(id).toString("hex");
}

const bytes = (id: string) => new Uint8Array(Buffer.from(id, "hex"));

async function cli(...argv: string[]) {
  const out: Record<string, unknown>[] = [];
  const err: Record<string, unknown>[] = [];
  const code = await run(argv, app, {
    // Through JSON, as main.ts prints them: a bigint or Date left unconverted
    // fails here.
    out: (v) => out.push(JSON.parse(JSON.stringify(v))),
    err: (v) => err.push(JSON.parse(JSON.stringify(v))),
  });
  return { code, out, err };
}

describe("moderation queue and review", () => {
  test("pages the queue by its cursor and reviews only what was seen", async () => {
    const ids = [await election(), await election(), await election()];
    for (const id of ids) await report(app, bytes(id), "spam");
    await report(app, bytes(ids[0]!), "spam");

    const seen: string[] = [];
    let after: string[] = [];
    for (;;) {
      const page = await cli("moderation", "queue", "--limit", "2", ...after);
      expect(page.code).toBe(0);
      const next = page.out.find((r) => "next" in r);
      for (const r of page.out)
        if (!("next" in r)) seen.push(`${String(r["electionId"])}/${String(r["reason"])}`);
      if (next === undefined) break;
      expect(page.out).toHaveLength(3);
      after = ["--after", String(next["next"])];
    }
    // This file's schema holds only these reports, each pair once.
    expect(seen.sort()).toEqual(ids.map((id) => `${id}/spam`).sort());

    const first = (await cli("moderation", "queue")).out.find((r) => r["electionId"] === ids[0]);
    expect(first).toMatchObject({ reason: "spam", pending: "2", total: "2" });
    expect(first?.["pendingSince"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/);

    // A report counted after the queue was read stays pending.
    await report(app, bytes(ids[0]!), "spam");
    expect(await cli("moderation", "review", ids[0]!, "spam", "2")).toEqual({
      code: 0,
      out: [{ electionId: ids[0], reason: "spam", pending: "1" }],
      err: [],
    });
    // Claiming to have seen more than was reported is refused.
    expect(await cli("moderation", "review", ids[1]!, "spam", "5")).toMatchObject({
      code: 1,
      err: [{ error: "invalid" }],
    });
  });

  test("refuses a malformed cursor or page size", async () => {
    const id = await election();
    for (const args of [
      ["--after", "garbage"],
      ["--after", `2026-01-01T00:30:00.000Z/${id}/spam`],
      ["--after", `2026-02-30T00:00:00.000Z/${id}/spam`],
      ["--after", `2026-01-01T00:00:00.000Z/${id.toUpperCase()}/spam`],
      ["--after", `2026-01-01T00:00:00.000Z/${id}/error`],
      ["--limit", "0"],
      ["--limit", "1001"],
      ["--limit", "01"],
      ["--limit", "-1"],
    ]) {
      const r = await cli("moderation", "queue", ...args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.out).toEqual([]);
    }
  });
});

describe("moderation decisions", () => {
  test("records decisions, prints the state and the public log without the moderator", async () => {
    const id = await election();
    expect(await cli("moderation", "status", id)).toEqual({
      code: 0,
      out: [{ electionId: id, state: "visible" }],
      err: [],
    });

    const hidden = await cli("moderation", "decide", id, "hide", "spam", "--moderator", "mod-7");
    expect(hidden.code).toBe(0);
    expect(hidden.out).toEqual([{ seq: expect.any(String), electionId: id, state: "hidden" }]);
    const seq = String(hidden.out[0]!["seq"]);

    const status = await cli("moderation", "status", id);
    expect(status.out).toEqual([
      {
        electionId: id,
        state: "hidden",
        latest: { seq, action: "hide", reason: "spam", decidedAt: expect.any(String) },
      },
    ]);

    const restored = await cli(
      "moderation",
      "decide",
      id,
      "restore",
      "error",
      "--moderator",
      "mod-7",
    );
    expect(restored.out).toEqual([{ seq: expect.any(String), electionId: id, state: "visible" }]);

    const log = await cli("moderation", "log", "--after", String(BigInt(seq) - 1n));
    expect(log.out.map((e) => [e["electionId"], e["action"], e["reason"]])).toEqual([
      [id, "hide", "spam"],
      [id, "restore", "error"],
    ]);
    expect(JSON.stringify([status, log])).not.toContain("mod-7");
  });

  test("core's refusals come back as their codes, with nothing recorded", async () => {
    // Closes in 2100: hiding it is allowed only on the open-poll grounds.
    const open = await election(4_102_444_800n);
    const before = (await cli("moderation", "log", "--limit", "1000")).out.length;
    for (const [argv, code] of [
      [["decide", open, "hide", "spam"], "open-poll"],
      [["decide", open, "restore", "error"], "no-change"],
      [["decide", "00".repeat(32), "delist", "spam"], "unknown-election"],
      [["decide", open, "hide", "spam", "--moderator", "Mod"], "invalid"],
    ] as const) {
      const moderator = argv.length === 4 ? ["--moderator", "mod-1"] : [];
      expect(await cli("moderation", ...argv, ...moderator)).toEqual({
        code: 1,
        out: [],
        err: [{ error: code }],
      });
    }
    expect((await cli("moderation", "log", "--limit", "1000")).out).toHaveLength(before);
    expect(
      (await cli("moderation", "decide", open, "hide", "threat", "--moderator", "mod-1")).code,
    ).toBe(0);
  });

  test("refuses malformed arguments before reaching the database", async () => {
    const id = await election();
    for (const argv of [
      [],
      ["moderation"],
      ["moderation", "purge"],
      ["accounts", "list"],
      ["moderation", "decide", id, "hide", "spam"],
      ["moderation", "decide", id, "hide", "error", "--moderator", "m"],
      ["moderation", "decide", id, "restore", "spam", "--moderator", "m"],
      ["moderation", "decide", id, "erase", "spam", "--moderator", "m"],
      ["moderation", "decide", id.toUpperCase(), "hide", "spam", "--moderator", "m"],
      ["moderation", "decide", `0x${id}`, "hide", "spam", "--moderator", "m"],
      ["moderation", "decide", id.slice(2), "hide", "spam", "--moderator", "m"],
      ["moderation", "decide", id, "hide", "spam", "extra", "--moderator", "m"],
      ["moderation", "decide", id, "hide", "spam", "--moderator", "m", "--force"],
      ["moderation", "decide", id, "hide", "spam", "--moderator"],
      ["moderation", "status"],
      ["moderation", "review", id, "spam", "0"],
      ["moderation", "review", id, "spam", "1.5"],
      ["moderation", "review", id, "spam", "9223372036854775808"],
      ["moderation", "log", "--after", "-1"],
      ["moderation", "log", "--after", "007"],
    ]) {
      const r = await cli(...argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.out).toEqual([]);
      expect(r.err).toEqual([
        { error: "usage", detail: expect.any(String), usage: expect.any(String) },
      ]);
    }
    expect((await cli("moderation", "status", id)).out).toEqual([
      { electionId: id, state: "visible" },
    ]);
  });

  test("the log past the largest sequence number is empty", async () => {
    expect(await cli("moderation", "log", "--after", "9223372036854775807")).toEqual({
      code: 0,
      out: [],
      err: [],
    });
  });
});
