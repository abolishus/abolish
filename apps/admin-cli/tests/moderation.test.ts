import {
  fileAppeal,
  fileProfileAppeal,
  makeProfile,
  newAccountId,
  newProfileHandle,
  insertPollTags,
  readPollTags,
  refilePoll,
  report,
  reportProfile,
  storeDefinition,
} from "@abolishus/core";
import { addModerators, newAccount, type TestDb, testDb, typical } from "@abolishus/core/test-db";
import { encodeElectionDefinition } from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { run } from "../src/index.ts";

// The moderation commands against Postgres, as the app role: they read the
// queue a page at a time (T-52), review only what the moderator saw, record
// decisions through core's rules (T-68), and print the public log without the
// moderator; the `profile-` commands do the same for creator profiles, naming
// each by its handle, never its account or name (T-75).

let db: TestDb;
let app: Sql;
let mods: Map<string, string>;
beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
  mods = await addModerators(app, "m", "mod-1", "mod-7");
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

  test("the log prints refilings with what they changed, never the place or the moderator", async () => {
    const id = await election();
    await insertPollTags(app, bytes(id), { topic: "food", place: "14 Elm Street" });
    const { seq } = await refilePoll(app, bytes(id), {
      tags: { topic: "housing" },
      reason: "personal-data",
      moderator: "mod-7",
    });
    const log = await cli("moderation", "log", "--after", String(seq - 1n), "--limit", "1");
    expect(log.out[0]).toEqual({
      seq: String(seq),
      electionId: id,
      action: "refile",
      reason: "personal-data",
      decidedAt: expect.any(String),
      topic: "housing",
      place: "cleared",
    });
    expect(JSON.stringify(log)).not.toMatch(/Elm Street|mod-7/);
  });

  test("refiles a poll, setting, clearing or keeping each tag, and logs it without the place", async () => {
    const id = await election();
    const place = `14 Elm Street ${randomBytes(4).toString("hex")}`;
    await insertPollTags(app, bytes(id), { topic: "food", place });
    const refile = (...args: string[]) =>
      cli("moderation", "refile", id, ...args, "--moderator", "mod-1");

    const moved = await refile("misfiled", "--topic", "housing", "--keep-place");
    expect(moved).toEqual({ code: 0, out: [{ seq: expect.any(String), electionId: id }], err: [] });
    expect(await readPollTags(app, bytes(id))).toEqual({
      state: "visible",
      tags: { topic: "housing", place },
    });
    // A hidden poll's place is withheld from every read, so keeping a tag
    // needs no knowledge of it.
    expect(
      (await cli("moderation", "decide", id, "hide", "threat", "--moderator", "mod-1")).code,
    ).toBe(0);
    const cleared = await refile("personal-data", "--keep-topic", "--no-place");
    expect(cleared.code).toBe(0);
    // A place is filed as typed, even one spelling a choice's name.
    expect((await refile("misfiled", "--no-topic", "--place", "keep")).code).toBe(0);
    expect(
      (await cli("moderation", "decide", id, "restore", "error", "--moderator", "mod-1")).code,
    ).toBe(0);
    expect(await readPollTags(app, bytes(id))).toEqual({
      state: "visible",
      tags: { place: "keep" },
    });

    const seq = BigInt(String(moved.out[0]!["seq"]));
    const log = (await cli("moderation", "log", "--after", String(seq - 1n))).out.filter(
      (e) => e["action"] === "refile",
    );
    expect(log).toEqual([
      expect.objectContaining({ reason: "misfiled", topic: "housing" }),
      expect.objectContaining({ reason: "personal-data", place: "cleared" }),
      expect.objectContaining({ reason: "misfiled", topic: null, place: "changed" }),
    ]);
    expect(log[0]).not.toHaveProperty("place");
    expect(log[1]).not.toHaveProperty("topic");
    expect(JSON.stringify(log)).not.toMatch(/Elm Street|mod-1/);
  });

  test("a refiling core refuses, or one malformed, records nothing", async () => {
    const id = await election();
    await insertPollTags(app, bytes(id), { topic: "food" });
    const before = (await cli("moderation", "log", "--limit", "1000")).out.length;
    for (const [args, code] of [
      [[id, "misfiled", "--keep-topic", "--keep-place", "--moderator", "mod-1"], "no-change"],
      [[id, "misfiled", "--topic", "food", "--no-place", "--moderator", "mod-1"], "no-change"],
      [
        ["00".repeat(32), "misfiled", "--no-topic", "--no-place", "--moderator", "mod-1"],
        "unknown-election",
      ],
      [[id, "misfiled", "--no-topic", "--no-place", "--moderator", "mod-9"], "unknown-moderator"],
    ] as const)
      expect(await cli("moderation", "refile", ...args)).toEqual({
        code: 1,
        out: [],
        err: [{ error: code }],
      });
    const ok = ["--topic", "sport", "--no-place", "--moderator", "mod-1"];
    for (const args of [
      [id, "misfiled", "--no-place", "--moderator", "mod-1"],
      [id, "misfiled", "--topic", "sport", "--moderator", "mod-1"],
      [id, "misfiled", "--topic", "sport", "--keep-topic", "--no-place", "--moderator", "mod-1"],
      [id, "misfiled", "--no-topic", "--keep-topic", "--no-place", "--moderator", "mod-1"],
      [id, "misfiled", "--no-topic", "--place", "Mill Lane", "--no-place", "--moderator", "mod-1"],
      [id, "misfiled", "--topic", "weather", "--no-place", "--moderator", "mod-1"],
      [id, "misfiled", "--no-topic", "--place", " Mill Lane", "--moderator", "mod-1"],
      [id, "misfiled", "--no-topic", "--place", "Mill  Lane", "--moderator", "mod-1"],
      [id, "misfiled", "--no-topic", "--place", "Mill\u202eLane", "--moderator", "mod-1"],
      [id, "misfiled", "--no-topic", "--place", "a".repeat(81), "--moderator", "mod-1"],
      [id, "misfiled", "--no-topic", "--place", "", "--moderator", "mod-1"],
      [id, "error", ...ok],
      [id, "appeal-upheld", ...ok],
      [id, "misfiled", "--topic", "sport", "--no-place"],
      [id.toUpperCase(), "misfiled", ...ok],
      [id, ...ok],
      [id, "misfiled", "extra", ...ok],
      [id, "misfiled", "--no-topic=yes", "--no-place", "--moderator", "mod-1"],
    ]) {
      const r = await cli("moderation", "refile", ...args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.out).toEqual([]);
      expect(r.err).toEqual([
        { error: "usage", detail: expect.any(String), usage: expect.any(String) },
      ]);
    }
    expect((await cli("moderation", "log", "--limit", "1000")).out).toHaveLength(before);
    expect(await readPollTags(app, bytes(id))).toEqual({
      state: "visible",
      tags: { topic: "food" },
    });
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
    const refiled = await cli(
      "moderation",
      "refile",
      mine.id,
      "misfiled",
      "--no-topic",
      "--no-place",
      "--moderator",
      "ann",
    );
    expect([refiled.code, refiled.err]).toEqual([1, [{ error: "own-poll" }]]);
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

describe("profiles", () => {
  const NAME = "Riverside Neighbours";

  /** A profile of `account`'s, or of a fresh account, with a stand-in for its verified phone. */
  async function profile(account?: string) {
    const author = account ?? (await newAccount(app));
    await app`INSERT INTO account_phones VALUES (${author}, ${randomBytes(32)}, 'p1', '2026-10-01T00:00:00Z')`;
    const handle = await makeProfile(app, author, NAME, { now: new Date("2026-10-22T12:00:00Z") });
    return { author, handle };
  }

  test("pages the profiles' queue by its cursor and reviews only what was seen", async () => {
    const handles = [(await profile()).handle, (await profile()).handle, (await profile()).handle];
    for (const h of handles) await reportProfile(app, h, "impersonation");
    await reportProfile(app, handles[0]!, "impersonation");

    const seen: string[] = [];
    let after: string[] = [];
    for (;;) {
      const page = await cli("moderation", "profile-queue", "--limit", "2", ...after);
      expect(page.code).toBe(0);
      const next = page.out.find((r) => "next" in r);
      for (const r of page.out)
        if (!("next" in r)) seen.push(`${String(r["handle"])}/${String(r["reason"])}`);
      if (next === undefined) break;
      expect(page.out).toHaveLength(3);
      after = ["--after", String(next["next"])];
    }
    // This file's schema holds only these profile reports, each pair once.
    expect(seen.sort()).toEqual(handles.map((h) => `${h}/impersonation`).sort());

    const first = (await cli("moderation", "profile-queue")).out.find(
      (r) => r["handle"] === handles[0],
    );
    expect(first).toMatchObject({ reason: "impersonation", pending: "2", total: "2" });
    expect(first?.["pendingSince"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/);

    // A report counted after the queue was read stays pending.
    await reportProfile(app, handles[0]!, "impersonation");
    expect(await cli("moderation", "profile-review", handles[0]!, "impersonation", "2")).toEqual({
      code: 0,
      out: [{ handle: handles[0], reason: "impersonation", pending: "1" }],
      err: [],
    });
    const over = await cli("moderation", "profile-review", handles[1]!, "impersonation", "5");
    expect([over.code, over.err]).toEqual([1, [{ error: "invalid" }]]);
  });

  test("records decisions and prints them in the one public log, by handle only", async () => {
    const { author, handle } = await profile();
    expect(await cli("moderation", "profile-status", handle)).toEqual({
      code: 0,
      out: [{ handle, state: "visible" }],
      err: [],
    });

    const id = await election();
    const poll = await cli("moderation", "decide", id, "hide", "spam", "--moderator", "mod-1");
    const hidden = await cli(
      "moderation",
      "profile-decide",
      handle,
      "hide",
      "impersonation",
      "--moderator",
      "mod-7",
    );
    expect(hidden).toEqual({
      code: 0,
      out: [{ seq: expect.any(String), handle, state: "hidden" }],
      err: [],
    });
    const seq = String(hidden.out[0]!["seq"]);
    const status = await cli("moderation", "profile-status", handle);
    expect(status.out).toEqual([
      {
        handle,
        state: "hidden",
        latest: { seq, action: "hide", reason: "impersonation", decidedAt: expect.any(String) },
      },
    ]);
    const restored = await cli(
      "moderation",
      "profile-decide",
      handle,
      "restore",
      "error",
      "--moderator",
      "mod-7",
    );
    expect(restored.out).toEqual([{ seq: expect.any(String), handle, state: "visible" }]);

    // One numbering: the poll's decision, then the profile's two.
    const log = await cli(
      "moderation",
      "log",
      "--after",
      String(BigInt(poll.out[0]!["seq"] as string) - 1n),
    );
    expect(log.out.map((e) => [e["electionId"] ?? e["handle"], e["action"], e["reason"]])).toEqual([
      [id, "hide", "spam"],
      [handle, "hide", "impersonation"],
      [handle, "restore", "error"],
    ]);
    expect(log.out[1]).toEqual({
      seq,
      handle,
      action: "hide",
      reason: "impersonation",
      decidedAt: expect.any(String),
    });
    for (const secret of ["mod-7", author, NAME])
      expect(JSON.stringify([status, log])).not.toContain(secret);
  });

  test("core's refusals come back as their codes, with nothing recorded", async () => {
    const { handle } = await profile();
    // mod-1's own account has a profile too.
    const own = await profile(mods.get("mod-1"));
    const before = (await cli("moderation", "log", "--limit", "1000")).out.length;
    for (const [argv, code] of [
      [["profile-decide", newProfileHandle(), "hide", "spam"], "unknown-profile"],
      [["profile-decide", handle, "restore", "error"], "no-change"],
      [["profile-decide", handle, "restore", "appeal-upheld"], "appeal-only"],
      [["profile-decide", own.handle, "hide", "spam"], "own-profile"],
      [["profile-decide", handle, "hide", "spam", "--moderator", "Mod"], "invalid"],
      [["profile-decide", handle, "hide", "spam", "--moderator", "nobody"], "unknown-moderator"],
    ] as const) {
      const moderator = argv.length === 4 ? ["--moderator", "mod-1"] : [];
      expect(await cli("moderation", ...argv, ...moderator), argv.join(" ")).toEqual({
        code: 1,
        out: [],
        err: [{ error: code }],
      });
    }
    expect((await cli("moderation", "log", "--limit", "1000")).out).toHaveLength(before);
    const hide = ["profile-decide", handle, "hide", "spam", "--moderator", "mod-1"];
    expect((await cli("moderation", ...hide)).code).toBe(0);
    // The same ground again changes nothing.
    expect((await cli("moderation", ...hide)).err).toEqual([{ error: "no-change" }]);
  });

  test("refuses malformed arguments before reaching the database", async () => {
    const { handle } = await profile();
    for (const argv of [
      ["profile-decide", handle, "hide", "spam"],
      ["profile-decide", handle, "delist", "spam", "--moderator", "m"],
      ["profile-decide", handle, "hide", "error", "--moderator", "m"],
      ["profile-decide", handle, "restore", "spam", "--moderator", "m"],
      ["profile-decide", handle.toUpperCase(), "hide", "spam", "--moderator", "m"],
      ["profile-decide", handle.slice(1), "hide", "spam", "--moderator", "m"],
      ["profile-decide", `${handle}a`, "hide", "spam", "--moderator", "m"],
      ["profile-decide", `${handle.slice(1)}1`, "hide", "spam", "--moderator", "m"],
      ["profile-status", "00".repeat(32)],
      ["profile-status"],
      ["profile-review", handle, "spam", "0"],
      ["profile-review", handle, "error", "1"],
      ["profile-queue", "--after", "garbage"],
      ["profile-queue", "--after", `2026-01-01T00:30:00.000Z/${handle}/spam`],
      ["profile-queue", "--after", `2026-01-01T00:00:00.000Z/${handle.toUpperCase()}/spam`],
      ["profile-queue", "--after", `2026-01-01T00:00:00.000Z/${"00".repeat(32)}/spam`],
      ["profile-queue", "--after", `2026-01-01T00:00:00.000Z/${handle}/error`],
      ["profile-queue", "--limit", "1001"],
      ["profile-appeals", "--limit", "0"],
      ["profile-appeals", "--after", "-1"],
      ["profile-appeal-decide", "1", "upheld"],
      ["profile-appeal-decide", "0", "upheld", "--moderator", "m"],
      ["profile-appeal-decide", "1", "maybe", "--moderator", "m"],
    ]) {
      const r = await cli("moderation", ...argv);
      expect([argv, r.code, r.out, r.err[0]?.["error"]]).toEqual([argv, 2, [], "usage"]);
    }
    expect((await cli("moderation", "profile-status", handle)).out).toEqual([
      { handle, state: "visible" },
    ]);
  });

  test("lists open appeals without the author and reviews them", async () => {
    const { author, handle } = await profile();
    const hidden = await cli(
      "moderation",
      "profile-decide",
      handle,
      "hide",
      "harassment",
      "--moderator",
      "mod-1",
    );
    const seq = String(hidden.out[0]!["seq"]);
    await fileProfileAppeal(app, author);
    const appeals = await cli("moderation", "profile-appeals", "--after", String(BigInt(seq) - 1n));
    expect(appeals.out).toEqual([
      {
        decisionSeq: seq,
        handle,
        action: "hide",
        reason: "harassment",
        decidedAt: expect.any(String),
        filedAt: expect.any(String),
      },
    ]);
    expect(JSON.stringify(appeals)).not.toContain(author);
    const decide = (outcome: string, moderator: string) =>
      cli("moderation", "profile-appeal-decide", seq, outcome, "--moderator", moderator);
    const same = await decide("upheld", "mod-1");
    expect([same.code, same.err]).toEqual([1, [{ error: "same-moderator" }]]);
    expect(await decide("upheld", "mod-7")).toEqual({
      code: 0,
      out: [
        { decisionSeq: seq, outcome: "upheld", state: "visible", restoreSeq: expect.any(String) },
      ],
      err: [],
    });
    const status = await cli("moderation", "profile-status", handle);
    expect(status.out[0]!["latest"]).toMatchObject({ action: "restore", reason: "appeal-upheld" });
    const again = await decide("rejected", "m");
    expect([again.code, again.err]).toEqual([1, [{ error: "reviewed" }]]);
    const unknown = await cli(
      "moderation",
      "profile-appeal-decide",
      "9223372036854775807",
      "upheld",
      "--moderator",
      "m",
    );
    expect([unknown.code, unknown.err]).toEqual([1, [{ error: "not-found" }]]);
  });
});
