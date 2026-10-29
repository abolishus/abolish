import { MAX_BOARD_PAYLOAD } from "@abolishus/crypto";
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
//   handler. Job IDs are BullMQ's counters, or random for the queues the
//   API waits on (`{ballot-submit}`, `{receipt-submit}`, `{opening-submit}`,
//   `{destruction-submit}` and `{results-read}`), never derived from the data.
//
// Every key a queue uses is `abolish:{<queue>}:…`, so the braces are a hash
// tag: Dragonfly (and Redis Cluster) keep each queue's keys in one slot,
// which BullMQ's Lua scripts need, while separate queues can live on
// separate threads or shards.

export const KEY_PREFIX = "abolish";

/**
 * Bound on a share receipt record in a `{receipt-submit}` job: the API
 * contract's `MAX_SHARE_RECEIPT`, which a test of apps/api ties to this.
 */
export const MAX_SHARE_RECEIPT = 256;

/**
 * Bound on a tally opening record in an `{opening-submit}` job: the API
 * contract's `MAX_TALLY_OPENING`, which a test of apps/api ties to this.
 */
export const MAX_TALLY_OPENING = 8192;

/**
 * Bound on a destruction statement in a `{destruction-submit}` job: the API
 * contract's `MAX_DESTRUCTION_STATEMENT`, which a test of apps/api ties to this.
 */
export const MAX_DESTRUCTION_STATEMENT = 128;

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
   * Posts every taken checkpoint's segment object and entry-hash list to
   * Arweave, writes the manifests that list them once their uploads are
   * deep, and posts those (core's archiveBoards; docs/spec/archive.md;
   * T-49, T-51). Runs on a schedule, only beside the anchoring runner, whose
   * anchor every manifest names and whose calls carry the locator, and takes
   * no data.
   */
  archive: { name: "{archive}", side: "board", data: z.strictObject({}) },
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
  /**
   * Brings the Tier 1 relay's counting state and index up to the L2 node,
   * so the relay route's step 5 stays within a minute of it (core's
   * Tier1Batches.refreshIndex; docs/spec/tier1-relay.md, Answers). Runs on a
   * schedule and takes no data: no request or record is ever queued here
   * (T-10, T-13).
   */
  tier1Index: { name: "{tier1-index}", side: "operational", data: z.strictObject({}) },
  /**
   * The Tier 1 relay's batch at each period boundary (core's
   * Tier1Batches.runBoundary; docs/spec/tier1-relay.md, The batch). Ticks
   * well within each period and takes no data; core runs each period's
   * boundary once, so a tick after it does nothing (T-13).
   */
  tier1Boundary: { name: "{tier1-boundary}", side: "operational", data: z.strictObject({}) },
  /**
   * Records the election registry's finalized registrations from the index,
   * checked against the registry's event accumulator, and stores their
   * definitions (core's syncRegistrations; T-71, T-49, T-53). Runs on a
   * schedule, only when the worker is configured for it, and takes no data:
   * everything it reads is public chain data.
   */
  registrySync: { name: "{registry-sync}", side: "operational", data: z.strictObject({}) },
  /**
   * The creation step of each submitted poll's setup (core's
   * advancePollCreations; ADR 0032, rules 12 and 18): sends the creation
   * key's `createElection()` for each and records the identifier once final.
   * Runs on a schedule, only in a worker holding the creation key and
   * running nothing else, and takes no data: no poll, author or draft is ever
   * queued (T-10, T-72).
   */
  pollCreate: { name: "{poll-create}", side: "account", data: z.strictObject({}) },
  /**
   * The roots step of each created, checked poll's setup (core's rootPolls;
   * ADR 0032, rule 9): its electorate at the newest output root's block.
   * Runs on a schedule, only beside the registry sync and never with the
   * creation key, and takes no data: no poll, author or draft is ever queued
   * (T-10).
   */
  pollRoot: { name: "{poll-root}", side: "account", data: z.strictObject({}) },
  /**
   * The stub step of each rooted poll's setup (core's stubPolls; ADR 0032,
   * rules 7, 8, 10 and 11): the version-5 stub its ceremony binds, and a new
   * one under rule 10 when its registration can't land in time. Runs on a
   * schedule, only beside the registry sync, whose deployment every stub
   * pins, and never with the creation key, and takes no data: no poll,
   * author or draft is ever queued (T-10).
   */
  pollStub: { name: "{poll-stub}", side: "account", data: z.strictObject({}) },
  /**
   * The key ceremony's coordinator (core's openCeremonyRuns and
   * closeCeremonyRounds; ADR 0032, rule 5): opens a run for each stubbed
   * poll and closes rounds and approvals at their deadlines, while the API
   * serves the seats' side. Runs on a schedule, only beside the stub step,
   * whose default panel it relays between, and takes no data: no poll,
   * author, stub or seat is ever queued (T-10, T-54).
   */
  ceremonyCoordinate: {
    name: "{ceremony-coordinate}",
    side: "account",
    data: z.strictObject({}),
  },
  /**
   * The opening step of each registered poll's setup (core's openPolls; ADR
   * 0032, rules 12 to 14): the read-back of what the registry holds against
   * the draft, the transcript boarded as entry 0 and the display text
   * stored. Runs on a schedule, only beside the stub step, after the
   * registry sync has stored the registration, and takes no data: no poll,
   * author or draft is ever queued (T-10, T-34).
   */
  pollOpen: { name: "{poll-open}", side: "account", data: z.strictObject({}) },
  /**
   * Ballots the API received, to admit and board (core's
   * BallotAdmissions.submitAll; docs/spec/ballot-validity.md, Batched
   * admission; T-17, T-52). Queued by the API's `ballots.submit` through
   * `BallotQueue` and run only when the worker pins panels; jobs waiting
   * together are judged in one batch. A job carries the election and the
   * ballot's bytes, never who sent them (T-10), and returns only the outcome
   * (`BALLOT_OUTCOME`).
   */
  ballotSubmit: {
    name: "{ballot-submit}",
    side: "board",
    data: z.strictObject({
      electionId: z.string().regex(/^[0-9a-f]{64}$/),
      ballot: z
        .string()
        .max(2 * MAX_BOARD_PAYLOAD)
        // As the contract's: an empty ballot is the verifier's to refuse (decode).
        .regex(/^(?:[0-9a-f]{2})*$/),
    }),
  },
  /**
   * Share receipts the API received, to judge and board by the board path's
   * rules (core's BallotAdmissions.submitReceipt; docs/spec/delivery.md,
   * Boarding; T-17, T-52). Queued by the API's `receipts.submit` through
   * `ReceiptQueue` and run beside `{ballot-submit}`, with the same
   * admissions. A job carries the election and the receipt record's bytes,
   * never who sent them (T-10), and returns only the outcome
   * (`RECEIPT_OUTCOME`).
   */
  receiptSubmit: {
    name: "{receipt-submit}",
    side: "board",
    data: z.strictObject({
      electionId: z.string().regex(/^[0-9a-f]{64}$/),
      record: z
        .string()
        .max(2 * MAX_SHARE_RECEIPT)
        .regex(/^(?:[0-9a-f]{2})*$/),
    }),
  },
  /**
   * Tally openings the API received, to judge and board by the Boarding rule
   * over the anchored counted set (core's OpeningBoardings.submitOpening;
   * docs/spec/tally.md, Opening record, Boarding; T-17, T-29, T-52). Queued
   * by the API's `openings.submit` through `OpeningQueue` and run only when
   * the worker reads the anchor and finalized L1. A job carries the election
   * and the opening's bytes, never who sent them (T-10), and returns only
   * the outcome (`OPENING_OUTCOME`).
   */
  openingSubmit: {
    name: "{opening-submit}",
    side: "board",
    data: z.strictObject({
      electionId: z.string().regex(/^[0-9a-f]{64}$/),
      opening: z
        .string()
        .max(2 * MAX_TALLY_OPENING)
        .regex(/^(?:[0-9a-f]{2})*$/),
    }),
  },
  /**
   * Destruction statements the API received, to judge and board by the
   * Boarding rule (core's DestructionBoardings.submitDestruction;
   * docs/spec/tally.md, Destruction, Boarding; T-17, T-29, T-52). Queued by
   * the API's `destructions.submit` through `DestructionQueue` and run only
   * beside `{ballot-submit}`, by its clock. A job carries the election and
   * the statement's bytes, never who sent them (T-10), and returns only the
   * outcome (`DESTRUCTION_OUTCOME`).
   */
  destructionSubmit: {
    name: "{destruction-submit}",
    side: "board",
    data: z.strictObject({
      electionId: z.string().regex(/^[0-9a-f]{64}$/),
      statement: z
        .string()
        .max(2 * MAX_DESTRUCTION_STATEMENT)
        .regex(/^(?:[0-9a-f]{2})*$/),
    }),
  },
  /**
   * A poll's results from the openings boarded so far (core's
   * OpeningBoardings.readResults over the counted tally the openings are
   * judged against; docs/spec/verifier.md, Results from the counted tally;
   * T-29, T-52). Queued by the API's `elections.getResults` through
   * `ResultsQueue` and run only beside `{opening-submit}`, whose boardings
   * keep that tally. A job carries the election alone, never who asked
   * (T-10, T-11), and returns the results (`RESULTS_OUTCOME`).
   */
  resultsRead: {
    name: "{results-read}",
    side: "board",
    data: z.strictObject({ electionId: z.string().regex(/^[0-9a-f]{64}$/) }),
  },
} as const satisfies Record<string, QueueSpec>;

export type QueueKey = keyof typeof QUEUES;
export type JobData<K extends QueueKey> = z.output<(typeof QUEUES)[K]["data"]>;

/**
 * What every job is queued with: no data kept in Redis once a job is done,
 * failed or not (its outcome is in the log line, by kind), and no retries,
 * since every job here is idempotent and the next scheduled run repeats it.
 */
export const JOB_OPTIONS = { removeOnComplete: true, removeOnFail: true, attempts: 1 } as const;
