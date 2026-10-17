import {
  createPollDraft,
  newAccountId,
  type PollDraft,
  type PollRootDeployment,
  type RegistrySyncReport,
  submitPollDraft,
} from "@abolishus/core";
import { type TestDb, testDb } from "@abolishus/core/test-db";
import {
  contractEventLog,
  type ContractEventRecord,
  encodeGroupAddition,
  groupAdditionDigest,
  groupRegistryDomainSeparator,
  replayEventAccumulator,
  signGroupApproval,
  tierTreeRoot,
} from "@abolishus/crypto";
import { OutputRootError } from "@abolishus/verifier";
import { Redis } from "ioredis";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Sql } from "postgres";
import { bytesToHex, encodeAbiParameters, type Hex, keccak256, stringToHex } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  type LogLine,
  PollRoots,
  type RegistryAccumulator,
  type RegistrySync,
  startWorker,
} from "../src/index.ts";

// The roots step's worker side (src/poll-roots.ts; P2-22 part 3b-2): the
// group registry's records from the index, judged against the accumulator
// proven at the output root's block, root each checked poll through core;
// an index or node the proof refuses, or a published group the registry
// never created, fails the job as a finding and moves no poll (T-71, T-34).

const CHAIN = 84_532n;
const redisUrl = process.env["REDIS_URL"];
if (!redisUrl) throw new Error("REDIS_URL is not set");

const registrarVectors = (
  JSON.parse(
    readFileSync(
      new URL("../../../docs/spec/vectors/group-registry.json", import.meta.url),
      "utf8",
    ),
  ) as { registrars: { threshold: number; secretKeys: string[]; addresses: string[] } }
).registrars;
const bytes = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const NOW = new Date("2026-10-17T12:00:00Z");
const BLOCK = 30n;

interface Log {
  readonly block: bigint;
  readonly topics: readonly Hex[];
  readonly data: Hex;
}

const word = (v: bigint) => encodeAbiParameters([{ type: "uint256" }], [v]);

/** The group registry's logs: group 1 (Tier 0) created at block 10 and three members added at 20. */
function registryLogs(registry: Hex): Log[] {
  const domain = groupRegistryDomainSeparator(CHAIN, bytes(registry));
  const commitments = [11n, 12n, 13n];
  const digest = groupAdditionDigest(domain, {
    groupId: 1n,
    tier: 0,
    firstIndex: 0n,
    commitments,
  });
  const record = encodeGroupAddition({
    groupId: 1n,
    firstIndex: 0n,
    commitments,
    approvals: registrarVectors.secretKeys
      .slice(0, registrarVectors.threshold)
      .map((k, i) => signGroupApproval(digest, i + 1, bytes(k))),
  });
  return [
    {
      block: 10n,
      topics: [keccak256(stringToHex("GroupCreated(uint64,uint8)")), word(1n), word(0n)],
      data: "0x",
    },
    {
      block: 20n,
      topics: [keccak256(stringToHex("MembersAdded(uint64,uint64,bytes)")), word(1n), word(0n)],
      data: encodeAbiParameters([{ type: "bytes" }], [bytesToHex(record)]),
    },
  ];
}

const recordOf = (registry: Hex, log: Log, n: number): ContractEventRecord => ({
  contract: bytes(registry),
  n: BigInt(n),
  l2_block: log.block,
  l2_timestamp: 1_800_000_000n + log.block,
  topics: log.topics.map(bytes),
  data: bytes(log.data),
});

/** The registry's accumulator over its logs up to `BLOCK`, as the output-root adapter proves it. */
const accumulatorOf = (registry: Hex, logs: readonly Log[]): RegistryAccumulator => ({
  async proven() {
    const state = replayEventAccumulator(
      CHAIN,
      bytes(registry),
      logs.map((l, i) => contractEventLog(recordOf(registry, l, i))),
    );
    return { block: BLOCK, ...state };
  },
});

const draft: PollDraft = {
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
  closesAt: BigInt(NOW.getTime() / 1000) + 7n * 24n * 3600n,
};

let db: TestDb;
let app: Sql;
let index: string;
beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
  // The indexer's `contract_log` as Ponder creates it (apps/indexer/ponder.schema.ts).
  index = `ix_${hex(randomBytes(6))}`;
  await db.admin.unsafe(`CREATE SCHEMA "${index}"`);
  await db.admin.unsafe(`CREATE TABLE "${index}".contract_log (
    id text PRIMARY KEY, contract text NOT NULL, block_number numeric(78) NOT NULL,
    block_timestamp numeric(78) NOT NULL, topics text[] NOT NULL, data text NOT NULL,
    transaction_hash text NOT NULL, log_index integer NOT NULL)`);
});
afterAll(async () => {
  await db?.admin.unsafe(`DROP SCHEMA IF EXISTS "${index}" CASCADE`);
  await db?.close();
});
beforeEach(async () => {
  await db.admin`DELETE FROM account_polls`;
});

/** A group registry of its own, its logs indexed. */
async function indexed(): Promise<{ registry: Hex; logs: Log[] }> {
  const registry = bytesToHex(randomBytes(20));
  const logs = registryLogs(registry);
  for (const [i, l] of logs.entries())
    await db.admin`
      INSERT INTO ${db.admin(index)}.contract_log
      VALUES (${`${registry}-${String(i).padStart(6, "0")}`}, ${registry}, ${l.block.toString()},
        ${(1_800_000_000n + l.block).toString()}, ${l.topics as string[]}, ${l.data},
        ${bytesToHex(randomBytes(32))}, 0)`;
  return { registry, logs };
}

/** A poll through creation and the per-slot check, as the creation worker leaves it. */
async function checked(): Promise<string> {
  const author = newAccountId();
  await app`
    INSERT INTO account_users VALUES (${author}, ${`${newAccountId()}@account.invalid`},
      false, '', NULL, now(), now())`;
  const id = await createPollDraft(app, author, draft, NOW);
  await submitPollDraft(app, author, id, {
    turnstile: { verify: async () => "passed" as const },
    token: "t",
    now: NOW,
  });
  await db.admin`
    UPDATE account_polls SET state = 'created', creator_address = ${new Uint8Array(20).fill(0xc0)},
      create_tx_hash = ${randomBytes(32)}, election_id = ${randomBytes(32)}, created_block = 7,
      l1_origin_timestamp = 1, anchors_checked_block = 9
    WHERE id = ${id}`;
  return id;
}

const deploymentOf = (registry: Hex, groups: readonly bigint[]): PollRootDeployment => ({
  groups: new Map([[0, groups.map((group_id) => ({ group_id, region: 0 }))]]),
  pins: {
    version: 6,
    chainId: CHAIN,
    registry: bytes(registry),
    registrars: registrarVectors.addresses.map(bytes),
    threshold: registrarVectors.threshold,
  },
});

const rootsOf = (registry: Hex, accumulator: RegistryAccumulator, groups = [1n]) =>
  new PollRoots({
    sql: app,
    index: db.admin,
    indexSchema: index,
    accumulator,
    chainId: CHAIN,
    deployment: deploymentOf(registry, groups),
  });

/** A registry sync with nothing to record: the roots step runs only beside one. */
const idleSync = {
  run: async (): Promise<RegistrySyncReport> => ({ recorded: 0, unstored: [] }),
} as unknown as RegistrySync;

/** Runs the scheduled roots job once through a worker, with the clock at `NOW`. */
async function scheduledRun(roots: PollRoots) {
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
    pollRoots: { roots, everyMs: 3_600_000 },
  });
  let keys: string[];
  try {
    for (let i = 0; i < 200 && !lines.some((l) => l.queue === "{poll-root}" && "outcome" in l); i++)
      await new Promise((r) => setTimeout(r, 25));
    keys = await connection.keys(`${prefix}:{poll-root}:*`);
  } finally {
    await worker.close();
    for (const key of await connection.keys(`${prefix}:*`)) await connection.del(key);
    connection.disconnect();
  }
  return { lines: lines.filter((l) => l.queue === "{poll-root}"), keys };
}

const stateOf = async (id: string) => {
  const [r] = await db.admin`SELECT state, electorate FROM account_polls WHERE id = ${id}`;
  return r!;
};

describe("the roots step", () => {
  test("roots a checked poll from the index at the proven block, logging counts only", async () => {
    const { registry, logs } = await indexed();
    const id = await checked();
    const { lines, keys } = await scheduledRun(rootsOf(registry, accumulatorOf(registry, logs)));
    // Its queue's keys are under its own hash tag.
    expect(keys.length).toBeGreaterThan(0);
    expect(lines).toEqual([
      { queue: "{poll-root}", rooted: 1, failed: {} },
      { queue: "{poll-root}", outcome: "completed", ms: expect.any(Number) },
    ]);
    expect(await stateOf(id)).toEqual({
      state: "rooted",
      electorate: [
        {
          tier: 0,
          rootL2Block: BLOCK.toString(),
          groups: [{ groupId: "1", region: 0 }],
          regions: ["3"],
          cells: [{ root: tierTreeRoot([11n, 12n, 13n]).toString(), members: "3" }],
        },
      ],
    });
  });

  test("an idle run reads nothing and writes only its job line", async () => {
    const { registry } = await indexed();
    const { lines } = await scheduledRun(
      rootsOf(registry, {
        proven: () => Promise.reject(new Error("nothing is waiting")),
      }),
    );
    expect(lines).toEqual([{ queue: "{poll-root}", outcome: "completed", ms: expect.any(Number) }]);
  });

  test("an index missing a record the accumulator counts roots nothing, and the job says so", async () => {
    const { registry, logs } = await indexed();
    await db.admin`
      DELETE FROM ${db.admin(index)}.contract_log WHERE id = ${`${registry}-000000`}`;
    const id = await checked();
    const { lines } = await scheduledRun(rootsOf(registry, accumulatorOf(registry, logs)));
    expect(lines).toEqual([
      { queue: "{poll-root}", finding: "incomplete", reason: expect.any(String) },
      {
        queue: "{poll-root}",
        outcome: "failed",
        error: "poll-root-refused",
        ms: expect.any(Number),
      },
    ]);
    expect((await stateOf(id)).state).toBe("created");
  });

  test("an L2 node whose answers don't prove under the output root fails the job as a finding", async () => {
    const { registry } = await indexed();
    const id = await checked();
    const { lines } = await scheduledRun(
      rootsOf(registry, { proven: () => Promise.reject(new OutputRootError("output-root")) }),
    );
    expect(lines).toEqual([
      { queue: "{poll-root}", finding: "output-root", reason: "output-root" },
      {
        queue: "{poll-root}",
        outcome: "failed",
        error: "poll-root-refused",
        ms: expect.any(Number),
      },
    ]);
    expect((await stateOf(id)).state).toBe("created");
  });

  test("a published group the registry never created fails the job, not the poll", async () => {
    const { registry, logs } = await indexed();
    const id = await checked();
    const { lines } = await scheduledRun(
      rootsOf(registry, accumulatorOf(registry, logs), [1n, 2n]),
    );
    expect(lines).toEqual([
      { queue: "{poll-root}", finding: "groups", reason: "group-created" },
      {
        queue: "{poll-root}",
        outcome: "failed",
        error: "poll-root-refused",
        ms: expect.any(Number),
      },
    ]);
    expect((await stateOf(id)).state).toBe("created");
  });
});
