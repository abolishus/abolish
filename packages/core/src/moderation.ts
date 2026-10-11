// The moderation log (docs/moderation-policy.md; T-68). Moderation decides
// what our front ends show of a poll: whether it is listed in discovery and
// search, and whether its display text is shown. It never touches a result:
// this module reads and writes `moderation_actions` alone, and nothing that
// builds or checks a result reads that table. A result stays verifiable from
// chain + IPFS whatever is decided here (G-9), and hiding a poll's text
// leaves its counts published, by option index.

import { decodeElectionDefinition } from "@abolishus/crypto";
import { asc, desc, eq, gt, sql as q } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { isBytes } from "./bytes.ts";
import { electionDefinitions, moderationActions } from "./db/schema/index.ts";

/** Grounds for delisting or hiding (docs/moderation-policy.md, Reasons). */
export const REMOVAL_REASONS = [
  "illegal",
  "personal-data",
  "threat",
  "harassment",
  "spam",
  "impersonation",
  "legal-notice",
] as const;
/**
 * The only grounds for hiding a poll's text before it closes
 * (docs/moderation-policy.md, Actions). Hiding stops voting through our
 * ballot client, which won't show text it can't check, so for any other
 * ground an open poll is delisted instead (T-68).
 */
export const OPEN_POLL_HIDE_REASONS = ["illegal", "personal-data", "threat"] as const;
/** Grounds for restoring (docs/moderation-policy.md, Appeals and errors). */
export const RESTORE_REASONS = ["appeal-upheld", "error", "notice-withdrawn"] as const;

export type RemovalReason = (typeof REMOVAL_REASONS)[number];
export type RestoreReason = (typeof RESTORE_REASONS)[number];

/**
 * A decision: one action with a reason of its kind, by a moderator. Its time
 * is the database's clock when it is recorded, never the caller's: a
 * caller-chosen time could date a hide past a poll's close (T-68).
 */
export type ModerationDecision =
  | {
      readonly action: "delist" | "hide";
      readonly reason: RemovalReason;
      readonly moderator: string;
    }
  | {
      readonly action: "restore";
      readonly reason: RestoreReason;
      readonly moderator: string;
    };

/**
 * What our front ends do with a poll: `visible` (listed, text shown),
 * `delisted` (off discovery and search, text shown to anyone with the link)
 * or `hidden` (off discovery and search, text withheld; the result is still
 * shown, by option index).
 */
export type ModerationState = "visible" | "delisted" | "hidden";

const STATE_AFTER = { delist: "delisted", hide: "hidden", restore: "visible" } as const;

export type ModerationErrorCode =
  /** The decision is malformed: an unknown action, a reason of the wrong kind, a bad handle or time. */
  | "invalid"
  /** No definition is stored for the election, so there is no poll to moderate. */
  | "unknown-election"
  /** Hiding a poll that hasn't closed, for a reason outside `OPEN_POLL_HIDE_REASONS`. */
  | "open-poll"
  /**
   * The poll is already in the state the action leads to, and the reason was
   * already cited since that state began (a removal may be re-cited under a
   * new ground; a restore never repeats).
   */
  | "no-change";

export class ModerationError extends Error {
  override readonly name = "ModerationError";
  readonly code: ModerationErrorCode;
  constructor(code: ModerationErrorCode) {
    super(`moderation refused: ${code}`);
    this.code = code;
  }
}

/**
 * A moderator handle: 1 to 32 lowercase letters, digits and inner hyphens.
 * It names a moderator to the operator, not an account to the database (no
 * foreign key leaves the account tables, T-10), and the public log omits it.
 */
const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
/**
 * The two-key advisory lock every decision takes (a separate keyspace from
 * the board's lock class and from migrations' one-key locks). One lock for
 * all elections: decisions are rare, and serialising them all makes the log's
 * sequence numbers commit in order, so a reader paging by sequence number
 * never passes a decision that commits later with a smaller one.
 */
const MODERATION_LOCK = [0x0b0a4e, 0] as const;

function checkElectionId(electionId: unknown): asserts electionId is Uint8Array {
  if (!isBytes(electionId) || electionId.length !== 32)
    throw new TypeError("electionId must be 32 bytes");
}

function wellFormed(d: ModerationDecision): boolean {
  if (typeof d !== "object" || d === null) return false;
  const reasons: readonly string[] =
    d.action === "restore"
      ? RESTORE_REASONS
      : d.action === "delist" || d.action === "hide"
        ? REMOVAL_REASONS
        : [];
  return reasons.includes(d.reason) && typeof d.moderator === "string" && HANDLE.test(d.moderator);
}

export interface ModerationStatus {
  readonly state: ModerationState;
  /** The newest decision, absent while the poll has never been moderated. */
  readonly latest?: {
    readonly seq: bigint;
    readonly action: ModerationDecision["action"];
    readonly reason: RemovalReason | RestoreReason;
    readonly decidedAt: Date;
  };
}

/**
 * Records `decision` about `electionId`'s poll and returns its log sequence
 * number and the poll's new state. Decisions are serialised by a
 * transaction-scoped advisory lock, so each one is judged against the state
 * it changes and sequence numbers commit in order. Each is dated by the
 * database clock. Refused, with nothing written: a malformed decision, an
 * election with no stored definition, hiding a poll that hasn't closed for a
 * reason outside `OPEN_POLL_HIDE_REASONS`, and an action that changes nothing
 * (a log of no-ops would bury the decisions that matter). Only this function
 * enforces those rules: the app role can insert rows directly, bypassing them,
 * so they hold for the tooling, not against an insider (T-68).
 */
export async function moderate(
  client: Sql,
  electionId: Uint8Array,
  decision: ModerationDecision,
): Promise<{ readonly seq: bigint; readonly state: ModerationState }> {
  checkElectionId(electionId);
  if (!wellFormed(decision)) throw new ModerationError("invalid");
  const id = new Uint8Array(electionId);
  const { action, reason, moderator } = decision;
  return drizzle({ client }).transaction(
    async (tx) => {
      await tx.execute(
        q`SELECT pg_advisory_xact_lock(${MODERATION_LOCK[0]}::int, ${MODERATION_LOCK[1]}::int)`,
      );
      // The decision's time: the database clock, read after the lock.
      const [clock] = await tx.execute<{ now: Date | string }>(q`SELECT clock_timestamp() AS now`);
      // SELECT without FROM yields exactly one row.
      const decidedAt = new Date(clock!.now);
      const [stored] = await tx
        .select({ definition: electionDefinitions.definition })
        .from(electionDefinitions)
        .where(eq(electionDefinitions.electionId, id));
      if (stored === undefined) throw new ModerationError("unknown-election");
      if (action === "hide" && !(OPEN_POLL_HIDE_REASONS as readonly string[]).includes(reason)) {
        // A stored definition was decoded and checked before it was stored.
        const def = decodeElectionDefinition(new Uint8Array(stored.definition));
        // Ballots can still arrive until the inclusion bound after the close
        // (election-definition.md, closes_at and l1_inclusion_bound).
        const at = BigInt(Math.floor(decidedAt.getTime() / 1000));
        if (at < def.closes_at + BigInt(def.l1_inclusion_bound))
          throw new ModerationError("open-poll");
      }
      // The newest decisions, enough to cover the run since the last change
      // of state: within a run each reason appears once (below), so a run has
      // at most one row per removal reason.
      const recent = await tx
        .select({ action: moderationActions.action, reason: moderationActions.reason })
        .from(moderationActions)
        .where(eq(moderationActions.electionId, id))
        .orderBy(desc(moderationActions.seq))
        .limit(REMOVAL_REASONS.length + 1);
      const before = recent[0] === undefined ? "visible" : stateAfter(recent[0].action);
      const state = STATE_AFTER[action];
      if (state === before) {
        // A removal may be re-cited under a ground not yet cited since the
        // state last changed, so the log can't fill with alternating no-ops.
        const cited = new Set<string>();
        for (const r of recent) {
          if (stateAfter(r.action) !== before) break;
          cited.add(r.reason);
        }
        if (action === "restore" || cited.has(reason)) throw new ModerationError("no-change");
      }
      const [row] = await tx
        .insert(moderationActions)
        .values({ electionId: id, action, reason, moderator, decidedAt })
        .returning({ seq: moderationActions.seq });
      // INSERT … RETURNING yields exactly the one row inserted.
      return { seq: row!.seq, state };
    },
    // The newest decisions must be read after the lock is taken (as for the
    // board's appends): a snapshot older than the lock could miss one.
    { isolationLevel: "read committed" },
  );
}

function stateAfter(action: string): ModerationState {
  if (action === "delist" || action === "hide" || action === "restore") return STATE_AFTER[action];
  // The table's check constraint admits only those three.
  throw new Error(`moderation_actions holds an unknown action: ${action}`);
}

/** The poll's current state: its newest decision's, or `visible` if it has none. */
export async function moderationStatus(
  client: Sql,
  electionId: Uint8Array,
): Promise<ModerationStatus> {
  checkElectionId(electionId);
  const [row] = await drizzle({ client })
    .select({
      seq: moderationActions.seq,
      action: moderationActions.action,
      reason: moderationActions.reason,
      decidedAt: moderationActions.decidedAt,
    })
    .from(moderationActions)
    .where(eq(moderationActions.electionId, new Uint8Array(electionId)))
    .orderBy(desc(moderationActions.seq))
    .limit(1);
  if (row === undefined) return { state: "visible" };
  const state = stateAfter(row.action);
  return {
    state,
    latest: {
      seq: row.seq,
      action: row.action as ModerationDecision["action"],
      reason: row.reason as RemovalReason | RestoreReason,
      decidedAt: row.decidedAt,
    },
  };
}

/** One decision as the public log shows it: everything but the moderator. */
export interface PublicModerationEntry {
  readonly seq: bigint;
  readonly electionId: Uint8Array;
  readonly action: ModerationDecision["action"];
  readonly reason: RemovalReason | RestoreReason;
  readonly decidedAt: Date;
}

/** The largest Postgres `bigint`. */
const INT8_MAX = (1n << 63n) - 1n;

/** The most entries one page of the public log returns. */
export const MAX_MODERATION_PAGE = 1000;

/**
 * Up to `limit` decisions with a sequence number above `after`, oldest first:
 * the public moderation log (docs/moderation-policy.md, Transparency). It
 * never includes the moderator's handle.
 */
export async function readModerationLog(
  client: Sql,
  after: bigint,
  limit: number,
): Promise<PublicModerationEntry[]> {
  if (typeof after !== "bigint" || after < 0n) throw new TypeError("after must be a bigint ≥ 0");
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MODERATION_PAGE)
    throw new TypeError(`limit must be an integer from 1 to ${MAX_MODERATION_PAGE}`);
  // Sequence numbers are Postgres `bigint`s: past the largest there is
  // nothing, and Postgres would refuse the comparison rather than say so.
  if (after >= INT8_MAX) return [];
  const rows = await drizzle({ client })
    .select({
      seq: moderationActions.seq,
      electionId: moderationActions.electionId,
      action: moderationActions.action,
      reason: moderationActions.reason,
      decidedAt: moderationActions.decidedAt,
    })
    .from(moderationActions)
    .where(gt(moderationActions.seq, after))
    .orderBy(asc(moderationActions.seq))
    .limit(limit);
  return rows.map((r) => ({
    seq: r.seq,
    electionId: new Uint8Array(r.electionId),
    action: r.action as ModerationDecision["action"],
    reason: r.reason as RemovalReason | RestoreReason,
    decidedAt: r.decidedAt,
  }));
}
