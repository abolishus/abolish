import {
  BallotAdmissions,
  DestructionBoardings,
  readBoard,
  readBoardedDestructions,
} from "@abolishus/core";
import { newElection, type TestDb, testDb } from "@abolishus/core/test-db";
import {
  type DestructionElection,
  encodeDestructionStatement,
  identityKey,
  signDestructionStatement,
} from "@abolishus/crypto";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, test } from "vite-plus/test";
import { panel } from "../../../packages/verifier/tests/receipt-poll.ts";
import {
  BALLOT_MAX_AGE_MS,
  DESTRUCTION_OUTCOME,
  DestructionQueue,
  type LogLine,
  QUEUES,
  type RunningWorker,
  startWorker,
} from "../src/index.ts";

// The `{destruction-submit}` queue end to end, against a live Redis and
// Postgres: the API's DestructionQueue queues a destruction statement and
// hears the worker's outcome from core's DestructionBoardings
// (docs/spec/tally.md, Destruction, Boarding; T-17, T-52), and no statement
// stays in Redis once judged, nor reaches the log (T-10, T-11). The verdicts
// themselves are core's destruction-boarding test's, over
// docs/spec/vectors/destruction.json; the target is given to the boarding
// directly, as there: a deployment's is core's `destructionTargets`.

const redisUrl = process.env["REDIS_URL"];
if (!redisUrl) throw new Error("REDIS_URL is not set");

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const prefix = `abolish-test-destructions-${hex(randomBytes(6))}`;
const CLOCK = { epoch: 1_000_000n, period: 3_600n };
const NOW = CLOCK.epoch + 10n * CLOCK.period;

// Seats of a panel of three, two registered, each signing its statement.
const SECRETS = [1, 2, 3].map((i) => new Uint8Array(32).fill(i));
const own: DestructionElection = {
  definitionHash: new Uint8Array(32).fill(0xd1),
  registered: [1, 2].map((index) => ({
    index,
    signingKey: identityKey(SECRETS[index - 1] as Uint8Array),
  })),
};
const statementOf = (signer: number, definitionHash = own.definitionHash) =>
  encodeDestructionStatement(
    signDestructionStatement(SECRETS[signer - 1] as Uint8Array, {
      definition_hash: definitionHash,
      signer,
    }),
  );

let connection: Redis;
let dbs: TestDb[] = [];
const running: { worker: RunningWorker; destructions: DestructionQueue }[] = [];
const logs: LogLine[] = [];

beforeAll(() => {
  connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
});
afterEach(async () => {
  for (const { worker, destructions } of running.splice(0)) {
    await destructions.close();
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

/** A schema of its own holding an election, a worker boarding its statements against `target`, and the API's queue. */
async function setUp(
  options: { target?: DestructionElection | undefined | false; timeoutMs?: number } = {},
) {
  const db = await testDb();
  dbs.push(db);
  const app = await db.as("abolish_app");
  const id = await newElection(app);
  const target = "target" in options ? options.target : own;
  const worker = await startWorker({
    connection,
    sql: app,
    log: (l) => logs.push(l),
    auditEveryMs: 3_600_000,
    prefix,
    now: () => new Date(Number(NOW) * 1000),
    ballots: { admissions: new BallotAdmissions({ panels: [panel], clock: CLOCK }) },
    ...(target === false
      ? {}
      : {
          destructions: {
            boardings: new DestructionBoardings({ target: async () => target, clock: CLOCK }),
          },
        }),
  });
  const destructions = await DestructionQueue.open({
    connection,
    prefix,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  running.push({ worker, destructions });
  return { app, id, destructions };
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

test("a statement is boarded and answered by its position, a resend by the same, and no statement stays in Redis or reaches the log (T-10)", async () => {
  const { app, id, destructions } = await setUp();
  const records = [statementOf(1), statementOf(2)];
  const outcomes = [];
  for (const r of records) outcomes.push(await destructions.submit(id, r));
  expect(outcomes).toEqual([0, 1].map((i) => ({ ok: true, index: String(i) })));
  expect(await destructions.submit(id, statementOf(2))).toEqual({ ok: true, index: "1" });
  expect((await readBoardedDestructions(app, id)).map((d) => d.index)).toEqual([0n, 1n]);
  // A refusal is an outcome with core's code, not a failed job.
  expect(await destructions.submit(id, statementOf(3))).toEqual({
    ok: false,
    code: "rejected",
    rejection: "destruction-unattributed",
  });
  expect(await destructions.submit(id, statementOf(1, new Uint8Array(32).fill(0xd2)))).toEqual({
    ok: false,
    code: "rejected",
    rejection: "destruction-stray",
  });
  expect(await destructions.submit(id, Uint8Array.of(0x00, 0x0f, 1))).toEqual({
    ok: false,
    code: "rejected",
    rejection: "decode",
  });
  expect(await readBoard(app, id)).toHaveLength(2);
  const stream = await connection.xrange(
    `${prefix}:${QUEUES.destructionSubmit.name}:events`,
    "-",
    "+",
  );
  expect(stream.length).toBeGreaterThan(0);
  // The signatures: the rest of a statement is the election's and the seat's.
  for (const r of records) await expectNoKeyHolds(hex(r.subarray(36)));
  await expectNoKeyHolds(hex(id));
  const mine = logs.filter((l) => l.queue === "{destruction-submit}");
  for (const line of mine)
    expect(line).toEqual({
      queue: "{destruction-submit}",
      outcome: "completed",
      ms: expect.any(Number),
    });
  expect(mine).toHaveLength(records.length + 4);
});

test("where no target is given, the code says the election takes none", async () => {
  const { app, id, destructions } = await setUp({ target: undefined });
  expect(await destructions.submit(id, statementOf(1))).toEqual({ ok: false, code: "not-open" });
  expect(await readBoard(app, id)).toHaveLength(0);
});

test("with no worker boarding statements, after the timeout, and the job leaves the queue", async () => {
  const { app, id, destructions } = await setUp({ target: false, timeoutMs: 300 });
  expect(await destructions.submit(id, statementOf(1))).toEqual({
    ok: false,
    code: "unavailable",
  });
  const queue = new Queue(QUEUES.destructionSubmit.name, { connection, prefix });
  expect(await queue.getWaitingCount()).toBe(0);
  await queue.close();
  expect(await readBoard(app, id)).toHaveLength(0);
});

test("a job older than BALLOT_MAX_AGE_MS is refused unjudged, and boards nothing", async () => {
  const { app, id } = await setUp();
  const queue = new Queue(QUEUES.destructionSubmit.name, { connection, prefix });
  await queue.add(
    "destructionSubmit",
    { electionId: hex(id), statement: hex(statementOf(1)) },
    {
      removeOnComplete: true,
      removeOnFail: true,
      attempts: 1,
      timestamp: Date.now() - BALLOT_MAX_AGE_MS - 1,
    },
  );
  await queue.close();
  for (let i = 0; i < 200 && !logs.some((l) => l.queue === "{destruction-submit}"); i++)
    await new Promise((r) => setTimeout(r, 25));
  expect(logs.filter((l) => l.queue === "{destruction-submit}")).toEqual([
    {
      queue: "{destruction-submit}",
      outcome: "failed",
      error: "stale-job",
      ms: expect.any(Number),
    },
  ]);
  expect(await readBoard(app, id)).toHaveLength(0);
});

test("when the database work fails: the job fails by kind, and the API hears unavailable", async () => {
  const { id, destructions } = await setUp();
  await dbs[0]!.close();
  dbs = [];
  expect(await destructions.submit(id, statementOf(1))).toEqual({
    ok: false,
    code: "unavailable",
  });
  expect(logs).toContainEqual({
    queue: "{destruction-submit}",
    outcome: "failed",
    error: "internal",
    ms: expect.any(Number),
  });
});

test("destruction statements are boarded only beside ballot admission", async () => {
  const db = await testDb();
  dbs.push(db);
  await expect(
    startWorker({
      connection,
      sql: await db.as("abolish_app"),
      log: () => {},
      auditEveryMs: 3_600_000,
      prefix,
      destructions: {
        boardings: new DestructionBoardings({ target: async () => own, clock: CLOCK }),
      },
    }),
  ).rejects.toThrow("beside ballot admission");
});

test("an outcome is parsed strictly: a statement or an unknown field never passes", () => {
  expect(DESTRUCTION_OUTCOME.safeParse({ ok: true, index: "3" }).success).toBe(true);
  expect(DESTRUCTION_OUTCOME.safeParse({ ok: false, code: "not-ready" }).success).toBe(true);
  expect(
    DESTRUCTION_OUTCOME.safeParse({
      ok: false,
      code: "rejected",
      rejection: "destruction-stray",
    }).success,
  ).toBe(true);
  expect(DESTRUCTION_OUTCOME.safeParse({ ok: true, index: "3", statement: "000f" }).success).toBe(
    false,
  );
  expect(DESTRUCTION_OUTCOME.safeParse({ ok: true, index: "-1" }).success).toBe(false);
  expect(DESTRUCTION_OUTCOME.safeParse({ ok: false, code: "unavailable" }).success).toBe(false);
});
