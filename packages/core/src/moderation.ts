// The moderation log (docs/moderation-policy.md; T-68). Moderation decides
// what our front ends show of a poll: whether it is listed in discovery and
// search, and whether its display text is shown. It never touches a result:
// this module reads and writes `moderation_actions` alone, and nothing that
// builds or checks a result reads that table. A result stays verifiable from
// chain + IPFS whatever is decided here (G-9), and hiding a poll's text
// leaves its counts published, by option index.

import { decodeElectionDefinition } from "@abolishus/crypto";
import { and, asc, desc, eq, gt, sql as q } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { isBytes } from "./bytes.ts";
import {
  accountModerators,
  accountPolls,
  electionDefinitions,
  moderationActions,
} from "./db/schema/index.ts";

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
  /** The handle isn't a moderator's: never added, or retired (src/appeals.ts). */
  | "unknown-moderator"
  /** The moderator's account created the poll (docs/moderation-policy.md, Moderators). */
  | "own-poll"
  /** A restore citing `appeal-upheld` outside an appeal's review (`decideAppeal`). */
  | "appeal-only"
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
 * `account_moderators` says whose account it is (src/appeals.ts), so the
 * tooling can refuse a decision on the moderator's own poll; the log stores
 * the handle, not the account (no foreign key leaves the account tables,
 * T-10), and the public log omits it.
 */
export const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
/**
 * The two-key advisory lock every decision takes (a separate keyspace from
 * the board's lock class and from migrations' one-key locks). One lock for
 * all elections: decisions are rare, and serialising them all makes the log's
 * sequence numbers commit in order, so a reader paging by sequence number
 * never passes a decision that commits later with a smaller one.
 */
const MODERATION_LOCK = [0x0b0a4e, 0] as const;

type Db = ReturnType<typeof drizzle>;
/** A transaction holding `lockModeration`. */
export type ModerationTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Takes the moderation lock for the rest of `tx`. */
export async function lockModeration(tx: ModerationTx): Promise<void> {
  await tx.execute(
    q`SELECT pg_advisory_xact_lock(${MODERATION_LOCK[0]}::int, ${MODERATION_LOCK[1]}::int)`,
  );
}

/** The account behind an active moderator's handle, or `undefined`. */
export async function moderatorAccount(
  tx: ModerationTx,
  handle: string,
): Promise<string | undefined> {
  const [row] = await tx
    .select({ userId: accountModerators.userId })
    .from(accountModerators)
    .where(eq(accountModerators.handle, handle));
  return row?.userId ?? undefined;
}

/** Whether `accountId` created the poll of `electionId` (ADR 0032, rule 15). */
export async function createdBy(
  tx: ModerationTx,
  electionId: Uint8Array,
  accountId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: accountPolls.id })
    .from(accountPolls)
    .where(and(eq(accountPolls.electionId, electionId), eq(accountPolls.userId, accountId)));
  return row !== undefined;
}

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
 * election with no stored definition, a handle that isn't an active
 * moderator's, a moderator deciding on a poll their account created, a
 * restore citing `appeal-upheld` (only `decideAppeal` records one, so the
 * public log's appeals are real ones), hiding a poll that hasn't closed for a
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
  if (decision.reason === "appeal-upheld") throw new ModerationError("appeal-only");
  const id = new Uint8Array(electionId);
  return drizzle({ client }).transaction(
    async (tx) => {
      await lockModeration(tx);
      return recordDecision(tx, id, decision);
    },
    // The newest decisions must be read after the lock is taken (as for the
    // board's appends): a snapshot older than the lock could miss one.
    { isolationLevel: "read committed" },
  );
}

/**
 * `moderate`'s checks and write, for a well-formed decision, inside a
 * read-committed transaction that holds `lockModeration`.
 */
export async function recordDecision(
  tx: ModerationTx,
  id: Uint8Array,
  decision: ModerationDecision,
): Promise<{ readonly seq: bigint; readonly state: ModerationState }> {
  const { action, reason, moderator } = decision;
  // The decision's time: the database clock, read after the lock.
  const [clock] = await tx.execute<{ now: Date | string }>(q`SELECT clock_timestamp() AS now`);
  // SELECT without FROM yields exactly one row.
  const decidedAt = new Date(clock!.now);
  const [stored] = await tx
    .select({ definition: electionDefinitions.definition })
    .from(electionDefinitions)
    .where(eq(electionDefinitions.electionId, id));
  if (stored === undefined) throw new ModerationError("unknown-election");
  const account = await moderatorAccount(tx, moderator);
  if (account === undefined) throw new ModerationError("unknown-moderator");
  // A stake other than authorship isn't recorded anywhere, so only this
  // one is refused (docs/moderation-policy.md, Known-weak).
  if (await createdBy(tx, id, account)) throw new ModerationError("own-poll");
  if (action === "hide" && !(OPEN_POLL_HIDE_REASONS as readonly string[]).includes(reason)) {
    // A stored definition was decoded and checked before it was stored.
    const def = decodeElectionDefinition(new Uint8Array(stored.definition));
    // Ballots can still arrive until the inclusion bound after the close
    // (election-definition.md, closes_at and l1_inclusion_bound).
    const at = BigInt(Math.floor(decidedAt.getTime() / 1000));
    if (at < def.closes_at + BigInt(def.l1_inclusion_bound)) throw new ModerationError("open-poll");
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
}

/** The state a decision's action leads to. */
export function stateAfter(action: string): ModerationState {
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
