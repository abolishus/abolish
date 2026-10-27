import {
  type AnchorChain,
  type ArweaveClient,
  appendEntry,
  type BallotAdmissions,
  type CreationAnchors,
  type PollCreationChain,
  type PollRegistrationChain,
  type PollStubDeployment,
  type Tier0Batches,
  type Tier1Batches,
} from "@abolishus/core";
import { identityKey, type Panel } from "@abolishus/crypto";
import type { PollRoots, RegistrySync } from "../src/index.ts";
import { newElection, type TestDb, testDb } from "@abolishus/core/test-db";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import type { Sql } from "postgres";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import {
  type LogLine,
  PRUNE_EVERY_MS,
  QUEUES,
  type QueueSpec,
  type RunningWorker,
  startWorker,
  TIER0_QUEUES,
  TIER1_QUEUES,
} from "../src/index.ts";

// The worker end to end, against a live Redis and Postgres: the scheduled
// audit passes good boards and names bad ones (T-23, T-66), the scheduled
// prune deletes expired identity backups and nothing else (T-52), every key is
// under its queue's hash tag, and no log line or Redis key keeps a job's data
// or anything that names a person (T-10, T-11).

const redisUrl = process.env["REDIS_URL"];
if (!redisUrl) throw new Error("REDIS_URL is not set");

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const b32 = () => new Uint8Array(randomBytes(32));
const ballot = (...body: number[]) => Uint8Array.of(0x00, 0x02, 1, ...body);
const MARKER = "alice@example.org";
// The worker's clock: March 2026, so a backup last written in February 2024
// has expired and one written in March 2024 hasn't (24 whole months). Months
// away from the system clock's, so a prune that ignored the worker's clock
// fails the test.
const NOW = new Date("2026-03-15T12:00:00Z");

// Each run its own key prefix, so runs sharing a Redis never see each other.
const prefix = `abolish-test-${hex(randomBytes(6))}`;

let db: TestDb;
let app: Sql;
let connection: Redis;
let worker: RunningWorker;
let audits: Queue;
let prunes: Queue;
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
    now: () => NOW,
    prefix,
  });
  audits = new Queue(QUEUES.boardAudit.name, { connection, prefix });
  prunes = new Queue(QUEUES.identityBackupPrune.name, { connection, prefix });
});
afterAll(async () => {
  await worker?.close();
  for (const queue of [audits, prunes]) {
    await queue?.obliterate({ force: true });
    await queue?.close();
  }
  connection?.disconnect();
  await db?.close();
});

/**
 * Waits for the next outcome line of `queue`'s jobs, and takes every line of
 * that queue logged since the last call; other queues' lines stay. Jobs of
 * one queue run one at a time.
 */
async function outcome(queue: QueueSpec["name"] = "{board-audit}"): Promise<LogLine[]> {
  for (let i = 0; i < 200; i++) {
    if (logs.some((l) => l.queue === queue && "outcome" in l)) {
      const mine = logs.filter((l) => l.queue === queue);
      logs.splice(0, logs.length, ...logs.filter((l) => l.queue !== queue));
      return mine;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no ${queue} job finished`);
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
    // The worker is still running, so a listed key can expire or be deleted
    // before its type is read (a lock or a marker, say); a key that is gone
    // holds nothing.
    if (type === "none") continue;
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
                  : expect.unreachable(`a key of unchecked type ${type}`);
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

test("schedules no anchoring run without an anchor", async () => {
  const queue = new Queue(QUEUES.boardAnchor.name, { connection, prefix });
  try {
    expect(await queue.getJobSchedulers()).toEqual([]);
  } finally {
    await queue.close();
  }
});

test("schedules no archive run without an archive", async () => {
  const queue = new Queue(QUEUES.archive.name, { connection, prefix });
  try {
    expect(await queue.getJobSchedulers()).toEqual([]);
  } finally {
    await queue.close();
  }
});

test("schedules the identity-backup prune daily, and runs it once at start", async () => {
  expect(PRUNE_EVERY_MS).toBe(86_400_000);
  const schedulers = await prunes.getJobSchedulers();
  expect(schedulers.map((s) => [s.key, s.every])).toEqual([
    ["identity-backup-prune", PRUNE_EVERY_MS],
  ]);
  expect(await outcome("{identity-backup-prune}")).toEqual([
    { queue: "{identity-backup-prune}", outcome: "completed", ms: expect.any(Number) },
  ]);
});

test("a prune deletes the backups expired by the worker's clock, and only those", async () => {
  // Rows of the table's shape: the prune judges only the month, never the
  // envelope, so these needn't open.
  const row = async (month: string) => {
    const id = b32();
    const envelope = Uint8Array.of(0x00, 0x0a, 1, ...randomBytes(60));
    await db.admin`INSERT INTO identity_backups (id, envelope, written_month)
      VALUES (${id}, ${envelope}, ${month})`;
    return id;
  };
  const stored = async (id: Uint8Array) =>
    (await db.admin`SELECT 1 FROM identity_backups WHERE id = ${id}`).length === 1;
  const expired = await row("2024-02-01");
  const kept = await row("2024-03-01");
  const recent = await row("2026-03-01");
  await prunes.add("identityBackupPrune", {});
  const lines = await outcome("{identity-backup-prune}");
  // One line, by outcome only: nothing about the rows is logged (T-10).
  expect(lines).toEqual([
    { queue: "{identity-backup-prune}", outcome: "completed", ms: expect.any(Number) },
  ]);
  expect(await stored(expired)).toBe(false);
  expect(await stored(kept)).toBe(true);
  expect(await stored(recent)).toBe(true);
});

test("an audit of good boards completes, and its line holds only queue, outcome and duration", async () => {
  const id = await newElection(app);
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

test("a job named other than its queue's key fails unhandled", async () => {
  await audits.add("audit", {});
  expect(await outcome()).toEqual([
    {
      queue: "{board-audit}",
      outcome: "failed",
      error: "invalid-job-data",
      ms: expect.any(Number),
    },
  ]);
});

test("every key the worker uses is under its queue's hash tag", async () => {
  await audit({});
  await prunes.add("identityBackupPrune", {});
  await outcome("{identity-backup-prune}");
  const keys = await connection.keys(`${prefix}:*`);
  // This worker has no Tier 0 job or Tier 1 relay, pins no panel (so boards
  // no opening or destruction statement either, tests/openings.test.ts and
  // tests/destructions.test.ts), has no
  // registry sync, roots or stub step (nor the coordinator and the opening
  // step beside it) and holds no creation key, so those queues have no keys
  // here (tests/tier0.test.ts, tests/tier1.test.ts, tests/ballots.test.ts,
  // tests/registry-sync.test.ts, tests/poll-roots.test.ts,
  // tests/poll-stubs.test.ts, tests/ceremony.test.ts and
  // tests/poll-open.test.ts cover the first eight; the creation worker's test
  // below checks its keys).
  const tags = Object.entries(QUEUES)
    .filter(
      ([key]) =>
        ![
          ...TIER0_QUEUES,
          ...TIER1_QUEUES,
          "ballotSubmit",
          "receiptSubmit",
          "openingSubmit",
          "destructionSubmit",
          "registrySync",
          "pollCreate",
          "pollRoot",
          "pollStub",
          "ceremonyCoordinate",
          "pollOpen",
        ].includes(key),
    )
    .map(([, q]) => `${prefix}:${q.name}:`);
  for (const tag of tags)
    expect(
      keys.some((k) => k.startsWith(tag)),
      tag,
    ).toBe(true);
  for (const key of keys)
    expect(
      tags.some((t) => key.startsWith(t)),
      key,
    ).toBe(true);
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
      // Not scheduled: this worker has no anchor.
      boardAnchor: async () => {
        throw new Error(`params: ${MARKER}`);
      },
      // Not scheduled: this worker has no archive.
      archive: async () => {},
      identityBackupPrune: async () => {
        throw new Error(`params: ${MARKER}`);
      },
      // Not scheduled: this worker has no Tier 0 job.
      tier0Index: async () => {},
      tier0Boundary: async () => {},
      // Not scheduled: this worker has no Tier 1 relay.
      tier1Index: async () => {},
      tier1Boundary: async () => {},
      // Not scheduled: this worker has no registry sync.
      registrySync: async () => {},
      // Not scheduled: this worker holds no creation key.
      pollCreate: async () => {},
      // Not scheduled: this worker has no roots step.
      pollRoot: async () => {},
      // Not scheduled: this worker has no stub step.
      pollStub: async () => {},
      ceremonyCoordinate: async () => {},
      pollOpen: async () => {},
      // Not run: this worker pins no panel.
      ballotSubmit: async () => {
        throw new Error(`params: ${MARKER}`);
      },
      receiptSubmit: async () => {
        throw new Error(`params: ${MARKER}`);
      },
      // Not run: this worker boards no opening.
      openingSubmit: async () => {
        throw new Error(`params: ${MARKER}`);
      },
      // Not run: this worker boards no destruction statement.
      destructionSubmit: async () => {
        throw new Error(`params: ${MARKER}`);
      },
    },
  });
  try {
    // Both scheduled jobs run once at start.
    for (let i = 0; i < 200 && lines.filter((l) => "outcome" in l).length < 2; i++)
      await new Promise((r) => setTimeout(r, 25));
    expect(lines.sort((a, b) => a.queue.localeCompare(b.queue))).toEqual([
      { queue: "{board-audit}", outcome: "failed", error: "internal", ms: expect.any(Number) },
      {
        queue: "{identity-backup-prune}",
        outcome: "failed",
        error: "internal",
        ms: expect.any(Number),
      },
    ]);
    await expectNoKeyHolds(own, MARKER);
  } finally {
    await other.close();
    for (const { name } of Object.values(QUEUES)) {
      const queue = new Queue(name, { connection, prefix: own });
      await queue.obliterate({ force: true });
      await queue.close();
    }
  }
});

test("schedules no creation run without the creation key", async () => {
  const queue = new Queue(QUEUES.pollCreate.name, { connection, prefix });
  try {
    expect(await queue.getJobSchedulers()).toEqual([]);
  } finally {
    await queue.close();
  }
});

/** A creation key that never has anything to send or read. */
const idleChain: PollCreationChain & PollRegistrationChain = {
  creator: new Uint8Array(20).fill(0xc0),
  nonces: async () => ({ finalized: 0n, latest: 0n, pending: 0n }),
  signCreation: async () => {
    throw new Error("nothing is submitted");
  },
  signCeremony: async () => {
    throw new Error("nothing is approved");
  },
  signDefinition: async () => {
    throw new Error("nothing is approved");
  },
  broadcast: async () => {},
  creation: async () => ({ state: "unknown" }),
  registration: async () => ({ state: "unknown" }),
};

/** A default panel with no ceremony to register. */
const idlePanel: Panel = {
  threshold: 2,
  keys: [1, 2, 3].map((i) => identityKey(new Uint8Array(32).fill(i))),
};

/** An L1 anchor the per-slot check never needs: nothing is created. */
const idleAnchors: CreationAnchors = {
  clock: { epoch: 0n, period: 3600n },
  finalized: async () => {
    throw new Error("nothing is created");
  },
  words: async () => {
    throw new Error("nothing is created");
  },
};

test("a worker holding the creation key runs the creation step and nothing else", async () => {
  // ADR 0032, rule 2: no audit, prune, anchoring, Tier 0 or ballot work
  // beside the key.
  const own = `abolish-test-${hex(randomBytes(6))}`;
  const lines: LogLine[] = [];
  const creator = await startWorker({
    connection,
    sql: app,
    log: (l) => lines.push(l),
    auditEveryMs: 3_600_000,
    prefix: own,
    pollCreation: {
      chain: idleChain,
      dailyCeiling: 1,
      anchors: idleAnchors,
      panel: idlePanel,
      everyMs: 3_600_000,
    },
  });
  try {
    for (let i = 0; i < 200 && !lines.some((l) => "outcome" in l); i++)
      await new Promise((r) => setTimeout(r, 25));
    // An idle run writes only its job line.
    expect(lines).toEqual([
      { queue: "{poll-create}", outcome: "completed", ms: expect.any(Number) },
    ]);
    // Read before the queues below are opened to list schedules.
    const keys = await connection.keys(`${own}:*`);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((k) => !k.startsWith(`${own}:{poll-create}:`))).toEqual([]);
    const scheduled: string[] = [];
    for (const { name } of Object.values(QUEUES)) {
      const queue = new Queue(name, { connection, prefix: own });
      for (const s of await queue.getJobSchedulers()) scheduled.push(`${name} ${s.key} ${s.every}`);
      await queue.close();
    }
    expect(scheduled).toEqual(["{poll-create} poll-create 3600000"]);
  } finally {
    await creator.close();
    for (const { name } of Object.values(QUEUES)) {
      const queue = new Queue(name, { connection, prefix: own });
      await queue.obliterate({ force: true });
      await queue.close();
    }
  }
});

test("a worker refuses the creation key beside any other job", async () => {
  const base = {
    connection,
    sql: app,
    log: () => {},
    auditEveryMs: 3_600_000,
    prefix: `abolish-test-${hex(randomBytes(6))}`,
    pollCreation: { chain: idleChain, dailyCeiling: 1, anchors: idleAnchors, panel: idlePanel },
  };
  const anchor = { chain: {} as AnchorChain, everyMs: 3_600_000 };
  const archive = { client: {} as ArweaveClient, everyMs: 3_600_000 };
  const tier0 = { batches: {} as Tier0Batches };
  const tier1 = { batches: {} as Tier1Batches };
  const ballots = { admissions: {} as BallotAdmissions };
  const registry = { sync: {} as RegistrySync };
  const pollRoots = { roots: {} as PollRoots };
  const pollStubs = {
    deployment: {} as PollStubDeployment,
    clock: { anchor: new Uint8Array(20), epoch: 0n, period: 3600n },
  };
  for (const extra of [
    { anchor },
    { anchor, archive },
    { tier0 },
    { tier1 },
    { ballots },
    { registry },
    { registry, pollRoots },
    { registry, pollStubs },
  ])
    await expect(startWorker({ ...base, ...extra })).rejects.toThrow("runs nothing else");
});

test("a worker refuses the anchoring keys beside a relay's keys", async () => {
  const base = {
    connection,
    sql: app,
    log: () => {},
    auditEveryMs: 3_600_000,
    prefix: `abolish-test-${hex(randomBytes(6))}`,
    anchor: { chain: {} as AnchorChain, everyMs: 3_600_000 },
  };
  for (const extra of [
    { tier0: { batches: {} as Tier0Batches } },
    { tier1: { batches: {} as Tier1Batches } },
  ])
    await expect(startWorker({ ...base, ...extra })).rejects.toThrow("runs no relay");
});

test("a worker refuses the archive without the anchoring runner", async () => {
  await expect(
    startWorker({
      connection,
      sql: app,
      log: () => {},
      auditEveryMs: 3_600_000,
      prefix: `abolish-test-${hex(randomBytes(6))}`,
      archive: { client: {} as ArweaveClient, everyMs: 3_600_000 },
    }),
  ).rejects.toThrow("only beside the anchoring runner");
});

test("a worker refuses the roots step without the registry sync", async () => {
  await expect(
    startWorker({
      connection,
      sql: app,
      log: () => {},
      auditEveryMs: 3_600_000,
      prefix: `abolish-test-${hex(randomBytes(6))}`,
      pollRoots: { roots: {} as PollRoots },
    }),
  ).rejects.toThrow("only beside the registry sync");
});

test("a worker refuses the stub step without the registry sync", async () => {
  await expect(
    startWorker({
      connection,
      sql: app,
      log: () => {},
      auditEveryMs: 3_600_000,
      prefix: `abolish-test-${hex(randomBytes(6))}`,
      pollStubs: {
        deployment: {} as PollStubDeployment,
        clock: { anchor: new Uint8Array(20), epoch: 0n, period: 3600n },
      },
    }),
  ).rejects.toThrow("only beside the registry sync");
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
  const bad = [await newElection(app), await newElection(app)];
  for (const id of bad) {
    await appendEntry(app, id, 0, ballot(0));
    // A row a writer stored without appendEntry: its entry hash is random.
    const [prev] = await app`SELECT link FROM board_entries WHERE election_id = ${id}`;
    await app`INSERT INTO board_entries (election_id, idx, segment, payload, entry_hash, prev_link, link)
      VALUES (${id}, 1, 0, ${ballot(1)}, ${b32()}, ${Uint8Array.from(prev!["link"])}, ${b32()})`;
  }
  const lines = await audit({});
  const findings = lines.filter((l) => "finding" in l && l.queue === "{board-audit}");
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
