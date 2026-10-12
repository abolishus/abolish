// The worker's log (T-10, T-11): one line per job, holding the queue, the
// outcome, the error's kind and the duration, never the job's data, its ID or
// an error message (messages can quote data). Findings are their own lines
// and carry only public board values.

import type { BoardAuditCode } from "@abolishus/core";
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

/** A failure outside any job: the worker lost Redis, say. */
export interface WorkerErrorLine {
  readonly queue: QueueSpec["name"];
  readonly error: "worker";
}

export type ErrorKind = "board-audit-findings" | "invalid-job-data" | "internal";

export type LogLine = JobLogLine | AuditFindingLine | WorkerErrorLine;
export type Log = (line: LogLine) => void;
