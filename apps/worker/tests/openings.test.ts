import {
  BallotAdmissions,
  type CountedTally,
  OpeningBoardings,
  readBoard,
  readBoardedOpenings,
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
  OPENING_OUTCOME,
  OpeningQueue,
  QUEUES,
  type RunningWorker,
  startWorker,
} from "../src/index.ts";

// The `{opening-submit}` queue end to end, against a live Redis and
// Postgres: the API's OpeningQueue queues a tally opening and hears the
// worker's outcome from core's OpeningBoardings (docs/spec/tally.md, Opening
// record, Boarding; T-17, T-29, T-52), and no opening stays in Redis once
// judged, nor reaches the log (T-10, T-11). The verdicts themselves are
// core's tally-boarding test's, and the counted tally the openings are
// judged against is given to the boarding directly, as there: an anchored
// one is core's `anchoredCountedTally`, over the reads tests/anchor-chain.
// test.ts runs on Anvil.

const redisUrl = process.env["REDIS_URL"];
if (!redisUrl) throw new Error("REDIS_URL is not set");

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const prefix = `abolish-test-openings-${hex(randomBytes(6))}`;
const CLOCK = { epoch: 1_000_000n, period: 3_600n };
const NOW = CLOCK.epoch + 10n * CLOCK.period;

// Seats of a panel of three, two registered, each signing whole openings of
// two empty cells, as core's test does.
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
const running: { worker: RunningWorker; openings: OpeningQueue }[] = [];
const logs: LogLine[] = [];

beforeAll(() => {
  connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
});
afterEach(async () => {
  for (const { worker, openings } of running.splice(0)) {
    await openings.close();
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

/** A schema of its own holding an election, a worker boarding openings of it against `tally`, and the API's queue. */
async function setUp(options: { tally?: CountedTally | false; timeoutMs?: number } = {}) {
  const db = await testDb();
  dbs.push(db);
  const app = await db.as("abolish_app");
  const id = await newElection(app);
  const tally = options.tally ?? FIXED;
  const worker = await startWorker({
    connection,
    sql: app,
    log: (l) => logs.push(l),
    auditEveryMs: 3_600_000,
    prefix,
    now: () => new Date(Number(NOW) * 1000),
    ballots: { admissions: new BallotAdmissions({ panels: [panel], clock: CLOCK }) },
    ...(tally === false
      ? {}
      : {
          openings: {
            boardings: new OpeningBoardings({
              tally: async () => tally,
              target: async () => ({ definitionHash: own.definitionHash, pinned: 1 }),
              clock: CLOCK,
            }),
          },
        }),
  });
  const openings = await OpeningQueue.open({
    connection,
    prefix,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  running.push({ worker, openings });
  return { app, id, openings };
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

test("an opening is boarded and answered by its position, a resend by the same, and no opening stays in Redis or reaches the log (T-10)", async () => {
  const { app, id, openings } = await setUp();
  const records = [openingOf(0, 1), openingOf(0, 2), openingOf(1, 1)];
  const outcomes = [];
  for (const r of records) outcomes.push(await openings.submit(id, r));
  expect(outcomes).toEqual([0, 1, 2].map((i) => ({ ok: true, index: String(i) })));
  expect(await openings.submit(id, openingOf(0, 2))).toEqual({ ok: true, index: "1" });
  expect((await readBoardedOpenings(app, id)).map((o) => o.index)).toEqual([0n, 1n, 2n]);
  // A refusal is an outcome with core's code, not a failed job.
  expect(await openings.submit(id, openingOf(1, 3))).toEqual({
    ok: false,
    code: "rejected",
    rejection: "tally-unattributed",
  });
  expect(await openings.submit(id, Uint8Array.of(0x00, 0x06, 1))).toEqual({
    ok: false,
    code: "rejected",
    rejection: "decode",
  });
  expect(await readBoard(app, id)).toHaveLength(3);
  const stream = await connection.xrange(`${prefix}:${QUEUES.openingSubmit.name}:events`, "-", "+");
  expect(stream.length).toBeGreaterThan(0);
  for (const r of records) await expectNoKeyHolds(hex(r).slice(0, 64));
  await expectNoKeyHolds(hex(id));
  const mine = logs.filter((l) => l.queue === "{opening-submit}");
  for (const line of mine)
    expect(line).toEqual({
      queue: "{opening-submit}",
      outcome: "completed",
      ms: expect.any(Number),
    });
  expect(mine).toHaveLength(records.length + 3);
});

test("before the counted set is fixed, the code says to send it again", async () => {
  const { app, id, openings } = await setUp({ tally: { state: "waiting" } });
  expect(await openings.submit(id, openingOf(0, 1))).toEqual({ ok: false, code: "not-ready" });
  expect(await readBoard(app, id)).toHaveLength(0);
});

test("where the counted set is refused, the code says the election takes none", async () => {
  const { app, id, openings } = await setUp({ tally: { state: "refused", reason: "a test's" } });
  expect(await openings.submit(id, openingOf(0, 1))).toEqual({ ok: false, code: "not-open" });
  expect(await readBoard(app, id)).toHaveLength(0);
});

test("with no worker boarding openings, after the timeout, and the job leaves the queue", async () => {
  const { app, id, openings } = await setUp({ tally: false, timeoutMs: 300 });
  expect(await openings.submit(id, openingOf(0, 1))).toEqual({ ok: false, code: "unavailable" });
  const queue = new Queue(QUEUES.openingSubmit.name, { connection, prefix });
  expect(await queue.getWaitingCount()).toBe(0);
  await queue.close();
  expect(await readBoard(app, id)).toHaveLength(0);
});

test("a job older than BALLOT_MAX_AGE_MS is refused unjudged, and boards nothing", async () => {
  const { app, id } = await setUp();
  const queue = new Queue(QUEUES.openingSubmit.name, { connection, prefix });
  await queue.add(
    "openingSubmit",
    { electionId: hex(id), opening: hex(openingOf(0, 1)) },
    {
      removeOnComplete: true,
      removeOnFail: true,
      attempts: 1,
      timestamp: Date.now() - BALLOT_MAX_AGE_MS - 1,
    },
  );
  await queue.close();
  for (let i = 0; i < 200 && !logs.some((l) => l.queue === "{opening-submit}"); i++)
    await new Promise((r) => setTimeout(r, 25));
  expect(logs.filter((l) => l.queue === "{opening-submit}")).toEqual([
    { queue: "{opening-submit}", outcome: "failed", error: "stale-job", ms: expect.any(Number) },
  ]);
  expect(await readBoard(app, id)).toHaveLength(0);
});

test("when the database work fails: the job fails by kind, and the API hears unavailable", async () => {
  const { id, openings } = await setUp();
  await dbs[0]!.close();
  dbs = [];
  expect(await openings.submit(id, openingOf(0, 1))).toEqual({ ok: false, code: "unavailable" });
  expect(logs).toContainEqual({
    queue: "{opening-submit}",
    outcome: "failed",
    error: "internal",
    ms: expect.any(Number),
  });
});

test("openings are boarded only beside ballot admission", async () => {
  const db = await testDb();
  dbs.push(db);
  await expect(
    startWorker({
      connection,
      sql: await db.as("abolish_app"),
      log: () => {},
      auditEveryMs: 3_600_000,
      prefix,
      openings: {
        boardings: new OpeningBoardings({ tally: async () => FIXED, clock: CLOCK }),
      },
    }),
  ).rejects.toThrow("beside ballot admission");
});

test("an outcome is parsed strictly: an opening or an unknown field never passes", () => {
  expect(OPENING_OUTCOME.safeParse({ ok: true, index: "3" }).success).toBe(true);
  expect(OPENING_OUTCOME.safeParse({ ok: false, code: "not-ready" }).success).toBe(true);
  expect(
    OPENING_OUTCOME.safeParse({ ok: false, code: "rejected", rejection: "tally-second" }).success,
  ).toBe(true);
  expect(OPENING_OUTCOME.safeParse({ ok: true, index: "3", opening: "0006" }).success).toBe(false);
  expect(OPENING_OUTCOME.safeParse({ ok: true, index: "-1" }).success).toBe(false);
  expect(OPENING_OUTCOME.safeParse({ ok: false, code: "unavailable" }).success).toBe(false);
});
