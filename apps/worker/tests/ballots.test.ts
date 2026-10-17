import { decodeBoardEntry, decodeElectionDefinition, type Panel } from "@abolishus/crypto";
import {
  appendEntry,
  BallotAdmissions,
  type FinalizedL1Source,
  L1References,
  readBoard,
  storeDefinition,
  type SubmitOutcome,
} from "@abolishus/core";
import { type TestDb, testDb } from "@abolishus/core/test-db";
import { splitEntries } from "@abolishus/verifier";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Sql } from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  BALLOT_MAX_AGE_MS,
  BALLOT_OUTCOME,
  type BallotOutcome,
  BallotBatches,
  BallotQueue,
  type LogLine,
  QUEUES,
  type RunningWorker,
  startWorker,
} from "../src/index.ts";

// The `{ballot-submit}` queue end to end, against a live Redis and Postgres:
// the API's BallotQueue queues a ballot and hears the worker's outcome; the
// worker judges the ballots waiting together in one batch through core's
// submitAll, so each gets the verdict and the entry it would get alone, in
// arrival order (T-17, T-52); and no ballot stays in Redis once judged, nor
// reaches the log (T-10, T-11). Fixtures: docs/spec/vectors/
// verifier-ballots.json (an independent implementation's verdicts).

const redisUrl = process.env["REDIS_URL"];
if (!redisUrl) throw new Error("REDIS_URL is not set");

const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const file = JSON.parse(
  readFileSync(
    new URL("../../../docs/spec/vectors/verifier-ballots.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly panels: Readonly<Record<string, { threshold: string; keys: string[] }>>;
  readonly cases: readonly {
    readonly id: string;
    readonly definition: string;
    readonly board: string;
    readonly ballots?: { readonly rejected: readonly { entry: number; code: string }[] };
  }[];
};
const byId = (id: string) => file.cases.find((c) => c.id === id)!;
const panel: Panel = {
  threshold: Number(file.panels["panel-4"]!.threshold),
  keys: file.panels["panel-4"]!.keys.map(unhex),
};
// Every case shares one election and one window; the fixtures pin board-entry version 5.
const definition = decodeElectionDefinition(unhex(byId("admitted").definition));
const electionId = definition.election_id;
const entriesOf = (id: string) =>
  splitEntries(unhex(byId(id).board)).entries.map((e) => decodeBoardEntry(e, 5));

/** Counts the ballots in each submitAll call, so a test can see the batches. */
class CountingAdmissions extends BallotAdmissions {
  readonly batches: number[] = [];
  override submitAll(...args: Parameters<BallotAdmissions["submitAll"]>): Promise<SubmitOutcome[]> {
    this.batches.push(args[2].length);
    return super.submitAll(...args);
  }
}

// The worker's clock, in UNIX seconds.
let now = definition.opens_at + 60n;
const prefix = `abolish-test-${hex(randomBytes(6))}`;
let connection: Redis;
let dbs: TestDb[] = [];
const running: { worker: RunningWorker; ballots: BallotQueue }[] = [];
const logs: LogLine[] = [];

beforeAll(() => {
  connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
});
afterEach(async () => {
  for (const { worker, ballots } of running.splice(0)) {
    await ballots.close();
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
  now = definition.opens_at + 60n;
});
afterAll(() => connection?.disconnect());

/** A schema of its own holding `id`'s definition and transcript, a worker judging its ballots, and the API's queue. */
async function setUp(
  id: string,
  options: { pins?: boolean; timeoutMs?: number; l1?: FinalizedL1Source } = {},
) {
  const db = await testDb();
  dbs.push(db);
  const app = await db.as("abolish_app");
  await storeDefinition(app, unhex(byId(id).definition));
  const transcript = entriesOf(id)[0]!;
  await appendEntry(app, electionId, transcript.segment, transcript.payload);
  const admissions = new CountingAdmissions({
    panels: [panel],
    clock: { epoch: definition.opens_at, period: 3_600n },
    ...(options.l1 === undefined ? {} : { l1: new L1References({ source: options.l1 }) }),
  });
  const worker = await startWorker({
    connection,
    sql: app,
    log: (l) => logs.push(l),
    auditEveryMs: 3_600_000,
    prefix,
    now: () => new Date(Number(now) * 1000),
    ...(options.pins === false ? {} : { ballots: { admissions, waitMs: 50 } }),
  });
  const ballots = await BallotQueue.open({
    connection,
    prefix,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  running.push({ worker, ballots });
  return { app, admissions, ballots };
}

const label = (o: BallotOutcome | { ok: false; code: "unavailable" }) =>
  o.ok
    ? "boarded"
    : "admission" in o && o.admission !== undefined
      ? `${o.code}:${o.admission}`
      : o.code;

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

describe("the worker judges queued ballots as core's submit would", () => {
  test(
    "each ballot of the mixed case, one at a time, gets its verdict, and the admitted ones their entries",
    { timeout: 60_000 },
    async () => {
      const { app, ballots } = await setUp("mixed");
      const rejected = new Map(
        (byId("mixed").ballots?.rejected ?? [])
          .filter((r) => r.code !== "repeat")
          .map((r) => [r.entry, r.code] as const),
      );
      for (const [at, e] of entriesOf("mixed").entries()) {
        if (at === 0) continue;
        const o = await ballots.submit(electionId, e.payload);
        const code = rejected.get(at);
        expect(label(o)).toBe(code === undefined ? "boarded" : `rejected:${code}`);
        if (o.ok) {
          const board = await readBoard(app, electionId);
          expect(decodeBoardEntry(board[Number(o.index)]!, 5).payload).toEqual(e.payload);
        }
      }
      expect(rejected.size).toBeGreaterThan(0);
    },
  );

  test(
    "ballots sent together are judged in one batch, boarded in the order they arrived",
    { timeout: 60_000 },
    async () => {
      const { app, admissions, ballots } = await setUp("admitted");
      const payloads = entriesOf("admitted")
        .slice(1)
        .map((e) => e.payload);
      expect(payloads.length).toBeGreaterThan(1);
      const outcomes = await Promise.all(payloads.map((p) => ballots.submit(electionId, p)));
      expect(outcomes.map(label)).toEqual(payloads.map(() => "boarded"));
      // Fewer batches than ballots: some were judged together.
      expect(admissions.batches.reduce((a, b) => a + b, 0)).toBe(payloads.length);
      expect(admissions.batches.length).toBeLessThan(payloads.length);
      const board = await readBoard(app, electionId);
      expect(board).toHaveLength(payloads.length + 1);
      // Each outcome names the entry that carries its own ballot.
      for (const [i, o] of outcomes.entries())
        expect(decodeBoardEntry(board[Number(o.ok && o.index)]!, 5).payload).toEqual(payloads[i]);
    },
  );

  test("outside the window by the worker's clock, every ballot is not-open", async () => {
    const { app, ballots } = await setUp("admitted");
    now = definition.closes_at + 1n;
    const o = await ballots.submit(electionId, entriesOf("admitted")[1]!.payload);
    expect(label(o)).toBe("not-open");
    expect(label(await ballots.submit(new Uint8Array(32).fill(7), Uint8Array.of(0, 2, 1)))).toBe(
      "unknown-election",
    );
    now = definition.opens_at + 60n;
    // Empty bytes are the verifier's to refuse, as the contract lets them through.
    expect(label(await ballots.submit(electionId, new Uint8Array(0)))).toBe("rejected:decode");
    expect(await readBoard(app, electionId)).toHaveLength(1);
  });

  test("no ballot stays in Redis once judged, and no log line names one (T-10)", async () => {
    const { ballots } = await setUp("mixed");
    const payloads = entriesOf("mixed")
      .slice(1)
      .map((e) => e.payload);
    await Promise.all(payloads.map((p) => ballots.submit(electionId, p)));
    // The events stream keeps each job's outcome: an index or a code, never the ballot.
    const stream = await connection.xrange(
      `${prefix}:${QUEUES.ballotSubmit.name}:events`,
      "-",
      "+",
    );
    expect(stream.length).toBeGreaterThan(0);
    for (const p of payloads) await expectNoKeyHolds(hex(p).slice(0, 64));
    await expectNoKeyHolds(hex(electionId));
    for (const line of logs)
      for (const p of payloads) expect(JSON.stringify(line)).not.toContain(hex(p).slice(0, 64));
    const mine = logs.filter((l) => l.queue === "{ballot-submit}");
    for (const line of mine)
      expect(line).toEqual({
        queue: "{ballot-submit}",
        outcome: "completed",
        ms: expect.any(Number),
      });
    expect(mine).toHaveLength(payloads.length);
  });
});

describe("the L1 reference (5.8), with an L1 node", () => {
  // A chain on which every block the fixtures' ballots name is finalized
  // and stamped inside the window, but by other hashes.
  const forged = (down = false): FinalizedL1Source => ({
    chainId: definition.l1_chain_id,
    finalizedHead: async () => {
      if (down) throw new Error("node down");
      return 21_100_000n;
    },
    block: async (n) => ({
      hash: new Uint8Array(32),
      timestamp: definition.opens_at + 12n * (n - 21_000_000n),
    }),
  });

  test("a ballot naming a finalized block by another hash is refused with 5.8's code", async () => {
    const { app, ballots } = await setUp("admitted", { l1: forged() });
    const o = await ballots.submit(electionId, entriesOf("admitted")[1]!.payload);
    expect(label(o)).toBe("rejected:l1-ref-unknown");
    expect(await readBoard(app, electionId)).toHaveLength(1);
  });

  test("an unreachable node boards the ballot unchecked, and says so without naming it", async () => {
    const { ballots } = await setUp("admitted", { l1: forged(true) });
    const payload = entriesOf("admitted")[1]!.payload;
    expect(label(await ballots.submit(electionId, payload))).toBe("boarded");
    const lines = logs.filter((l) => "finding" in l && l.queue === "{ballot-submit}");
    expect(lines).toEqual([{ queue: "{ballot-submit}", finding: "l1-unchecked" }]);
    const text = JSON.stringify(logs);
    expect(text).not.toContain(hex(electionId));
    expect(text).not.toContain(hex(payload).slice(0, 64));
  });
});

describe("a ballot without an outcome in time is unavailable", () => {
  test("with no worker judging ballots, after the timeout, and the job leaves the queue", async () => {
    const { app, ballots } = await setUp("admitted", { pins: false, timeoutMs: 300 });
    const o = await ballots.submit(electionId, entriesOf("admitted")[1]!.payload);
    expect(label(o)).toBe("unavailable");
    const queue = new Queue(QUEUES.ballotSubmit.name, { connection, prefix });
    expect(await queue.getWaitingCount()).toBe(0);
    await queue.close();
    expect(await readBoard(app, electionId)).toHaveLength(1);
  });

  test("past the waiting bound, without being queued (T-52)", async () => {
    const { ballots } = await setUp("admitted", { pins: false, timeoutMs: 30_000 });
    const full = await BallotQueue.open({ connection, prefix, maxWaiting: 1, timeoutMs: 30_000 });
    try {
      const queue = new Queue(QUEUES.ballotSubmit.name, { connection, prefix });
      const first = ballots.submit(electionId, entriesOf("admitted")[1]!.payload);
      for (let i = 0; i < 200 && (await queue.getWaitingCount()) < 1; i++)
        await new Promise((r) => setTimeout(r, 10));
      await queue.close();
      expect(label(await full.submit(electionId, entriesOf("admitted")[2]!.payload))).toBe(
        "unavailable",
      );
      await ballots.close();
      expect(label(await first)).toBe("unavailable");
    } finally {
      await full.close();
    }
  });

  test("when the batch's database work fails: the job fails by kind, and the API hears unavailable", async () => {
    const { ballots } = await setUp("admitted");
    // The schema is dropped under the running worker.
    await dbs[0]!.close();
    dbs = [];
    expect(label(await ballots.submit(electionId, entriesOf("admitted")[1]!.payload))).toBe(
      "unavailable",
    );
    expect(logs).toContainEqual({
      queue: "{ballot-submit}",
      outcome: "failed",
      error: "internal",
      ms: expect.any(Number),
    });
  });
});

test("a job older than BALLOT_MAX_AGE_MS is refused unjudged, and boards nothing", async () => {
  const { app } = await setUp("admitted");
  const queue = new Queue(QUEUES.ballotSubmit.name, { connection, prefix });
  await queue.add(
    "ballotSubmit",
    { electionId: hex(electionId), ballot: hex(entriesOf("admitted")[1]!.payload) },
    {
      removeOnComplete: true,
      removeOnFail: true,
      attempts: 1,
      timestamp: Date.now() - BALLOT_MAX_AGE_MS - 1,
    },
  );
  await queue.close();
  for (let i = 0; i < 200 && !logs.some((l) => l.queue === "{ballot-submit}"); i++)
    await new Promise((r) => setTimeout(r, 25));
  expect(logs.filter((l) => l.queue === "{ballot-submit}")).toEqual([
    { queue: "{ballot-submit}", outcome: "failed", error: "stale-job", ms: expect.any(Number) },
  ]);
  expect(await readBoard(app, electionId)).toHaveLength(1);
});

test("a batch that fails outside an election's call still settles every ballot", async () => {
  const batches = new BallotBatches({
    sql: undefined as unknown as Sql,
    admissions: undefined as unknown as BallotAdmissions,
    now: () => {
      throw new Error("clock");
    },
    waitMs: 0,
  });
  const ballots = [1, 2, 3].map((i) =>
    batches.submit(hex(electionId), hex(Uint8Array.of(0, 2, i))),
  );
  for (const b of ballots) await expect(b).rejects.toThrow("clock");
});

test("an outcome is parsed strictly: a ballot or an unknown field never passes", () => {
  expect(BALLOT_OUTCOME.safeParse({ ok: true, index: "3" }).success).toBe(true);
  expect(
    BALLOT_OUTCOME.safeParse({ ok: false, code: "rejected", admission: "repeat" }).success,
  ).toBe(true);
  expect(BALLOT_OUTCOME.safeParse({ ok: true, index: "3", ballot: "0002" }).success).toBe(false);
  expect(BALLOT_OUTCOME.safeParse({ ok: true, index: "-1" }).success).toBe(false);
  expect(BALLOT_OUTCOME.safeParse({ ok: false, code: "unavailable" }).success).toBe(false);
});

test("BallotBatches refuses options it can't run under", () => {
  const options = {
    sql: undefined as unknown as Sql,
    admissions: undefined as unknown as BallotAdmissions,
    now: () => 0n,
  };
  expect(() => new BallotBatches({ ...options, batch: 0 })).toThrow(RangeError);
  expect(() => new BallotBatches({ ...options, waitMs: -1 })).toThrow(RangeError);
});
