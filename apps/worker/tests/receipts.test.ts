import { appendEntry, BallotAdmissions, readBoard, storeDefinition } from "@abolishus/core";
import { type TestDb, testDb } from "@abolishus/core/test-db";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, test } from "vite-plus/test";
import {
  ballots,
  definition,
  definitionBytes,
  electionId,
  panel,
  receiptFor,
  transcript,
} from "../../../packages/verifier/tests/receipt-poll.ts";
import {
  BALLOT_MAX_AGE_MS,
  type LogLine,
  QUEUES,
  RECEIPT_OUTCOME,
  ReceiptQueue,
  type RunningWorker,
  startWorker,
} from "../src/index.ts";

// The `{receipt-submit}` queue end to end, against a live Redis and
// Postgres: the API's ReceiptQueue queues a share receipt and hears the
// worker's outcome from core's submitReceipt (docs/spec/delivery.md,
// Boarding; T-17, T-52), and no receipt stays in Redis once judged, nor
// reaches the log (T-10, T-11). The verdicts themselves are core's
// share-receipts test's and apps/api's receipts test's; the election and
// its receipts are packages/verifier's tests/receipt-poll.ts.

const redisUrl = process.env["REDIS_URL"];
if (!redisUrl) throw new Error("REDIS_URL is not set");

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const b32 = () => new Uint8Array(randomBytes(32));
const prefix = `abolish-test-receipts-${hex(randomBytes(6))}`;
const clock = { epoch: definition.opens_at - 7_200n, period: 3_600n };
const [first] = ballots as [(typeof ballots)[number]];

let connection: Redis;
let dbs: TestDb[] = [];
const running: { worker: RunningWorker; receipts: ReceiptQueue }[] = [];
const logs: LogLine[] = [];

beforeAll(() => {
  connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
});
afterEach(async () => {
  for (const { worker, receipts } of running.splice(0)) {
    await receipts.close();
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

/** A schema of its own holding the election and its ballots, a worker judging receipts for it, and the API's queue. */
async function setUp(options: { pins?: boolean; timeoutMs?: number } = {}) {
  const db = await testDb();
  dbs.push(db);
  const app = await db.as("abolish_app");
  await storeDefinition(app, definitionBytes);
  await appendEntry(app, electionId, 0, transcript, { first: true });
  for (const b of ballots)
    await appendEntry(app, electionId, 0, b.payload, {
      ballot: { tier: 0, nullifier: b.nullifier, message: b32(), ballotHash: b.hash },
    });
  const worker = await startWorker({
    connection,
    sql: app,
    log: (l) => logs.push(l),
    auditEveryMs: 3_600_000,
    prefix,
    now: () => new Date(Number(definition.opens_at + 60n) * 1000),
    ...(options.pins === false
      ? {}
      : { ballots: { admissions: new BallotAdmissions({ panels: [panel], clock }) } }),
  });
  const receipts = await ReceiptQueue.open({
    connection,
    prefix,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  running.push({ worker, receipts });
  return { app, receipts };
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

test("a receipt is boarded and answered by its position, and no receipt stays in Redis or reaches the log (T-10)", async () => {
  const { app, receipts } = await setUp();
  const records = [1, 2, 3, 4].map((seat) => receiptFor(first, seat));
  const outcomes = await Promise.all(records.map((r) => receipts.submit(electionId, r)));
  const board = await readBoard(app, electionId);
  expect(board).toHaveLength(ballots.length + 1 + records.length);
  for (const o of outcomes) {
    expect(o.ok && !o.earlier).toBe(true);
    if (o.ok) expect(BigInt(o.index)).toBeGreaterThan(BigInt(ballots.length));
  }
  // A refusal is an outcome with core's code, not a failed job.
  expect(await receipts.submit(electionId, receiptFor(first, 1, { ballotHash: b32() }))).toEqual({
    ok: false,
    code: "rejected",
    rejection: "receipt-ballot",
  });
  const stream = await connection.xrange(`${prefix}:${QUEUES.receiptSubmit.name}:events`, "-", "+");
  expect(stream.length).toBeGreaterThan(0);
  for (const r of records) await expectNoKeyHolds(hex(r).slice(0, 64));
  await expectNoKeyHolds(hex(electionId));
  const mine = logs.filter((l) => l.queue === "{receipt-submit}");
  for (const line of mine)
    expect(line).toEqual({
      queue: "{receipt-submit}",
      outcome: "completed",
      ms: expect.any(Number),
    });
  expect(mine).toHaveLength(records.length + 1);
});

test("with no worker judging receipts, after the timeout, and the job leaves the queue", async () => {
  const { app, receipts } = await setUp({ pins: false, timeoutMs: 300 });
  expect(await receipts.submit(electionId, receiptFor(first, 1))).toEqual({
    ok: false,
    code: "unavailable",
  });
  const queue = new Queue(QUEUES.receiptSubmit.name, { connection, prefix });
  expect(await queue.getWaitingCount()).toBe(0);
  await queue.close();
  expect(await readBoard(app, electionId)).toHaveLength(ballots.length + 1);
});

test("a job older than BALLOT_MAX_AGE_MS is refused unjudged, and boards nothing", async () => {
  const { app } = await setUp();
  const queue = new Queue(QUEUES.receiptSubmit.name, { connection, prefix });
  await queue.add(
    "receiptSubmit",
    { electionId: hex(electionId), record: hex(receiptFor(first, 1)) },
    {
      removeOnComplete: true,
      removeOnFail: true,
      attempts: 1,
      timestamp: Date.now() - BALLOT_MAX_AGE_MS - 1,
    },
  );
  await queue.close();
  for (let i = 0; i < 200 && !logs.some((l) => l.queue === "{receipt-submit}"); i++)
    await new Promise((r) => setTimeout(r, 25));
  expect(logs.filter((l) => l.queue === "{receipt-submit}")).toEqual([
    { queue: "{receipt-submit}", outcome: "failed", error: "stale-job", ms: expect.any(Number) },
  ]);
  expect(await readBoard(app, electionId)).toHaveLength(ballots.length + 1);
});

test("when the database work fails: the job fails by kind, and the API hears unavailable", async () => {
  const { receipts } = await setUp();
  // The schema is dropped under the running worker.
  await dbs[0]!.close();
  dbs = [];
  expect(await receipts.submit(electionId, receiptFor(first, 1))).toEqual({
    ok: false,
    code: "unavailable",
  });
  expect(logs).toContainEqual({
    queue: "{receipt-submit}",
    outcome: "failed",
    error: "internal",
    ms: expect.any(Number),
  });
});

test("an outcome is parsed strictly: a receipt or an unknown field never passes", () => {
  expect(RECEIPT_OUTCOME.safeParse({ ok: true, index: "3", earlier: false }).success).toBe(true);
  expect(
    RECEIPT_OUTCOME.safeParse({ ok: false, code: "rejected", rejection: "share-receipt" }).success,
  ).toBe(true);
  expect(RECEIPT_OUTCOME.safeParse({ ok: true, index: "3" }).success).toBe(false);
  expect(
    RECEIPT_OUTCOME.safeParse({ ok: true, index: "3", earlier: false, record: "000c" }).success,
  ).toBe(false);
  expect(RECEIPT_OUTCOME.safeParse({ ok: true, index: "-1", earlier: true }).success).toBe(false);
  expect(RECEIPT_OUTCOME.safeParse({ ok: false, code: "unavailable" }).success).toBe(false);
});
