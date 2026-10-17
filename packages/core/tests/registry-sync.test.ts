import {
  type ContractEventRecord,
  contractEventLog,
  decodeElectionDefinition,
  electionDefinitionHash,
  encodeElectionDefinition,
  type EventContracts,
  replayEventAccumulator,
} from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  type IndexedLog,
  latestRegistration,
  readDefinition,
  recordRegistration,
  RegistrationError,
  type RegistryDeployment,
  RegistrySyncError,
  syncRegistrations,
} from "../src/index.ts";
import { type TestDb, testDb } from "./db.ts";

// Registrations from the registry's indexed logs (src/registry-sync.ts; P3-5
// part 3a): only logs the registry's accumulator at the finalized block
// vouches for are recorded, in chain order, each definition stored first; an
// index that drops, adds or alters a log records nothing, and a log the event
// check refuses stops the run at it (T-71, T-49, T-53).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const vectors = (file: string) =>
  JSON.parse(readFileSync(new URL(`../../../docs/spec/vectors/${file}`, import.meta.url), "utf8"));

const typical = decodeElectionDefinition(
  Buffer.from(
    vectors("election-definition.json").vectors.find(
      (v: { id: string }) => v.id === "definition-typical",
    ).encoding,
    "hex",
  ),
);

/** The registry's topics 0, from the published event table rather than the code under test. */
const topic0 = (signature: string) =>
  Uint8Array.from(
    Buffer.from(
      vectors("contract-event-v6.json").events.find(
        (e: { signature: string }) => e.signature === signature,
      ).topic0,
      "hex",
    ),
  );
const ELECTION_CREATED = topic0("ElectionCreated(bytes32,address,uint64,uint64,uint64,bytes32)");
const DEFINITION_REGISTERED = topic0(
  "DefinitionRegistered(bytes32,bytes32,uint64,uint64,bytes32,bytes)",
);

const CHAIN = 84_532n;
const b = (n: number) => new Uint8Array(randomBytes(n));

/** A big-endian 32-byte word. */
function word(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 31, x = v; i >= 0; i--, x >>= 8n) out[i] = Number(x & 0xffn);
  return out;
}

const concat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));

/** A deployment with a registry of its own, so its accumulator starts from genesis. */
function deployment(): RegistryDeployment {
  const contracts: EventContracts = {
    electionRegistry: b(20),
    trusteeRegistry: b(20),
    groupRegistry: b(20),
    board: b(20),
  };
  return { chainId: CHAIN, contracts, version: 6 };
}

interface Emitted {
  readonly topics: readonly Uint8Array[];
  readonly data: Uint8Array;
}

const l1Words = (block: bigint) => [word(20_000_000n + block), word(1_700_000_000n + block), b(32)];

function created(electionId: Uint8Array, block: bigint): Emitted {
  return {
    topics: [ELECTION_CREATED, electionId, concat(new Uint8Array(12), b(20))],
    data: concat(word(block), ...l1Words(block)),
  };
}

function registered(definition: Uint8Array, block: bigint, electionId?: Uint8Array): Emitted {
  const decoded = decodeElectionDefinition(definition);
  const padded = concat(definition, new Uint8Array((32 - (definition.length % 32)) % 32));
  return {
    topics: [
      DEFINITION_REGISTERED,
      electionId ?? decoded.election_id,
      electionDefinitionHash(decoded),
    ],
    data: concat(...l1Words(block), word(0x80n), word(BigInt(definition.length)), padded),
  };
}

const definition = (changes: Partial<typeof typical> = {}) =>
  encodeElectionDefinition({ ...typical, election_id: b(32), ...changes });

/** Blocks handed out in increasing order, so every sequence is after what's recorded. */
let nextBlock = 1_000n;

/** Indexed logs of `d`'s registry, one block each, numbered from 0. */
function logsOf(d: RegistryDeployment, emitted: readonly Emitted[]): IndexedLog[] {
  return emitted.map((e, i) => {
    const block = nextBlock++;
    const record: ContractEventRecord = {
      contract: d.contracts.electionRegistry,
      n: BigInt(i),
      l2_block: block,
      l2_timestamp: 1_800_000_000n + block * 2n,
      topics: e.topics,
      data: e.data,
    };
    return { record, logIndex: i % 3 };
  });
}

/** The registry's accumulator over its first `count` logs, proven at `block`. */
function provenAt(
  d: RegistryDeployment,
  logs: readonly IndexedLog[],
  count: number,
  block: bigint,
) {
  const state = replayEventAccumulator(
    CHAIN,
    d.contracts.electionRegistry,
    logs.slice(0, count).map((l) => contractEventLog(l.record)),
  );
  return { ...state, block };
}

/** Proven at the last log's block: the whole sequence finalized. */
const provenAll = (d: RegistryDeployment, logs: readonly IndexedLog[]) =>
  provenAt(d, logs, logs.length, logs.at(-1)?.record.l2_block ?? 0n);

async function refusal(p: Promise<unknown>): Promise<[string, string]> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RegistrySyncError) return [e.code, e.reason];
    throw e;
  }
  throw new Error("sync succeeded");
}

// A database of its own for each test (and each property run): a deployment
// has one registry, and the sync refuses a table holding another's.
let db: TestDb;
let app: Sql;
let open: TestDb | undefined;
async function reset() {
  await open?.close();
  open = db = await testDb();
  app = await db.as("abolish_app");
}
beforeEach(reset);
afterEach(async () => {
  await open?.close();
  open = undefined;
});

/** The registrations recorded after `block`, in chain order. */
const recordedSince = async (block: bigint) =>
  (
    await db.admin<{ election_id: Uint8Array; l2_block: string; log_index: number }[]>`
      SELECT election_id, l2_block::text, log_index FROM election_registrations
      WHERE l2_block >= ${block.toString()} ORDER BY l2_block, log_index`
  ).map((r) => ({
    electionId: Buffer.from(r.election_id).toString("hex"),
    position: `${r.l2_block}/${r.log_index}`,
  }));

const hex = (x: Uint8Array) => Buffer.from(x).toString("hex");

describe("records what the accumulator vouches for", () => {
  test("each finalized registration in chain order, its definition stored; a rerun records nothing", async () => {
    const d = deployment();
    const defs = [definition(), definition(), definition()];
    const ids = defs.map((x) => decodeElectionDefinition(x).election_id);
    const start = nextBlock;
    const logs = logsOf(d, [
      created(ids[0]!, 1n),
      registered(defs[0]!, 1n),
      created(ids[1]!, 2n),
      created(ids[2]!, 3n),
      registered(defs[2]!, 3n),
      registered(defs[1]!, 4n),
    ]);
    const report = await syncRegistrations(app, d, logs, provenAll(d, logs));
    expect(report).toEqual({ recorded: 3, unstored: [] });
    const rec = await recordedSince(start);
    expect(rec.map((r) => r.electionId)).toEqual([0, 2, 1].map((i) => hex(ids[i]!)));
    expect(rec.map((r) => r.position)).toEqual(
      [1, 4, 5].map((i) => `${logs[i]!.record.l2_block}/${logs[i]!.logIndex}`),
    );
    for (const [i, x] of defs.entries()) expect(await readDefinition(app, ids[i]!)).toEqual(x);
    expect(await syncRegistrations(app, d, logs, provenAll(d, logs))).toEqual({
      recorded: 0,
      unstored: [],
    });
  });

  test("logs above the finalized block wait for a later run", async () => {
    const d = deployment();
    const defs = [definition(), definition()];
    const logs = logsOf(d, [registered(defs[0]!, 1n), registered(defs[1]!, 2n)]);
    const first = logs[0]!.record.l2_block;
    // The index already holds the second log; the node has finalized only the first.
    expect(await syncRegistrations(app, d, logs, provenAt(d, logs, 1, first))).toEqual({
      recorded: 1,
      unstored: [],
    });
    expect((await recordedSince(first)).map((r) => r.electionId)).toEqual([
      hex(decodeElectionDefinition(defs[0]!).election_id),
    ]);
    expect(await syncRegistrations(app, d, logs, provenAll(d, logs))).toEqual({
      recorded: 1,
      unstored: [],
    });
    expect(await recordedSince(first)).toHaveLength(2);
  });

  test("a definition storeDefinition refuses is still registered, its codes kept", async () => {
    const d = deployment();
    const ill = definition({ opens_at: typical.closes_at });
    const id = decodeElectionDefinition(ill).election_id;
    const logs = logsOf(d, [registered(ill, 1n)]);
    expect(await syncRegistrations(app, d, logs, provenAll(d, logs))).toEqual({
      recorded: 1,
      unstored: [{ electionId: id, code: "ill-formed" }],
    });
    expect(await readDefinition(app, id)).toBeUndefined();
    expect((await recordedSince(logs[0]!.record.l2_block)).map((r) => r.electionId)).toEqual([
      hex(id),
    ]);
  });

  test("across runs at rising finalized blocks, every registration lands once, in order", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }),
        fc.array(fc.nat(), { minLength: 1, maxLength: 4 }),
        async (kinds, cuts) => {
          await reset();
          const d = deployment();
          const emitted = kinds.map((reg, i) =>
            reg ? registered(definition(), BigInt(i)) : created(b(32), BigInt(i)),
          );
          const start = nextBlock;
          const logs = logsOf(d, emitted);
          const counts = [...cuts.map((c) => c % (logs.length + 1)), logs.length].sort(
            (x, y) => x - y,
          );
          let total = 0;
          for (const count of counts) {
            const block = count === 0 ? start - 1n : logs[count - 1]!.record.l2_block;
            total += (await syncRegistrations(app, d, logs, provenAt(d, logs, count, block)))
              .recorded;
          }
          const expected = logs
            .filter((_, i) => kinds[i])
            .map((l) => `${l.record.l2_block}/${l.logIndex}`);
          expect(total).toBe(expected.length);
          expect((await recordedSince(start)).map((r) => r.position)).toEqual(expected);
        },
      ),
      // Each run migrates a database of its own.
      { numRuns: Math.min(numRuns, 25) },
    );
  }, 120_000);
});

describe("refuses an index the accumulator doesn't vouch for, recording nothing", () => {
  const cases: [string, (logs: IndexedLog[]) => IndexedLog[], string][] = [
    // n is a row's position, so a dropped row renumbers every later one.
    [
      "a dropped log",
      (logs) =>
        logs
          .filter((_, i) => i !== 0)
          .map((l, i) => ({ ...l, record: { ...l.record, n: BigInt(i) } })),
      "accumulator",
    ],
    [
      "an altered log",
      (logs) =>
        logs.map((l, i) =>
          i === 1
            ? {
                ...l,
                record: { ...l.record, data: l.record.data.map((x, j) => (j === 0 ? x ^ 1 : x)) },
              }
            : l,
        ),
      "accumulator",
    ],
    [
      "a log moved to a later block",
      (logs) =>
        logs.map((l, i) =>
          i === 0 ? { ...l, record: { ...l.record, l2_block: l.record.l2_block + 1n } } : l,
        ),
      "accumulator",
    ],
    ["a gap in the numbering", (logs) => logs.filter((_, i) => i !== 0), "index"],
  ];
  test.each(cases)("%s", async (_, tamper, reason) => {
    const d = deployment();
    const start = nextBlock;
    const logs = logsOf(d, [registered(definition(), 1n), registered(definition(), 2n)]);
    const proven = provenAll(d, logs);
    expect(await refusal(syncRegistrations(app, d, tamper(logs), proven))).toEqual([
      "incomplete",
      reason,
    ]);
    expect(await recordedSince(start)).toEqual([]);
  });

  test("another registry's logs", async () => {
    const d = deployment();
    const start = nextBlock;
    const logs = logsOf(d, [registered(definition(), 1n)]);
    const other = { ...d, contracts: { ...d.contracts, electionRegistry: b(20) } };
    expect(await refusal(syncRegistrations(app, other, logs, provenAll(d, logs)))).toEqual([
      "incomplete",
      "accumulator",
    ]);
    expect(await recordedSince(start)).toEqual([]);
  });
});

describe("refuses an index or a table it can't line up", () => {
  test("two registrations in one block with their log indices swapped", async () => {
    const d = deployment();
    const start = nextBlock;
    const logs = logsOf(d, [registered(definition(), 1n), registered(definition(), 1n)]);
    // One block, the two logs' indices in the order the index claims.
    const block = logs[0]!.record.l2_block;
    const swapped = logs.map((l, i) => ({
      record: { ...l.record, l2_block: block },
      logIndex: i === 0 ? 7 : 4,
    }));
    expect(await refusal(syncRegistrations(app, d, swapped, provenAll(d, swapped)))).toEqual([
      "incomplete",
      "log-index",
    ]);
    expect(await recordedSince(start)).toEqual([]);
    const ordered = swapped.map((l, i) => ({ ...l, logIndex: i === 0 ? 4 : 7 }));
    expect(await syncRegistrations(app, d, ordered, provenAll(d, ordered))).toEqual({
      recorded: 2,
      unstored: [],
    });
    expect((await recordedSince(start)).map((r) => r.position)).toEqual([
      `${block}/4`,
      `${block}/7`,
    ]);
  });

  test("another registry's logs over a table holding this one's registrations", async () => {
    const d = deployment();
    const first = logsOf(d, [registered(definition(), 1n)]);
    await syncRegistrations(app, d, first, provenAll(d, first));
    const other = deployment();
    const start = nextBlock;
    const logs = logsOf(other, [registered(definition(), 1n), registered(definition(), 2n)]);
    expect(await refusal(syncRegistrations(app, other, logs, provenAll(other, logs)))).toEqual([
      "recorded",
      "other-registrations",
    ]);
    expect(await recordedSince(start)).toEqual([]);
  });

  test("an index whose latest recorded registration moved in its block", async () => {
    const d = deployment();
    const logs = logsOf(d, [
      registered(definition(), 1n),
      registered(definition(), 2n),
      registered(definition(), 3n),
    ]);
    await syncRegistrations(app, d, logs.slice(0, 2), provenAll(d, logs.slice(0, 2)));
    const start = logs[2]!.record.l2_block;
    // The latest recorded registration at another index in its block.
    const moved = logs.map((l, i) => (i === 1 ? { ...l, logIndex: l.logIndex + 1 } : l));
    expect(await refusal(syncRegistrations(app, d, moved, provenAll(d, moved)))).toEqual([
      "recorded",
      "other-registrations",
    ]);
    expect(await recordedSince(start)).toEqual([]);
  });
  test("a table holding a registration the registry's logs don't", async () => {
    await recordRegistration(app, {
      electionId: b(32),
      definitionHash: b(32),
      l2Block: 1n,
      logIndex: 0,
    });
    const d = deployment();
    const start = nextBlock;
    const logs = logsOf(d, [registered(definition(), 1n)]);
    expect(await refusal(syncRegistrations(app, d, logs, provenAll(d, logs)))).toEqual([
      "recorded",
      "other-registrations",
    ]);
    expect(await recordedSince(start)).toEqual([]);
  });
});

describe("stops at a log the event check refuses", () => {
  const cases: [string, (good: Emitted) => Emitted, string][] = [
    ["an unknown event", (e) => ({ ...e, topics: [b(32), ...e.topics.slice(1)] }), "unknown-event"],
    ["a missing topic", (e) => ({ ...e, topics: e.topics.slice(0, 2) }), "event-topics"],
    ["data cut short", (e) => ({ ...e, data: e.data.slice(0, 64) }), "event-data"],
  ];
  test.each(cases)("%s: the logs before it are recorded, none after", async (_, bad, reason) => {
    const d = deployment();
    const start = nextBlock;
    const defs = [definition(), definition(), definition()];
    const logs = logsOf(d, [
      registered(defs[0]!, 1n),
      bad(registered(defs[1]!, 2n)),
      registered(defs[2]!, 3n),
    ]);
    expect(await refusal(syncRegistrations(app, d, logs, provenAll(d, logs)))).toEqual([
      "event-check",
      reason,
    ]);
    expect((await recordedSince(start)).map((r) => r.electionId)).toEqual([
      hex(decodeElectionDefinition(defs[0]!).election_id),
    ]);
    expect(
      await readDefinition(app, decodeElectionDefinition(defs[2]!).election_id),
    ).toBeUndefined();
  });

  test("a log naming another contract, though its accumulator replays", async () => {
    const d = deployment();
    const start = nextBlock;
    const logs = logsOf(d, [registered(definition(), 1n)]).map((l) => ({
      ...l,
      record: { ...l.record, contract: d.contracts.board },
    }));
    expect(await refusal(syncRegistrations(app, d, logs, provenAll(d, logs)))).toEqual([
      "event-check",
      "other-contract",
    ]);
    expect(await recordedSince(start)).toEqual([]);
  });

  test("a registration filing its definition under another election", async () => {
    const d = deployment();
    const start = nextBlock;
    const def = definition();
    const logs = logsOf(d, [registered(def, 1n, b(32))]);
    expect(await refusal(syncRegistrations(app, d, logs, provenAll(d, logs)))).toEqual([
      "event-check",
      "other-election",
    ]);
    expect(await recordedSince(start)).toEqual([]);
    // Refused before anything is written.
    expect(await readDefinition(app, decodeElectionDefinition(def).election_id)).toBeUndefined();
  });

  test("a registration the table refuses stops the run with its error", async () => {
    const d = deployment();
    const def = definition();
    // The same definition registered twice: its hash already owns a row.
    const logs = logsOf(d, [registered(def, 1n), registered(def, 2n)]);
    await expect(syncRegistrations(app, d, logs, provenAll(d, logs))).rejects.toThrow(
      RegistrationError,
    );
    expect(await latestRegistration(app)).toEqual({
      l2Block: logs[0]!.record.l2_block,
      logIndex: logs[0]!.logIndex,
    });
  });
});
