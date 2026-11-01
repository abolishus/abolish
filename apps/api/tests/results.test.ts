import {
  MAX_RESULT_CELLS,
  MAX_RESULT_OPTIONS,
  MAX_RESULT_QUESTIONS,
  MAX_RESULT_SEATS,
} from "@abolishus/api-contract";
import { BallotAdmissions, type CountedTally, OpeningBoardings } from "@abolishus/core";
import { newElection, type TestDb, testDb } from "@abolishus/core/test-db";
import {
  aggregateCell,
  aggregateHash,
  encodeTallyOpening,
  identityKey,
  PARAMETERS,
  signTallyOpening,
  type TallyElection,
} from "@abolishus/crypto";
import {
  OpeningQueue,
  RESULTS_OUTCOME,
  ResultsQueue,
  type ResultsOutcome,
  type RunningWorker,
  startWorker,
} from "@abolishus/worker";
import fc from "fast-check";
import { Redis } from "ioredis";
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { panel } from "../../../packages/verifier/tests/receipt-poll.ts";
import { createApiServer, type ResultsReader } from "../src/index.ts";

// `elections.getResults` over HTTP through the worker's `{results-read}`
// queue on a live Redis: a poll's results from the tally openings boarded so
// far, as core's OpeningBoardings reads them (docs/spec/verifier.md, Results
// from the counted tally; T-29, T-52), carried whole: `unopened` before any
// opening, then each cell's and tier's report as openings are boarded.
// Where the operator boards no opening it is RESULTS_NOT_COUNTED, before the
// tally can be had RESULTS_NOT_READY, without an outcome in time
// RESULTS_UNAVAILABLE. The request log holds only the method, route, status
// and duration (T-10, T-11). The counted tally is given to the worker's
// boarding directly, as in tests/openings.test.ts.

const redisUrl = process.env["REDIS_URL"];
if (!redisUrl) throw new Error("REDIS_URL is not set");

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const CLOCK = { epoch: 1_000_000n, period: 3_600n };
const NOW = CLOCK.epoch + 10n * CLOCK.period;
const SECRETS = [1, 2, 3].map((i) => new Uint8Array(32).fill(i));
const own: TallyElection = {
  definitionHash: new Uint8Array(32).fill(0xd1),
  rules: { optionCount: 3, threshold: 2, panelSize: 3 },
  registered: [1, 2].map((index) => ({
    index,
    signingKey: identityKey(SECRETS[index - 1] as Uint8Array),
  })),
};
const empty = aggregateCell(own.rules, []);
const FIXED: CountedTally = {
  state: "fixed",
  election: own,
  aggregates: [empty, empty],
  counted: [0, 0],
  tiers: [0, 0],
  pinned: 1,
  lastSegment: 5,
};
const openingOf = (cell: number, signer: number) =>
  encodeTallyOpening(
    signTallyOpening(SECRETS[signer - 1] as Uint8Array, {
      definition_hash: own.definitionHash,
      cell,
      aggregate_hash: aggregateHash(empty),
      signer,
      opening: [0n, 0n, 0n].map(() => ({ v: 0n, r: 0n })),
    }),
    1,
  );

let connection: Redis;
const dbs: TestDb[] = [];
const servers: Server[] = [];
const workers: RunningWorker[] = [];
const queues: { close(): Promise<void> }[] = [];
const prefixes: string[] = [];

/** A schema of its own with an election stored. */
async function election(): Promise<{ app: Sql; id: Uint8Array }> {
  const db = await testDb();
  dbs.push(db);
  const app = await db.as("abolish_app");
  return { app, id: await newElection(app) };
}

const prefixed = () => {
  const prefix = `abolish-test-api-results-${hex(randomBytes(6))}`;
  prefixes.push(prefix);
  return prefix;
};

/**
 * A worker boarding openings for `sql` (against `FIXED`, or none where the
 * operator boards no opening) and the API's queues to it, under a prefix of
 * their own.
 */
async function counting(sql: Sql, boards = true) {
  const prefix = prefixed();
  workers.push(
    await startWorker({
      connection,
      sql,
      log: () => {},
      auditEveryMs: 3_600_000,
      prefix,
      now: () => new Date(Number(NOW) * 1000),
      ballots: { admissions: new BallotAdmissions({ panels: [panel], clock: CLOCK }) },
      openings: {
        boardings: new OpeningBoardings({
          tally: async () => FIXED,
          target: async () =>
            boards
              ? { definitionHash: own.definitionHash, pinned: 1, registered: own.registered }
              : undefined,
          clock: CLOCK,
        }),
      },
    }),
  );
  const openings = await OpeningQueue.open({ connection, prefix });
  const results = await ResultsQueue.open({ connection, prefix });
  queues.push(openings, results);
  return { openings, results };
}

/** An API on `sql` with `results`, and a function reading an election's results from it. */
async function api(sql: Sql, id: Uint8Array, results?: ResultsReader, log: unknown[] = []) {
  const s = createApiServer({
    sql,
    log: (l) => log.push(l),
    ...(results !== undefined && { results }),
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/elections/results`;
  return async (electionId = id) => {
    const r = await fetch(`${url}?electionId=${hex(electionId)}`);
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
}

beforeAll(() => {
  connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
});
afterAll(async () => {
  for (const s of servers) await new Promise((r) => s.close(r));
  for (const q of queues) await q.close();
  for (const w of workers) await w.close();
  for (const prefix of prefixes)
    for (const key of await connection.keys(`${prefix}:*`)) await connection.del(key);
  connection?.disconnect();
  await Promise.all(dbs.map((d) => d.close()));
});

describe("elections.getResults through the worker", { timeout: 60_000 }, () => {
  test("follows the boarded openings: unopened, one cell, then every cell and its tier", async () => {
    const { app, id } = await election();
    const { openings, results } = await counting(app);
    const log: unknown[] = [];
    const read = await api(app, id, results, log);
    expect(await read()).toEqual({ status: 200, body: { state: "unopened" } });
    expect(await openings.submit(id, openingOf(0, 1))).toEqual({ ok: true, index: "0" });
    expect(await read()).toEqual({
      status: 200,
      body: {
        state: "read",
        openings: 1,
        passed: false,
        failure: { cell: 1, code: "tally-missing" },
        cells: [
          { cell: 0, tier: 0, counted: 0, counts: ["0", "0", "0"], signers: [1] },
          { cell: 1, tier: 0, counted: 0, code: "tally-missing", signers: [] },
        ],
        tiers: [{ tier: 0, counted: 0 }],
      },
    });
    expect(await openings.submit(id, openingOf(1, 2))).toEqual({ ok: true, index: "1" });
    expect(await read()).toEqual({
      status: 200,
      body: {
        state: "read",
        openings: 2,
        passed: true,
        cells: [
          { cell: 0, tier: 0, counted: 0, counts: ["0", "0", "0"], signers: [1] },
          { cell: 1, tier: 0, counted: 0, counts: ["0", "0", "0"], signers: [2] },
        ],
        tiers: [{ tier: 0, counted: 0, counts: ["0", "0", "0"] }],
      },
    });
    // T-10, T-11: the log names the route, never the election.
    expect(log).toContainEqual({
      method: "GET",
      route: "GET /elections/results",
      status: 200,
      ms: expect.any(Number),
    });
    for (const line of log) expect(JSON.stringify(line)).not.toContain(hex(id));
  });

  test("an election whose openings this operator never boards is RESULTS_NOT_COUNTED", async () => {
    const { app, id } = await election();
    const { status, body } = await (await api(app, id, (await counting(app, false)).results))();
    expect(status).toBe(409);
    expect(body["code"]).toBe("RESULTS_NOT_COUNTED");
  });
});

describe("elections.getResults' answers", () => {
  const reading = (outcome: ResultsOutcome | { ok: false; code: "unavailable" }) => ({
    read: async () => outcome,
  });

  test("each worker code is its contract error", async () => {
    const { app, id } = await election();
    for (const [code, status, error] of [
      ["unknown-election", 404, "ELECTION_NOT_FOUND"],
      ["not-open", 409, "RESULTS_NOT_COUNTED"],
      ["not-ready", 503, "RESULTS_NOT_READY"],
      ["unavailable", 503, "RESULTS_UNAVAILABLE"],
    ] as const) {
      const { status: got, body } = await (await api(app, id, reading({ ok: false, code })))();
      expect(got, code).toBe(status);
      expect(body["code"], code).toBe(error);
    }
  });

  test("an election this server doesn't hold is ELECTION_NOT_FOUND, never queued", async () => {
    const { app, id } = await election();
    const read = await api(app, id, {
      read: () => {
        throw new Error("queued an unknown election");
      },
    });
    const { status, body } = await read(new Uint8Array(randomBytes(32)));
    expect(status).toBe(404);
    expect(body["code"]).toBe("ELECTION_NOT_FOUND");
  });

  test("without a queue no results are counted: RESULTS_NOT_COUNTED", async () => {
    const { app, id } = await election();
    const { status, body } = await (await api(app, id))();
    expect(status).toBe(409);
    expect(body["code"]).toBe("RESULTS_NOT_COUNTED");
  });

  test("a read no worker answers in time is RESULTS_UNAVAILABLE", async () => {
    const { app, id } = await election();
    const queue = await ResultsQueue.open({ connection, prefix: prefixed(), timeoutMs: 200 });
    queues.push(queue);
    const { status, body } = await (await api(app, id, queue))();
    expect(status).toBe(503);
    expect(body["code"]).toBe("RESULTS_UNAVAILABLE");
  });

  test("every outcome the queue's schema takes is served whole by the contract, up to its bounds", async () => {
    const { app, id } = await election();
    let outcome: ResultsOutcome = { ok: true, state: "unopened" };
    const read = await api(app, id, { read: async () => outcome });
    const small = fc.nat({ max: 1000 });
    const count = fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }).map(String);
    const counts = fc.array(count, { maxLength: MAX_RESULT_OPTIONS });
    const byQuestion = fc.array(counts, { maxLength: 4 });
    const outcomes = fc.record(
      {
        ok: fc.constant(true as const),
        state: fc.constant("read" as const),
        openings: small,
        passed: fc.boolean(),
        failure: fc.record(
          { cell: small, code: fc.constant("tally-missing") },
          { requiredKeys: ["cell", "code"] },
        ),
        cells: fc.array(
          fc.record(
            {
              cell: small,
              tier: small,
              counted: small,
              counts,
              byQuestion,
              code: fc.constantFrom("tally-missing", "tally-range"),
              signers: fc.array(fc.integer({ min: 1, max: 16 }), { maxLength: MAX_RESULT_SEATS }),
            },
            { requiredKeys: ["cell", "tier", "counted", "signers"] },
          ),
          { maxLength: 4 },
        ),
        tiers: fc.array(
          fc.record(
            {
              tier: small,
              counted: small,
              counts,
              byQuestion,
              electorate: fc.record({
                opening: small,
                eligible: small,
                flagged: fc.record({ eligible: fc.boolean() }),
              }),
            },
            { requiredKeys: ["tier", "counted"] },
          ),
          { maxLength: 4 },
        ),
        questions: fc.array(
          fc.record({
            question: small,
            size: small,
            atLeast: small,
            atMost: small,
            method: fc.constantFrom("pick one", "pick any", "up to 3"),
          }),
          { maxLength: MAX_RESULT_QUESTIONS },
        ),
      },
      { requiredKeys: ["ok", "state", "openings", "passed", "cells", "tiers"] },
    );
    await fc.assert(
      fc.asyncProperty(outcomes, async (o) => {
        const parsed = RESULTS_OUTCOME.parse(o);
        outcome = parsed;
        const { ok: _, ...served } = parsed;
        expect(await read()).toEqual({ status: 200, body: served });
      }),
      { numRuns: Math.min(numRuns, 200) },
    );
    // The largest: every cell with every count, each a u64's largest.
    const most = String(2n ** 64n - 1n);
    const full = Array.from({ length: MAX_RESULT_OPTIONS }, () => most);
    outcome = RESULTS_OUTCOME.parse({
      ok: true,
      state: "read",
      openings: 1,
      passed: true,
      cells: Array.from({ length: MAX_RESULT_CELLS }, (_, cell) => ({
        cell,
        tier: 0,
        counted: 1,
        counts: full,
        byQuestion: [full],
        signers: Array.from({ length: MAX_RESULT_SEATS }, (_, s) => s + 1),
      })),
      tiers: [{ tier: 0, counted: 1, counts: full, byQuestion: [full] }],
    });
    expect((await read()).status).toBe(200);
  });

  test("the queue's bounds are the contract's", () => {
    expect(PARAMETERS.MAX_OPTIONS).toBe(MAX_RESULT_OPTIONS);
    expect(PARAMETERS.MAX_QUESTIONS).toBe(MAX_RESULT_QUESTIONS);
    expect(PARAMETERS.MAX_TRUSTEES).toBe(MAX_RESULT_SEATS);
    const cells = (n: number) =>
      RESULTS_OUTCOME.safeParse({
        ok: true,
        state: "read",
        openings: 0,
        passed: false,
        cells: Array.from({ length: n }, (_, cell) => ({ cell, tier: 0, counted: 0, signers: [] })),
        tiers: [],
      }).success;
    expect(cells(MAX_RESULT_CELLS)).toBe(true);
    expect(cells(MAX_RESULT_CELLS + 1)).toBe(false);
  });
});
