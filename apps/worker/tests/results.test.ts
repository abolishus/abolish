import {
  BallotAdmissions,
  type CountedTally,
  OpeningBoardings,
  OpeningError,
} from "@abolishus/core";
import { newElection, type TestDb, testDb } from "@abolishus/core/test-db";
import {
  aggregateCell,
  aggregateHash,
  encodeTallyOpening,
  identityKey,
  signTallyOpening,
  type TallyElection,
} from "@abolishus/crypto";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, test } from "vite-plus/test";
import { panel } from "../../../packages/verifier/tests/receipt-poll.ts";
import {
  BALLOT_MAX_AGE_MS,
  type LogLine,
  OpeningQueue,
  QUEUES,
  RESULTS_OUTCOME,
  ResultsQueue,
  type RunningWorker,
  startWorker,
} from "../src/index.ts";

// The `{results-read}` queue end to end, against a live Redis and Postgres:
// the API's ResultsQueue asks for a poll's results and hears what core's
// OpeningBoardings.readResults gives from the openings boarded so far
// (docs/spec/verifier.md, Results from the counted tally; T-29, T-52), with
// the same boardings `{opening-submit}` judges openings by. The figures
// themselves are core's tally-boarding test's and the verifier's; here they
// are only carried, whole and strictly. A job carries the election alone,
// and nothing of it stays in Redis or reaches the log (T-10, T-11).

const redisUrl = process.env["REDIS_URL"];
if (!redisUrl) throw new Error("REDIS_URL is not set");

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const prefix = `abolish-test-results-${hex(randomBytes(6))}`;
const CLOCK = { epoch: 1_000_000n, period: 3_600n };
const NOW = CLOCK.epoch + 10n * CLOCK.period;

// Seats of a panel of three, two registered, each signing whole openings of
// two empty cells of one tier, as tests/openings.test.ts does.
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
let dbs: TestDb[] = [];
const running: { worker: RunningWorker; openings: OpeningQueue; results: ResultsQueue }[] = [];
const logs: LogLine[] = [];

beforeAll(() => {
  connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
});
afterEach(async () => {
  for (const { worker, openings, results } of running.splice(0)) {
    await openings.close();
    await results.close();
    await worker.close();
  }
  for (const { name } of Object.values(QUEUES)) {
    const queue = new Queue(name, { connection, prefix });
    await queue.obliterate({ force: true });
    await queue.close();
  }
  await Promise.all(dbs.map((d) => d.close()));
  dbs = [];
  logs.splice(0);
});
afterAll(() => connection?.disconnect());

/**
 * A schema of its own holding an election, a worker boarding openings of it
 * with `boardings` (by default against `FIXED`), and the API's queues.
 */
async function setUp(options: { boardings?: OpeningBoardings | false; timeoutMs?: number } = {}) {
  const db = await testDb();
  dbs.push(db);
  const app = await db.as("abolish_app");
  const id = await newElection(app);
  const boardings =
    options.boardings ??
    new OpeningBoardings({
      tally: async () => FIXED,
      target: async () => ({
        definitionHash: own.definitionHash,
        pinned: 1,
        registered: own.registered,
      }),
      clock: CLOCK,
    });
  const worker = await startWorker({
    connection,
    sql: app,
    log: (l) => logs.push(l),
    auditEveryMs: 3_600_000,
    prefix,
    now: () => new Date(Number(NOW) * 1000),
    ballots: { admissions: new BallotAdmissions({ panels: [panel], clock: CLOCK }) },
    ...(boardings === false ? {} : { openings: { boardings } }),
  });
  const openings = await OpeningQueue.open({ connection, prefix });
  const results = await ResultsQueue.open({
    connection,
    prefix,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  running.push({ worker, openings, results });
  return { id, openings, results };
}

/** Fails if any key under this run's prefix holds `marker`. */
async function expectNoKeyHolds(marker: string) {
  for (const key of await connection.keys(`${prefix}:*`)) {
    const type = await connection.type(key);
    const dump =
      type === "hash"
        ? JSON.stringify(await connection.hgetall(key))
        : type === "string"
          ? String(await connection.get(key))
          : type === "list"
            ? JSON.stringify(await connection.lrange(key, 0, -1))
            : type === "zset"
              ? JSON.stringify(await connection.zrange(key, 0, -1))
              : type === "stream"
                ? JSON.stringify(await connection.xrange(key, "-", "+"))
                : type === "set"
                  ? JSON.stringify(await connection.smembers(key))
                  : type === "none"
                    ? ""
                    : expect.unreachable(`a key of unchecked type ${type}`);
    expect(dump, key).not.toContain(marker);
  }
}

test("a poll's results follow its boarded openings, and no election stays in Redis or reaches the log (T-10)", async () => {
  const { id, openings, results } = await setUp();
  expect(await results.read(id)).toEqual({ ok: true, state: "unopened" });
  expect(await openings.submit(id, openingOf(0, 1))).toEqual({ ok: true, index: "0" });
  // One cell opened: its counts and signer, the other missing, so its tier
  // has no counts yet.
  expect(await results.read(id)).toEqual({
    ok: true,
    state: "read",
    openings: 1,
    passed: false,
    failure: { cell: 1, code: "tally-missing" },
    cells: [
      { cell: 0, tier: 0, counted: 0, counts: ["0", "0", "0"], signers: [1] },
      { cell: 1, tier: 0, counted: 0, code: "tally-missing", signers: [] },
    ],
    tiers: [{ tier: 0, counted: 0 }],
  });
  expect(await openings.submit(id, openingOf(1, 2))).toEqual({ ok: true, index: "1" });
  expect(await results.read(id)).toEqual({
    ok: true,
    state: "read",
    openings: 2,
    passed: true,
    cells: [
      { cell: 0, tier: 0, counted: 0, counts: ["0", "0", "0"], signers: [1] },
      { cell: 1, tier: 0, counted: 0, counts: ["0", "0", "0"], signers: [2] },
    ],
    tiers: [{ tier: 0, counted: 0, counts: ["0", "0", "0"] }],
  });
  await expectNoKeyHolds(hex(id));
  const mine = logs.filter((l) => l.queue === "{results-read}");
  for (const line of mine)
    expect(line).toEqual({ queue: "{results-read}", outcome: "completed", ms: expect.any(Number) });
  expect(mine).toHaveLength(3);
});

test.each(["unknown-election", "not-ready", "not-open"] as const)(
  "core's %s is an outcome with its code",
  async (code) => {
    const boardings = new OpeningBoardings({
      tally: async () => FIXED,
      target: async () => undefined,
      clock: CLOCK,
    });
    boardings.readResults = async () => {
      throw new OpeningError(code);
    };
    const { id, results } = await setUp({ boardings });
    expect(await results.read(id)).toEqual({ ok: false, code });
  },
);

test("an election this operator boards no opening of is not-open", async () => {
  const { id, results } = await setUp({
    boardings: new OpeningBoardings({
      tally: async () => FIXED,
      target: async () => undefined,
      clock: CLOCK,
    }),
  });
  expect(await results.read(id)).toEqual({ ok: false, code: "not-open" });
});

test("anything else fails the job by kind, and the API hears unavailable", async () => {
  const boardings = new OpeningBoardings({
    tally: async () => FIXED,
    target: async () => undefined,
    clock: CLOCK,
  });
  boardings.readResults = async () => {
    // A submitted opening's code, which a read never gets.
    throw new OpeningError("rejected", "decode");
  };
  const { id, results } = await setUp({ boardings });
  expect(await results.read(id)).toEqual({ ok: false, code: "unavailable" });
  expect(logs).toContainEqual({
    queue: "{results-read}",
    outcome: "failed",
    error: "internal",
    ms: expect.any(Number),
  });
});

test("with no worker boarding openings, after the timeout, and the job leaves the queue", async () => {
  const { id, results } = await setUp({ boardings: false, timeoutMs: 300 });
  expect(await results.read(id)).toEqual({ ok: false, code: "unavailable" });
  const queue = new Queue(QUEUES.resultsRead.name, { connection, prefix });
  expect(await queue.getWaitingCount()).toBe(0);
  await queue.close();
});

test("a job older than BALLOT_MAX_AGE_MS is refused unread", async () => {
  const { id } = await setUp();
  const queue = new Queue(QUEUES.resultsRead.name, { connection, prefix });
  await queue.add(
    "resultsRead",
    { electionId: hex(id) },
    {
      removeOnComplete: true,
      removeOnFail: true,
      attempts: 1,
      timestamp: Date.now() - BALLOT_MAX_AGE_MS - 1,
    },
  );
  await queue.close();
  for (let i = 0; i < 200 && !logs.some((l) => l.queue === "{results-read}"); i++)
    await new Promise((r) => setTimeout(r, 25));
  expect(logs.filter((l) => l.queue === "{results-read}")).toEqual([
    { queue: "{results-read}", outcome: "failed", error: "stale-job", ms: expect.any(Number) },
  ]);
});

test("an outcome is parsed strictly: an unknown field, a negative count or a ballot never passes", () => {
  const read = {
    ok: true,
    state: "read",
    openings: 1,
    passed: true,
    cells: [{ cell: 0, tier: 0, counted: 2, counts: ["1", "1"], signers: [1] }],
    tiers: [{ tier: 0, counted: 2, counts: ["1", "1"] }],
  };
  expect(RESULTS_OUTCOME.safeParse(read).success).toBe(true);
  expect(RESULTS_OUTCOME.safeParse({ ok: true, state: "unopened" }).success).toBe(true);
  expect(RESULTS_OUTCOME.safeParse({ ok: false, code: "not-ready" }).success).toBe(true);
  expect(RESULTS_OUTCOME.safeParse({ ...read, ballot: "0002" }).success).toBe(false);
  expect(
    RESULTS_OUTCOME.safeParse({
      ...read,
      cells: [{ cell: 0, tier: 0, counted: 2, counts: ["-1", "1"], signers: [1] }],
    }).success,
  ).toBe(false);
  expect(
    RESULTS_OUTCOME.safeParse({ ...read, tiers: [{ tier: 0, counted: 2, panel: 2 }] }).success,
  ).toBe(false);
  expect(RESULTS_OUTCOME.safeParse({ ok: false, code: "rejected" }).success).toBe(false);
  expect(RESULTS_OUTCOME.safeParse({ ok: false, code: "unavailable" }).success).toBe(false);
});
