import { appendEntry } from "@abolishus/core";
import { type TestDb, testDb } from "@abolishus/core/test-db";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import type { Sql } from "postgres";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { type LogLine, QUEUES, type RunningWorker, startWorker } from "../src/index.ts";

// The worker end to end, against a live Redis and Postgres: the scheduled
// audit passes good boards and names bad ones (T-23, T-66), every key is
// under its queue's hash tag, and no log line or Redis key keeps a job's data
// or anything that names a person (T-10, T-11).

const redisUrl = process.env["REDIS_URL"];
if (!redisUrl) throw new Error("REDIS_URL is not set");

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const b32 = () => new Uint8Array(randomBytes(32));
const ballot = (...body: number[]) => Uint8Array.of(0x00, 0x02, 1, ...body);
const MARKER = "alice@example.org";

// Each run its own key prefix, so runs sharing a Redis never see each other.
const prefix = `abolish-test-${hex(randomBytes(6))}`;

let db: TestDb;
let app: Sql;
let connection: Redis;
let worker: RunningWorker;
let audits: Queue;
const logs: LogLine[] = [];

beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
  connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  worker = await startWorker({
    connection,
    sql: app,
    log: (l) => logs.push(l),
    // Long enough that the schedule never fires during the run; tests queue
    // audits themselves.
    auditEveryMs: 3_600_000,
    prefix,
  });
  audits = new Queue(QUEUES.boardAudit.name, { connection, prefix });
});
afterAll(async () => {
  await worker?.close();
  await audits?.obliterate({ force: true });
  await audits?.close();
  connection?.disconnect();
  await db?.close();
});

/** Waits for the next job's outcome line, and returns every line logged since the last call. */
async function outcome(): Promise<LogLine[]> {
  for (let i = 0; i < 200; i++) {
    if (logs.some((l) => "outcome" in l)) return logs.splice(0);
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("no job finished");
}

/** Queues an audit with `data` and waits for its lines. Jobs run one at a time. */
async function audit(data: object): Promise<LogLine[]> {
  await audits.add("boardAudit", data);
  return outcome();
}

/** Fails if any key under `keyPrefix`, of any type, holds `marker`. */
async function expectNoKeyHolds(keyPrefix: string, marker: string) {
  const keys = await connection.keys(`${keyPrefix}:*`);
  expect(keys.length).toBeGreaterThan(0);
  for (const key of keys) {
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
                  : `unchecked ${type}`;
    expect(dump, key).not.toContain(marker);
  }
}

test("schedules the board audit, and runs it once at start", async () => {
  const schedulers = await audits.getJobSchedulers();
  expect(schedulers.map((s) => [s.key, s.every])).toEqual([["board-audit", 3_600_000]]);
  expect(await outcome()).toEqual([
    { queue: "{board-audit}", outcome: "completed", ms: expect.any(Number) },
  ]);
});

test("an audit of good boards completes, and its line holds only queue, outcome and duration", async () => {
  const id = b32();
  await appendEntry(app, id, 0, ballot(1));
  const lines = await audit({});
  expect(lines).toHaveLength(1);
  expect(Object.keys(lines[0] as object).sort()).toEqual(["ms", "outcome", "queue"]);
  expect(lines[0]).toMatchObject({ queue: "{board-audit}", outcome: "completed" });
});

test("a job with data its schema doesn't name fails unhandled, and its data is neither logged nor kept", async () => {
  // A producer that skipped the schema: an account field on a board queue.
  const lines = await audit({ account: MARKER });
  expect(lines).toEqual([
    {
      queue: "{board-audit}",
      outcome: "failed",
      error: "invalid-job-data",
      ms: expect.any(Number),
    },
  ]);
  expect(JSON.stringify(lines)).not.toContain(MARKER);
  // removeOnFail: nothing in Redis still holds the data.
  await expectNoKeyHolds(prefix, MARKER);
});

test("every key the worker uses is under its queue's hash tag", async () => {
  await audit({});
  const keys = await connection.keys(`${prefix}:*`);
  expect(keys.length).toBeGreaterThan(0);
  for (const key of keys) expect(key.startsWith(`${prefix}:{board-audit}:`), key).toBe(true);
});

test("a handler's own error message is neither logged nor kept, the events stream included", async () => {
  // Error messages can quote data (Drizzle's quote the query's parameters).
  const own = `abolish-test-${hex(randomBytes(6))}`;
  const lines: LogLine[] = [];
  const other = await startWorker({
    connection,
    sql: app,
    log: (l) => lines.push(l),
    auditEveryMs: 3_600_000,
    prefix: own,
    handlers: {
      boardAudit: async () => {
        throw new Error(`params: ${MARKER}`);
      },
    },
  });
  try {
    for (let i = 0; i < 200 && !lines.some((l) => "outcome" in l); i++)
      await new Promise((r) => setTimeout(r, 25));
    expect(lines).toEqual([
      { queue: "{board-audit}", outcome: "failed", error: "internal", ms: expect.any(Number) },
    ]);
    await expectNoKeyHolds(own, MARKER);
  } finally {
    await other.close();
    await new Queue(QUEUES.boardAudit.name, { connection, prefix: own }).obliterate({
      force: true,
    });
  }
});

test("msgpackr's native accelerator isn't installed, so no prebuilt binary loads", async () => {
  const fromBullmq = createRequire(createRequire(import.meta.url).resolve("bullmq"));
  const msgpackr = fromBullmq.resolve("msgpackr");
  expect(() => createRequire(msgpackr).resolve("msgpackr-extract")).toThrow();
  const { isNativeAccelerationEnabled } = (await import(msgpackr)) as {
    isNativeAccelerationEnabled: boolean;
  };
  expect(isNativeAccelerationEnabled).toBe(false);
});

// Last: the bad boards stay in the schema and fail every later audit.
test("an audit names every bad board, then fails by kind", async () => {
  const bad = [b32(), b32()];
  for (const id of bad) {
    await appendEntry(app, id, 0, ballot(0));
    // A row a writer stored without appendEntry: its entry hash is random.
    const [prev] = await app`SELECT link FROM board_entries WHERE election_id = ${id}`;
    await app`INSERT INTO board_entries (election_id, idx, segment, payload, entry_hash, prev_link, link)
      VALUES (${id}, 1, 0, ${ballot(1)}, ${b32()}, ${Uint8Array.from(prev!["link"])}, ${b32()})`;
  }
  const lines = await audit({});
  const findings = lines.filter((l) => "finding" in l);
  expect(findings.map((f) => f.election).sort()).toEqual(bad.map(hex).sort());
  for (const f of findings)
    expect(f).toEqual({
      queue: "{board-audit}",
      finding: "entry-hash-mismatch",
      election: f.election,
      index: 1,
    });
  expect(lines.filter((l) => "outcome" in l)).toEqual([
    {
      queue: "{board-audit}",
      outcome: "failed",
      error: "board-audit-findings",
      ms: expect.any(Number),
    },
  ]);
});
