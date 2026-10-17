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
import {
  bytesToHex,
  createPublicClient,
  custom,
  encodeAbiParameters,
  type Hex,
  hexToBigInt,
  keccak256,
  stringToHex,
  toHex,
} from "viem";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  ACCUMULATOR_SLOT,
  type LogLine,
  RegistrySync,
  startWorker,
  ViemRegistryAccumulator,
} from "../src/index.ts";

// The registry sync (src/registry-sync.ts; P3-5 part 3a): the L2 node's
// adapter reads the registry's accumulator at its finalized head from the
// spec's slots, and the sync records from an index only what that
// accumulator vouches for, through core (T-71, T-34's RPC residual).

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
 * An L2 node whose finalized head is `finalized` and whose registry storage
 * holds the accumulator over the logs at or below it. `calls` records each
 * request.
 */
function nodeOf(
  registry: Hex,
  logs: () => readonly Log[],
  options: { chainId?: bigint; finalized: () => bigint; count?: Hex },
) {
  const calls: { method: string; params: unknown }[] = [];
  const client = createPublicClient({
    transport: custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        calls.push({ method, params });
        if (method === "eth_chainId") return toHex(options.chainId ?? CHAIN);
        if (method === "eth_getBlockByNumber") {
          const n = options.finalized();
          return {
            number: toHex(n),
            hash: toHex(n, { size: 32 }),
            parentHash: toHex(n - 1n, { size: 32 }),
            timestamp: toHex(1_800_000_000n + n),
            transactions: [],
            logsBloom: null,
            nonce: null,
          };
        }
        if (method === "eth_getStorageAt") {
          const [address, slot, block] = params as [Hex, Hex, Hex];
          if (address.toLowerCase() !== registry) return toHex(0n, { size: 32 });
          const upTo = logs().filter((l) => l.block <= hexToBigInt(block));
          const state = replayEventAccumulator(
            CHAIN,
            Buffer.from(registry.slice(2), "hex"),
            upTo.map((l, i) => contractEventLog(recordOf(registry, l, i))),
          );
          if (hexToBigInt(slot) === ACCUMULATOR_SLOT) return bytesToHex(state.accumulator);
          if (hexToBigInt(slot) === ACCUMULATOR_SLOT + 1n)
            return options.count ?? toHex(state.count, { size: 32 });
        }
        throw new Error(`unexpected ${method}`);
      },
    }),
  });
  return { client, calls };
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

describe("the L2 node's adapter", () => {
  const registry = addr();
  const logs: Log[] = [{ block: 5n, logIndex: 0, ...registration(5n) }];

  test("reads both slots at the finalized head, by number", async () => {
    const { client, calls } = nodeOf(registry, () => logs, { finalized: () => 7n });
    const node = await ViemRegistryAccumulator.connect(client, CHAIN);
    const proven = await node.finalized(registry);
    expect(proven.block).toBe(7n);
    expect(proven.count).toBe(1n);
    expect(calls.filter((c) => c.method === "eth_getStorageAt").map((c) => c.params)).toEqual([
      [registry, toHex(ACCUMULATOR_SLOT, { size: 32 }), toHex(7n)],
      [registry, toHex(ACCUMULATOR_SLOT + 1n, { size: 32 }), toHex(7n)],
    ]);
  });

  test("refuses a node on another chain", async () => {
    const { client } = nodeOf(registry, () => logs, { chainId: 1n, finalized: () => 7n });
    await expect(ViemRegistryAccumulator.connect(client, CHAIN)).rejects.toThrow("another chain");
  });

  test("refuses a count that isn't a u64", async () => {
    const { client } = nodeOf(registry, () => logs, {
      finalized: () => 7n,
      count: toHex(1n << 64n, { size: 32 }),
    });
    const node = await ViemRegistryAccumulator.connect(client, CHAIN);
    await expect(node.finalized(registry)).rejects.toThrow("isn't a u64");
  });
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

function syncOf(registry: Hex, node: ViemRegistryAccumulator) {
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

describe("the sync", () => {
  test("records the index's registrations up to the finalized head, with their positions", async () => {
    const { registry, logs } = await indexed(4);
    let finalized = logs[1]!.block;
    const { client } = nodeOf(registry, () => logs, { finalized: () => finalized });
    const sync = syncOf(registry, await ViemRegistryAccumulator.connect(client, CHAIN));
    expect(await sync.run()).toEqual({ recorded: 2, unstored: [] });
    finalized = logs[3]!.block;
    expect(await sync.run()).toEqual({ recorded: 2, unstored: [] });
    expect(await positions(logs[0]!.block)).toEqual(
      logs.map((l) => [hex(l.electionId), l.block, l.logIndex]),
    );
    for (const l of logs) expect(await readDefinition(app, l.electionId)).toEqual(l.definition);
  });

  test("an index missing a log the node's accumulator counts records nothing, and the job says so", async () => {
    const { registry, logs } = await indexed(2);
    await db.admin`
      DELETE FROM ${db.admin(index)}.contract_log WHERE id = ${`${registry}-000000`}`;
    const { client } = nodeOf(registry, () => logs, { finalized: () => logs[1]!.block });
    const sync = syncOf(registry, await ViemRegistryAccumulator.connect(client, CHAIN));
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
});
