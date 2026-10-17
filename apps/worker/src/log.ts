// The worker's log (T-10, T-11): one line per job, holding the queue, the
// outcome, the error's kind and the duration, never the job's data, its ID or
// an error message (messages can quote data). Findings are their own lines
// and carry only public board values.

import type { AnchorFindingCode, BoardAuditCode, Tier0GroupOutcome } from "@abolishus/core";
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

/** A failure outside any job: the worker lost Redis, say. */
export interface WorkerErrorLine {
  readonly queue: QueueSpec["name"];
  readonly error: "worker";
}

export type ErrorKind =
  | "board-audit-findings"
  | "board-anchor-findings"
  | "invalid-job-data"
  | "tier0-chain-unavailable"
  | "internal";

export type LogLine =
  | JobLogLine
  | AuditFindingLine
  | AnchorFindingLine
  | Tier0BoundaryLine
  | WorkerErrorLine;
export type Log = (line: LogLine) => void;
