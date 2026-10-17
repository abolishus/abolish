import {
  CEREMONY_ROUND_SECONDS,
  createPollDraft,
  newAccountId,
  type PollStubDeployment,
  type RegistrySyncReport,
  stubPolls,
  submitPollDraft,
} from "@abolishus/core";
import { type TestDb, testDb } from "@abolishus/core/test-db";
import { identityKey, tierTreeRoot } from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { type LogLine, type RegistrySync, startWorker } from "../src/index.ts";

// The coordinator's worker job (P2-22 part 4c-2; ADR 0032, rule 5): beside
// the stub step, under its deployment, it opens a run for each stubbed poll
// and closes rounds at their deadlines, logging counts only (T-10). The
// coordinator's own logic is core's, tested there over whole ceremonies.

const redisUrl = process.env["REDIS_URL"];
const NOW = new Date("2026-10-17T12:00:00Z");
const NOW_S = BigInt(NOW.getTime() / 1000);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const address = (b: number) => new Uint8Array(20).fill(b);
const secret = (i: number) => {
  const d = new Uint8Array(32);
  d[0] = 0x42;
  d[31] = i;
  return d;
};
const ascending = (keys: Uint8Array[]) =>
  keys.sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));

const DEPLOYMENT: PollStubDeployment = {
  l2ChainId: 84532n,
  l1ChainId: 11155111n,
  electionRegistry: address(0xa1),
  board: address(0xa2),
  trusteeRegistry: address(0xa3),
  groupRegistry: address(0xa4),
  l1Anchor: address(0xb1),
  l1Relay: address(0xb2),
  panel: { threshold: 2, keys: [1, 2, 3].map((i) => identityKey(secret(i))) },
  receiptKeys: ascending([identityKey(secret(9)), identityKey(secret(8))]),
  l1InclusionBound: 3600,
  sequencingWindow: 3600n,
  maxSequencerDrift: 1800n,
};

/** A registry sync with nothing to record: the stub step, and so the coordinator, runs only beside one. */
const idleSync = {
  run: async (): Promise<RegistrySyncReport> => ({ recorded: 0, unstored: [] }),
} as unknown as RegistrySync;

let db: TestDb;
let app: Sql;

beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
});
afterAll(() => db?.close());

/** A poll the stub step moved to `ceremony`. */
async function stubbed(): Promise<void> {
  const author = newAccountId();
  await app`
    INSERT INTO account_users VALUES (${author}, ${`${newAccountId()}@account.invalid`},
      false, '', NULL, now(), now())`;
  const submittedAt = new Date(NOW.getTime() - 3600_000);
  const id = await createPollDraft(
    app,
    author,
    {
      language: "en",
      title: "Lunch",
      description: "",
      questions: [
        {
          question: "Which day?",
          description: "",
          options: [
            { label: "Friday", description: "" },
            { label: "Monday", description: "" },
          ],
          minSelections: 0,
          maxSelections: 1,
        },
      ],
      tiers: [0],
      closesAt: NOW_S + 7n * 24n * 3600n,
    },
    submittedAt,
  );
  await submitPollDraft(app, author, id, {
    turnstile: { verify: async () => "passed" as const },
    token: "t",
    now: submittedAt,
  });
  const electorate = [
    {
      tier: 0,
      rootL2Block: "500",
      groups: [{ groupId: "1", region: 0 }],
      regions: ["2"],
      cells: [{ root: tierTreeRoot([11n, 12n]).toString(), members: "2" }],
    },
  ];
  await db.admin`
    UPDATE account_polls SET state = 'rooted', creator_address = ${address(0xc0)},
      create_tx_hash = ${randomBytes(32)}, election_id = ${randomBytes(32)}, created_block = 7,
      l1_origin_timestamp = 1, anchors_checked_block = 9,
      electorate = ${db.admin.json(electorate as never)}
    WHERE id = ${id}`;
  expect((await stubPolls(app, DEPLOYMENT, { now: NOW })).stubbed).toBe(1);
}

/** Runs the scheduled coordinator job once through a worker, with the clock at `now`. */
async function scheduledRun(now: Date) {
  const lines: LogLine[] = [];
  const prefix = `abolish-test-${hex(randomBytes(6))}`;
  const connection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
  const worker = await startWorker({
    connection,
    sql: app,
    log: (l) => lines.push(l),
    auditEveryMs: 3_600_000,
    prefix,
    now: () => now,
    registry: { sync: idleSync, everyMs: 3_600_000 },
    pollStubs: {
      deployment: DEPLOYMENT,
      everyMs: 3_600_000,
      coordinateEveryMs: 3_600_000,
      openEveryMs: 3_600_000,
      clock: { epoch: 0n, period: 3600n },
    },
  });
  const queue = "{ceremony-coordinate}";
  let keys: string[];
  try {
    for (let i = 0; i < 200 && !lines.some((l) => l.queue === queue && "outcome" in l); i++)
      await new Promise((r) => setTimeout(r, 25));
    keys = await connection.keys(`${prefix}:${queue}:*`);
  } finally {
    await worker.close();
    for (const key of await connection.keys(`${prefix}:*`)) await connection.del(key);
    connection.disconnect();
  }
  return { lines: lines.filter((l) => l.queue === queue), keys };
}

const runs = () => db.admin`SELECT round, outcome FROM ceremony_runs`;

describe.skipIf(redisUrl === undefined)("the coordinator job", () => {
  test("opens a run for a stubbed poll, closes its round at the deadline and logs counts only", async () => {
    await stubbed();
    const first = await scheduledRun(NOW);
    // Its queue's keys are under its own hash tag.
    expect(first.keys.length).toBeGreaterThan(0);
    expect(first.lines).toEqual([
      {
        queue: "{ceremony-coordinate}",
        opened: 1,
        mismatched: 0,
        expired: 0,
        closed: 0,
        ended: {},
      },
      { queue: "{ceremony-coordinate}", outcome: "completed", ms: expect.any(Number) },
    ]);
    expect(await runs()).toEqual([{ round: 1, outcome: null }]);

    // A second before the deadline nothing moves, and the idle run writes only its job line.
    const early = new Date(NOW.getTime() + (CEREMONY_ROUND_SECONDS - 1) * 1000);
    expect((await scheduledRun(early)).lines).toEqual([
      { queue: "{ceremony-coordinate}", outcome: "completed", ms: expect.any(Number) },
    ]);
    expect(await runs()).toEqual([{ round: 1, outcome: null }]);

    // No seat sent: round 1 closes below rule 7's quorum and the run ends.
    const due = new Date(NOW.getTime() + CEREMONY_ROUND_SECONDS * 1000);
    expect((await scheduledRun(due)).lines).toEqual([
      {
        queue: "{ceremony-coordinate}",
        opened: 0,
        mismatched: 0,
        expired: 0,
        closed: 1,
        ended: { "too-few-messages": 1 },
      },
      { queue: "{ceremony-coordinate}", outcome: "completed", ms: expect.any(Number) },
    ]);
    expect(await runs()).toEqual([{ round: 6, outcome: "too-few-messages" }]);
  });
});
