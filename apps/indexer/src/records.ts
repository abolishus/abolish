// Reads the index back: the group registry's records, in the shape
// @abolishus/crypto's applyGroupRecords replays, and any contract's logs as
// contract-event records. Rows are what the events carried; whether a
// history is valid is the replay's and the accumulator check's to say, under
// what the reader's release pins (T-71, T-06).

import type { ContractEventRecord, GroupLogRecord } from "@abolishus/crypto";
import type { Sql } from "postgres";

export interface IndexedGroup {
  readonly groupId: bigint;
  readonly tier: number;
  /** The group's records in chain order. */
  readonly records: readonly GroupLogRecord[];
}

function hexBytes(h: string, what: string): Uint8Array {
  // Buffer.from stops at the first bad digit; a corrupted row must fail as one.
  if (!/^0x(?:[0-9a-f]{2})*$/.test(h)) throw new Error(`${what} isn't 0x-prefixed hex`);
  return Uint8Array.from(Buffer.from(h.slice(2), "hex"));
}

/**
 * Every indexed group with its records, in group order. `schema` is the
 * Postgres schema the indexer ran under (`DATABASE_SCHEMA`). A record whose
 * group has no `GroupCreated` row is returned under no group: the registry
 * refuses such records, so finding one means the index or the chain is
 * wrong, and it throws rather than drop it.
 *
 * Replay catches an altered or reordered row, not a missing one: a dropped
 * removal or a dropped tail of additions still replays, to another tree.
 * Only the event accumulator's proof shows a history complete: check the
 * registry's `readContractEvents` against it first.
 */
export async function readIndexedGroups(sql: Sql, schema: string): Promise<IndexedGroup[]> {
  // One snapshot, so a group and a record the indexer commits between the
  // two reads can't show as a record without its group.
  const [groups, rows] = await sql.begin("isolation level repeatable read read only", (tx) => [
    tx<{ group_id: string; tier: number }[]>`
      select group_id::text, tier from ${tx(schema)}."group" order by group_id`,
    // Ponder's event IDs are fixed-width decimal checkpoints: bytewise order
    // ("C") is chain order whatever the database's collation.
    tx<{ group_id: string; kind: "add" | "remove"; record: string }[]>`
      select group_id::text, kind::text, record from ${tx(schema)}.group_record
      order by group_id, id collate "C"`,
  ]);
  const byGroup = new Map<string, GroupLogRecord[]>(groups.map((g) => [g.group_id, []]));
  for (const row of rows) {
    const list = byGroup.get(row.group_id);
    if (list === undefined) throw new Error(`group ${row.group_id}: records but no GroupCreated`);
    list.push({ kind: row.kind, record: hexBytes(row.record, "group_record: record") });
  }
  return groups.map((g) => ({
    groupId: BigInt(g.group_id),
    tier: g.tier,
    records: byGroup.get(g.group_id) ?? [],
  }));
}

/**
 * A contract's indexed logs as contract-event records (docs/spec/contracts.md,
 * Contract-event record), in chain order, `n` counting from 0. `contract` is
 * the address as 0x and 40 hex digits. The rows are claims: a reader
 * replays them with @abolishus/crypto's `checkEventAccumulatorProof` (over
 * `contractEventLog`) against a storage proof of the contract's accumulator
 * it checked itself, which fails a dropped, added, altered, reordered or
 * moved log (T-71, T-25), and runs `checkContractEvent` before reading one.
 * A row that can't be a log at all (a topic that isn't 32 bytes, more than
 * four topics, non-hex data) throws as corruption.
 */
export async function readContractEvents(
  sql: Sql,
  schema: string,
  contract: string,
): Promise<ContractEventRecord[]> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(contract))
    throw new Error("contract must be 0x and 40 hex digits");
  const address = contract.toLowerCase();
  const rows = await sql<
    { block_number: string; block_timestamp: string; topics: string[]; data: string }[]
  >`
    select block_number::text, block_timestamp::text, topics, data
    from ${sql(schema)}.contract_log where contract = ${address}
    order by id collate "C"`;
  const contractBytes = hexBytes(address, "contract");
  return rows.map((row, i) => {
    const topics = row.topics.map((t) => hexBytes(t, "contract_log: topic"));
    if (topics.length > 4 || topics.some((t) => t.length !== 32))
      throw new Error("contract_log: topics aren't up to four 32-byte words");
    return {
      contract: contractBytes,
      n: BigInt(i),
      l2_block: BigInt(row.block_number),
      l2_timestamp: BigInt(row.block_timestamp),
      topics,
      data: hexBytes(row.data, "contract_log: data"),
    };
  });
}
