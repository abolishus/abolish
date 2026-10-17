// Moderators' accounts and creators' appeals (docs/moderation-policy.md,
// Appeals and Moderators; P2-10 part 3b; T-68). A poll's creator can appeal
// each decision against their poll once; a moderator other than the one who
// decided, and other than the creator, reviews it. An upheld appeal is a
// `restore` citing `appeal-upheld` in the public log, recorded only here; a
// rejected one leaves the poll and the log as they are.
//
// T-10: `account_moderators` and `account_appeals` are account tables. The
// moderation queue and the operator's commands get an appeal's election and
// the decision it contests, never the creator's account.

import { and, asc, desc, eq, gt, isNull, sql as q } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import {
  accountAppeals,
  accountModerators,
  accountPolls,
  accountUsers,
  moderationActions,
} from "./db/schema/index.ts";
import {
  createdBy,
  HANDLE,
  lockModeration,
  type ModerationDecision,
  moderatorAccount,
  type ModerationState,
  type ModerationTx,
  recordDecision,
  type RemovalReason,
  stateAfter,
} from "./moderation.ts";

/** What a reviewer decides. */
export const APPEAL_DECISIONS = ["upheld", "rejected"] as const;
export type AppealDecision = (typeof APPEAL_DECISIONS)[number];
/**
 * An appeal's outcome: the reviewer's, or `superseded` when a later decision
 * changed the poll before the review, so the creator appeals that one.
 */
export type AppealOutcome = AppealDecision | "superseded";

export type AppealErrorCode =
  /** A malformed handle, account ID, decision or position. */
  | "invalid"
  /** `addModerator`: no account has this ID. */
  | "unknown-account"
  /** `addModerator`: the handle was used before; handles are never rebound. */
  | "handle-taken"
  /** `addModerator`: the account already has a handle. */
  | "already-moderator"
  /** The handle isn't an active moderator's. */
  | "unknown-moderator"
  /** No such poll of this account, or no such appeal. */
  | "not-found"
  /** The poll's newest decision isn't a removal, or it has none. */
  | "not-appealable"
  /** The decision was appealed before. */
  | "already-appealed"
  /** The appeal's outcome is recorded. */
  | "reviewed"
  /** The reviewer made the appealed decision. */
  | "same-moderator"
  /** The reviewer's account created the poll. */
  | "own-poll";

export class AppealError extends Error {
  override readonly name = "AppealError";
  readonly code: AppealErrorCode;
  constructor(code: AppealErrorCode) {
    super(`appeal refused: ${code}`);
    this.code = code;
  }
}

const INT8_MAX = (1n << 63n) - 1n;

/** An account's or a poll's ID, as `newAccountId` makes them. */
const isAccountId = (id: unknown): id is string =>
  typeof id === "string" && /^[a-z0-9]{32}$/.test(id);

const handleOk = (h: unknown): h is string => typeof h === "string" && HANDLE.test(h);

const transaction = <T>(client: Sql, run: (tx: ModerationTx) => Promise<T>) =>
  drizzle({ client }).transaction(
    async (tx) => {
      // Appeals are judged against the newest decision, so they take the
      // moderation lock and read after it, as decisions do.
      await lockModeration(tx);
      return run(tx);
    },
    { isolationLevel: "read committed" },
  );

const clock = async (tx: ModerationTx) => {
  const [row] = await tx.execute<{ now: Date | string }>(q`SELECT clock_timestamp() AS now`);
  // SELECT without FROM yields exactly one row.
  return new Date(row!.now);
};

/**
 * Makes `handle` the moderator handle of `accountId`. A handle names one
 * account for good: one retired, or whose account was deleted, is never
 * given to another, so a handle in the log always meant the same person.
 */
export async function addModerator(client: Sql, handle: string, accountId: string): Promise<void> {
  if (!handleOk(handle) || !isAccountId(accountId)) throw new AppealError("invalid");
  await transaction(client, async (tx) => {
    const [user] = await tx
      .select({ id: accountUsers.id })
      .from(accountUsers)
      .where(eq(accountUsers.id, accountId));
    if (user === undefined) throw new AppealError("unknown-account");
    const [taken] = await tx
      .select({ handle: accountModerators.handle, userId: accountModerators.userId })
      .from(accountModerators)
      .where(
        q`${accountModerators.handle} = ${handle} OR ${accountModerators.userId} = ${accountId}`,
      );
    if (taken?.handle === handle) throw new AppealError("handle-taken");
    if (taken !== undefined) throw new AppealError("already-moderator");
    await tx
      .insert(accountModerators)
      .values({ handle, userId: accountId, addedAt: await clock(tx) });
  });
}

/** Retires `handle`: it decides nothing more and is never given again. */
export async function retireModerator(client: Sql, handle: string): Promise<void> {
  if (!handleOk(handle)) throw new AppealError("invalid");
  const retired = await drizzle({ client })
    .update(accountModerators)
    .set({ userId: null })
    .where(and(eq(accountModerators.handle, handle), q`${accountModerators.userId} IS NOT NULL`))
    .returning({ handle: accountModerators.handle });
  if (retired.length === 0) throw new AppealError("unknown-moderator");
}

/** The newest decision about `electionId`, if any. */
async function newestDecision(tx: ModerationTx, electionId: Uint8Array) {
  const [row] = await tx
    .select({
      seq: moderationActions.seq,
      action: moderationActions.action,
      moderator: moderationActions.moderator,
    })
    .from(moderationActions)
    .where(eq(moderationActions.electionId, electionId))
    .orderBy(desc(moderationActions.seq))
    .limit(1);
  return row;
}

/**
 * Appeals the newest decision about `accountId`'s poll `pollId` and returns
 * that decision's sequence number, which names the appeal. Refused, with
 * nothing written: a poll the account doesn't have (`not-found`), one whose
 * newest decision isn't a removal (`not-appealable`: there is nothing to
 * restore, and an older decision was superseded by it) and a decision
 * appealed before (`already-appealed`).
 */
export async function fileAppeal(client: Sql, accountId: string, pollId: string): Promise<bigint> {
  if (!isAccountId(accountId) || !isAccountId(pollId)) throw new AppealError("invalid");
  return transaction(client, async (tx) => {
    const [poll] = await tx
      .select({ electionId: accountPolls.electionId })
      .from(accountPolls)
      .where(and(eq(accountPolls.id, pollId), eq(accountPolls.userId, accountId)));
    if (poll === undefined) throw new AppealError("not-found");
    const newest = poll.electionId === null ? undefined : await newestDecision(tx, poll.electionId);
    if (newest === undefined || newest.action === "restore")
      throw new AppealError("not-appealable");
    const filed = await tx
      .insert(accountAppeals)
      .values({ decisionSeq: newest.seq, pollId, filedAt: await clock(tx) })
      .onConflictDoNothing()
      .returning({ seq: accountAppeals.decisionSeq });
    if (filed.length === 0) throw new AppealError("already-appealed");
    return newest.seq;
  });
}

/** One appeal as its poll's creator sees it: never the reviewer. */
export interface PollAppeal {
  readonly decisionSeq: bigint;
  readonly filedAt: Date;
  readonly outcome: AppealOutcome | undefined;
  readonly reviewedAt: Date | undefined;
}

/** The appeals against `accountId`'s poll `pollId`, oldest decision first. */
export async function listPollAppeals(
  client: Sql,
  accountId: string,
  pollId: string,
): Promise<PollAppeal[]> {
  if (!isAccountId(accountId) || !isAccountId(pollId)) throw new AppealError("invalid");
  const rows = await drizzle({ client })
    .select({
      decisionSeq: accountAppeals.decisionSeq,
      filedAt: accountAppeals.filedAt,
      outcome: accountAppeals.outcome,
      reviewedAt: accountAppeals.reviewedAt,
    })
    .from(accountAppeals)
    .innerJoin(accountPolls, eq(accountPolls.id, accountAppeals.pollId))
    .where(and(eq(accountAppeals.pollId, pollId), eq(accountPolls.userId, accountId)))
    .orderBy(asc(accountAppeals.decisionSeq));
  return rows.map((r) => ({
    decisionSeq: r.decisionSeq,
    filedAt: r.filedAt,
    // The migration's check admits only these.
    outcome: (r.outcome as AppealOutcome | null) ?? undefined,
    reviewedAt: r.reviewedAt ?? undefined,
  }));
}

/** One open appeal as a moderator sees it: the decision, never the creator. */
export interface OpenAppeal {
  readonly decisionSeq: bigint;
  readonly electionId: Uint8Array;
  readonly action: "delist" | "hide";
  readonly reason: RemovalReason;
  readonly decidedAt: Date;
  readonly filedAt: Date;
}

/** The most appeals one page of the queue returns. */
export const MAX_APPEAL_QUEUE = 1000;

/**
 * Up to `limit` open appeals whose decision's sequence number is above
 * `after`, in that order. A moderator reviews only those they didn't decide
 * and whose poll their account didn't create; `decideAppeal` enforces it.
 */
export async function readAppealQueue(
  client: Sql,
  limit: number,
  after = 0n,
): Promise<OpenAppeal[]> {
  if (typeof after !== "bigint" || after < 0n) throw new AppealError("invalid");
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_APPEAL_QUEUE)
    throw new AppealError("invalid");
  if (after >= INT8_MAX) return [];
  const rows = await drizzle({ client })
    .select({
      decisionSeq: accountAppeals.decisionSeq,
      electionId: moderationActions.electionId,
      action: moderationActions.action,
      reason: moderationActions.reason,
      decidedAt: moderationActions.decidedAt,
      filedAt: accountAppeals.filedAt,
    })
    .from(accountAppeals)
    .innerJoin(moderationActions, eq(moderationActions.seq, accountAppeals.decisionSeq))
    .where(and(isNull(accountAppeals.outcome), gt(accountAppeals.decisionSeq, after)))
    .orderBy(asc(accountAppeals.decisionSeq))
    .limit(limit);
  return rows.map((r) => ({
    decisionSeq: r.decisionSeq,
    electionId: new Uint8Array(r.electionId),
    // An appeal is filed only against a removal.
    action: r.action as OpenAppeal["action"],
    reason: r.reason as RemovalReason,
    decidedAt: r.decidedAt,
    filedAt: r.filedAt,
  }));
}

export interface AppealReview {
  readonly outcome: AppealOutcome;
  /** The poll's state after the review. */
  readonly state: ModerationState;
  /** The restore an upheld appeal recorded. */
  readonly restoreSeq?: bigint;
}

/**
 * Records `moderator`'s decision on the appeal against decision
 * `decisionSeq`. Upheld, it records a `restore` citing `appeal-upheld`
 * (with every check `moderate` makes); rejected, it changes nothing in the
 * log. If a later decision changed the poll since the appeal was filed, the
 * appeal is closed as `superseded` whatever the reviewer chose, since the
 * decision it contests no longer stands; the creator can appeal the newer
 * one. Refused, with nothing written: an unknown appeal (`not-found`), one
 * already reviewed (`reviewed`), a handle that isn't an active moderator's,
 * the moderator who made the decision (`same-moderator`) and a moderator
 * whose account created the poll (`own-poll`).
 */
export async function decideAppeal(
  client: Sql,
  decisionSeq: bigint,
  decision: AppealDecision,
  moderator: string,
): Promise<AppealReview> {
  if (
    typeof decisionSeq !== "bigint" ||
    decisionSeq < 1n ||
    decisionSeq > INT8_MAX ||
    !APPEAL_DECISIONS.includes(decision) ||
    !handleOk(moderator)
  )
    throw new AppealError("invalid");
  return transaction(client, async (tx) => {
    const [appeal] = await tx
      .select({
        outcome: accountAppeals.outcome,
        electionId: moderationActions.electionId,
        decidedBy: moderationActions.moderator,
      })
      .from(accountAppeals)
      .innerJoin(moderationActions, eq(moderationActions.seq, accountAppeals.decisionSeq))
      .where(eq(accountAppeals.decisionSeq, decisionSeq))
      .for("update", { of: accountAppeals });
    if (appeal === undefined) throw new AppealError("not-found");
    if (appeal.outcome !== null) throw new AppealError("reviewed");
    const account = await moderatorAccount(tx, moderator);
    if (account === undefined) throw new AppealError("unknown-moderator");
    if (appeal.decidedBy === moderator) throw new AppealError("same-moderator");
    const electionId = new Uint8Array(appeal.electionId);
    if (await createdBy(tx, electionId, account)) throw new AppealError("own-poll");
    // An appeal is filed against a decision, so its poll has one.
    const newest = (await newestDecision(tx, electionId))!;
    let review: AppealReview;
    if (newest.seq !== decisionSeq) {
      review = { outcome: "superseded", state: stateAfter(newest.action) };
    } else if (decision === "upheld") {
      const restore: ModerationDecision = { action: "restore", reason: "appeal-upheld", moderator };
      const { seq, state } = await recordDecision(tx, electionId, restore);
      review = { outcome: "upheld", state, restoreSeq: seq };
    } else {
      review = { outcome: "rejected", state: stateAfter(newest.action) };
    }
    await tx
      .update(accountAppeals)
      .set({ outcome: review.outcome, reviewer: moderator, reviewedAt: await clock(tx) })
      .where(eq(accountAppeals.decisionSeq, decisionSeq));
    return review;
  });
}
