// The group registry's events, stored verbatim (ponder.schema.ts). Handlers
// only copy what the log says; the registry already refused anything its
// rules forbid, and consumers recheck every record anyway. Every event, the
// constructor's `RegistrarsPinned` included, also lands in `contract_log`
// as emitted, for the accumulator check.

import { ponder } from "ponder:registry";
import { contractLog, group, groupRecord } from "ponder:schema";

interface Emitted {
  readonly id: string;
  readonly log: {
    readonly address: `0x${string}`;
    readonly topics: readonly (`0x${string}` | null)[];
    readonly data: `0x${string}`;
    readonly logIndex: number;
  };
  readonly block: { readonly number: bigint; readonly timestamp: bigint };
  readonly transaction: { readonly hash: `0x${string}` };
}

function logRow(event: Emitted) {
  // Logs from Ponder's backfill come back from its cache with four topic
  // slots, the missing ones null; topics are contiguous, so the log's own end
  // at the first null.
  const end = event.log.topics.indexOf(null);
  const topics = (
    end === -1 ? event.log.topics : event.log.topics.slice(0, end)
  ) as `0x${string}`[];
  return {
    id: event.id,
    contract: event.log.address.toLowerCase() as `0x${string}`,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    topics,
    data: event.log.data,
    transactionHash: event.transaction.hash,
    logIndex: event.log.logIndex,
  };
}

ponder.on("GroupRegistry:RegistrarsPinned", async ({ event, context }) => {
  await context.db.insert(contractLog).values(logRow(event));
});

ponder.on("GroupRegistry:GroupCreated", async ({ event, context }) => {
  await context.db.insert(contractLog).values(logRow(event));
  await context.db.insert(group).values({
    groupId: event.args.groupId,
    tier: event.args.tier,
    blockNumber: event.block.number,
    transactionHash: event.transaction.hash,
    logIndex: event.log.logIndex,
  });
});

ponder.on("GroupRegistry:MembersAdded", async ({ event, context }) => {
  await context.db.insert(contractLog).values(logRow(event));
  await context.db.insert(groupRecord).values({
    id: event.id,
    groupId: event.args.groupId,
    kind: "add",
    record: event.args.record,
    blockNumber: event.block.number,
    transactionHash: event.transaction.hash,
    logIndex: event.log.logIndex,
  });
});

ponder.on("GroupRegistry:MembersRemoved", async ({ event, context }) => {
  await context.db.insert(contractLog).values(logRow(event));
  await context.db.insert(groupRecord).values({
    id: event.id,
    groupId: event.args.groupId,
    kind: "remove",
    record: event.args.record,
    blockNumber: event.block.number,
    transactionHash: event.transaction.hash,
    logIndex: event.log.logIndex,
  });
});
