// Moderation of creator profiles ([[0040-creator-profiles]], Moderation of
// names; [[P2-27]] part 1c; docs/moderation-policy.md, Profiles). A profile
// is reported, decided and appealed as a poll is, under the same grounds, by
// the same moderators, in the same log: `profile_moderation_actions` takes
// its numbers from the poll log's sequence and every decision here takes
// `lockModeration`, so the two tables commit in one order. The one removal is
// `hide`: our pages show the reason code instead of the profile's name and
// polls, and no poll says "Asked by" it, until a `restore` (T-75). A hide
// leaves the author's polls listed; their content is moderated as polls.
//
// T-10: the log, the reports and the moderators' queues name a profile by
// its public handle, never its account. Only the own-profile rule and the
// author's appeals read `account_profiles`, on the account side, and so does
// the notice each decision and rejected appeal queues for the author
// (src/account-notices.ts).

import { and, asc, desc, eq, gt, isNull, sql as q } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { queueNotice } from "./account-notices.ts";
import {
  AppealError,
  type AppealDecision,
  APPEAL_DECISIONS,
  type AppealOutcome,
  type PollAppeal,
} from "./appeals.ts";
import {
  accountProfileAppeals,
  accountProfiles,
  profileModerationActions,
  profileReports,
} from "./db/schema/index.ts";
import {
  HANDLE,
  lockModeration,
  MAX_MODERATION_PAGE,
  ModerationError,
  moderationLogOf,
  moderatorAccount,
  type ModerationTx,
  type PublicModerationEntry,
  REMOVAL_REASONS,
  type RemovalReason,
  RESTORE_REASONS,
  type RestoreReason,
} from "./moderation.ts";
import { type PublicRefilingEntry, refilingLogOf } from "./poll-tags.ts";
import { PROFILE_HANDLE } from "./profiles.ts";
import { MAX_REPORT_QUEUE } from "./reports.ts";

/** A decision about a profile: hiding it under a removal ground, or restoring it. */
export type ProfileModerationDecision =
  | { readonly action: "hide"; readonly reason: RemovalReason; readonly moderator: string }
  | { readonly action: "restore"; readonly reason: RestoreReason; readonly moderator: string };

/** What our pages do with a profile: show it, or show only the reason it is hidden. */
export type ProfileModerationState = "visible" | "hidden";

export interface ProfileModerationStatus {
  readonly state: ProfileModerationState;
  /** The newest decision, absent while the profile has never been moderated. */
  readonly latest?: {
    readonly seq: bigint;
    readonly action: ProfileModerationDecision["action"];
    readonly reason: RemovalReason | RestoreReason;
    readonly decidedAt: Date;
  };
}

const INT8_MAX = (1n << 63n) - 1n;

const isHandle = (h: unknown): h is string => typeof h === "string" && PROFILE_HANDLE.test(h);

function checkHandle(handle: unknown): asserts handle is string {
  if (!isHandle(handle)) throw new TypeError("not a profile handle");
}

const isRemovalReason = (reason: unknown): reason is RemovalReason =>
  (REMOVAL_REASONS as readonly unknown[]).includes(reason);

function wellFormed(d: ProfileModerationDecision): boolean {
  if (typeof d !== "object" || d === null) return false;
  const reasons: readonly string[] =
    d.action === "restore" ? RESTORE_REASONS : d.action === "hide" ? REMOVAL_REASONS : [];
  return reasons.includes(d.reason) && typeof d.moderator === "string" && HANDLE.test(d.moderator);
}

const stateAfter = (action: string): ProfileModerationState => {
  if (action === "hide") return "hidden";
  if (action === "restore") return "visible";
  // The table's check constraint admits only those two.
  throw new Error(`profile_moderation_actions holds an unknown action: ${action}`);
};

const transaction = <T>(client: Sql, run: (tx: ModerationTx) => Promise<T>) =>
  drizzle({ client }).transaction(
    async (tx) => {
      await lockModeration(tx);
      return run(tx);
    },
    // The newest decisions must be read after the lock is taken, as for polls.
    { isolationLevel: "read committed" },
  );

const clock = async (tx: ModerationTx) => {
  const [row] = await tx.execute<{ now: Date | string }>(q`SELECT clock_timestamp() AS now`);
  // SELECT without FROM yields exactly one row.
  return new Date(row!.now);
};

/** The account whose profile has `handle`, or `undefined` if no profile has it now. */
async function profileAccount(
  db: Pick<ModerationTx, "select">,
  handle: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ userId: accountProfiles.userId })
    .from(accountProfiles)
    .where(eq(accountProfiles.handle, handle));
  return row?.userId;
}

/**
 * The decisions about `handle` since its state last changed, newest first:
 * within such a run each removal reason appears once, so it has at most one
 * row per removal reason.
 */
async function currentRun(tx: Pick<ModerationTx, "select">, handle: string) {
  const t = profileModerationActions;
  const recent = await tx
    .select({ seq: t.seq, action: t.action, reason: t.reason, moderator: t.moderator })
    .from(t)
    .where(eq(t.handle, handle))
    .orderBy(desc(t.seq))
    .limit(REMOVAL_REASONS.length + 1);
  const state = recent[0] === undefined ? undefined : stateAfter(recent[0].action);
  const end = recent.findIndex((r) => stateAfter(r.action) !== state);
  return end === -1 ? recent : recent.slice(0, end);
}

/**
 * Records `decision` about the profile at `handle` and returns its log
 * sequence number and the profile's new state, as `moderate` does for a
 * poll. Refused, with nothing written: a malformed decision (`invalid`), a
 * restore citing `appeal-upheld` (`appeal-only`: only
 * `decideProfileAppeal` records one), a handle no profile has now
 * (`unknown-profile`: never made, or deleted and so retired), a handle that
 * isn't an active moderator's (`unknown-moderator`), a moderator deciding on
 * their own account's profile (`own-profile`), and a decision that changes
 * nothing (`no-change`: hiding a hidden profile again under a ground cited
 * since it was hidden, or restoring a visible one). Only this function
 * enforces those rules; the app role can insert rows directly (T-68).
 */
export async function moderateProfile(
  client: Sql,
  handle: string,
  decision: ProfileModerationDecision,
): Promise<{ readonly seq: bigint; readonly state: ProfileModerationState }> {
  checkHandle(handle);
  if (!wellFormed(decision)) throw new ModerationError("invalid");
  if (decision.reason === "appeal-upheld") throw new ModerationError("appeal-only");
  return transaction(client, (tx) => recordProfileDecision(tx, handle, decision));
}

/**
 * `moderateProfile`'s checks and write, for a well-formed decision, inside a
 * read-committed transaction that holds `lockModeration`.
 */
async function recordProfileDecision(
  tx: ModerationTx,
  handle: string,
  decision: ProfileModerationDecision,
): Promise<{ readonly seq: bigint; readonly state: ProfileModerationState }> {
  const { action, reason, moderator } = decision;
  const decidedAt = await clock(tx);
  const author = await profileAccount(tx, handle);
  if (author === undefined) throw new ModerationError("unknown-profile");
  const account = await moderatorAccount(tx, moderator);
  if (account === undefined) throw new ModerationError("unknown-moderator");
  if (account === author) throw new ModerationError("own-profile");
  const run = await currentRun(tx, handle);
  const before = run[0] === undefined ? "visible" : stateAfter(run[0].action);
  const state = stateAfter(action);
  // A hide may be re-cited under a ground not yet cited since the profile
  // was hidden, so the log can't fill with no-ops.
  if (state === before && (action === "restore" || run.some((r) => r.reason === reason)))
    throw new ModerationError("no-change");
  const [row] = await tx
    .insert(profileModerationActions)
    // The insert trigger draws `seq` from the poll log's sequence.
    .values({ seq: 0n, handle, action, reason, moderator, decidedAt })
    .returning({ seq: profileModerationActions.seq });
  await queueNotice(
    tx,
    author,
    decision.action === "restore"
      ? { subject: "profile", event: "restore", reason: decision.reason }
      : { subject: "profile", event: "hide", reason: decision.reason },
    decidedAt,
  );
  // INSERT … RETURNING yields exactly the one row inserted.
  return { seq: row!.seq, state };
}

/** The profile's current state at `handle`: its newest decision's, or `visible`. */
export async function profileModerationStatus(
  client: Sql,
  handle: string,
): Promise<ProfileModerationStatus> {
  checkHandle(handle);
  return profileStatusOf(drizzle({ client }), handle);
}

/** `profileModerationStatus` inside a transaction the caller holds. */
export async function profileStatusOf(
  db: Pick<ModerationTx, "select">,
  handle: string,
): Promise<ProfileModerationStatus> {
  const t = profileModerationActions;
  const [row] = await db
    .select({ seq: t.seq, action: t.action, reason: t.reason, decidedAt: t.decidedAt })
    .from(t)
    .where(eq(t.handle, handle))
    .orderBy(desc(t.seq))
    .limit(1);
  if (row === undefined) return { state: "visible" };
  return {
    state: stateAfter(row.action),
    latest: {
      seq: row.seq,
      action: row.action as ProfileModerationDecision["action"],
      reason: row.reason as RemovalReason | RestoreReason,
      decidedAt: row.decidedAt,
    },
  };
}

/** One profile decision as the public log shows it: everything but the moderator. */
export interface PublicProfileModerationEntry {
  readonly seq: bigint;
  readonly handle: string;
  readonly action: ProfileModerationDecision["action"];
  readonly reason: RemovalReason | RestoreReason;
  readonly decidedAt: Date;
}

/**
 * Up to `limit` profile decisions with a sequence number above `after`,
 * oldest first: the profiles' part of the public log. Its numbers come from
 * the same sequence as `readModerationLog`'s, so the two merge by `seq` into
 * one log in commit order. It never includes the moderator's handle.
 */
export async function readProfileModerationLog(
  client: Sql,
  after: bigint,
  limit: number,
): Promise<PublicProfileModerationEntry[]> {
  if (typeof after !== "bigint" || after < 0n) throw new TypeError("after must be a bigint ≥ 0");
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MODERATION_PAGE)
    throw new TypeError(`limit must be an integer from 1 to ${MAX_MODERATION_PAGE}`);
  return profileModerationLogOf(drizzle({ client }), after, limit);
}

/** `readProfileModerationLog` in a transaction the caller holds, with arguments it has checked. */
async function profileModerationLogOf(
  db: Pick<ModerationTx, "select">,
  after: bigint,
  limit: number,
): Promise<PublicProfileModerationEntry[]> {
  if (after >= INT8_MAX) return [];
  const t = profileModerationActions;
  const rows = await db
    .select({
      seq: t.seq,
      handle: t.handle,
      action: t.action,
      reason: t.reason,
      decidedAt: t.decidedAt,
    })
    .from(t)
    .where(gt(t.seq, after))
    .orderBy(asc(t.seq))
    .limit(limit);
  return rows.map((r) => ({
    seq: r.seq,
    handle: r.handle,
    action: r.action as ProfileModerationDecision["action"],
    reason: r.reason as RemovalReason | RestoreReason,
    decidedAt: r.decidedAt,
  }));
}

/**
 * One entry of the whole public log: a decision about a poll, a refiling of
 * one, or a decision about a profile.
 */
export type PublicLogEntry =
  | ({ readonly target: "poll" } & PublicModerationEntry)
  | ({ readonly target: "refiling" } & PublicRefilingEntry)
  | ({ readonly target: "profile" } & PublicProfileModerationEntry);

/**
 * Up to `limit` decisions about polls and profiles, and refilings, with a
 * sequence number above `after`, oldest first: the whole public log, as
 * `GET /moderation/log` serves it (docs/moderation-policy.md, Profiles and
 * Refiling). Its three tables are read from one snapshot, so a decision
 * committed between two reads can't land on this page while an
 * earlier-numbered one waits for the next, which `after` would then skip
 * (T-68). None names a moderator or an account, and no entry carries a
 * place's words (T-17).
 */
export async function readPublicModerationLog(
  client: Sql,
  after: bigint,
  limit: number,
): Promise<PublicLogEntry[]> {
  if (typeof after !== "bigint" || after < 0n) throw new TypeError("after must be a bigint ≥ 0");
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MODERATION_PAGE)
    throw new TypeError(`limit must be an integer from 1 to ${MAX_MODERATION_PAGE}`);
  const [polls, refilings, profiles] = await drizzle({ client }).transaction(
    async (tx) => [
      await moderationLogOf(tx, after, limit),
      await refilingLogOf(tx, after, limit),
      await profileModerationLogOf(tx, after, limit),
    ],
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
  const entries: PublicLogEntry[] = [
    ...polls.map((e) => ({ target: "poll" as const, ...e })),
    ...refilings.map((e) => ({ target: "refiling" as const, ...e })),
    ...profiles.map((e) => ({ target: "profile" as const, ...e })),
  ];
  // Every number comes from one sequence, so no two entries share one.
  return entries.sort((a, b) => (a.seq < b.seq ? -1 : 1)).slice(0, limit);
}

/**
 * Counts one report of the profile at `handle` under `reason`, as `report`
 * does for a poll: nothing about the reporter and no time but the hour a
 * pending run starts (T-10, T-11). Refused, with nothing written: a reason
 * outside `REMOVAL_REASONS` (`invalid`) and a handle no profile has now
 * (`unknown-profile`).
 */
export async function reportProfile(
  client: Sql,
  handle: string,
  reason: RemovalReason,
): Promise<void> {
  checkHandle(handle);
  if (!isRemovalReason(reason)) throw new ModerationError("invalid");
  const db = drizzle({ client });
  if ((await profileAccount(db, handle)) === undefined)
    throw new ModerationError("unknown-profile");
  const t = profileReports;
  const hour = q`date_trunc('hour', clock_timestamp(), 'UTC')`;
  await db
    .insert(t)
    .values({ handle, reason, total: 1n, pending: 1n, pendingSince: hour })
    .onConflictDoUpdate({
      target: [t.handle, t.reason],
      set: {
        total: q`${t.total} + 1`,
        pending: q`${t.pending} + 1`,
        // Kept while reports are pending, so reporting again never moves a
        // profile back in the queue (T-68).
        pendingSince: q`COALESCE(${t.pendingSince}, ${hour})`,
      },
    });
}

/** Reports of one profile under one ground, as the moderators' queue shows them. */
export interface PendingProfileReport {
  readonly handle: string;
  readonly reason: RemovalReason;
  readonly pending: bigint;
  /** Every report under this ground; pass it to `reviewProfileReports` once judged. */
  readonly total: bigint;
  /** The hour the oldest unreviewed report under this ground arrived. */
  readonly pendingSince: Date;
}

/** Where a page of the profiles' queue ended: its last row's position. */
export type ProfileReportQueueCursor = Pick<
  PendingProfileReport,
  "pendingSince" | "handle" | "reason"
>;

/**
 * Up to `limit` (profile, ground) pairs with unreviewed reports, the longest
 * waiting first, after `after` if given, as `readReportQueue` for polls. For
 * the moderators' tooling only: the API never serves it.
 */
export async function readProfileReportQueue(
  client: Sql,
  limit: number,
  after?: ProfileReportQueueCursor,
): Promise<PendingProfileReport[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_REPORT_QUEUE)
    throw new TypeError(`limit must be an integer from 1 to ${MAX_REPORT_QUEUE}`);
  if (after !== undefined) {
    checkHandle(after.handle);
    if (!(after.pendingSince instanceof Date) || Number.isNaN(after.pendingSince.getTime()))
      throw new TypeError("after.pendingSince must be a valid Date");
    if (!isRemovalReason(after.reason))
      throw new TypeError("after.reason must be a removal reason");
  }
  const t = profileReports;
  const rows = await drizzle({ client })
    .select()
    .from(t)
    .where(
      and(
        gt(t.pending, 0n),
        after === undefined
          ? undefined
          : q`(${t.pendingSince}, ${t.handle}, ${t.reason}) > (${after.pendingSince.toISOString()}::timestamptz, ${after.handle}, ${after.reason})`,
      ),
    )
    .orderBy(asc(t.pendingSince), asc(t.handle), asc(t.reason))
    .limit(limit);
  return rows.map((r) => {
    // The table's check constraint admits only the removal reasons.
    if (!isRemovalReason(r.reason)) throw new Error(`profile_reports holds ${r.reason}`);
    return {
      handle: r.handle,
      reason: r.reason,
      pending: r.pending,
      total: r.total,
      // The table's check constraint sets it whenever reports are pending.
      pendingSince: r.pendingSince!,
    };
  });
}

/**
 * Marks reviewed the first `seenTotal` reports of the profile at `handle`
 * under `reason`, as `reviewReports` does for a poll: a report counted after
 * the moderator read the queue stays pending. Returns how many stay pending.
 * Reviewing is not a decision.
 */
export async function reviewProfileReports(
  client: Sql,
  handle: string,
  reason: RemovalReason,
  seenTotal: bigint,
): Promise<bigint> {
  checkHandle(handle);
  if (!isRemovalReason(reason)) throw new ModerationError("invalid");
  if (typeof seenTotal !== "bigint" || seenTotal < 1n || seenTotal > INT8_MAX)
    throw new TypeError("seenTotal must be a bigint from 1 to 2^63 − 1");
  const t = profileReports;
  const left = q`LEAST(${t.pending}, ${t.total} - ${seenTotal}::bigint)`;
  const [row] = await drizzle({ client })
    .update(t)
    .set({
      pending: left,
      pendingSince: q`CASE WHEN ${left} = 0 THEN NULL ELSE ${t.pendingSince} END`,
    })
    .where(and(eq(t.handle, handle), eq(t.reason, reason), q`${t.total} >= ${seenTotal}::bigint`))
    .returning({ pending: t.pending });
  // No row: nothing reported under this ground, or fewer reports than seen.
  if (row === undefined) throw new ModerationError("invalid");
  return row.pending;
}

/** An account ID as `newAccountId` makes them. */
const isAccountId = (id: unknown): id is string =>
  typeof id === "string" && /^[a-z0-9]{32}$/.test(id);

const foreignKeyViolation = (e: unknown): boolean => {
  // Drizzle wraps the driver's error; the SQLSTATE is on it or its cause.
  const code = (x: unknown) => (x as { code?: unknown } | null)?.code;
  return code(e) === "23503" || code((e as { cause?: unknown } | null)?.cause) === "23503";
};

/**
 * Appeals the newest decision about `accountId`'s profile and returns that
 * decision's sequence number, which names the appeal, as `fileAppeal` does
 * for a poll. Refused, with nothing written: an account with no profile
 * (`not-found`, also when it is deleted while the appeal is filed), a
 * profile whose newest decision isn't a hide
 * (`not-appealable`) and a decision appealed before (`already-appealed`).
 */
export async function fileProfileAppeal(client: Sql, accountId: string): Promise<bigint> {
  if (!isAccountId(accountId)) throw new AppealError("invalid");
  return transaction(client, async (tx) => {
    const [profile] = await tx
      .select({ handle: accountProfiles.handle })
      .from(accountProfiles)
      .where(eq(accountProfiles.userId, accountId));
    if (profile === undefined) throw new AppealError("not-found");
    const { latest } = await profileStatusOf(tx, profile.handle);
    if (latest === undefined || latest.action !== "hide") throw new AppealError("not-appealable");
    const filed = await tx
      .insert(accountProfileAppeals)
      .values({ decisionSeq: latest.seq, handle: profile.handle, filedAt: await clock(tx) })
      .onConflictDoNothing()
      .returning({ seq: accountProfileAppeals.decisionSeq })
      .catch((e: unknown) => {
        // The profile was deleted since it was read: its appeals go with it.
        if (foreignKeyViolation(e)) throw new AppealError("not-found");
        throw e;
      });
    if (filed.length === 0) throw new AppealError("already-appealed");
    return latest.seq;
  });
}

/** One appeal as the profile's author sees it, as `PollAppeal`: never the reviewer. */
export type ProfileAppeal = PollAppeal;

/**
 * A profile's moderation as its author sees it: the state and newest
 * decision, and their appeals, never a moderator. `appealable` says whether
 * `fileProfileAppeal` would take the newest decision now.
 */
export interface ProfileModeration extends ProfileModerationStatus {
  readonly handle: string;
  readonly appeals: readonly ProfileAppeal[];
  readonly appealable: boolean;
}

/**
 * `accountId`'s profile's moderation, or `undefined` if it has no profile,
 * read in one snapshot so the state and the appeals agree.
 */
export async function readProfileModeration(
  client: Sql,
  accountId: string,
): Promise<ProfileModeration | undefined> {
  if (!isAccountId(accountId)) throw new AppealError("invalid");
  return drizzle({ client }).transaction(
    async (tx) => {
      const [profile] = await tx
        .select({ handle: accountProfiles.handle })
        .from(accountProfiles)
        .where(eq(accountProfiles.userId, accountId));
      if (profile === undefined) return undefined;
      const status = await profileStatusOf(tx, profile.handle);
      const a = accountProfileAppeals;
      const rows = await tx
        .select({
          decisionSeq: a.decisionSeq,
          filedAt: a.filedAt,
          outcome: a.outcome,
          reviewedAt: a.reviewedAt,
        })
        .from(a)
        .where(eq(a.handle, profile.handle))
        .orderBy(asc(a.decisionSeq));
      const appeals = rows.map((r) => ({
        decisionSeq: r.decisionSeq,
        filedAt: r.filedAt,
        // The migration's check admits only these.
        outcome: (r.outcome as AppealOutcome | null) ?? undefined,
        reviewedAt: r.reviewedAt ?? undefined,
      }));
      const latest = status.latest;
      return {
        handle: profile.handle,
        ...status,
        appeals,
        // `fileProfileAppeal`'s rule: the newest decision, a hide, not appealed before.
        appealable: latest?.action === "hide" && !appeals.some((x) => x.decisionSeq === latest.seq),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/** One open profile appeal as a moderator sees it: the decision, never the author. */
export interface OpenProfileAppeal {
  readonly decisionSeq: bigint;
  readonly handle: string;
  readonly reason: RemovalReason;
  readonly decidedAt: Date;
  readonly filedAt: Date;
}

/** The most appeals one page of the profiles' queue returns. */
export const MAX_PROFILE_APPEAL_QUEUE = 1000;

// The decision must be about the appeal's own profile: a log restored on its
// own could reuse a sequence number.
const sameProfile = and(
  eq(profileModerationActions.seq, accountProfileAppeals.decisionSeq),
  eq(profileModerationActions.handle, accountProfileAppeals.handle),
);

/**
 * Up to `limit` open profile appeals whose decision's sequence number is
 * above `after`, in that order. `decideProfileAppeal` says who may review each.
 */
export async function readProfileAppealQueue(
  client: Sql,
  limit: number,
  after = 0n,
): Promise<OpenProfileAppeal[]> {
  if (typeof after !== "bigint" || after < 0n) throw new AppealError("invalid");
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PROFILE_APPEAL_QUEUE)
    throw new AppealError("invalid");
  if (after >= INT8_MAX) return [];
  const a = accountProfileAppeals;
  const t = profileModerationActions;
  const rows = await drizzle({ client })
    .select({
      decisionSeq: a.decisionSeq,
      handle: a.handle,
      reason: t.reason,
      decidedAt: t.decidedAt,
      filedAt: a.filedAt,
    })
    .from(a)
    .innerJoin(t, sameProfile)
    .where(and(isNull(a.outcome), gt(a.decisionSeq, after)))
    .orderBy(asc(a.decisionSeq))
    .limit(limit);
  return rows.map((r) => ({
    decisionSeq: r.decisionSeq,
    handle: r.handle,
    // An appeal is filed only against a hide.
    reason: r.reason as RemovalReason,
    decidedAt: r.decidedAt,
    filedAt: r.filedAt,
  }));
}

export interface ProfileAppealReview {
  readonly outcome: AppealOutcome;
  /** The profile's state after the review. */
  readonly state: ProfileModerationState;
  /** The restore an upheld appeal recorded. */
  readonly restoreSeq?: bigint;
}

/**
 * Records `moderator`'s decision on the appeal against profile decision
 * `decisionSeq`, as `decideAppeal` does for a poll: upheld, a `restore`
 * citing `appeal-upheld`; rejected, nothing in the log; `superseded`
 * whatever the reviewer chose if the profile was restored since. Refused,
 * with nothing written: an unknown appeal (`not-found`), one already
 * reviewed (`reviewed`), a handle that isn't an active moderator's, a
 * moderator who made the appealed decision or re-cited the hide since
 * (`same-moderator`), and one whose account has the profile (`own-profile`).
 */
export async function decideProfileAppeal(
  client: Sql,
  decisionSeq: bigint,
  decision: AppealDecision,
  moderator: string,
): Promise<ProfileAppealReview> {
  if (
    typeof decisionSeq !== "bigint" ||
    decisionSeq < 1n ||
    decisionSeq > INT8_MAX ||
    !APPEAL_DECISIONS.includes(decision) ||
    typeof moderator !== "string" ||
    !HANDLE.test(moderator)
  )
    throw new AppealError("invalid");
  return transaction(client, async (tx) => {
    const a = accountProfileAppeals;
    const [appeal] = await tx
      .select({
        outcome: a.outcome,
        handle: a.handle,
        decidedBy: profileModerationActions.moderator,
        reason: profileModerationActions.reason,
      })
      .from(a)
      .innerJoin(profileModerationActions, sameProfile)
      .where(eq(a.decisionSeq, decisionSeq))
      .for("update", { of: a });
    if (appeal === undefined) throw new AppealError("not-found");
    if (appeal.outcome !== null) throw new AppealError("reviewed");
    const account = await moderatorAccount(tx, moderator);
    if (account === undefined) throw new AppealError("unknown-moderator");
    const run = await currentRun(tx, appeal.handle);
    const stands = run.some((r) => r.seq === decisionSeq);
    if (appeal.decidedBy === moderator || (stands && run.some((r) => r.moderator === moderator)))
      throw new AppealError("same-moderator");
    // The appeal's foreign key keeps its profile while it exists.
    const author = (await profileAccount(tx, appeal.handle))!;
    if (author === account) throw new AppealError("own-profile");
    // An appeal is filed against a decision, so its profile has one.
    const newest = run[0]!;
    let review: ProfileAppealReview;
    if (!stands) {
      review = { outcome: "superseded", state: stateAfter(newest.action) };
    } else if (decision === "upheld") {
      const { seq, state } = await recordProfileDecision(tx, appeal.handle, {
        action: "restore",
        reason: "appeal-upheld",
        moderator,
      });
      review = { outcome: "upheld", state, restoreSeq: seq };
    } else {
      review = { outcome: "rejected", state: stateAfter(newest.action) };
    }
    const reviewedAt = await clock(tx);
    if (review.outcome === "rejected")
      await queueNotice(
        tx,
        author,
        // An appeal is filed only against a hide (`fileProfileAppeal`).
        { subject: "profile", event: "appeal-rejected", reason: appeal.reason as RemovalReason },
        reviewedAt,
      );
    await tx
      .update(a)
      .set({ outcome: review.outcome, reviewer: moderator, reviewedAt })
      .where(eq(a.decisionSeq, decisionSeq));
    return review;
  });
}
