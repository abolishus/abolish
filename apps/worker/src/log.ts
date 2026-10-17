// The worker's log (T-10, T-11): one line per job, holding the queue, the
// outcome, the error's kind and the duration, never the job's data, its ID or
// an error message (messages can quote data). Findings are their own lines
// and carry only public board values.

import type {
  AnchorFindingCode,
  BoardAuditCode,
  DefinitionErrorCode,
  RegistrationErrorCode,
  RegistrySyncErrorCode,
  RegistrySyncReason,
  CreationFailure,
  RootFailure,
  Tier0GroupOutcome,
} from "@abolishus/core";
import type { EventAccumulatorProofError, TierMembershipErrorCode } from "@abolishus/crypto";
import type { OutputRootErrorCode } from "@abolishus/verifier";
import type { QueueSpec } from "./queues.ts";

export interface JobLogLine {
  readonly queue: QueueSpec["name"];
  readonly outcome: "completed" | "failed";
  /** For a failed job, the error's kind from a fixed list. */
  readonly error?: ErrorKind;
  readonly ms: number;
}

/**
 * A board that failed its audit. The election ID and position are public:
 * they are on the board itself, and no person's request led here.
 */
export type AuditFindingLine =
  | {
      readonly queue: "{board-audit}";
      readonly finding: BoardAuditCode;
      readonly election: string;
      readonly index: number;
    }
  | {
      /** The audit itself failed (its message isn't logged), so the board is unchecked. */
      readonly queue: "{board-audit}";
      readonly finding: "audit-error";
      readonly election: string;
    };

/**
 * What an anchoring run found (core's AnchorFindingCode), for one election
 * but `anchor-clock`. The election ID and segment are public: both are on
 * the board and on L1.
 */
export interface AnchorFindingLine {
  readonly queue: "{board-anchor}";
  readonly finding: AnchorFindingCode;
  readonly election?: string;
  readonly segment?: number;
}

/**
 * What a Tier 0 boundary did to one published group. The group ID is public
 * (the deployment record lists it), and the line names a step, never a
 * commitment or a record (T-10, T-13).
 */
export interface Tier0BoundaryLine {
  readonly queue: "{tier0-boundary}";
  readonly group: string;
  readonly outcome: Tier0GroupOutcome;
  readonly abandoned: boolean;
  readonly submitFailed?: boolean;
}

/**
 * A ballot boarded with its L1 reference unchecked (core's L1Check): the L1
 * node couldn't be read, or isn't on the chain the definition names. The
 * line names neither the ballot nor its election (T-10).
 */
export interface BallotL1Line {
  readonly queue: "{ballot-submit}";
  readonly finding: "l1-unchecked";
}

/**
 * What a registry sync found: the index or a log refused (`incomplete`,
 * `event-check`), the L2 node's answers refused under the output root
 * (`output-root`), a registration or definition the database refused, or a
 * registration recorded without its definition. Every value is public chain
 * data (T-10).
 */
export type RegistrySyncLine =
  | {
      readonly queue: "{registry-sync}";
      readonly finding: RegistrySyncErrorCode;
      readonly reason: RegistrySyncReason;
    }
  | {
      readonly queue: "{registry-sync}";
      readonly finding: "registration";
      readonly reason: RegistrationErrorCode;
    }
  | {
      readonly queue: "{registry-sync}";
      readonly finding: "definition";
      readonly reason: "conflict";
    }
  | {
      readonly queue: "{registry-sync}";
      readonly finding: "output-root";
      readonly reason: OutputRootErrorCode | "l2-block";
    }
  | {
      readonly queue: "{registry-sync}";
      readonly finding: "definition-unstored";
      readonly election: string;
      readonly reason: Exclude<DefinitionErrorCode, "conflict">;
    };

/**
 * What a creation-step run did, in counts only: no poll, author, nonce or
 * identifier (T-10, T-67). Written only when something moved or a send
 * failed, so an idle tick writes only its job line.
 */
export interface PollCreationLine {
  readonly queue: "{poll-create}";
  readonly sent: number;
  readonly resent: number;
  readonly sendFailed: number;
  readonly created: number;
  /** Identifiers the per-slot check proved clear. */
  readonly checked: number;
  /** Identifiers abandoned for an anchor ahead of their ceremony (T-69). */
  readonly abandoned: number;
  readonly failed: Partial<Record<CreationFailure, number>>;
  readonly ceilingReached: boolean;
}

/**
 * What a roots-step run did, in counts only (T-10, T-67), written only when
 * a poll moved; or why it refused the registry's history, every value
 * public: the index's records against the accumulator (`incomplete`), the
 * L2 node's answers under the output root (`output-root`), or a published
 * group's history the deployment's registry can't have logged (`groups`,
 * with the replay's code).
 */
export type PollRootLine =
  | {
      readonly queue: "{poll-root}";
      readonly rooted: number;
      readonly failed: Partial<Record<RootFailure, number>>;
    }
  | {
      readonly queue: "{poll-root}";
      readonly finding: "incomplete";
      readonly reason: EventAccumulatorProofError;
    }
  | {
      readonly queue: "{poll-root}";
      readonly finding: "output-root";
      readonly reason: OutputRootErrorCode | "l2-block";
    }
  | {
      readonly queue: "{poll-root}";
      readonly finding: "groups";
      readonly reason: TierMembershipErrorCode;
    };

/** A failure outside any job: the worker lost Redis, say. */
export interface WorkerErrorLine {
  readonly queue: QueueSpec["name"];
  readonly error: "worker";
}

export type ErrorKind =
  | "board-audit-findings"
  | "board-anchor-findings"
  | "invalid-job-data"
  | "stale-job"
  | "tier0-chain-unavailable"
  | "registry-sync-refused"
  | "poll-root-refused"
  | "internal";

export type LogLine =
  | JobLogLine
  | AuditFindingLine
  | AnchorFindingLine
  | Tier0BoundaryLine
  | BallotL1Line
  | RegistrySyncLine
  | PollCreationLine
  | PollRootLine
  | WorkerErrorLine;
export type Log = (line: LogLine) => void;
