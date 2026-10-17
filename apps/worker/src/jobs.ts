// The job handlers. Each parses nothing itself (the worker has parsed the job
// data against its queue's schema) and calls core: transports stay thin.

import {
  type AnchorChain,
  anchorBoards,
  auditBoard,
  BoardAuditError,
  listBoards,
  pruneIdentityBackups,
  type Tier0Batches,
  Tier0LockError,
} from "@abolishus/core";
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
  /** The clock expiry is judged by; injected so tests can move it. */
  readonly now: () => Date;
  /** The L1 anchor the anchoring job sends through; its queue runs only with one. */
  readonly anchor?: AnchorChain;
  /** The Tier 0 batch job, when the worker is configured for it; its queues run only then. */
  readonly tier0?: Tier0Batches;
}

/** The Tier 0 queues, which run only with `JobContext.tier0`. */
export const TIER0_QUEUES = ["tier0Index", "tier0Boundary"] as const satisfies readonly QueueKey[];

function tier0Of(ctx: JobContext): Tier0Batches {
  if (ctx.tier0 === undefined) throw new JobError("internal");
  return ctx.tier0;
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

/**
 * One anchoring run over every board. Each finding is logged; the job fails
 * if there was any, since each one is an election at risk of failing on its
 * anchors (or one this worker can't anchor).
 */
async function boardAnchor(ctx: JobContext, _data: JobData<"boardAnchor">): Promise<void> {
  if (ctx.anchor === undefined) throw new JobError("internal");
  const { findings } = await anchorBoards(ctx.sql, ctx.anchor);
  for (const f of findings)
    ctx.log({
      queue: "{board-anchor}",
      finding: f.code,
      election: hex(f.electionId),
      ...(f.segment === undefined ? {} : { segment: f.segment }),
    });
  if (findings.length > 0) throw new JobError("board-anchor-findings");
}

/**
 * Deletes every identity backup past its retention, judged by the UTC month
 * of `now`. Daily runs remove a month's expired rows within a day of the
 * month turning (T-52, T-66).
 */
async function identityBackupPrune(
  ctx: JobContext,
  _data: JobData<"identityBackupPrune">,
): Promise<void> {
  await pruneIdentityBackups(ctx.sql, ctx.now());
}

/**
 * Brings the Tier 0 index up to the L2 node. A boundary or another refresh
 * holding the lock is left to it: the next tick refreshes again.
 */
async function tier0Index(ctx: JobContext, _data: JobData<"tier0Index">): Promise<void> {
  try {
    if (!(await tier0Of(ctx).refreshIndex())) throw new JobError("tier0-chain-unavailable");
  } catch (e) {
    if (!(e instanceof Tier0LockError)) throw e;
  }
}

/**
 * Runs the current period's boundary if it hasn't run, and logs what it did
 * to each group. A lock held by an index refresh is retried at the next
 * tick, still within the period.
 */
async function tier0Boundary(ctx: JobContext, _data: JobData<"tier0Boundary">): Promise<void> {
  let reports;
  try {
    reports = await tier0Of(ctx).runBoundary();
  } catch (e) {
    if (e instanceof Tier0LockError) return;
    throw e;
  }
  for (const r of reports ?? [])
    ctx.log({
      queue: "{tier0-boundary}",
      group: r.groupId.toString(),
      outcome: r.outcome,
      abandoned: r.abandoned,
      ...(r.submitFailed === undefined ? {} : { submitFailed: r.submitFailed }),
    });
}

export const HANDLERS: {
  readonly [K in QueueKey]: (ctx: JobContext, data: JobData<K>) => Promise<void>;
} = { boardAudit, boardAnchor, identityBackupPrune, tier0Index, tier0Boundary };
