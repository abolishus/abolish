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

const hexBytes = (h: string) => Uint8Array.from(Buffer.from(h.slice(2), "hex"));

/**
 * Every indexed group with its records, in group order. `schema` is the
 * Postgres schema the indexer ran under (`DATABASE_SCHEMA`). A record whose
 * group has no `GroupCreated` row is returned under no group: the registry
 * refuses such records, so finding one means the index or the chain is
 * wrong, and it throws rather than drop it.
 */
export async function readIndexedGroups(sql: Sql, schema: string): Promise<IndexedGroup[]> {
  const groups = await sql<{ group_id: string; tier: number }[]>`
    select group_id::text, tier from ${sql(schema)}."group" order by group_id`;
  const rows = await sql<{ group_id: string; kind: "add" | "remove"; record: string }[]>`
    select group_id::text, kind::text, record from ${sql(schema)}.group_record
    order by group_id, id`;
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
