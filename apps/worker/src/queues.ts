import * as z from "zod";

// Every queue the worker knows, with the job data it takes. Two rules keep
// queues from joining accounts to ballots (T-10):
//
// - Each queue is on one side. A board queue's jobs never carry an account,
//   a session or anything about a person; an account queue's jobs never carry
//   a ballot, a nullifier or anything about who took part in which poll; an
//   operational queue's jobs carry neither. No job crosses sides, and
//   `tests/no-join.test.ts` checks every schema here.
// - Job data is a strict object, parsed before it is queued and again before
//   it is handled, so no field the schema doesn't name reaches Redis or a
//   handler. Job IDs are BullMQ's counters, never derived from the data.
//
// Every key a queue uses is `abolish:{<queue>}:…`, so the braces are a hash
// tag: Dragonfly (and Redis Cluster) keep each queue's keys in one slot,
// which BullMQ's Lua scripts need, while separate queues can live on
// separate threads or shards.

export const KEY_PREFIX = "abolish";

export type Side = "board" | "account" | "operational";

export interface QueueSpec<Data extends z.ZodObject = z.ZodObject> {
  /** The queue's name, `{name}`: its own hash tag. */
  readonly name: `{${string}}`;
  readonly side: Side;
  readonly data: Data;
}

export const QUEUES = {
  /**
   * Re-checks every stored board against its own bytes (core's auditBoard;
   * T-23, T-66). Runs on a schedule and takes no data.
   */
  boardAudit: { name: "{board-audit}", side: "board", data: z.strictObject({}) },
  /**
   * Takes every board's checkpoints for the ended anchoring periods and
   * anchors them on L1 (core's anchorBoards; docs/spec/board.md, Segments
   * and checkpoints; T-23, T-24, T-49). Runs on a schedule, only when the
   * worker has an anchor to send through, and takes no data.
   */
  boardAnchor: { name: "{board-anchor}", side: "board", data: z.strictObject({}) },
  /**
   * Deletes expired identity backups (core's pruneIdentityBackups; T-52,
   * T-66). Runs on a schedule and takes no data: the table is on neither
   * side's queues, and nothing about a backup is ever queued (T-10, T-20).
   */
  identityBackupPrune: {
    name: "{identity-backup-prune}",
    side: "operational",
    data: z.strictObject({}),
  },
  /**
   * Rebuilds the Tier 0 index from the group registry, so the registration
   * route's step 6 stays within a minute of the L2 node (core's
   * Tier0Batches.refreshIndex; docs/spec/registration.md, Answers). Runs on
   * a schedule and takes no data: no request, commitment or record is ever
   * queued (T-10, T-13).
   */
  tier0Index: { name: "{tier0-index}", side: "operational", data: z.strictObject({}) },
  /**
   * The Tier 0 batch at each period boundary (core's Tier0Batches.runBoundary;
   * docs/spec/registration.md, The batch). Ticks well within each period and
   * takes no data; core runs each period's boundary once, so a tick after it
   * does nothing (T-13).
   */
  tier0Boundary: { name: "{tier0-boundary}", side: "operational", data: z.strictObject({}) },
} as const satisfies Record<string, QueueSpec>;

export type QueueKey = keyof typeof QUEUES;
export type JobData<K extends QueueKey> = z.output<(typeof QUEUES)[K]["data"]>;

/**
 * What every job is queued with: no data kept in Redis once a job is done,
 * failed or not (its outcome is in the log line, by kind), and no retries,
 * since every job here is idempotent and the next scheduled run repeats it.
 */
export const JOB_OPTIONS = { removeOnComplete: true, removeOnFail: true, attempts: 1 } as const;
