import { encodeElectionDefinition } from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  accountReactionHours,
  accountReactions,
  MAX_REACTION_CHANGES_PER_HOUR,
  newAccountId,
  pruneReactionHours,
  type Reaction,
  ReactionError,
  type ReactionErrorCode,
  REACTIONS,
  readOwnReactions,
  readReactionCounts,
  setReaction,
  storeDefinition,
} from "../src/index.ts";
import { type TestDb, testDb, typical } from "./db.ts";

// Reactions on a poll (migrations/0032_poll_reactions.sql, src/reactions.ts;
// P2-25 part 5): one per account, poll and reaction, set only by an account
// verified by e-mail, public as counts and never as who, with no time kept,
// limited per account and hour, and closed on a hidden poll (T-10, T-11,
// T-52, T-68).

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

const NOW = new Date("2026-10-22T12:34:56Z");
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

async function hide(electionId: Uint8Array): Promise<void> {
  await app`INSERT INTO moderation_actions (election_id, action, reason, moderator, decided_at)
    VALUES (${electionId}, 'hide', 'illegal', 'mod', now())`;
}

async function refusedWith(p: Promise<unknown>): Promise<ReactionErrorCode> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ReactionError) return e.code;
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

const zero = Object.fromEntries(REACTIONS.map((r) => [r, 0]));
const rowsOf = async (account: string) =>
  db.admin`SELECT * FROM account_reactions WHERE user_id = ${account} ORDER BY reaction`;

describe("schema", () => {
  test("the Drizzle tables match the migrated ones", async () => {
    for (const table of [accountReactions, accountReactionHours]) {
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

  test("the table's reactions are exactly REACTIONS", async () => {
    const sql = readFileSync(
      new URL("../src/db/migrations/0032_poll_reactions.sql", import.meta.url),
      "utf8",
    );
    const list = /reaction IN \(([^)]*)\)/.exec(sql)?.[1];
    expect(list?.split(",").map((s) => s.trim().replaceAll("'", ""))).toEqual([...REACTIONS]);
  });

  test("no reaction or hour row keeps a time finer than the hour, or a ballot", async () => {
    const cols = await db.admin`
      SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = ${db.schema}
        AND table_name IN ('account_reactions', 'account_reaction_hours')
      ORDER BY table_name, ordinal_position`;
    // T-11: the hour is the only time, and it names no poll.
    expect(cols.map((c) => [c["table_name"], c["column_name"], c["data_type"]])).toEqual([
      ["account_reaction_hours", "user_id", "text"],
      ["account_reaction_hours", "hour", "timestamp with time zone"],
      ["account_reaction_hours", "changes", "integer"],
      ["account_reactions", "user_id", "text"],
      ["account_reactions", "election_id", "bytea"],
      ["account_reactions", "reaction", "text"],
    ]);
    const account = await newAccount();
    await expect(
      app`INSERT INTO account_reaction_hours VALUES (${account}, '2026-10-22T12:30:00Z', 1)`,
    ).rejects.toThrow(/check constraint/);
  });

  test("the app role can set and take back a reaction, never change one in place", async () => {
    const [account, id] = [await newAccount(), await election()];
    await setReaction(app, account, id, "heart", true, at);
    expect(await failsWith(app`UPDATE account_reactions SET reaction = 'sad'`)).toBe("42501");
    expect(await failsWith(app`TRUNCATE account_reactions`)).toBe("42501");
    expect(await failsWith(app`TRUNCATE account_reaction_hours`)).toBe("42501");
  });

  test("the table refuses a reaction outside the set and a malformed election ID", async () => {
    const account = await newAccount();
    expect(
      await failsWith(
        app`INSERT INTO account_reactions VALUES (${account}, ${randomBytes(32)}, 'yes')`,
      ),
    ).toBe("23514");
    expect(
      await failsWith(
        app`INSERT INTO account_reactions VALUES (${account}, ${randomBytes(31)}, 'heart')`,
      ),
    ).toBe("23514");
  });

  test("deleting an account deletes its reactions and its hours, and the counts drop", async () => {
    const [account, other, id] = [await newAccount(), await newAccount(), await election()];
    await setReaction(app, account, id, "laugh", true, at);
    await setReaction(app, other, id, "laugh", true, at);
    await app`DELETE FROM account_users WHERE id = ${account}`;
    expect(await rowsOf(account)).toHaveLength(0);
    expect(
      await db.admin`SELECT 1 FROM account_reaction_hours WHERE user_id = ${account}`,
    ).toHaveLength(0);
    expect((await readReactionCounts(app, id)).laugh).toBe(1);
  });
});

describe("setting and taking back", () => {
  test("one per account, poll and reaction, whatever the order of changes", async () => {
    const id = await election();
    const accounts = [await newAccount(), await newAccount(), await newAccount()];
    // A model of the table: the reactions set per account.
    const model = new Map(accounts.map((a) => [a, new Set<Reaction>()]));
    let hours = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.tuple(fc.constantFrom(...accounts), fc.constantFrom(...REACTIONS), fc.boolean()),
          { maxLength: 12 },
        ),
        async (changes) => {
          for (const [account, reaction, on] of changes) {
            const mine = model.get(account)!;
            const changed = await setReaction(app, account, id, reaction, on, {
              // Each in its own hour, so the hour's limit stays out of it.
              now: new Date(NOW.getTime() + ++hours * 3_600_000),
            });
            expect(changed).toBe(mine.has(reaction) !== on);
            if (on) mine.add(reaction);
            else mine.delete(reaction);
          }
          const counts = await readReactionCounts(app, id);
          for (const r of REACTIONS)
            expect(counts[r]).toBe([...model.values()].filter((s) => s.has(r)).length);
          for (const a of accounts)
            expect(await readOwnReactions(app, a, id)).toEqual(
              REACTIONS.filter((r) => model.get(a)!.has(r)),
            );
        },
      ),
      { numRuns: Math.min(numRuns, 50) },
    );
  });

  test("two accounts setting the same reaction at once are both counted", async () => {
    const [a, b, id] = [await newAccount(), await newAccount(), await election()];
    await Promise.all([
      setReaction(app, a, id, "wow", true, at),
      setReaction(app2, b, id, "wow", true, at),
    ]);
    expect(await readReactionCounts(app, id)).toEqual({ ...zero, wow: 2 });
  });

  test("the same account setting one twice at once keeps one row and counts one change", async () => {
    const [account, id] = [await newAccount(), await election()];
    const changed = await Promise.all([
      setReaction(app, account, id, "clap", true, at),
      setReaction(app2, account, id, "clap", true, at),
    ]);
    expect(changed.sort()).toEqual([false, true]);
    expect(await rowsOf(account)).toHaveLength(1);
    expect(
      (await db.admin`SELECT changes FROM account_reaction_hours WHERE user_id = ${account}`)[0],
    ).toEqual({ changes: 1 });
  });

  test("counts are per poll", async () => {
    const [account, one, two] = [await newAccount(), await election(), await election()];
    await setReaction(app, account, one, "sad", true, at);
    expect(await readReactionCounts(app, one)).toEqual({ ...zero, sad: 1 });
    expect(await readReactionCounts(app, two)).toEqual(zero);
    expect(await readOwnReactions(app, account, two)).toEqual([]);
  });

  test("a row holds the account, the poll and the reaction, and nothing else", async () => {
    const [account, id] = [await newAccount(), await election()];
    await setReaction(app, account, id, "thinking", true, at);
    expect(await rowsOf(account)).toEqual([
      { user_id: account, election_id: Buffer.from(id), reaction: "thinking" },
    ]);
  });
});

describe("refusals", () => {
  test("an account not verified by e-mail can't set a reaction, but can take one back", async () => {
    const [account, id] = [await newAccount(), await election()];
    await setReaction(app, account, id, "heart", true, at);
    // Its address unlinked since.
    await db.admin`DELETE FROM account_emails WHERE user_id = ${account}`;
    expect(await refusedWith(setReaction(app, account, id, "laugh", true, at))).toBe("account");
    expect(await setReaction(app, account, id, "heart", false, at)).toBe(true);
    expect(await rowsOf(account)).toHaveLength(0);
  });

  test("a reaction outside the set is refused before anything is read", async () => {
    const [account, id] = [await newAccount({ verified: false }), await election()];
    await fc.assert(
      fc.asyncProperty(
        fc.string().filter((s) => !(REACTIONS as readonly string[]).includes(s)),
        async (r) => {
          expect(await refusedWith(setReaction(app, account, id, r as Reaction, true, at))).toBe(
            "invalid",
          );
        },
      ),
      { numRuns: Math.min(numRuns, 100) },
    );
  });

  test("an election with no stored definition takes no reaction", async () => {
    const account = await newAccount();
    expect(
      await refusedWith(
        setReaction(app, account, new Uint8Array(randomBytes(32)), "heart", true, at),
      ),
    ).toBe("unknown-election");
    expect(await rowsOf(account)).toHaveLength(0);
  });

  test("a hidden poll takes no new reaction and shows no counts; one can still be taken back", async () => {
    const [account, id] = [await newAccount(), await election()];
    await setReaction(app, account, id, "heart", true, at);
    await hide(id);
    expect(await refusedWith(setReaction(app, account, id, "laugh", true, at))).toBe("hidden");
    expect(await refusedWith(readReactionCounts(app, id))).toBe("hidden");
    expect(await setReaction(app, account, id, "heart", false, at)).toBe(true);
    expect(await rowsOf(account)).toHaveLength(0);
  });

  test("a delisted poll still takes reactions", async () => {
    const [account, id] = [await newAccount(), await election()];
    await app`INSERT INTO moderation_actions (election_id, action, reason, moderator, decided_at)
      VALUES (${id}, 'delist', 'spam', 'mod', now())`;
    expect(await setReaction(app, account, id, "heart", true, at)).toBe(true);
    expect((await readReactionCounts(app, id)).heart).toBe(1);
  });

  test("malformed arguments are type errors", async () => {
    const [account, id] = [await newAccount(), await election()];
    await expect(setReaction(app, "x", id, "heart", true, at)).rejects.toThrow(RangeError);
    await expect(setReaction(app, account, id.subarray(1), "heart", true, at)).rejects.toThrow(
      TypeError,
    );
    await expect(
      setReaction(app, account, id, "heart", "yes" as unknown as boolean, at),
    ).rejects.toThrow(TypeError);
    await expect(
      setReaction(app, account, id, "heart", true, { now: new Date(Number.NaN) }),
    ).rejects.toThrow(TypeError);
    await expect(readOwnReactions(app, "x", id)).rejects.toThrow(RangeError);
    await expect(readReactionCounts(app, id.subarray(1))).rejects.toThrow(TypeError);
  });
});

describe("the hour's limit (T-52)", () => {
  test(`${MAX_REACTION_CHANGES_PER_HOUR} changes an hour, then refused with nothing written`, async () => {
    const [account, id] = [await newAccount(), await election()];
    for (let i = 0; i < MAX_REACTION_CHANGES_PER_HOUR; i++)
      expect(await setReaction(app, account, id, "heart", i % 2 === 0, at)).toBe(true);
    // The last change took it back, so the next one would set it.
    expect(await refusedWith(setReaction(app, account, id, "heart", true, at))).toBe(
      "too-many-this-hour",
    );
    expect(await rowsOf(account)).toHaveLength(0);
    // A change that changes nothing isn't counted, so it isn't refused.
    expect(await setReaction(app, account, id, "heart", false, at)).toBe(false);
    // Another account, and the next hour, are unaffected.
    expect(await setReaction(app, await newAccount(), id, "heart", true, at)).toBe(true);
    const next = { now: new Date("2026-10-22T13:00:00Z") };
    expect(await setReaction(app, account, id, "heart", true, next)).toBe(true);
  });

  test("changes at once can't take the hour's last one twice", async () => {
    const [account, id] = [await newAccount(), await election()];
    for (let i = 0; i < MAX_REACTION_CHANGES_PER_HOUR - 1; i++)
      await setReaction(app, account, id, "heart", i % 2 === 0, at);
    const results = await Promise.allSettled([
      setReaction(app, account, id, "laugh", true, at),
      setReaction(app2, account, id, "wow", true, at),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((refused.reason as ReactionError).code).toBe("too-many-this-hour");
    expect(
      (await rowsOf(account)).filter((r) => r["reaction"] === "laugh" || r["reaction"] === "wow"),
    ).toHaveLength(1);
  });

  test("the hour is kept truncated, and pruning deletes the hours gone by", async () => {
    const [account, id] = [await newAccount(), await election()];
    await setReaction(app, account, id, "heart", true, { now: new Date("2026-10-22T10:59:59Z") });
    await setReaction(app, account, id, "wow", true, { now: new Date("2026-10-22T11:15:00Z") });
    await setReaction(app, account, id, "sad", true, at);
    const hours = async () =>
      (
        await db.admin`SELECT hour FROM account_reaction_hours WHERE user_id = ${account} ORDER BY hour`
      ).map((r) => (r["hour"] as Date).toISOString());
    expect(await hours()).toEqual([
      "2026-10-22T10:00:00.000Z",
      "2026-10-22T11:00:00.000Z",
      "2026-10-22T12:00:00.000Z",
    ]);
    expect(await pruneReactionHours(app, NOW)).toBeGreaterThanOrEqual(1);
    // The hour before stays, so a clock running ahead never wipes this one.
    expect(await hours()).toEqual(["2026-10-22T11:00:00.000Z", "2026-10-22T12:00:00.000Z"]);
    // Pruning the hours never touches the reactions.
    expect(await rowsOf(account)).toHaveLength(3);
  });
});

test("reactions.ts reads no board table but the definitions, and writes none", () => {
  const src = readFileSync(new URL("../src/reactions.ts", import.meta.url), "utf8");
  expect(src).not.toMatch(
    /boardEntries|board_entries|boardBallot|boardShareReceipts|appendEntry|identityBackups|accountTokens/,
  );
});
