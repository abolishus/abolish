import { readDefinition } from "@abolishus/core";
import { type TestDb, testDb } from "@abolishus/core/test-db";
import {
  contractEventLog,
  type ContractEventRecord,
  decodeElectionDefinition,
  electionDefinitionHash,
  encodeElectionDefinition,
  replayEventAccumulator,
} from "@abolishus/crypto";
import { Redis } from "ioredis";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Sql } from "postgres";
import { ACCUMULATOR_SLOT, OutputRootError } from "@abolishus/verifier";
import {
  bytesToHex,
  encodeAbiParameters,
  type Hex,
  hexToBigInt,
  keccak256,
  stringToHex,
} from "viem";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { type LogLine, type RegistryAccumulator, RegistrySync, startWorker } from "../src/index.ts";

// The registry sync (src/registry-sync.ts; P3-5 parts 3a and 3b): it records
// from an index only what the proven accumulator vouches for, through core,
// and a node whose answers don't prove under the output root fails the job
// as a finding (T-71, T-34).

const CHAIN = 84_532n;
const redisUrl = process.env["REDIS_URL"];
if (!redisUrl) throw new Error("REDIS_URL is not set");

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const addr = () => bytesToHex(randomBytes(20));

const typical = decodeElectionDefinition(
  Buffer.from(
    JSON.parse(
      readFileSync(
        new URL("../../../docs/spec/vectors/election-definition.json", import.meta.url),
        "utf8",
      ),
    ).vectors.find((v: { id: string }) => v.id === "definition-typical").encoding,
    "hex",
  ),
);

const DEFINITION_REGISTERED = keccak256(
  stringToHex("DefinitionRegistered(bytes32,bytes32,uint64,uint64,bytes32,bytes)"),
);

/** A DefinitionRegistered log of a fresh definition, as the registry emits it. */
function registration(block: bigint) {
  const definition = encodeElectionDefinition({ ...typical, election_id: randomBytes(32) });
  const decoded = decodeElectionDefinition(definition);
  return {
    electionId: decoded.election_id,
    definition,
    topics: [
      DEFINITION_REGISTERED,
      bytesToHex(decoded.election_id),
      bytesToHex(electionDefinitionHash(decoded)),
    ] as Hex[],
    data: encodeAbiParameters(
      [{ type: "uint64" }, { type: "uint64" }, { type: "bytes32" }, { type: "bytes" }],
      [
        20_000_000n + block,
        1_700_000_000n + block,
        bytesToHex(randomBytes(32)),
        bytesToHex(definition),
      ],
    ),
  };
}

interface Log {
  readonly block: bigint;
  readonly logIndex: number;
  readonly topics: readonly Hex[];
  readonly data: Hex;
}

const recordOf = (registry: Hex, log: Log, n: number): ContractEventRecord => ({
  contract: Buffer.from(registry.slice(2), "hex"),
  n: BigInt(n),
  l2_block: log.block,
  l2_timestamp: 1_800_000_000n + log.block,
  topics: log.topics.map((t) => Buffer.from(t.slice(2), "hex")),
  data: Buffer.from(log.data.slice(2), "hex"),
});

/**
 * The registry's accumulator over its logs at or below the block `at()`
 * returns, as the output-root adapter proves it (tests/output-roots.test.ts
 * tests the proof).
 */
function accumulatorOf(registry: Hex, logs: () => readonly Log[], at: () => bigint) {
  return {
    async proven() {
      const block = at();
      const upTo = logs().filter((l) => l.block <= block);
      const state = replayEventAccumulator(
        CHAIN,
        Buffer.from(registry.slice(2), "hex"),
        upTo.map((l, i) => contractEventLog(recordOf(registry, l, i))),
      );
      return { block, ...state };
    },
  };
}

test("the accumulator's slot is the spec's ERC-7201 derivation", () => {
  const derived =
    hexToBigInt(
      keccak256(
        encodeAbiParameters(
          [{ type: "uint256" }],
          [hexToBigInt(keccak256(stringToHex("abolish.event-accumulator"))) - 1n],
        ),
      ),
    ) & ~0xffn;
  expect(ACCUMULATOR_SLOT).toBe(derived);
});

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

/** Blocks handed out in increasing order, so every registry's logs come after what's recorded. */
let nextBlock = 100n;

/** A registry of its own with `n` registrations indexed, two to a block. */
async function indexed(n: number) {
  const registry = addr();
  const base = nextBlock;
  nextBlock += BigInt(n);
  const logs = Array.from({ length: n }, (_, i) => {
    const block = base + BigInt(Math.floor(i / 2));
    return { block, logIndex: (i % 2) * 3, ...registration(block) };
  });
  for (const [i, l] of logs.entries())
    await db.admin`
      INSERT INTO ${db.admin(index)}.contract_log
      VALUES (${`${registry}-${String(i).padStart(6, "0")}`}, ${registry}, ${l.block.toString()},
        ${(1_800_000_000n + l.block).toString()}, ${l.topics as string[]}, ${l.data},
        ${bytesToHex(randomBytes(32))}, ${l.logIndex})`;
  return { registry, logs };
}

function syncOf(registry: Hex, node: RegistryAccumulator) {
  return new RegistrySync({
    sql: app,
    index: db.admin,
    indexSchema: index,
    accumulator: node,
    deployment: {
      chainId: CHAIN,
      contracts: {
        electionRegistry: Buffer.from(registry.slice(2), "hex"),
        trusteeRegistry: randomBytes(20),
        groupRegistry: randomBytes(20),
        board: randomBytes(20),
      },
      version: 6,
    },
  });
}

const positions = async (from: bigint) =>
  (
    await db.admin<{ election_id: Uint8Array; l2_block: string; log_index: number }[]>`
      SELECT election_id, l2_block::text, log_index FROM election_registrations
      WHERE l2_block >= ${from.toString()} ORDER BY l2_block, log_index`
  ).map((r) => [hex(r.election_id), BigInt(r.l2_block), r.log_index]);

/** Runs the scheduled job once through a worker, and returns its log lines and Redis keys. */
async function scheduledRun(sync: RegistrySync) {
  const lines: LogLine[] = [];
  const prefix = `abolish-test-${hex(randomBytes(6))}`;
  const connection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
  const worker = await startWorker({
    connection,
    sql: app,
    log: (l) => lines.push(l),
    auditEveryMs: 3_600_000,
    prefix,
    registry: { sync, everyMs: 3_600_000 },
  });
  let keys: string[];
  try {
    for (
      let i = 0;
      i < 200 && !lines.some((l) => l.queue === "{registry-sync}" && "outcome" in l);
      i++
    )
      await new Promise((r) => setTimeout(r, 25));
    keys = await connection.keys(`${prefix}:{registry-sync}:*`);
  } finally {
    await worker.close();
    for (const key of await connection.keys(`${prefix}:*`)) await connection.del(key);
    connection.disconnect();
  }
  return { lines, keys };
}

describe("the sync", () => {
  test("records the index's registrations up to the proven block, with their positions", async () => {
    const { registry, logs } = await indexed(4);
    let proven = logs[1]!.block;
    const sync = syncOf(
      registry,
      accumulatorOf(
        registry,
        () => logs,
        () => proven,
      ),
    );
    expect(await sync.run()).toEqual({ recorded: 2, unstored: [] });
    proven = logs[3]!.block;
    expect(await sync.run()).toEqual({ recorded: 2, unstored: [] });
    expect(await positions(logs[0]!.block)).toEqual(
      logs.map((l) => [hex(l.electionId), l.block, l.logIndex]),
    );
    for (const l of logs) expect(await readDefinition(app, l.electionId)).toEqual(l.definition);
  });

  test("an index missing a log the proven accumulator counts records nothing, and the job says so", async () => {
    const { registry, logs } = await indexed(2);
    await db.admin`
      DELETE FROM ${db.admin(index)}.contract_log WHERE id = ${`${registry}-000000`}`;
    const sync = syncOf(
      registry,
      accumulatorOf(
        registry,
        () => logs,
        () => logs[1]!.block,
      ),
    );
    const { lines, keys } = await scheduledRun(sync);
    // Its queue's keys are under its own hash tag.
    expect(keys.length).toBeGreaterThan(0);
    expect(lines.filter((l) => l.queue === "{registry-sync}")).toEqual([
      { queue: "{registry-sync}", finding: "incomplete", reason: "accumulator" },
      {
        queue: "{registry-sync}",
        outcome: "failed",
        error: "registry-sync-refused",
        ms: expect.any(Number),
      },
    ]);
    expect(await positions(logs[0]!.block)).toEqual([]);
  });

  test("an L2 node whose answers don't prove under the output root fails the job as a finding", async () => {
    const { registry, logs } = await indexed(1);
    const sync = syncOf(registry, {
      proven: () => Promise.reject(new OutputRootError("output-root")),
    });
    const { lines } = await scheduledRun(sync);
    expect(lines.filter((l) => l.queue === "{registry-sync}")).toEqual([
      { queue: "{registry-sync}", finding: "output-root", reason: "output-root" },
      {
        queue: "{registry-sync}",
        outcome: "failed",
        error: "registry-sync-refused",
        ms: expect.any(Number),
      },
    ]);
    expect(await positions(logs[0]!.block)).toEqual([]);
  });
});
