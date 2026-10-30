import { encodeElectionDefinition } from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import { getTableConfig } from "drizzle-orm/pg-core";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  accountFollowHours,
  accountFollowResults,
  accountFollows,
  dropFollowResult,
  FollowError,
  type FollowErrorCode,
  followedPolls,
  followResults,
  isFollowing,
  landResults,
  MAX_FOLLOW_CHANGES_PER_HOUR,
  MAX_FOLLOWED_POLLS,
  newAccountId,
  noticeDue,
  pruneFollowHours,
  queueNotice,
  setFollow,
  storeDefinition,
} from "../src/index.ts";
import { type TestDb, testDb, typical } from "./db.ts";

// Following a poll (migrations/0050_poll_follows.sql, src/follows.ts; P2-25
// part 4): one row per account and poll, set only by an account verified by
// e-mail, read only by that account, with no time kept, limited per account
// and hour, and closed to new followers on a hidden poll (T-10, T-11, T-52,
// T-68). Once a poll's results are in (0051_follow_results.sql, part 4c),
// its follows become its followers' list of polls with results, each with a
// notice naming no poll (T-73).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

let db: TestDb;
let app: Sql;
let app2: Sql;
beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
  app2 = await db.as("abolish_app");
});
afterAll(() => db?.close());

const NOW = new Date("2026-10-30T12:34:56Z");
const at = { now: NOW };

async function election(): Promise<Uint8Array> {
  const id = new Uint8Array(randomBytes(32));
  await storeDefinition(app, encodeElectionDefinition({ ...typical, election_id: id }));
  return id;
}

async function newAccount({ verified = true } = {}): Promise<string> {
  const id = newAccountId();
  await app`
    INSERT INTO account_users VALUES (${id}, ${`${newAccountId()}@account.invalid`},
      false, '', NULL, now(), now())`;
  // A stand-in for a verified address: its hash and sealed box, as
  // account-emails.ts stores them.
  if (verified)
    await app`
      INSERT INTO account_emails VALUES (${id}, ${randomBytes(32)}, 'h1', ${randomBytes(40)}, 'b1', now())`;
  return id;
}

async function moderate(electionId: Uint8Array, action: "hide" | "delist"): Promise<void> {
  await app`INSERT INTO moderation_actions (election_id, action, reason, moderator, decided_at)
    VALUES (${electionId}, ${action}, ${action === "hide" ? "illegal" : "spam"}, 'mod', now())`;
}

async function refusedWith(p: Promise<unknown>): Promise<FollowErrorCode> {
  try {
    await p;
  } catch (e) {
    if (e instanceof FollowError) return e.code;
    throw e;
  }
  throw new Error("accepted");
}

async function failsWith(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
  } catch (e) {
    return (e as { code?: string }).code ?? "no code";
  }
  throw new Error("query succeeded");
}

const rowsOf = async (account: string) =>
  db.admin`SELECT * FROM account_follows WHERE user_id = ${account} ORDER BY election_id`;

describe("schema", () => {
  test("the Drizzle tables match the migrated ones", async () => {
    for (const table of [accountFollows, accountFollowHours, accountFollowResults]) {
      const config = getTableConfig(table);
      const cols = await db.admin`
        SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = ${db.schema} AND table_name = ${config.name} ORDER BY ordinal_position`;
      expect([
        config.name,
        cols.map((c) => [c["column_name"], c["data_type"], c["is_nullable"]]),
      ]).toEqual([
        config.name,
        config.columns.map((c) => [c.name, c.getSQLType(), c.notNull ? "NO" : "YES"]),
      ]);
    }
  });

  test("no follow or hour row keeps a time finer than the hour, or a ballot", async () => {
    const cols = await db.admin`
      SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = ${db.schema}
        AND table_name IN ('account_follows', 'account_follow_hours', 'account_follow_results')
      ORDER BY table_name, ordinal_position`;
    // T-11: the hour is the only time, and it names no poll.
    expect(cols.map((c) => [c["table_name"], c["column_name"], c["data_type"]])).toEqual([
      ["account_follow_hours", "user_id", "text"],
      ["account_follow_hours", "hour", "timestamp with time zone"],
      ["account_follow_hours", "changes", "integer"],
      ["account_follow_results", "user_id", "text"],
      ["account_follow_results", "election_id", "bytea"],
      ["account_follows", "user_id", "text"],
      ["account_follows", "election_id", "bytea"],
    ]);
    const account = await newAccount();
    await expect(
      app`INSERT INTO account_follow_hours VALUES (${account}, '2026-10-30T12:30:00Z', 1)`,
    ).rejects.toThrow(/check constraint/);
    expect(
      await failsWith(
        app`INSERT INTO account_follow_hours VALUES (${account}, '2026-10-30T12:00:00Z', 61)`,
      ),
    ).toBe("23514");
  });

  test("the app role can follow and stop, never change a follow in place", async () => {
    const [account, id] = [await newAccount(), await election()];
    await setFollow(app, account, id, true, at);
    expect(await failsWith(app`UPDATE account_follows SET election_id = ${randomBytes(32)}`)).toBe(
      "42501",
    );
    expect(await failsWith(app`TRUNCATE account_follows`)).toBe("42501");
    expect(await failsWith(app`TRUNCATE account_follow_hours`)).toBe("42501");
    await landResults(app, id, at);
    expect(
      await failsWith(app`UPDATE account_follow_results SET election_id = ${randomBytes(32)}`),
    ).toBe("42501");
    expect(await failsWith(app`TRUNCATE account_follow_results`)).toBe("42501");
  });

  test("the table refuses a malformed election ID", async () => {
    const account = await newAccount();
    expect(
      await failsWith(app`INSERT INTO account_follows VALUES (${account}, ${randomBytes(31)})`),
    ).toBe("23514");
    expect(
      await failsWith(
        app`INSERT INTO account_follow_results VALUES (${account}, ${randomBytes(33)})`,
      ),
    ).toBe("23514");
  });

  test("deleting an account deletes its follows and its hours, and no one else's", async () => {
    const [account, other, id] = [await newAccount(), await newAccount(), await election()];
    await setFollow(app, account, id, true, at);
    await setFollow(app, other, id, true, at);
    const landed = await election();
    await setFollow(app, account, landed, true, at);
    await landResults(app, landed, at);
    await app`DELETE FROM account_users WHERE id = ${account}`;
    expect(await rowsOf(account)).toHaveLength(0);
    expect(
      await db.admin`SELECT 1 FROM account_follow_results WHERE user_id = ${account}`,
    ).toHaveLength(0);
    expect(
      await db.admin`SELECT 1 FROM account_follow_hours WHERE user_id = ${account}`,
    ).toHaveLength(0);
    expect(await isFollowing(app, other, id)).toBe(true);
  });
});

describe("following and stopping", () => {
  test("one per account and poll, whatever the order of changes", async () => {
    const polls = [await election(), await election()];
    const accounts = [await newAccount(), await newAccount(), await newAccount()];
    // A model of the table: the polls each account follows, by index.
    const model = new Map(accounts.map((a) => [a, new Set<number>()]));
    let hours = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.constantFrom(...accounts), fc.nat({ max: 1 }), fc.boolean()), {
          maxLength: 12,
        }),
        async (changes) => {
          for (const [account, poll, on] of changes) {
            const mine = model.get(account)!;
            const changed = await setFollow(app, account, polls[poll]!, on, {
              // Each in its own hour, so the hour's limit stays out of it.
              now: new Date(NOW.getTime() + ++hours * 3_600_000),
            });
            expect(changed).toBe(mine.has(poll) !== on);
            if (on) mine.add(poll);
            else mine.delete(poll);
          }
          for (const a of accounts)
            for (const [i, p] of polls.entries())
              expect(await isFollowing(app, a, p)).toBe(model.get(a)!.has(i));
        },
      ),
      { numRuns: Math.min(numRuns, 50) },
    );
  });

  test("the same account following twice at once keeps one row and counts one change", async () => {
    const [account, id] = [await newAccount(), await election()];
    const changed = await Promise.all([
      setFollow(app, account, id, true, at),
      setFollow(app2, account, id, true, at),
    ]);
    expect(changed.sort()).toEqual([false, true]);
    expect(await rowsOf(account)).toHaveLength(1);
    expect(
      (await db.admin`SELECT changes FROM account_follow_hours WHERE user_id = ${account}`)[0],
    ).toEqual({ changes: 1 });
  });

  test("two accounts following one poll at once are both kept", async () => {
    const [a, b, id] = [await newAccount(), await newAccount(), await election()];
    await Promise.all([setFollow(app, a, id, true, at), setFollow(app2, b, id, true, at)]);
    expect([await isFollowing(app, a, id), await isFollowing(app, b, id)]).toEqual([true, true]);
  });

  test("a row holds the account and the poll, and nothing else", async () => {
    const [account, id] = [await newAccount(), await election()];
    await setFollow(app, account, id, true, at);
    expect(await rowsOf(account)).toEqual([{ user_id: account, election_id: Buffer.from(id) }]);
  });
});

describe("refusals", () => {
  test("an account not verified by e-mail can't follow, but can stop", async () => {
    const [account, id, other] = [await newAccount(), await election(), await election()];
    await setFollow(app, account, id, true, at);
    // Its address unlinked since.
    await db.admin`DELETE FROM account_emails WHERE user_id = ${account}`;
    expect(await refusedWith(setFollow(app, account, other, true, at))).toBe("account");
    expect(await setFollow(app, account, id, false, at)).toBe(true);
    expect(await rowsOf(account)).toHaveLength(0);
    const never = await newAccount({ verified: false });
    expect(await refusedWith(setFollow(app, never, id, true, at))).toBe("account");
  });

  test("an election with no stored definition takes no follower", async () => {
    const account = await newAccount();
    expect(
      await refusedWith(setFollow(app, account, new Uint8Array(randomBytes(32)), true, at)),
    ).toBe("unknown-election");
    expect(await rowsOf(account)).toHaveLength(0);
  });

  test("a hidden poll takes no new follower; one can still see it follows, and stop", async () => {
    const [account, newcomer, id] = [await newAccount(), await newAccount(), await election()];
    await setFollow(app, account, id, true, at);
    await moderate(id, "hide");
    expect(await refusedWith(setFollow(app, newcomer, id, true, at))).toBe("hidden");
    expect(await isFollowing(app, account, id)).toBe(true);
    expect(await setFollow(app, account, id, false, at)).toBe(true);
    expect(await rowsOf(account)).toHaveLength(0);
  });

  test("a delisted poll can still be followed", async () => {
    const [account, id] = [await newAccount(), await election()];
    await moderate(id, "delist");
    expect(await setFollow(app, account, id, true, at)).toBe(true);
    expect(await isFollowing(app, account, id)).toBe(true);
  });

  test("malformed arguments are type errors", async () => {
    const [account, id] = [await newAccount(), await election()];
    await expect(setFollow(app, "x", id, true, at)).rejects.toThrow(RangeError);
    await expect(setFollow(app, account, id.subarray(1), true, at)).rejects.toThrow(TypeError);
    await expect(setFollow(app, account, id, "yes" as unknown as boolean, at)).rejects.toThrow(
      TypeError,
    );
    await expect(setFollow(app, account, id, true, { now: new Date(Number.NaN) })).rejects.toThrow(
      TypeError,
    );
    await expect(isFollowing(app, "x", id)).rejects.toThrow(RangeError);
    await expect(isFollowing(app, account, id.subarray(1))).rejects.toThrow(TypeError);
    expect(await rowsOf(account)).toHaveLength(0);
  });
});

describe("the hour's limit (T-52)", () => {
  test(`${MAX_FOLLOW_CHANGES_PER_HOUR} changes an hour, then refused with nothing written`, async () => {
    const [account, id] = [await newAccount(), await election()];
    for (let i = 0; i < MAX_FOLLOW_CHANGES_PER_HOUR; i++)
      expect(await setFollow(app, account, id, i % 2 === 0, at)).toBe(true);
    // The last change stopped it, so the next one would follow.
    expect(await refusedWith(setFollow(app, account, id, true, at))).toBe("too-many-this-hour");
    expect(await rowsOf(account)).toHaveLength(0);
    // A change that changes nothing isn't counted, so it isn't refused.
    expect(await setFollow(app, account, id, false, at)).toBe(false);
    // Another account, and the next hour, are unaffected.
    expect(await setFollow(app, await newAccount(), id, true, at)).toBe(true);
    const next = { now: new Date("2026-10-30T13:00:00Z") };
    expect(await setFollow(app, account, id, true, next)).toBe(true);
  });

  test("changes at once can't take the hour's last one twice", async () => {
    const [account, one, two, three] = [
      await newAccount(),
      await election(),
      await election(),
      await election(),
    ];
    for (let i = 0; i < MAX_FOLLOW_CHANGES_PER_HOUR - 1; i++)
      await setFollow(app, account, one, i % 2 === 0, at);
    const results = await Promise.allSettled([
      setFollow(app, account, two, true, at),
      setFollow(app2, account, three, true, at),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((refused.reason as FollowError).code).toBe("too-many-this-hour");
    expect([await isFollowing(app, account, two), await isFollowing(app, account, three)]).toEqual(
      expect.arrayContaining([true, false]),
    );
  });

  test("the hour is kept truncated, and pruning deletes the hours gone by", async () => {
    const account = await newAccount();
    const polls = [await election(), await election(), await election()];
    await setFollow(app, account, polls[0]!, true, { now: new Date("2026-10-30T10:59:59Z") });
    await setFollow(app, account, polls[1]!, true, { now: new Date("2026-10-30T11:15:00Z") });
    await setFollow(app, account, polls[2]!, true, at);
    const hours = async () =>
      (
        await db.admin`SELECT hour FROM account_follow_hours WHERE user_id = ${account} ORDER BY hour`
      ).map((r) => (r["hour"] as Date).toISOString());
    expect(await hours()).toEqual([
      "2026-10-30T10:00:00.000Z",
      "2026-10-30T11:00:00.000Z",
      "2026-10-30T12:00:00.000Z",
    ]);
    expect(await pruneFollowHours(app, NOW)).toBeGreaterThanOrEqual(1);
    // The hour before stays, so a clock running ahead never wipes this one.
    expect(await hours()).toEqual(["2026-10-30T11:00:00.000Z", "2026-10-30T12:00:00.000Z"]);
    // Pruning the hours never touches the follows.
    expect(await rowsOf(account)).toHaveLength(3);
  });
});

const noticeOf = async (account: string) => {
  const [row] = await db.admin`
    SELECT not_before, tries, moderation, results FROM account_notices WHERE user_id = ${account}`;
  return row === undefined
    ? undefined
    : {
        notBefore: row["not_before"] as Date,
        tries: row["tries"],
        moderation: row["moderation"],
        results: row["results"],
      };
};

describe("results (part 4c)", () => {
  test("each follow becomes its account's listed poll with results, and its notice", async () => {
    const [a, b, c] = [await newAccount(), await newAccount(), await newAccount()];
    const [poll, other] = [await election(), await election()];
    for (const account of [a, b]) await setFollow(app, account, poll, true, at);
    await setFollow(app, c, other, true, at);
    expect(await landResults(app, poll, at)).toBe(2);
    for (const account of [a, b]) {
      expect(await isFollowing(app, account, poll)).toBe(false);
      expect(await followResults(app, account)).toEqual([poll]);
      // T-73: due after the next UTC midnight, never at the results' time.
      expect(await noticeOf(account)).toEqual({
        notBefore: noticeDue(NOW),
        tries: 0,
        moderation: false,
        results: true,
      });
    }
    // Another poll's follower is neither told nor moved.
    expect(await isFollowing(app, c, other)).toBe(true);
    expect(await followResults(app, c)).toEqual([]);
    expect(await noticeOf(c)).toBeUndefined();
    // Again, nothing changes: no one follows the poll now.
    expect(await landResults(app, poll, { now: new Date(NOW.getTime() + 86_400_000) })).toBe(0);
    expect((await noticeOf(a))?.notBefore).toEqual(noticeDue(NOW));
  });

  test("results join a moderation notice waiting, and a decision joins results", async () => {
    const [a, b] = [await newAccount(), await newAccount()];
    const poll = await election();
    for (const account of [a, b]) await setFollow(app, account, poll, true, at);
    // A notice for a decision tomorrow, already tried once.
    const tomorrow = new Date(NOW.getTime() + 86_400_000);
    await queueNotice(drizzle({ client: app }), a, tomorrow);
    await app`UPDATE account_notices SET tries = 1 WHERE user_id = ${a}`;
    await landResults(app, poll, at);
    // The later due time is kept, and the tries reset so a send in flight keeps it.
    expect(await noticeOf(a)).toEqual({
      notBefore: noticeDue(tomorrow),
      tries: 0,
      moderation: true,
      results: true,
    });
    await queueNotice(drizzle({ client: app }), b, NOW);
    expect(await noticeOf(b)).toEqual({
      notBefore: noticeDue(NOW),
      tries: 0,
      moderation: true,
      results: true,
    });
  });

  test("a follow set as results land is either told or still following", async () => {
    const poll = await election();
    const early = await newAccount();
    await setFollow(app, early, poll, true, at);
    const late = await newAccount();
    const [told] = await Promise.all([
      landResults(app, poll, at),
      setFollow(app2, late, poll, true, at),
    ]);
    const lateTold = (await followResults(app, late)).length === 1;
    expect(told).toBe(lateTold ? 2 : 1);
    expect(await isFollowing(app, late, poll)).toBe(!lateTold);
    expect((await noticeOf(late)) !== undefined).toBe(lateTold);
    expect(await followResults(app, early)).toEqual([poll]);
  });

  test("an account takes a poll off its list, and only its own", async () => {
    const [a, b] = [await newAccount(), await newAccount()];
    const [p, q] = [await election(), await election()];
    for (const account of [a, b])
      for (const poll of [p, q]) await setFollow(app, account, poll, true, at);
    await landResults(app, p, at);
    await landResults(app, q, at);
    const both = [p, q].sort((x, y) => Buffer.compare(x, y));
    expect(await followResults(app, a)).toEqual(both);
    expect(await dropFollowResult(app, a, p)).toBe(true);
    expect(await dropFollowResult(app, a, p)).toBe(false);
    expect(await followResults(app, a)).toEqual([q]);
    expect(await followResults(app, b)).toEqual(both);
    // Following again after results starts a new follow; the listed poll stays.
    await setFollow(app, b, p, true, at);
    expect(await isFollowing(app, b, p)).toBe(true);
    expect(await landResults(app, p, at)).toBe(1);
    expect(await followResults(app, b)).toEqual(both);
  });

  test("followed polls page through every poll followed, once each, in byte order", async () => {
    // A clean slate, so the pages hold only this test's polls.
    await db.admin`DELETE FROM account_follows`;
    const accounts = [await newAccount(), await newAccount()];
    const polls = [];
    for (let i = 0; i < 5; i++) polls.push(await election());
    for (const [i, poll] of polls.entries()) {
      await setFollow(app, accounts[0]!, poll, true, at);
      if (i % 2 === 0) await setFollow(app, accounts[1]!, poll, true, at);
    }
    const seen: Uint8Array[] = [];
    let after: Uint8Array | undefined;
    for (;;) {
      const page = await followedPolls(app, { limit: 2, ...(after && { after }) });
      if (page.length === 0) break;
      seen.push(...page);
      after = page.at(-1);
    }
    expect(seen).toEqual([...polls].sort((x, y) => Buffer.compare(x, y)));
    await landResults(app, polls[0]!, at);
    expect(await followedPolls(app, {})).not.toContainEqual(polls[0]);
  });

  test("malformed arguments are type and range errors", async () => {
    const account = await newAccount();
    await expect(landResults(app, new Uint8Array(31), at)).rejects.toThrow(TypeError);
    await expect(landResults(app, new Uint8Array(32), { now: new Date(NaN) })).rejects.toThrow(
      TypeError,
    );
    await expect(followResults(app, "Not-an-ID")).rejects.toThrow(RangeError);
    await expect(dropFollowResult(app, account, new Uint8Array(33))).rejects.toThrow(TypeError);
    await expect(followedPolls(app, { limit: 0 })).rejects.toThrow(RangeError);
    await expect(followedPolls(app, { limit: MAX_FOLLOWED_POLLS + 1 })).rejects.toThrow(RangeError);
    await expect(followedPolls(app, { after: new Uint8Array(3) })).rejects.toThrow(TypeError);
  });
});

test("follows.ts reads no board table but the definitions, and writes none", () => {
  const src = readFileSync(new URL("../src/follows.ts", import.meta.url), "utf8");
  expect(src).not.toMatch(
    /board[A-Z_]\w*|election_?[Rr]egistrations|election_?[Ss]chedules|appendEntry|identity_?[Bb]ackups|account_?[Tt]okens/,
  );
  // Its only reads beyond the account tables: the definitions and moderation;
  // it writes the notices of results (part 4c), an account table.
  expect([...src.matchAll(/from "(\.[^"]+)"/g)].map((m) => m[1])).toEqual([
    "./account-notices.ts",
    "./bytes.ts",
    "./db/schema/index.ts",
    "./definitions.ts",
    "./moderation.ts",
  ]);
});
