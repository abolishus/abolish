// The group registry's events, stored verbatim (ponder.schema.ts). Handlers
// only copy what the log says; the registry already refused anything its
// rules forbid, and consumers recheck every record anyway.

import { ponder } from "ponder:registry";
import { group, groupRecord } from "ponder:schema";

ponder.on("GroupRegistry:GroupCreated", async ({ event, context }) => {
  await context.db.insert(group).values({
    groupId: event.args.groupId,
    tier: event.args.tier,
    blockNumber: event.block.number,
    transactionHash: event.transaction.hash,
    logIndex: event.log.logIndex,
  });
});

ponder.on("GroupRegistry:MembersAdded", async ({ event, context }) => {
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
