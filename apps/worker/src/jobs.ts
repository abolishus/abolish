// The job handlers. Each parses nothing itself (the worker has parsed the job
// data against its queue's schema) and calls core: transports stay thin.

import { auditBoard, BoardAuditError, listBoards } from "@abolishus/core";
import type { Sql } from "postgres";
import type { ErrorKind, Log } from "./log.ts";
import type { JobData, QueueKey } from "./queues.ts";

/** A job's failure, by kind: the only thing about it that is logged. */
export class JobError extends Error {
  override readonly name = "JobError";
  readonly kind: ErrorKind;
  constructor(kind: ErrorKind) {
    super(`job failed: ${kind}`);
    this.kind = kind;
  }
}

export interface JobContext {
  readonly sql: Sql;
  readonly log: Log;
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/**
 * Audits every board, one after another, so one bad board doesn't hide
 * another: each finding is logged, including a board whose audit failed for
 * another reason (a timeout, a lost connection), then the job fails if there
 * was any.
 */
async function boardAudit(ctx: JobContext, _data: JobData<"boardAudit">): Promise<void> {
  let findings = 0;
  for (const id of await listBoards(ctx.sql)) {
    try {
      await auditBoard(ctx.sql, id);
    } catch (e) {
      ctx.log(
        e instanceof BoardAuditError
          ? { queue: "{board-audit}", finding: e.code, election: hex(id), index: e.index }
          : { queue: "{board-audit}", finding: "audit-error", election: hex(id) },
      );
      findings++;
    }
  }
  if (findings > 0) throw new JobError("board-audit-findings");
}

export const HANDLERS: {
  readonly [K in QueueKey]: (ctx: JobContext, data: JobData<K>) => Promise<void>;
} = { boardAudit };
