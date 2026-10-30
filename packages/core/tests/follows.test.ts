import { encodeElectionDefinition } from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  accountFollowHours,
  accountFollows,
  FollowError,
  type FollowErrorCode,
  isFollowing,
  MAX_FOLLOW_CHANGES_PER_HOUR,
  newAccountId,
  pruneFollowHours,
  setFollow,
  storeDefinition,
} from "../src/index.ts";
import { type TestDb, testDb, typical } from "./db.ts";

// Following a poll (migrations/0050_poll_follows.sql, src/follows.ts; P2-25
// part 4): one row per account and poll, set only by an account verified by
// e-mail, read only by that account, with no time kept, limited per account
// and hour, and closed to new followers on a hidden poll (T-10, T-11, T-52,
// T-68).

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
    for (const table of [accountFollows, accountFollowHours]) {
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
        AND table_name IN ('account_follows', 'account_follow_hours')
      ORDER BY table_name, ordinal_position`;
    // T-11: the hour is the only time, and it names no poll.
    expect(cols.map((c) => [c["table_name"], c["column_name"], c["data_type"]])).toEqual([
      ["account_follow_hours", "user_id", "text"],
      ["account_follow_hours", "hour", "timestamp with time zone"],
      ["account_follow_hours", "changes", "integer"],
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
  });

  test("the table refuses a malformed election ID", async () => {
    const account = await newAccount();
    expect(
      await failsWith(app`INSERT INTO account_follows VALUES (${account}, ${randomBytes(31)})`),
    ).toBe("23514");
  });

  test("deleting an account deletes its follows and its hours, and no one else's", async () => {
    const [account, other, id] = [await newAccount(), await newAccount(), await election()];
    await setFollow(app, account, id, true, at);
    await setFollow(app, other, id, true, at);
    await app`DELETE FROM account_users WHERE id = ${account}`;
    expect(await rowsOf(account)).toHaveLength(0);
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

test("follows.ts reads no board table but the definitions, and writes none", () => {
  const src = readFileSync(new URL("../src/follows.ts", import.meta.url), "utf8");
  expect(src).not.toMatch(
    /board[A-Z_]\w*|election_?[Rr]egistrations|election_?[Ss]chedules|appendEntry|identity_?[Bb]ackups|account_?[Tt]okens/,
  );
  // Its only reads beyond the account tables: the definitions and moderation.
  expect([...src.matchAll(/from "(\.[^"]+)"/g)].map((m) => m[1])).toEqual([
    "./bytes.ts",
    "./db/schema/index.ts",
    "./definitions.ts",
    "./moderation.ts",
  ]);
});
