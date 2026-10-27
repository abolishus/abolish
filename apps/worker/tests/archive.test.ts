import {
  type AnchorChain,
  appendEntry,
  type ArweaveClient,
  archiveLocator,
  readCheckpoints,
  readDefinition,
} from "@abolishus/core";
import { newElection, type TestDb, testDb } from "@abolishus/core/test-db";
import { type Checkpoint, checkpointHash, decodeElectionDefinition } from "@abolishus/crypto";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import {
  ARCHIVE_BUSY_LIMIT,
  type LogLine,
  QUEUES,
  type RunningWorker,
  startWorker,
} from "../src/index.ts";

// The archive job in the worker, against a live Redis and Postgres (P4-3
// part 4b-2b-2b-1): it is scheduled only beside the anchor, runs core's
// archiveBoards with the locator the anchor holds, logs what it did in
// counts, and the anchoring job then carries the locator it reached (T-49,
// T-51). What a run posts and lists is core's tests'
// (packages/core/tests/archiving.test.ts); the HTTP client is
// tests/arweave-client.test.ts's.

const redisUrl = process.env["REDIS_URL"];
if (!redisUrl) throw new Error("REDIS_URL is not set");

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const ballot = (...body: number[]) => Uint8Array.of(0x00, 0x02, 1, ...body);
const CLOCK = { epoch: 0n, period: 3600n, deadline: 43_200n } as const;
const prefix = `abolish-test-${hex(randomBytes(6))}`;
// In period 2: periods 0 and 1 have ended.
const START = 2n * CLOCK.period + 60n;
let workerNow = new Date(Number(START) * 1000);
const LOCK = "hashtextextended('archive_writer:' || current_schema(), 0)";

/** An anchor holding whatever it is sent, the latest locator among it. */
class HeldAnchor implements AnchorChain {
  readonly clock = CLOCK;
  readonly sent: Checkpoint[][] = [];
  readonly locators: Uint8Array[] = [];
  readonly chainId: bigint;
  readonly address: Uint8Array;
  constructor(chainId: bigint, address: Uint8Array) {
    this.chainId = chainId;
    this.address = address;
  }
  async now() {
    return START;
  }
  async anchored(electionId: Uint8Array, segment: number) {
    const c = this.sent
      .flat()
      .find((x) => hex(x.election_id) === hex(electionId) && x.segment === segment);
    return c === undefined ? undefined : checkpointHash(c);
  }
  async latestLocator() {
    return this.locators.at(-1);
  }
  async anchor(checkpoints: readonly Checkpoint[], locator: Uint8Array | undefined) {
    if (checkpoints.length > 0) this.sent.push([...checkpoints]);
    if (locator !== undefined) this.locators.push(locator);
  }
}

/** Arweave mining every upload with its data at once, one block deep. */
class InstantArweave implements ArweaveClient {
  readonly txs = new Map<string, Uint8Array>();
  async post(data: Uint8Array) {
    const id = new Uint8Array(randomBytes(32));
    this.txs.set(hex(id), Uint8Array.from(data));
    return id;
  }
  async confirmations(tx: Uint8Array) {
    return this.txs.has(hex(tx)) ? 1 : undefined;
  }
  async data(tx: Uint8Array, limit: number) {
    const d = this.txs.get(hex(tx));
    return d !== undefined && d.length <= limit ? d : undefined;
  }
}

let db: TestDb;
let app: Sql;
let connection: Redis;
let worker: RunningWorker;
let anchors: Queue;
let archives: Queue;
let chain: HeldAnchor;
let served: Uint8Array;
const arweave = new InstantArweave();
const logs: LogLine[] = [];

beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app", { max: 3 });
  served = await newElection(app);
  await appendEntry(app, served, 0, ballot(0));
  await appendEntry(app, served, 1, ballot(1));
  const d = decodeElectionDefinition((await readDefinition(app, served))!);
  chain = new HeldAnchor(d.l1_chain_id, d.l1_anchor);
  connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  anchors = new Queue(QUEUES.boardAnchor.name, { connection, prefix });
  archives = new Queue(QUEUES.archive.name, { connection, prefix });
  worker = await startWorker({
    connection,
    sql: app,
    log: (l) => logs.push(l),
    auditEveryMs: 3_600_000,
    anchor: { chain, everyMs: 3_600_000 },
    archive: { client: arweave, everyMs: 3_600_000, depth: 1, repostAfter: 100n },
    now: () => workerNow,
    prefix,
  });
});
afterAll(async () => {
  await worker?.close();
  for (const q of [anchors, archives]) {
    await q?.obliterate({ force: true });
    await q?.close();
  }
  connection?.disconnect();
  await db?.close();
});

/** Waits for the next outcome on `queue`, and takes that queue's lines. */
async function outcome(queue: "{archive}" | "{board-anchor}"): Promise<LogLine[]> {
  for (let i = 0; i < 400; i++) {
    if (logs.some((l) => l.queue === queue && "outcome" in l)) {
      const mine = logs.filter((l) => l.queue === queue);
      logs.splice(0, logs.length, ...logs.filter((l) => l.queue !== queue));
      return mine;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no ${queue} job finished`);
}

const completed = (queue: "{archive}" | "{board-anchor}") => ({
  queue,
  outcome: "completed",
  ms: expect.any(Number),
});

test("schedules the archive beside the anchor, and archives what anchoring took", async () => {
  expect((await archives.getJobSchedulers()).map((s) => [s.key, s.every])).toEqual([
    ["archive", 3_600_000],
  ]);
  // Both run once at start, in either order; once both have, the
  // checkpoints are taken and anchored.
  await outcome("{board-anchor}");
  await outcome("{archive}");
  expect(chain.sent).toEqual([await readCheckpoints(app, served)]);
  // Each run takes the next step: post the two checkpoints' objects, list
  // them once deep, post that manifest, and name it once it is deep.
  const steps: LogLine[][] = [];
  for (let i = 0; i < 3; i++) {
    await archives.add("archive", {});
    steps.push(await outcome("{archive}"));
  }
  const counts = { registered: 0, confirmed: 0, written: 0, posted: 0, refused: 0 };
  // The run at start may have met the checkpoints already.
  const first = steps[0]![0]!;
  if ("registered" in first && first.registered === 0)
    expect(steps).toEqual([
      [
        { queue: "{archive}", ...counts, confirmed: 4, written: 1, posted: 1 },
        completed("{archive}"),
      ],
      [{ queue: "{archive}", ...counts, confirmed: 1, locator: 0 }, completed("{archive}")],
      [{ queue: "{archive}", ...counts, locator: 0 }, completed("{archive}")],
    ]);
  else
    expect(steps).toEqual([
      [{ queue: "{archive}", ...counts, registered: 4, posted: 4 }, completed("{archive}")],
      [
        { queue: "{archive}", ...counts, confirmed: 4, written: 1, posted: 1 },
        completed("{archive}"),
      ],
      [{ queue: "{archive}", ...counts, confirmed: 1, locator: 0 }, completed("{archive}")],
    ]);
  // With nothing left to anchor, the anchoring run sends that locator alone.
  await anchors.add("boardAnchor", {});
  expect(await outcome("{board-anchor}")).toEqual([completed("{board-anchor}")]);
  const named = await archiveLocator(app, { l1ChainId: chain.chainId, anchor: chain.address });
  expect(named?.sequence).toBe(0n);
  expect(chain.locators.map(hex)).toEqual([hex(named!.locator)]);
  // And the archive's next run takes the anchor's locator as its own chain's.
  await archives.add("archive", {});
  expect(await outcome("{archive}")).toEqual([
    { queue: "{archive}", ...counts, locator: 0 },
    completed("{archive}"),
  ]);
});

test("logs a run that met another's lock, and fails only past the busy limit", async () => {
  const other = await db.as("abolish_app");
  const held = await other.reserve();
  await held.unsafe(`SELECT pg_advisory_lock(${LOCK})`);
  try {
    for (const after of [0n, ARCHIVE_BUSY_LIMIT, ARCHIVE_BUSY_LIMIT + 1n]) {
      workerNow = new Date(Number(START + after) * 1000);
      await archives.add("archive", {});
      expect(await outcome("{archive}")).toEqual([
        { queue: "{archive}", finding: "archive-busy" },
        after > ARCHIVE_BUSY_LIMIT
          ? {
              queue: "{archive}",
              outcome: "failed",
              error: "archive-findings",
              ms: expect.any(Number),
            }
          : completed("{archive}"),
      ]);
    }
  } finally {
    await held.unsafe(`SELECT pg_advisory_unlock(${LOCK})`);
    held.release();
    await other.end();
  }
  // A run that held the lock ends the streak: one more busy run is fine again.
  await archives.add("archive", {});
  expect(await outcome("{archive}")).toEqual([
    {
      queue: "{archive}",
      registered: 0,
      confirmed: 0,
      written: 0,
      posted: 0,
      refused: 0,
      locator: 0,
    },
    completed("{archive}"),
  ]);
  const again = await db.as("abolish_app");
  const lock = await again.reserve();
  await lock.unsafe(`SELECT pg_advisory_lock(${LOCK})`);
  try {
    await archives.add("archive", {});
    expect(await outcome("{archive}")).toEqual([
      { queue: "{archive}", finding: "archive-busy" },
      completed("{archive}"),
    ]);
  } finally {
    await lock.unsafe(`SELECT pg_advisory_unlock(${LOCK})`);
    lock.release();
    await again.end();
  }
});

test("fails a run that refused an object, and still posts the rest", async () => {
  workerNow = new Date(Number(START) * 1000);
  // A row naming bytes the board doesn't give, as a write around the run
  // would leave (T-23).
  await app`INSERT INTO archive_objects (cid, election_id, kind, first, size)
    VALUES (${new Uint8Array(36).fill(1)}, ${served}, 'hashes', 0, 1)`;
  const before = arweave.txs.size;
  await archives.add("archive", {});
  expect(await outcome("{archive}")).toEqual([
    {
      queue: "{archive}",
      registered: 0,
      confirmed: 0,
      written: 0,
      posted: 0,
      refused: 1,
      locator: 0,
    },
    { queue: "{archive}", outcome: "failed", error: "archive-findings", ms: expect.any(Number) },
  ]);
  expect(arweave.txs.size).toBe(before);
});

test("after a wipe, takes up the anchor's chain and logs it, and fails a run that can't", async () => {
  await db.admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`DELETE FROM archive_transactions`;
    await tx`DELETE FROM archive_objects`;
    await tx`DELETE FROM archive_manifests`;
  });
  const before = arweave.txs.size;
  // A locator this worker never writes: the run says why and posts nothing.
  chain.locators.push(new Uint8Array(70));
  await archives.add("archive", {});
  expect(await outcome("{archive}")).toEqual([
    { queue: "{archive}", finding: "archive-resume", reason: "locator" },
    { queue: "{archive}", outcome: "failed", error: "archive-findings", ms: expect.any(Number) },
  ]);
  chain.locators.pop();
  // The anchor's own: manifest 0 read back, the board's objects registered
  // again and marked listed there, nothing posted.
  await archives.add("archive", {});
  expect(await outcome("{archive}")).toEqual([
    {
      queue: "{archive}",
      registered: 4,
      confirmed: 0,
      written: 0,
      posted: 0,
      refused: 0,
      resumed: 1,
      locator: 0,
    },
    completed("{archive}"),
  ]);
  expect(arweave.txs.size).toBe(before);
});
