import { index, onchainEnum, onchainTable } from "ponder";

// Public chain data only, stored as the events carry it. Nothing here is
// judged: a consumer replays a group's records through @abolishus/crypto's
// applyGroupRecords under the registrars its release pins, never trusting a
// row for a member, a count or a root (T-71, T-06).

/** Each `GroupCreated`: a group and the tier fixed when it was created. */
export const group = onchainTable("group", (t) => ({
  groupId: t.bigint().primaryKey(),
  tier: t.integer().notNull(),
  blockNumber: t.bigint().notNull(),
  transactionHash: t.hex().notNull(),
  logIndex: t.integer().notNull(),
}));

export const groupRecordKind = onchainEnum("group_record_kind", ["add", "remove"]);

/** Each `MembersAdded` and `MembersRemoved`, with its whole record, signatures included. */
export const groupRecord = onchainTable(
  "group_record",
  (t) => ({
    /** Ponder's event ID: it sorts in chain order. */
    id: t.text().primaryKey(),
    groupId: t.bigint().notNull(),
    kind: groupRecordKind().notNull(),
    record: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    transactionHash: t.hex().notNull(),
    logIndex: t.integer().notNull(),
  }),
  (table) => ({ byGroup: index().on(table.groupId, table.id) }),
);

/**
 * Every log the indexed contracts emit, as emitted: the inputs of its
 * contract's event-accumulator step, so a reader can rebuild each log's
 * contract-event record (`0x0008`) and check the contract's whole sequence
 * against a storage proof of its accumulator (docs/spec/contracts.md, Event
 * accumulator; T-71, T-25). A log's index `n` in its contract's sequence is
 * its position here in chain order, never a stored number, so a dropped row
 * shifts every later `n` and fails the check rather than leave a gap.
 */
export const contractLog = onchainTable(
  "contract_log",
  (t) => ({
    /** Ponder's event ID: it sorts in chain order. */
    id: t.text().primaryKey(),
    contract: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    blockTimestamp: t.bigint().notNull(),
    topics: t.hex().array().notNull(),
    data: t.hex().notNull(),
    transactionHash: t.hex().notNull(),
    logIndex: t.integer().notNull(),
  }),
  (table) => ({ byContract: index().on(table.contract, table.id) }),
);
