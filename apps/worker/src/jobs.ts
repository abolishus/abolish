// The job handlers. Each parses nothing itself (the worker has parsed the job
// data against its queue's schema) and calls core: transports stay thin.

import {
  advancePollCreations,
  type AnchorCheckReport,
  CEREMONY_ROUND_SECONDS,
  checkCreationAnchors,
  closeCeremonyRounds,
  type CreationAnchors,
  type AnchorChain,
  anchorBoards,
  auditBoard,
  BoardAuditError,
  DefinitionError,
  GroupRecordsError,
  listBoards,
  openCeremonyRuns,
  type PollCreationChain,
  type PollStubDeployment,
  pruneIdentityBackups,
  RegistrationError,
  RegistrySyncError,
  stubPolls,
  type Tier0Batches,
  Tier0LockError,
} from "@abolishus/core";
import { TierMembershipError } from "@abolishus/crypto";
import { OutputRootError } from "@abolishus/verifier";
import type { Sql } from "postgres";
import type { BallotOutcome } from "./ballot-queue.ts";
import type { BallotBatches } from "./ballots.ts";
import type { ErrorKind, Log } from "./log.ts";
import { GameBlockError } from "./output-roots.ts";
import type { JobData, QueueKey } from "./queues.ts";
import type { PollRoots } from "./poll-roots.ts";
import type { RegistrySync } from "./registry-sync.ts";

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
  /** Ballot admission, when the worker pins panels; its queue runs only then. */
  readonly ballots?: BallotBatches;
  /** The registry sync, when the worker is configured for it; its queue runs only then. */
  readonly registry?: RegistrySync;
  /** The roots step, beside the registry sync; its queue runs only then. */
  readonly pollRoots?: PollRoots;
  /** The deployment every stub pins, beside the registry sync; its queue runs only then. */
  readonly pollStubs?: PollStubDeployment;
  /**
   * The creation key, its daily ceiling and the L1 anchor its identifiers
   * are checked against, in a creation worker; its queue runs only then.
   */
  readonly pollCreation?: {
    readonly chain: PollCreationChain;
    readonly dailyCeiling: number;
    readonly anchors: CreationAnchors;
  };
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
 * One anchoring run over every board, with the worker's clock as the bound
 * on the L1 node's. Each finding is logged; the job fails if any is an
 * election at risk of failing on its anchors, or a node to distrust. An
 * election naming another anchor is logged on every run but fails nothing,
 * so a job failing means something to act on.
 */
async function boardAnchor(ctx: JobContext, _data: JobData<"boardAnchor">): Promise<void> {
  if (ctx.anchor === undefined) throw new JobError("internal");
  const localNow = BigInt(Math.floor(ctx.now().getTime() / 1000));
  const { findings } = await anchorBoards(ctx.sql, ctx.anchor, localNow);
  for (const f of findings)
    ctx.log({
      queue: "{board-anchor}",
      finding: f.code,
      ...(f.electionId === undefined ? {} : { election: hex(f.electionId) }),
      ...(f.segment === undefined ? {} : { segment: f.segment }),
    });
  if (findings.some((f) => f.code !== "anchor-unserved"))
    throw new JobError("board-anchor-findings");
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

/**
 * Records the registry's proven registrations. A refusal (an L2 node whose
 * answers don't prove under the output root, an index the accumulator
 * doesn't vouch for, a log the event check refuses, a row the database
 * refuses) is logged as a finding and fails the job, and nothing
 * after the refused log is recorded until it is resolved; an unreachable
 * node or index fails it as `internal`. A registration recorded without its
 * definition is logged and fails nothing: the registry accepted it, and a
 * definition we can't store yet is a later version's or the verifier's to
 * refuse.
 */
async function registrySync(ctx: JobContext, _data: JobData<"registrySync">): Promise<void> {
  if (ctx.registry === undefined) throw new JobError("internal");
  const queue = "{registry-sync}";
  let report;
  try {
    report = await ctx.registry.run();
  } catch (e) {
    if (e instanceof RegistrySyncError) ctx.log({ queue, finding: e.code, reason: e.reason });
    else if (e instanceof RegistrationError)
      ctx.log({ queue, finding: "registration", reason: e.code });
    else if (e instanceof DefinitionError && e.code === "conflict")
      ctx.log({ queue, finding: "definition", reason: "conflict" });
    else if (e instanceof OutputRootError || e instanceof GameBlockError)
      ctx.log({ queue, finding: "output-root", reason: e.code });
    else throw e;
    throw new JobError("registry-sync-refused");
  }
  for (const u of report.unstored)
    ctx.log({ queue, finding: "definition-unstored", election: hex(u.electionId), reason: u.code });
}

/**
 * One run of the creation step: sends, resends and settles creations, then
 * runs the per-slot check on the created ones, and logs what moved, by
 * count. A node that can't be read fails the job; the next tick runs both
 * again from what is recorded.
 */
async function pollCreate(ctx: JobContext, _data: JobData<"pollCreate">): Promise<void> {
  if (ctx.pollCreation === undefined) throw new JobError("internal");
  const report = await advancePollCreations(ctx.sql, ctx.pollCreation.chain, {
    now: ctx.now(),
    dailyCeiling: ctx.pollCreation.dailyCeiling,
  });
  let anchors: AnchorCheckReport = { checked: 0, waiting: 0, abandoned: 0, overdue: 0, failed: 0 };
  try {
    anchors = await checkCreationAnchors(ctx.sql, ctx.pollCreation.anchors, { now: ctx.now() });
  } finally {
    // Logged even when the check throws, so this tick's creations are counted.
    const failed = { ...report.failed };
    if (anchors.failed > 0) failed["creation-anchored"] = anchors.failed;
    const moved =
      report.sent + report.resent + report.sendFailed + report.created > 0 ||
      anchors.checked + anchors.abandoned > 0 ||
      Object.keys(failed).length > 0 ||
      report.ceilingReached;
    if (moved)
      ctx.log({
        queue: "{poll-create}",
        ...report,
        checked: anchors.checked,
        abandoned: anchors.abandoned,
        failed,
      });
  }
}

/**
 * One run of the roots step, logging what moved, by count. A history it
 * refuses (an index the accumulator doesn't vouch for, an L2 node whose
 * answers don't prove under the output root, a published group the
 * deployment's registry can't have logged) is logged as a finding and fails
 * the job, failing no poll; an unreachable node or index fails it as
 * `internal`.
 */
async function pollRoot(ctx: JobContext, _data: JobData<"pollRoot">): Promise<void> {
  if (ctx.pollRoots === undefined) throw new JobError("internal");
  const queue = "{poll-root}";
  let report;
  try {
    report = await ctx.pollRoots.run(ctx.now());
  } catch (e) {
    if (e instanceof GroupRecordsError) ctx.log({ queue, finding: "incomplete", reason: e.code });
    else if (e instanceof OutputRootError || e instanceof GameBlockError)
      ctx.log({ queue, finding: "output-root", reason: e.code });
    else if (e instanceof TierMembershipError)
      ctx.log({ queue, finding: "groups", reason: e.code });
    else throw e;
    throw new JobError("poll-root-refused");
  }
  if (report.rooted > 0 || Object.keys(report.failed).length > 0) ctx.log({ queue, ...report });
}

/**
 * One run of the stub step, logging what moved, by count. A stub is built
 * from what the database holds and the deployment checked at startup, so
 * nothing here reads a chain; a poll whose stub breaks a rule fails alone.
 */
async function pollStub(ctx: JobContext, _data: JobData<"pollStub">): Promise<void> {
  if (ctx.pollStubs === undefined) throw new JobError("internal");
  const report = await stubPolls(ctx.sql, ctx.pollStubs, { now: ctx.now() });
  if (report.stubbed > 0 || Object.keys(report.failed).length > 0)
    ctx.log({ queue: "{poll-stub}", ...report });
}

/**
 * One run of the coordinator's half that no seat drives: opens a run for
 * each stubbed poll, then closes whatever round or approvals reached their
 * deadline, logging what moved, by count (T-10). Both are idempotent and
 * race the API's posts under each run's row lock, so a rerun or a second
 * worker changes nothing twice.
 */
async function ceremonyCoordinate(
  ctx: JobContext,
  _data: JobData<"ceremonyCoordinate">,
): Promise<void> {
  if (ctx.pollStubs === undefined) throw new JobError("internal");
  const now = ctx.now();
  const opened = await openCeremonyRuns(ctx.sql, ctx.pollStubs, { now });
  const closed = await closeCeremonyRounds(ctx.sql, ctx.pollStubs, {
    now,
    roundSeconds: CEREMONY_ROUND_SECONDS,
  });
  if (
    opened.opened + opened.mismatched + opened.expired + closed.closed > 0 ||
    Object.keys(closed.ended).length > 0
  )
    ctx.log({ queue: "{ceremony-coordinate}", ...opened, ...closed });
}

/**
 * Judges one ballot in the batch it joins, and returns its outcome: a
 * refusal is an outcome, not a failure, so the API can answer it. A job
 * fails only when the batch's database work does, and its fixed kind is all
 * the API learns.
 */
async function ballotSubmit(
  ctx: JobContext,
  data: JobData<"ballotSubmit">,
): Promise<BallotOutcome> {
  if (ctx.ballots === undefined) throw new JobError("internal");
  return ctx.ballots.submit(data.electionId, data.ballot);
}

/** What a job returns: nothing, but `{ballot-submit}`'s outcome. */
export type JobResult<K extends QueueKey> = K extends "ballotSubmit" ? BallotOutcome : void;

export const HANDLERS: {
  readonly [K in QueueKey]: (ctx: JobContext, data: JobData<K>) => Promise<JobResult<K>>;
} = {
  boardAudit,
  boardAnchor,
  identityBackupPrune,
  tier0Index,
  tier0Boundary,
  registrySync,
  pollCreate,
  pollRoot,
  pollStub,
  ceremonyCoordinate,
  ballotSubmit,
};
