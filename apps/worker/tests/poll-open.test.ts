import {
  approvedCeremony,
  createPollDraft,
  newAccountId,
  openCeremonyRuns,
  pollRegistration,
  type PollStubDeployment,
  readBoard,
  recordRegistration,
  type RegistrySyncReport,
  storeDefinition,
  stubPolls,
  submitPollDraft,
} from "@abolishus/core";
import { Seat } from "@abolishus/core/test-ceremony-seats";
import { type TestDb, testDb } from "@abolishus/core/test-db";
import { decodeBoardEntry, identityKey, type Panel, tierTreeRoot } from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { type LogLine, type RegistrySync, startWorker } from "../src/index.ts";

// The opening step's worker job (P2-22 part 5c; ADR 0032, rules 12 to 14):
// beside the stub step, by the anchor's clock, it opens each registered poll
// the registry sync has stored, boarding its transcript as entry 0 and
// logging counts only (T-10, T-67). The read-back itself is core's, tested
// there field by field.

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
const SECRETS = [1, 2, 3].map(secret);
const PANEL: Panel = { threshold: 2, keys: SECRETS.map(identityKey) };
// The hourly clock of the anchor every stub pins.
const CLOCK = { anchor: address(0xb1), epoch: 1_700_000_000n, period: 3600n };
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
  panel: PANEL,
  receiptKeys: ascending([identityKey(secret(9)), identityKey(secret(8))]),
  l1InclusionBound: 3600,
  sequencingWindow: 3600n,
  maxSequencerDrift: 1800n,
};

/** A registry sync with nothing to record: the stub step, and so the opening step, runs only beside one. */
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

/**
 * A poll stubbed, its ceremony run between three honest seats and approved,
 * moved to `registered`, and its registration recorded with its definition
 * as the registry sync records them.
 */
async function registered(): Promise<{
  id: string;
  electionId: Uint8Array;
  transcript: Uint8Array;
}> {
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
  const electionId = new Uint8Array(randomBytes(32));
  await db.admin`
    UPDATE account_polls SET state = 'rooted', creator_address = ${address(0xc0)},
      create_tx_hash = ${randomBytes(32)}, election_id = ${electionId}, created_block = 7,
      l1_origin_timestamp = ${(NOW_S - 86_400n).toString()}, anchors_checked_block = 9,
      electorate = ${db.admin.json(electorate as never)}
    WHERE id = ${id}`;
  expect((await stubPolls(app, DEPLOYMENT, { now: NOW })).stubbed).toBe(1);
  const [row] = await db.admin`SELECT stub_hash FROM account_polls WHERE id = ${id}`;
  const stubHash = Uint8Array.from(row!["stub_hash"]);
  expect((await openCeremonyRuns(app, DEPLOYMENT, { now: NOW })).opened).toBe(1);
  const seats = [1, 2, 3].map(
    (i) => new Seat(i, { deployment: DEPLOYMENT, secrets: SECRETS, client: () => app, now: NOW }),
  );
  for (let round = 1; round <= 5; round++) for (const s of seats) await s.act();
  const approved = (await approvedCeremony(app, stubHash))!;
  const [stub] = await db.admin`SELECT stub FROM ceremony_stubs WHERE stub_hash = ${stubHash}`;
  const registration = pollRegistration(
    Uint8Array.from(stub!["stub"]),
    stubHash,
    electionId,
    PANEL,
    approved,
  );
  if (typeof registration === "string") throw new Error(registration);
  await db.admin`
    UPDATE account_polls SET state = 'registered', ceremony_tx_hash = ${randomBytes(32)},
      register_tx_hash = ${randomBytes(32)}, registered_block = 900
    WHERE id = ${id}`;
  await storeDefinition(app, registration.definition);
  await recordRegistration(app, {
    electionId,
    definitionHash: registration.definitionHash,
    l2Block: 900n,
    logIndex: 0,
  });
  return { id, electionId, transcript: approved.transcript };
}

/** Runs the scheduled opening job once through a worker. */
async function scheduledRun() {
  const lines: LogLine[] = [];
  const prefix = `abolish-test-${hex(randomBytes(6))}`;
  const connection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
  const worker = await startWorker({
    connection,
    sql: app,
    log: (l) => lines.push(l),
    auditEveryMs: 3_600_000,
    prefix,
    now: () => NOW,
    registry: { sync: idleSync, everyMs: 3_600_000 },
    pollStubs: {
      deployment: DEPLOYMENT,
      everyMs: 3_600_000,
      coordinateEveryMs: 3_600_000,
      openEveryMs: 3_600_000,
      clock: CLOCK,
    },
  });
  const queue = "{poll-open}";
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

describe.skipIf(redisUrl === undefined)("the opening job", () => {
  test("opens a registered poll by the anchor's clock, boarding its transcript, and logs counts only", async () => {
    const r = await registered();
    const run = await scheduledRun();
    // Its queue's keys are under its own hash tag.
    expect(run.keys.length).toBeGreaterThan(0);
    expect(run.lines).toEqual([
      {
        queue: "{poll-open}",
        opened: 1,
        waiting: 0,
        early: 0,
        late: 0,
        otherAnchor: 0,
        unboarded: 0,
        errored: 0,
        failed: {},
      },
      { queue: "{poll-open}", outcome: "completed", ms: expect.any(Number) },
    ]);
    const [row] = await db.admin`SELECT state FROM account_polls WHERE id = ${r.id}`;
    expect(row!["state"]).toBe("open");
    const board = await readBoard(app, r.electionId);
    expect(board.length).toBe(1);
    expect(decodeBoardEntry(board[0]!, 5)).toMatchObject({
      index: 0n,
      segment: Number((NOW_S - CLOCK.epoch) / CLOCK.period),
      payload: r.transcript,
    });
  }, 60_000);

  test("an idle run writes only its job line", async () => {
    const run = await scheduledRun();
    expect(run.lines).toEqual([
      { queue: "{poll-open}", outcome: "completed", ms: expect.any(Number) },
    ]);
  });
});
