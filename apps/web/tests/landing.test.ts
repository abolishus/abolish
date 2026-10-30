// Followed polls' results landing (src/node/landing.ts) against Postgres as
// the app role: a poll whose results are in has its follows turned into its
// followers' list and notices, a poll whose results aren't stays followed, a
// follow set after a landing is told on the next pass, a pass longer than a
// run's pages carries on where it stopped and starts over at the end, and a
// failed read or run is logged by kind only. `resultsInFrom` reads the API's
// answer as the board's openings passing or not.

import { followResults, isFollowing, MAX_FOLLOWED_POLLS, setFollow } from "@abolishus/core";
import { newAccount, newElection, type TestDb, testDb } from "@abolishus/core/test-db";
import { ORPCError } from "@orpc/client";
import { randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, expect, test } from "vite-plus/test";

import {
  LAND_PAGES,
  type ResultsIn,
  resultsInFrom,
  startResultsLanding,
} from "../src/node/landing.ts";
import type { Api } from "../src/server/api.ts";
import { toHex } from "../src/values.ts";

let db: TestDb;
let sql: Sql;

beforeAll(async () => {
  db = await testDb();
  sql = await db.as("abolish_app");
});
afterAll(() => db?.close());
// Each test sees only its own follows, since a pass reads every followed poll.
beforeEach(async () => {
  await sql`DELETE FROM account_follows`;
});

const NOW = new Date("2026-10-30T12:34:56Z");

/** An account verified by e-mail, as setFollow requires. */
async function verifiedAccount(): Promise<string> {
  const account = await newAccount(sql);
  await sql`
    INSERT INTO account_emails VALUES (${account}, ${randomBytes(32)}, 'h1', ${randomBytes(40)}, 'b1', now())`;
  return account;
}

async function follow(account: string, electionId: Uint8Array): Promise<void> {
  await setFollow(sql, account, electionId, true, { now: NOW });
}

const noticeFor = async (account: string) =>
  (
    await sql`SELECT not_before = '2026-10-31T00:00:00Z' AS after_midnight, moderation, results FROM account_notices WHERE user_id = ${account}`
  )[0];

/** Runs `check` until it holds, for at most two seconds. */
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("never held");
}

/** One run: the timer's first, before its interval is ever due. */
async function runOnce(resultsIn: ResultsIn, log: { error: string }[] = []): Promise<void> {
  const landing = startResultsLanding({
    sql,
    resultsIn,
    log: (l) => log.push(l),
    everyMs: 60 * 60 * 1000,
    now: () => NOW,
  });
  await landing.stop();
}

test("lands the followed polls whose results are in, and leaves the rest followed", async () => {
  const [counted, open] = [await newElection(sql), await newElection(sql)];
  const [a, b] = [await verifiedAccount(), await verifiedAccount()];
  await follow(a, counted);
  await follow(b, counted);
  await follow(b, open);
  const asked: string[] = [];
  const lines: { error: string }[] = [];
  await runOnce(async (id) => {
    asked.push(toHex(id));
    return toHex(id) === toHex(counted) ? "in" : "not-yet";
  }, lines);
  expect(asked.sort()).toEqual([toHex(counted), toHex(open)].sort());
  for (const account of [a, b]) {
    expect(await isFollowing(sql, account, counted)).toBe(false);
    expect((await followResults(sql, account)).map(toHex)).toEqual([toHex(counted)]);
    expect(await noticeFor(account)).toMatchObject({
      // Due after the UTC midnight that follows the landing.
      after_midnight: true,
      moderation: false,
      results: true,
    });
  }
  expect(await isFollowing(sql, b, open)).toBe(true);
  expect(lines).toEqual([]);
});

test("tells a follow set after a poll's results landed on the next pass", async () => {
  const poll = await newElection(sql);
  const [early, late] = [await verifiedAccount(), await verifiedAccount()];
  await follow(early, poll);
  await runOnce(async () => "in");
  expect((await followResults(sql, early)).map(toHex)).toEqual([toHex(poll)]);
  await follow(late, poll);
  await runOnce(async () => "in");
  expect(await isFollowing(sql, late, poll)).toBe(false);
  expect((await followResults(sql, late)).map(toHex)).toEqual([toHex(poll)]);
  expect(await noticeFor(late)).toMatchObject({ results: true });
});

test("keeps a poll followed when its read fails, logging the failure by kind only", async () => {
  const [failing, counted] = [await newElection(sql), await newElection(sql)];
  const account = await verifiedAccount();
  await follow(account, failing);
  await follow(account, counted);
  const lines: { error: string }[] = [];
  await runOnce(async (id) => (toHex(id) === toHex(failing) ? "failed" : "in"), lines);
  expect(await isFollowing(sql, account, failing)).toBe(true);
  expect((await followResults(sql, account)).map(toHex)).toEqual([toHex(counted)]);
  // Once a run, never with the poll.
  expect(lines).toEqual([{ error: "ResultsReadFailed" }]);
});

test("logs a run that throws by kind only, and tries again on the next tick", async () => {
  const poll = await newElection(sql);
  await follow(await verifiedAccount(), poll);
  let calls = 0;
  const lines: { error: string }[] = [];
  const landing = startResultsLanding({
    sql,
    resultsIn: async () => {
      calls++;
      throw new Error(`gone: ${toHex(poll)}`);
    },
    log: (l) => lines.push(l),
    everyMs: 20,
    now: () => NOW,
  });
  await until(() => calls > 1);
  await landing.stop();
  expect(new Set(lines.map((l) => JSON.stringify(l)))).toEqual(
    new Set([JSON.stringify({ error: "ResultsLandingFailed" })]),
  );
});

test("reads every followed poll once a pass, carrying on across runs and starting over at the end", async () => {
  const account = await verifiedAccount();
  // More than one run's pages, written straight to the table: the polls need
  // no definition to be followed here, and the follows no hour's limit.
  const total = LAND_PAGES * MAX_FOLLOWED_POLLS + 5;
  await sql`
    INSERT INTO account_follows (user_id, election_id)
    SELECT ${account}, decode(lpad(to_hex(i), 64, '0'), 'hex') FROM generate_series(1, ${total}) AS i`;
  const read: string[] = [];
  const landing = startResultsLanding({
    sql,
    resultsIn: async (id) => {
      read.push(toHex(id));
      return "not-yet";
    },
    log: () => {},
    everyMs: 20,
    now: () => NOW,
  });
  await until(() => read.length > total);
  await landing.stop();
  const id = (i: number) => i.toString(16).padStart(64, "0");
  const ids = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => id(from + i));
  // The first run's pages in byte order, the second's the rest, then the
  // next pass from the first poll again.
  const perRun = LAND_PAGES * MAX_FOLLOWED_POLLS;
  expect(read.slice(0, perRun)).toEqual(ids(1, perRun));
  expect(read.slice(perRun, total)).toEqual(ids(perRun + 1, total));
  expect(read[total]).toBe(id(1));
});

const served = (answer: unknown): Pick<Api, "elections"> =>
  ({
    elections: {
      getResults: async () => {
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  }) as unknown as Pick<Api, "elections">;

test("reads results as in only once the board's openings pass", async () => {
  const id = new Uint8Array(32).fill(7);
  const read = (passed: boolean) => ({ state: "read", passed });
  expect(await resultsInFrom(served(read(true)))(id)).toBe("in");
  expect(await resultsInFrom(served(read(false)))(id)).toBe("not-yet");
  expect(await resultsInFrom(served({ state: "unopened" }))(id)).toBe("not-yet");
  for (const code of ["RESULTS_NOT_COUNTED", "RESULTS_NOT_READY"])
    expect(await resultsInFrom(served(new ORPCError(code, { defined: true })))(id)).toBe("not-yet");
  // Anything else, an undefined error of the same code included, is a failed read.
  expect(
    await resultsInFrom(served(new ORPCError("RESULTS_NOT_READY", { defined: false })))(id),
  ).toBe("failed");
  expect(
    await resultsInFrom(served(new ORPCError("RESULTS_UNAVAILABLE", { defined: true })))(id),
  ).toBe("failed");
  expect(await resultsInFrom(served(new TypeError("fetch failed")))(id)).toBe("failed");
});

test("asks the API for a poll by its ID alone", async () => {
  const id = new Uint8Array(randomBytes(32));
  const asked: unknown[] = [];
  const api = {
    elections: {
      getResults: async (...args: unknown[]) => {
        asked.push(args);
        return { state: "unopened" };
      },
    },
  } as unknown as Pick<Api, "elections">;
  await resultsInFrom(api)(id);
  expect(asked).toEqual([[{ electionId: toHex(id) }]]);
});
