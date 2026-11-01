import { GroupRecordsError, rollingChains } from "@abolishus/core";
import { type TestDb, testDb } from "@abolishus/core/test-db";
import {
  contractEventLog,
  type ContractEventRecord,
  replayEventAccumulator,
} from "@abolishus/crypto";
import { rollingChain, type RollingChainRelease } from "@abolishus/verifier";
import { randomBytes } from "node:crypto";
import { type Address, bytesToHex, hexToBytes } from "viem";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { definitionRegistered } from "../../../packages/verifier/tests/registration-logs.ts";
import { release, rolling, rollingTree } from "../../../packages/verifier/tests/registry-logs.ts";
import {
  checkPinnedRegistries,
  MAX_CLOCK_SKEW_SECONDS,
  type ProvenAccumulators,
  ProvenRegistryRecordSource,
  type RegistryAccumulators,
} from "../src/index.ts";

// The registries' records a rolling poll's ballots are judged against
// (src/registry-records.ts; P2-17 part 7b-2): both registries' records from
// the index, each checked against its accumulator under one output root,
// with that root's block's timestamp as the time they are settled through,
// so core's `rollingChains` builds the verifier's chain from them and no
// index that drops, adds or alters a record is judged against (T-08, T-71).
// The records are the verifier's test logs of rolling-tier-tree.json's
// `chain-order` tree, from an independent generator.

const t = rollingTree("chain-order");
const d = rolling([t.tier], t.closesAt);
const pinned: RollingChainRelease = { ...release, electionRegistry: d.value.election_registry };
const groupRecords = t.records;
const electionRecords = [definitionRegistered(d, undefined, undefined, 99n, t.registeredAt)];
const BLOCK = 1_000n;
const AT = t.closesAt + 1n;

let db: TestDb;
let index: string;
beforeAll(async () => {
  db = await testDb();
  // The indexer's `contract_log` as Ponder creates it (apps/indexer/ponder.schema.ts).
  index = `ix_${Buffer.from(randomBytes(6)).toString("hex")}`;
  await db.admin.unsafe(`CREATE SCHEMA "${index}"`);
  await db.admin.unsafe(`CREATE TABLE "${index}".contract_log (
    id text PRIMARY KEY, contract text NOT NULL, block_number numeric(78) NOT NULL,
    block_timestamp numeric(78) NOT NULL, topics text[] NOT NULL, data text NOT NULL,
    transaction_hash text NOT NULL, log_index integer NOT NULL)`);
  for (const records of [groupRecords, electionRecords])
    for (const [i, r] of records.entries()) await insert(r, i);
});
afterAll(async () => {
  await db?.admin.unsafe(`DROP SCHEMA IF EXISTS "${index}" CASCADE`);
  await db?.close();
});

async function insert(r: ContractEventRecord, i: number, contract = bytesToHex(r.contract)) {
  await db.admin`
    INSERT INTO ${db.admin(index)}.contract_log
    VALUES (${`${contract}-${String(i).padStart(6, "0")}`}, ${contract},
      ${r.l2_block.toString()}, ${r.l2_timestamp.toString()},
      ${r.topics.map((x) => bytesToHex(x))}, ${bytesToHex(r.data)},
      ${bytesToHex(randomBytes(32))}, 0)`;
}

const stateOf = (contract: Uint8Array, records: readonly ContractEventRecord[]) =>
  replayEventAccumulator(
    release.chainId,
    contract,
    records.map((r, i) => contractEventLog({ ...r, n: BigInt(i) })),
  );

/** Both registries' accumulators over their records, at `BLOCK` with timestamp `AT`, counting its reads. */
function accumulators(
  over: (contract: Address) => readonly ContractEventRecord[] = (c) =>
    hexToBytes(c).every((x, i) => x === release.registry[i]) ? groupRecords : electionRecords,
) {
  const asked: (readonly Address[])[] = [];
  const source: RegistryAccumulators = {
    async provenTogether(contracts): Promise<ProvenAccumulators> {
      asked.push(contracts);
      return {
        block: BLOCK,
        timestamp: AT,
        accumulators: contracts.map((c) => ({
          block: BLOCK,
          ...stateOf(hexToBytes(c), over(c)),
        })),
      };
    },
  };
  return { source, asked };
}

/** The worker's clock at `AT`, in milliseconds, unless a test sets it. */
const sourceOf = (
  a: RegistryAccumulators,
  options: { maxAgeMs?: number; now?: () => number } = {},
) =>
  new ProvenRegistryRecordSource({
    index: db.admin,
    indexSchema: index,
    accumulators: a,
    chainId: release.chainId,
    groupRegistry: release.registry,
    electionRegistry: d.value.election_registry,
    now: () => Number(AT) * 1000,
    ...options,
  });

const strip = (r: ContractEventRecord) => ({ ...r, contract: bytesToHex(r.contract) });

describe("the registries' proven records", () => {
  test("are both registries' indexed records under one root, settled at its block's timestamp", async () => {
    const { source, asked } = accumulators();
    const read = await sourceOf(source).read();
    expect(read.at).toBe(AT);
    // The block's number too, which the counted tally checks against every
    // rolling tier's `root_l2_block`.
    expect(read.block).toBe(BLOCK);
    expect(read.records.map(strip)).toEqual(
      [
        ...groupRecords.map((r, i) => ({ ...r, n: BigInt(i) })),
        ...electionRecords.map((r, i) => ({ ...r, n: BigInt(i) })),
      ].map(strip),
    );
    // One call for both, so both are read at one block.
    expect(asked).toEqual([[bytesToHex(release.registry), bytesToHex(d.value.election_registry)]]);
  });

  test("give core's rollingChains the verifier's chain over the registries' records", async () => {
    const read = await rollingChains(sourceOf(accumulators().source), pinned).read(d);
    expect(read.settledAt).toBe(AT);
    expect(read.outcome).toEqual(rollingChain(d, [...groupRecords, ...electionRecords], pinned));
    expect("status" in read.outcome && read.outcome.status).toBe("pass");
  });

  test("an index missing a record either accumulator counts is refused, never judged against", async () => {
    // The group registry's accumulator counts one more record than the index holds.
    const extra = { ...groupRecords[0]!, l2_block: 999n, l2_timestamp: AT - 1n };
    const ahead = accumulators((c) =>
      hexToBytes(c).every((x, i) => x === release.registry[i])
        ? [...groupRecords, extra]
        : electionRecords,
    );
    await expect(sourceOf(ahead.source).read()).rejects.toBeInstanceOf(GroupRecordsError);
    // And the election registry's: its registration missing from the index.
    const registration = accumulators((c) =>
      hexToBytes(c).every((x, i) => x === release.registry[i])
        ? groupRecords
        : [...electionRecords, { ...electionRecords[0]!, l2_block: 999n }],
    );
    await expect(sourceOf(registration.source).read()).rejects.toBeInstanceOf(GroupRecordsError);
  });

  test("an indexed record the accumulator doesn't vouch for is refused", async () => {
    const altered = accumulators((c) =>
      hexToBytes(c).every((x, i) => x === release.registry[i])
        ? groupRecords.map((r, i) => (i === 0 ? { ...r, l2_timestamp: r.l2_timestamp + 1n } : r))
        : electionRecords,
    );
    await expect(sourceOf(altered.source).read()).rejects.toMatchObject({ code: "accumulator" });
  });

  test("records the index holds past the proven block are left for a later read", async () => {
    // The index runs ahead of an output root posted about hourly: a group
    // record after the block, which the accumulator doesn't count yet.
    const later = { ...groupRecords[0]!, l2_block: BLOCK + 1n, l2_timestamp: AT + 1n };
    await insert(later, groupRecords.length);
    try {
      const read = await sourceOf(accumulators().source).read();
      expect(read.at).toBe(AT);
      expect(read.records.every((r) => r.l2_timestamp <= AT)).toBe(true);
      expect(read.records).toHaveLength(groupRecords.length + electionRecords.length);
      const chain = await rollingChains({ read: async () => read }, pinned).read(d);
      expect(chain.outcome).toEqual(rollingChain(d, [...groupRecords, ...electionRecords], pinned));
    } finally {
      await db.admin`DELETE FROM ${db.admin(index)}.contract_log
        WHERE id = ${`${bytesToHex(release.registry)}-${String(groupRecords.length).padStart(6, "0")}`}`;
    }
  });

  test("a block stamped ahead of the worker's clock by more than the drift bound is refused", async () => {
    const { source } = accumulators();
    const skew = Number(MAX_CLOCK_SKEW_SECONDS) * 1000;
    expect((await sourceOf(source, { now: () => Number(AT) * 1000 - skew }).read()).at).toBe(AT);
    await expect(
      sourceOf(source, { now: () => Number(AT) * 1000 - skew - 1000 }).read(),
    ).rejects.toThrow("ahead of this worker's clock");
  });

  test("accumulators proven at different blocks are refused", async () => {
    const split: RegistryAccumulators = {
      async provenTogether(contracts) {
        const read = await accumulators().source.provenTogether(contracts);
        const [group, election] = read.accumulators;
        return { ...read, accumulators: [group!, { ...election!, block: BLOCK - 1n }] };
      },
    };
    await expect(sourceOf(split).read()).rejects.toThrow("one block");
  });

  test("a read is reused for its age, shared while in flight, and never reused once it fails", async () => {
    let now = Number(AT) * 1000;
    let fail = false;
    const { source, asked } = accumulators();
    const flaky: RegistryAccumulators = {
      provenTogether: (c) =>
        fail ? Promise.reject(new Error("node down")) : source.provenTogether(c),
    };
    const records = sourceOf(flaky, { maxAgeMs: 1_000, now: () => now });
    const [a, b] = await Promise.all([records.read(), records.read()]);
    expect(b).toBe(a);
    now += 999;
    expect(await records.read()).toBe(a);
    expect(asked).toHaveLength(1);
    now += 1;
    fail = true;
    await expect(records.read()).rejects.toThrow("node down");
    fail = false;
    const again = await records.read();
    expect(again).not.toBe(a);
    expect(again).toEqual(a);
    expect(asked).toHaveLength(2);
  });

  test("refuses malformed options", () => {
    const { source } = accumulators();
    expect(() => sourceOf(source, { maxAgeMs: -1 })).toThrow(RangeError);
    expect(
      () =>
        new ProvenRegistryRecordSource({
          index: db.admin,
          indexSchema: index,
          accumulators: source,
          chainId: release.chainId,
          groupRegistry: new Uint8Array(19),
          electionRegistry: d.value.election_registry,
        }),
    ).toThrow(RangeError);
  });
});

describe("checkPinnedRegistries", () => {
  const deployment = {
    chainId: release.chainId,
    groupRegistry: release.registry,
    electionRegistry: d.value.election_registry,
  };

  test("passes the registries the release pins", () => {
    expect(() => checkPinnedRegistries(pinned, deployment)).not.toThrow();
  });

  test("refuses another chain, group registry or election registry", () => {
    const other = new Uint8Array(20).fill(0x77);
    for (const changed of [
      { ...deployment, chainId: deployment.chainId + 1n },
      { ...deployment, groupRegistry: other },
      { ...deployment, electionRegistry: other },
    ])
      expect(() => checkPinnedRegistries(pinned, changed)).toThrow("the release pins");
  });
});
