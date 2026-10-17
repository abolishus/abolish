// Every event of the four L2 contracts lands in `contract_log` as emitted,
// the constructors' `RegistrarsPinned` and `PanelPinned` included, for the
// accumulator check (src/events.ts). The group registry's records are also
// stored verbatim in `group` and `group_record` (ponder.schema.ts). Handlers
// only copy what the log says; the contracts already refused anything their
// rules forbid, and consumers recheck every record anyway.

import { ponder } from "ponder:registry";
import { contractLog, group, groupRecord } from "ponder:schema";
import { indexedEvents } from "./events.ts";

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

type Context = Parameters<
  Parameters<typeof ponder.on<"GroupRegistry:MembersAdded">>[1]
>[0]["context"];
type GroupEvent = Emitted & {
  readonly args: {
    readonly groupId: bigint;
    readonly tier?: number;
    readonly record?: `0x${string}`;
  };
};

async function recordRow(event: GroupEvent, context: Context, kind: "add" | "remove") {
  await context.db.insert(groupRecord).values({
    id: event.id,
    groupId: event.args.groupId,
    kind,
    record: event.args.record as `0x${string}`,
    blockNumber: event.block.number,
    transactionHash: event.transaction.hash,
    logIndex: event.log.logIndex,
  });
}

/** What the group registry's records add beside their `contract_log` row. */
const extra: Partial<Record<string, (event: GroupEvent, context: Context) => Promise<void>>> = {
  "GroupRegistry:GroupCreated": async (event, context) => {
    await context.db.insert(group).values({
      groupId: event.args.groupId,
      tier: event.args.tier as number,
      blockNumber: event.block.number,
      transactionHash: event.transaction.hash,
      logIndex: event.log.logIndex,
    });
  },
  "GroupRegistry:MembersAdded": (event, context) => recordRow(event, context, "add"),
  "GroupRegistry:MembersRemoved": (event, context) => recordRow(event, context, "remove"),
};

for (const name of indexedEvents()) {
  const more = extra[name];
  ponder.on(name as "GroupRegistry:MembersAdded", async ({ event, context }) => {
    await context.db.insert(contractLog).values(logRow(event));
    if (more !== undefined) await more(event as unknown as GroupEvent, context);
  });
}
