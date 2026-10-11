// Reports of polls to the moderators (docs/moderation-policy.md, Reports;
// T-68). Anyone can report a poll under a removal ground. A report is counted
// against its election and ground, and nothing else about it is kept: not the
// reporter's account, address or contact details, and no text (T-10, T-11,
// T-17). Counting rather than storing rows bounds the table at one row per
// election and ground however many anonymous reports arrive (T-52); report
// volume is never a ground, it only orders the moderators' queue.

import { and, asc, eq, gt, sql as q } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { isBytes } from "./bytes.ts";
import { moderationReports } from "./db/schema/index.ts";
import { hasDefinition } from "./definitions.ts";
import { ModerationError, type RemovalReason, REMOVAL_REASONS } from "./moderation.ts";

function checkElectionId(electionId: unknown): asserts electionId is Uint8Array {
  if (!isBytes(electionId) || electionId.length !== 32)
    throw new TypeError("electionId must be 32 bytes");
}

/** The largest Postgres `bigint`. */
const INT8_MAX = (1n << 63n) - 1n;

const isRemovalReason = (reason: unknown): reason is RemovalReason =>
  (REMOVAL_REASONS as readonly unknown[]).includes(reason);

/**
 * Counts one report of `electionId`'s poll under `reason`. Refused, with
 * nothing written: a reason outside `REMOVAL_REASONS` (`invalid`) and an
 * election with no stored definition (`unknown-election`). No time is kept
 * for the report itself: a report that starts a pending run sets
 * `pending_since` to the hour, by the database clock, and later ones change
 * only the counts (T-11).
 */
export async function report(
  client: Sql,
  electionId: Uint8Array,
  reason: RemovalReason,
): Promise<void> {
  checkElectionId(electionId);
  if (!isRemovalReason(reason)) throw new ModerationError("invalid");
  const id = new Uint8Array(electionId);
  if (!(await hasDefinition(client, id))) throw new ModerationError("unknown-election");
  const hour = q`date_trunc('hour', clock_timestamp(), 'UTC')`;
  await drizzle({ client })
    .insert(moderationReports)
    .values({ electionId: id, reason, total: 1n, pending: 1n, pendingSince: hour })
    .onConflictDoUpdate({
      target: [moderationReports.electionId, moderationReports.reason],
      set: {
        total: q`${moderationReports.total} + 1`,
        pending: q`${moderationReports.pending} + 1`,
        // Kept while reports are pending, so reporting a poll again never
        // moves it back in the queue (T-68).
        pendingSince: q`COALESCE(${moderationReports.pendingSince}, ${hour})`,
      },
    });
}

/** Reports of one poll under one ground, as the moderators' queue shows them. */
export interface PendingReport {
  readonly electionId: Uint8Array;
  readonly reason: RemovalReason;
  /** Reports under this ground no moderator has reviewed. */
  readonly pending: bigint;
  /** Every report under this ground; pass it to `reviewReports` once judged. */
  readonly total: bigint;
  /** The hour the oldest unreviewed report under this ground arrived. */
  readonly pendingSince: Date;
}

/** Where a page of the queue ended: its last row's position. */
export type ReportQueueCursor = Pick<PendingReport, "pendingSince" | "electionId" | "reason">;

/** The most rows one read of the report queue returns. */
export const MAX_REPORT_QUEUE = 1000;

/**
 * Up to `limit` (election, ground) pairs with unreviewed reports, the longest
 * waiting first, after `after` (the last row of the previous page) if given,
 * so a flood of reports can't hide the rest of the queue behind one page
 * (T-52). For the moderators' tooling only: the API never serves it, so
 * nobody else learns what was reported.
 */
export async function readReportQueue(
  client: Sql,
  limit: number,
  after?: ReportQueueCursor,
): Promise<PendingReport[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_REPORT_QUEUE)
    throw new TypeError(`limit must be an integer from 1 to ${MAX_REPORT_QUEUE}`);
  if (after !== undefined) {
    checkElectionId(after.electionId);
    if (!(after.pendingSince instanceof Date) || Number.isNaN(after.pendingSince.getTime()))
      throw new TypeError("after.pendingSince must be a valid Date");
    if (!isRemovalReason(after.reason))
      throw new TypeError("after.reason must be a removal reason");
  }
  const t = moderationReports;
  const rows = await drizzle({ client })
    .select()
    .from(t)
    .where(
      and(
        gt(t.pending, 0n),
        after === undefined
          ? undefined
          : q`(${t.pendingSince}, ${t.electionId}, ${t.reason}) > (${after.pendingSince.toISOString()}::timestamptz, ${new Uint8Array(after.electionId)}, ${after.reason})`,
      ),
    )
    .orderBy(
      asc(moderationReports.pendingSince),
      asc(moderationReports.electionId),
      asc(moderationReports.reason),
    )
    .limit(limit);
  return rows.map((r) => {
    // The table's check constraint admits only the removal reasons.
    if (!isRemovalReason(r.reason)) throw new Error(`moderation_reports holds ${r.reason}`);
    return {
      electionId: new Uint8Array(r.electionId),
      reason: r.reason,
      pending: r.pending,
      total: r.total,
      // The table's check constraint sets it whenever reports are pending.
      pendingSince: r.pendingSince!,
    };
  });
}

/**
 * Marks reviewed the reports of `electionId`'s poll under `reason` that a
 * moderator has seen: the first `seenTotal`, as `readReportQueue` gave its
 * `total`. A report counted after the moderator read the queue stays pending,
 * so reviewing never clears one nobody saw. Returns how many stay pending.
 * Reviewing is not a decision: the moderator records any action with
 * `moderate`, and reviewing without one leaves the poll as it is.
 */
export async function reviewReports(
  client: Sql,
  electionId: Uint8Array,
  reason: RemovalReason,
  seenTotal: bigint,
): Promise<bigint> {
  checkElectionId(electionId);
  if (!isRemovalReason(reason)) throw new ModerationError("invalid");
  if (typeof seenTotal !== "bigint" || seenTotal < 1n || seenTotal > INT8_MAX)
    throw new TypeError("seenTotal must be a bigint from 1 to 2^63 − 1");
  const [row] = await drizzle({ client })
    .update(moderationReports)
    .set({
      pending: q`LEAST(${moderationReports.pending}, ${moderationReports.total} - ${seenTotal}::bigint)`,
      pendingSince: q`CASE WHEN LEAST(${moderationReports.pending}, ${moderationReports.total} - ${seenTotal}::bigint) = 0 THEN NULL ELSE ${moderationReports.pendingSince} END`,
    })
    .where(
      and(
        eq(moderationReports.electionId, new Uint8Array(electionId)),
        eq(moderationReports.reason, reason),
        q`${moderationReports.total} >= ${seenTotal}::bigint`,
      ),
    )
    .returning({ pending: moderationReports.pending });
  // No row: nothing was reported under this ground, or fewer reports than the
  // moderator claims to have seen, which a queue read never gives.
  if (row === undefined) throw new ModerationError("invalid");
  return row.pending;
}
