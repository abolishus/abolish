import { type AnchorChain, appendEntry, readCheckpoints, readDefinition } from "@abolishus/core";
import { newElection, type TestDb, testDb } from "@abolishus/core/test-db";
import { type Checkpoint, checkpointHash, decodeElectionDefinition } from "@abolishus/crypto";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { type LogLine, QUEUES, type RunningWorker, startWorker } from "../src/index.ts";

// The anchoring job in the worker, against a live Redis and Postgres: it is
// scheduled only with an anchor, runs core's anchorBoards through it, and
// logs each finding with only public values (T-10, T-49). What a run sends
// is core's tests' (packages/core/tests/anchoring.test.ts).

const redisUrl = process.env["REDIS_URL"];
if (!redisUrl) throw new Error("REDIS_URL is not set");

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const ballot = (...body: number[]) => Uint8Array.of(0x00, 0x02, 1, ...body);
const CLOCK = { epoch: 0n, period: 3600n, deadline: 43_200n } as const;
const prefix = `abolish-test-${hex(randomBytes(6))}`;

/** An anchor holding whatever it is sent, at a fixed L1 time. */
class HeldAnchor implements AnchorChain {
  readonly clock = CLOCK;
  readonly sent: Checkpoint[][] = [];
  readonly chainId: bigint;
  readonly address: Uint8Array;
  readonly time: bigint;
  constructor(chainId: bigint, address: Uint8Array, time: bigint) {
    this.chainId = chainId;
    this.address = address;
    this.time = time;
  }
  async now() {
    return this.time;
  }
  async anchored(electionId: Uint8Array, segment: number) {
    const c = this.sent
      .flat()
      .find((x) => hex(x.election_id) === hex(electionId) && x.segment === segment);
    return c === undefined ? undefined : checkpointHash(c);
  }
  async anchor(checkpoints: readonly Checkpoint[]) {
    this.sent.push([...checkpoints]);
  }
}

let db: TestDb;
let app: Sql;
let connection: Redis;
let worker: RunningWorker;
let anchors: Queue;
let chain: HeldAnchor;
let served: Uint8Array;
const logs: LogLine[] = [];

beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
  served = await newElection(app);
  await appendEntry(app, served, 0, ballot(0));
  await appendEntry(app, served, 1, ballot(1));
  const d = decodeElectionDefinition((await readDefinition(app, served))!);
  // In period 2: periods 0 and 1 have ended.
  chain = new HeldAnchor(d.l1_chain_id, d.l1_anchor, 2n * CLOCK.period + 60n);
  connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  worker = await startWorker({
    connection,
    sql: app,
    log: (l) => logs.push(l),
    auditEveryMs: 3_600_000,
    anchor: { chain, everyMs: 300_000 },
    prefix,
  });
  anchors = new Queue(QUEUES.boardAnchor.name, { connection, prefix });
});
afterAll(async () => {
  await worker?.close();
  await anchors?.obliterate({ force: true });
  await anchors?.close();
  connection?.disconnect();
  await db?.close();
});

/** Waits for the next outcome of an anchoring job, and takes that queue's lines. */
async function outcome(): Promise<LogLine[]> {
  for (let i = 0; i < 200; i++) {
    if (logs.some((l) => l.queue === "{board-anchor}" && "outcome" in l)) {
      const mine = logs.filter((l) => l.queue === "{board-anchor}");
      logs.splice(0, logs.length, ...logs.filter((l) => l.queue !== "{board-anchor}"));
      return mine;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("no {board-anchor} job finished");
}

test("schedules the anchoring run, which anchors every ended period at start", async () => {
  const schedulers = await anchors.getJobSchedulers();
  expect(schedulers.map((s) => [s.key, s.every])).toEqual([["board-anchor", 300_000]]);
  expect(await outcome()).toEqual([
    { queue: "{board-anchor}", outcome: "completed", ms: expect.any(Number) },
  ]);
  expect(chain.sent).toEqual([await readCheckpoints(app, served)]);
  expect(chain.sent[0]!.map((c) => c.segment)).toEqual([0, 1]);
});

test("logs each finding by its public values, and fails the job", async () => {
  const other = await newElection(app, 1, new Uint8Array(20).fill(9));
  await appendEntry(app, other, 0, ballot(2));
  await anchors.add("boardAnchor", {});
  expect(await outcome()).toEqual([
    { queue: "{board-anchor}", finding: "anchor-unserved", election: hex(other) },
    {
      queue: "{board-anchor}",
      outcome: "failed",
      error: "board-anchor-findings",
      ms: expect.any(Number),
    },
  ]);
  // Nothing more to send for the served election.
  expect(chain.sent).toHaveLength(1);
});
