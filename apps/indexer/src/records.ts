// Reads the indexed group registry back, in the shape @abolishus/crypto's
// applyGroupRecords replays. Rows are what the events carried; whether a
// history is valid is the replay's to say, under the registrars the reader's
// release pins (T-71, T-06).

import type { GroupLogRecord } from "@abolishus/crypto";
import type { Sql } from "postgres";

export interface IndexedGroup {
  readonly groupId: bigint;
  readonly tier: number;
  /** The group's records in chain order. */
  readonly records: readonly GroupLogRecord[];
}

function hexBytes(h: string): Uint8Array {
  // Buffer.from stops at the first bad digit; a corrupted row must fail as one.
  if (!/^0x(?:[0-9a-f]{2})*$/.test(h))
    throw new Error("group_record: record isn't 0x-prefixed hex");
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
 * Only the event accumulator's proof shows a history complete (P3-5 part 3).
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
    list.push({ kind: row.kind, record: hexBytes(row.record) });
  }
  return groups.map((g) => ({
    groupId: BigInt(g.group_id),
    tier: g.tier,
    records: byGroup.get(g.group_id) ?? [],
  }));
}
