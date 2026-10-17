import { fileAppeal, newAccountId, report, storeDefinition } from "@abolishus/core";
import { addModerators, newAccount, type TestDb, testDb, typical } from "@abolishus/core/test-db";
import { encodeElectionDefinition } from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { run } from "../src/index.ts";

// The moderation commands against Postgres, as the app role: they read the
// queue a page at a time (T-52), review only what the moderator saw, record
// decisions through core's rules (T-68), and print the public log without the
// moderator.

let db: TestDb;
let app: Sql;
beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
  await addModerators(app, "m", "mod-1", "mod-7");
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
  const code = await run(argv, () => app, {
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

test("any other failure exits 3 with its kind only, never its message", async () => {
  const closed = await db.as("abolish_app");
  await closed.end();
  const err: unknown[] = [];
  const code = await run(["moderation", "status", "00".repeat(32)], () => closed, {
    out: () => expect.unreachable(),
    err: (v) => err.push(v),
  });
  expect(code).toBe(3);
  expect(err).toEqual([{ error: "internal", kind: expect.any(String) }]);
});

describe("moderators and appeals", () => {
  /** A stored, closed poll whose creator record names `author`, as hex and its record's ID. */
  async function poll(author: string) {
    const id = await election();
    const pollId = newAccountId();
    await app`
      INSERT INTO account_polls (id, user_id, state, draft, created_at, updated_at, submitted_at,
        creator_address, create_tx_hash, election_id, created_block, l1_origin_timestamp,
        anchors_checked_block, electorate, stub_hash, ceremony_tx_hash, register_tx_hash,
        registered_block)
      VALUES (${pollId}, ${author}, 'open', '{}', now(), now(), now(), ${randomBytes(20)},
        ${randomBytes(32)}, ${bytes(id)}, 1, 1, 1, '[]', ${randomBytes(32)}, ${randomBytes(32)},
        ${randomBytes(32)}, 2)`;
    return { id, pollId };
  }

  test("adds and retires handles; a moderator's own poll is refused", async () => {
    const account = await newAccount(app);
    expect(await cli("moderation", "moderator-add", "ann", account)).toEqual({
      code: 0,
      out: [{ handle: "ann" }],
      err: [],
    });
    const added = await cli("moderation", "moderator-add", "ann", await newAccount(app));
    expect([added.code, added.err]).toEqual([1, [{ error: "handle-taken" }]]);
    const mine = await poll(account);
    const own = await cli("moderation", "decide", mine.id, "delist", "spam", "--moderator", "ann");
    expect([own.code, own.err]).toEqual([1, [{ error: "own-poll" }]]);
    expect(await cli("moderation", "moderator-retire", "ann")).toEqual({
      code: 0,
      out: [{ handle: "ann", retired: true }],
      err: [],
    });
    const other = await election();
    const retired = await cli(
      "moderation",
      "decide",
      other,
      "delist",
      "spam",
      "--moderator",
      "ann",
    );
    expect([retired.code, retired.err]).toEqual([1, [{ error: "unknown-moderator" }]]);
  });

  test("lists open appeals without the creator and reviews them", async () => {
    const author = await newAccount(app);
    const { id, pollId } = await poll(author);
    const hidden = await cli("moderation", "decide", id, "hide", "spam", "--moderator", "mod-1");
    const seq = String(hidden.out[0]!["seq"]);
    await fileAppeal(app, author, pollId);
    const appeals = await cli("moderation", "appeals", "--after", String(BigInt(seq) - 1n));
    expect(appeals.out).toEqual([
      {
        decisionSeq: seq,
        electionId: id,
        action: "hide",
        reason: "spam",
        decidedAt: expect.any(String),
        filedAt: expect.any(String),
      },
    ]);
    expect(JSON.stringify(appeals)).not.toContain(author);
    const same = await cli("moderation", "appeal-decide", seq, "upheld", "--moderator", "mod-1");
    expect([same.code, same.err]).toEqual([1, [{ error: "same-moderator" }]]);
    const upheld = await cli("moderation", "appeal-decide", seq, "upheld", "--moderator", "mod-7");
    expect(upheld).toEqual({
      code: 0,
      out: [
        { decisionSeq: seq, outcome: "upheld", state: "visible", restoreSeq: expect.any(String) },
      ],
      err: [],
    });
    const status = await cli("moderation", "status", id);
    expect(status.out[0]!["latest"]).toMatchObject({ action: "restore", reason: "appeal-upheld" });
    const again = await cli("moderation", "appeal-decide", seq, "rejected", "--moderator", "m");
    expect([again.code, again.err]).toEqual([1, [{ error: "reviewed" }]]);
  });

  test("malformed appeal and moderator commands are usage errors", async () => {
    for (const argv of [
      ["appeal-decide", "1", "upheld"],
      ["appeal-decide", "1", "maybe", "--moderator", "m"],
      ["appeal-decide", "0", "upheld", "--moderator", "m"],
      ["appeal-decide", "01", "upheld", "--moderator", "m"],
      ["appeal-decide", "9223372036854775808", "upheld", "--moderator", "m"],
      ["appeals", "--limit", "0"],
      ["appeals", "--after", "-1"],
      ["moderator-add", "ann"],
      ["moderator-retire"],
    ]) {
      const r = await cli("moderation", ...argv);
      expect([argv, r.code, r.err[0]?.["error"]]).toEqual([argv, 2, "usage"]);
    }
    const bad = await cli("moderation", "moderator-add", "Ann", "x");
    expect([bad.code, bad.err]).toEqual([1, [{ error: "invalid" }]]);
  });
});
