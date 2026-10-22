// Moderation commands (docs/moderation-policy.md; T-68): the moderators' queue
// of reports, reviewing them, recording decisions and reading the log, the
// moderators' handles, and the creators' appeals, for polls and, under
// `profile-`, for creator profiles (Profiles; T-75). Until
// the owner names moderators, the operator of the deployment is the only one
// (docs/moderation-policy.md, Moderators), so this tooling is a command line
// on the operator's own connection rather than a page anyone can reach.

import {
  addModerator,
  APPEAL_DECISIONS,
  type AppealDecision,
  AppealError,
  decideAppeal,
  decideProfileAppeal,
  MAX_APPEAL_QUEUE,
  MAX_MODERATION_PAGE,
  MAX_PROFILE_APPEAL_QUEUE,
  MAX_REPORT_QUEUE,
  moderate,
  moderateProfile,
  type ModerationDecision,
  ModerationError,
  moderationStatus,
  PROFILE_HANDLE,
  profileModerationStatus,
  type ProfileModerationDecision,
  type ProfileReportQueueCursor,
  readAppealQueue,
  readProfileAppealQueue,
  readProfileReportQueue,
  readPublicModerationLog,
  readReportQueue,
  REMOVAL_REASONS,
  type RemovalReason,
  type ReportQueueCursor,
  RESTORE_REASONS,
  type RestoreReason,
  retireModerator,
  reviewProfileReports,
  reviewReports,
} from "@abolishus/core";
import type { Command } from "./cli.ts";
import { CliError, UsageError } from "./errors.ts";

const INT8_MAX = (1n << 63n) - 1n;
const DEFAULT_PAGE = 100;

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** An election ID in its one spelling, 64 lowercase hex digits (T-31). */
function electionId(s: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(s)) throw new UsageError("an election ID is 64 lowercase hex digits");
  return new Uint8Array(Buffer.from(s, "hex"));
}

/** A canonical decimal from `min` to the largest Postgres `bigint`. */
function bigintArg(s: string, min: bigint, what: string): bigint {
  if (!/^(?:0|[1-9][0-9]{0,18})$/.test(s) || BigInt(s) < min || BigInt(s) > INT8_MAX)
    throw new UsageError(`${what} is a decimal from ${min} to 2^63 − 1`);
  return BigInt(s);
}

/** A profile handle in its one spelling, 16 base32 letters and digits (T-75). */
function profileHandle(s: string): string {
  if (!PROFILE_HANDLE.test(s))
    throw new UsageError("a profile handle is 16 characters from a to z and 2 to 7");
  return s;
}

function limitArg(s: unknown, max: number): number {
  if (s === undefined) return DEFAULT_PAGE;
  if (typeof s !== "string" || !/^[1-9][0-9]{0,3}$/.test(s) || Number(s) > max)
    throw new UsageError(`--limit is from 1 to ${max}`);
  return Number(s);
}

function appealDecision(s: string): AppealDecision {
  const d = APPEAL_DECISIONS.find((x) => x === s);
  if (d === undefined) throw new UsageError(`a decision is ${APPEAL_DECISIONS.join(" or ")}`);
  return d;
}

function removalReason(s: string): RemovalReason {
  const r = REMOVAL_REASONS.find((x) => x === s);
  if (r === undefined)
    throw new UsageError(`a removal reason is one of ${REMOVAL_REASONS.join(", ")}`);
  return r;
}

function restoreReason(s: string): RestoreReason {
  const r = RESTORE_REASONS.find((x) => x === s);
  if (r === undefined)
    throw new UsageError(`a restore reason is one of ${RESTORE_REASONS.join(", ")}`);
  return r;
}

/** Core's refusals become the operator's; anything else isn't theirs to fix. */
async function refusable<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof ModerationError || e instanceof AppealError) throw new CliError(e.code);
    throw e;
  }
}

/**
 * A queue cursor's parts: the last row's hour, what was reported (an election
 * ID or a profile handle, which the caller checks) and the ground, as
 * `command` prints them in `next`. Opaque to the operator; parsed strictly so
 * a typo is a usage error rather than a page that silently starts elsewhere.
 */
function cursorParts(s: string, command: string) {
  const m = /^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:00:00\.000Z)\/([^/]+)\/([a-z-]+)$/.exec(s);
  const pendingSince = m?.[1] === undefined ? undefined : new Date(m[1]);
  // An out-of-range field (hour 30) makes an invalid Date, whose toISOString throws.
  if (
    m === null ||
    pendingSince === undefined ||
    Number.isNaN(pendingSince.getTime()) ||
    pendingSince.toISOString() !== m[1]
  )
    throw new UsageError(`--after is a cursor as \`${command}\` printed it in \`next\``);
  // Groups 2 and 3 aren't optional, so a match has both.
  return { pendingSince, key: m[2]!, reason: removalReason(m[3]!) };
}

/** The polls' queue cursor, as `queue` prints it in `next`. */
export function parseQueueCursor(s: string): ReportQueueCursor {
  const { pendingSince, key, reason } = cursorParts(s, "queue");
  return { pendingSince, electionId: electionId(key), reason };
}

export function formatQueueCursor(c: ReportQueueCursor): string {
  return `${c.pendingSince.toISOString()}/${hex(c.electionId)}/${c.reason}`;
}

/** The profiles' queue cursor, as `profile-queue` prints it in `next`. */
export function parseProfileQueueCursor(s: string): ProfileReportQueueCursor {
  const { pendingSince, key, reason } = cursorParts(s, "profile-queue");
  return { pendingSince, handle: profileHandle(key), reason };
}

export function formatProfileQueueCursor(c: ProfileReportQueueCursor): string {
  return `${c.pendingSince.toISOString()}/${c.handle}/${c.reason}`;
}

/** The moderator a decision names, required by every command that records one. */
function moderatorArg(s: unknown): string {
  // Every decision names who made it, for the operator's own records;
  // the public log omits it (docs/moderation-policy.md, Transparency).
  if (typeof s !== "string") throw new UsageError("--moderator is required");
  return s;
}

// `run` (cli.ts) calls a command only with exactly its `positionals`, so the
// `!` on each positional below holds.

export const moderationCommands: Readonly<Record<string, Command>> = {
  queue: {
    usage: `[--limit 1..${MAX_REPORT_QUEUE}] [--after <next>]`,
    options: { limit: { type: "string" }, after: { type: "string" } },
    positionals: 0,
    async run(sql, _, values, io) {
      const limit = limitArg(values["limit"], MAX_REPORT_QUEUE);
      const after = values["after"];
      const rows = await readReportQueue(
        sql,
        limit,
        typeof after === "string" ? parseQueueCursor(after) : undefined,
      );
      for (const r of rows)
        io.out({
          electionId: hex(r.electionId),
          reason: r.reason,
          pending: String(r.pending),
          total: String(r.total),
          pendingSince: r.pendingSince.toISOString(),
        });
      const last = rows.at(-1);
      // A full page may have more behind it; a short one is the end.
      if (rows.length === limit && last !== undefined)
        io.out({
          next: formatQueueCursor(last),
        });
    },
  },

  review: {
    usage: "<election-id> <reason> <seen-total>",
    options: {},
    positionals: 3,
    async run(sql, [id, reason, seen], _, io) {
      const election = electionId(id!);
      const ground = removalReason(reason!);
      // The `total` the queue showed, so a report counted since stays pending.
      const pending = await refusable(
        reviewReports(sql, election, ground, bigintArg(seen!, 1n, "seen-total")),
      );
      io.out({ electionId: id, reason: ground, pending: String(pending) });
    },
  },

  decide: {
    usage: "<election-id> <delist|hide|restore> <reason> --moderator <handle>",
    options: { moderator: { type: "string" } },
    positionals: 3,
    async run(sql, [id, action, reason], values, io) {
      const election = electionId(id!);
      const moderator = moderatorArg(values["moderator"]);
      let decision: ModerationDecision;
      if (action === "delist" || action === "hide")
        decision = { action, reason: removalReason(reason!), moderator };
      else if (action === "restore")
        decision = { action, reason: restoreReason(reason!), moderator };
      else throw new UsageError("an action is delist, hide or restore");
      const { seq, state } = await refusable(moderate(sql, election, decision));
      io.out({ seq: String(seq), electionId: id, state });
    },
  },

  status: {
    usage: "<election-id>",
    options: {},
    positionals: 1,
    async run(sql, [id], _, io) {
      const { state, latest } = await moderationStatus(sql, electionId(id!));
      io.out({
        electionId: id,
        state,
        ...(latest && {
          latest: {
            seq: String(latest.seq),
            action: latest.action,
            reason: latest.reason,
            decidedAt: latest.decidedAt.toISOString(),
          },
        }),
      });
    },
  },

  log: {
    usage: `[--after <seq>] [--limit 1..${MAX_MODERATION_PAGE}]`,
    options: { after: { type: "string" }, limit: { type: "string" } },
    positionals: 0,
    async run(sql, _, values, io) {
      const limit = limitArg(values["limit"], MAX_MODERATION_PAGE);
      const after = values["after"];
      const entries = await readPublicModerationLog(
        sql,
        typeof after === "string" ? bigintArg(after, 0n, "--after") : 0n,
        limit,
      );
      // The whole public log, polls' decisions, refilings and profiles'
      // decisions in one numbering, as GET /moderation/log serves it: no
      // moderator, a profile by its handle, never its name or account, and a
      // refiling's place only as changed or cleared, never its words (T-17).
      for (const e of entries) {
        const common = { seq: String(e.seq) };
        const when = { reason: e.reason, decidedAt: e.decidedAt.toISOString() };
        switch (e.target) {
          case "poll":
            io.out({ ...common, electionId: hex(e.electionId), action: e.action, ...when });
            break;
          case "refiling":
            io.out({
              ...common,
              electionId: hex(e.electionId),
              action: "refile",
              ...when,
              ...(e.topic === undefined ? {} : { topic: e.topic }),
              ...(e.place === undefined ? {} : { place: e.place }),
            });
            break;
          case "profile":
            io.out({ ...common, handle: e.handle, action: e.action, ...when });
            break;
        }
      }
      const last = entries.at(-1);
      if (entries.length === limit && last !== undefined) io.out({ next: String(last.seq) });
    },
  },

  "moderator-add": {
    usage: "<handle> <account-id>",
    options: {},
    positionals: 2,
    async run(sql, [handle, account], _, io) {
      // Who the handle is, so `decide` refuses a moderator's own poll and an
      // appeal goes to someone else (docs/moderation-policy.md, Moderators).
      await refusable(addModerator(sql, handle!, account!));
      io.out({ handle });
    },
  },

  "moderator-retire": {
    usage: "<handle>",
    options: {},
    positionals: 1,
    async run(sql, [handle], _, io) {
      await refusable(retireModerator(sql, handle!));
      io.out({ handle, retired: true });
    },
  },

  appeals: {
    usage: `[--limit 1..${MAX_APPEAL_QUEUE}] [--after <seq>]`,
    options: { limit: { type: "string" }, after: { type: "string" } },
    positionals: 0,
    async run(sql, _, values, io) {
      const limit = limitArg(values["limit"], MAX_APPEAL_QUEUE);
      const after = values["after"];
      const rows = await readAppealQueue(
        sql,
        limit,
        typeof after === "string" ? bigintArg(after, 0n, "--after") : 0n,
      );
      // The poll and the decision appealed, never who appealed.
      for (const a of rows)
        io.out({
          decisionSeq: String(a.decisionSeq),
          electionId: hex(a.electionId),
          action: a.action,
          reason: a.reason,
          decidedAt: a.decidedAt.toISOString(),
          filedAt: a.filedAt.toISOString(),
        });
      const last = rows.at(-1);
      if (rows.length === limit && last !== undefined) io.out({ next: String(last.decisionSeq) });
    },
  },

  "appeal-decide": {
    usage: "<decision-seq> <upheld|rejected> --moderator <handle>",
    options: { moderator: { type: "string" } },
    positionals: 2,
    async run(sql, [seq, decision], values, io) {
      const decisionSeq = bigintArg(seq!, 1n, "decision-seq");
      const outcome = appealDecision(decision!);
      const moderator = moderatorArg(values["moderator"]);
      const review = await refusable(decideAppeal(sql, decisionSeq, outcome, moderator));
      io.out({
        decisionSeq: seq,
        outcome: review.outcome,
        state: review.state,
        ...(review.restoreSeq !== undefined && { restoreSeq: String(review.restoreSeq) }),
      });
    },
  },

  "profile-queue": {
    usage: `[--limit 1..${MAX_REPORT_QUEUE}] [--after <next>]`,
    options: { limit: { type: "string" }, after: { type: "string" } },
    positionals: 0,
    async run(sql, _, values, io) {
      const limit = limitArg(values["limit"], MAX_REPORT_QUEUE);
      const after = values["after"];
      const rows = await readProfileReportQueue(
        sql,
        limit,
        typeof after === "string" ? parseProfileQueueCursor(after) : undefined,
      );
      for (const r of rows)
        io.out({
          handle: r.handle,
          reason: r.reason,
          pending: String(r.pending),
          total: String(r.total),
          pendingSince: r.pendingSince.toISOString(),
        });
      const last = rows.at(-1);
      if (rows.length === limit && last !== undefined)
        io.out({ next: formatProfileQueueCursor(last) });
    },
  },

  "profile-review": {
    usage: "<handle> <reason> <seen-total>",
    options: {},
    positionals: 3,
    async run(sql, [h, reason, seen], _, io) {
      const handle = profileHandle(h!);
      const ground = removalReason(reason!);
      // The `total` the queue showed, so a report counted since stays pending.
      const pending = await refusable(
        reviewProfileReports(sql, handle, ground, bigintArg(seen!, 1n, "seen-total")),
      );
      io.out({ handle, reason: ground, pending: String(pending) });
    },
  },

  "profile-decide": {
    usage: "<handle> <hide|restore> <reason> --moderator <handle>",
    options: { moderator: { type: "string" } },
    positionals: 3,
    async run(sql, [h, action, reason], values, io) {
      const handle = profileHandle(h!);
      const moderator = moderatorArg(values["moderator"]);
      // No delist: a profile is reached only through its polls (Profiles).
      let decision: ProfileModerationDecision;
      if (action === "hide") decision = { action, reason: removalReason(reason!), moderator };
      else if (action === "restore")
        decision = { action, reason: restoreReason(reason!), moderator };
      else throw new UsageError("a profile's action is hide or restore");
      const { seq, state } = await refusable(moderateProfile(sql, handle, decision));
      io.out({ seq: String(seq), handle, state });
    },
  },

  "profile-status": {
    usage: "<handle>",
    options: {},
    positionals: 1,
    async run(sql, [h], _, io) {
      const handle = profileHandle(h!);
      const { state, latest } = await profileModerationStatus(sql, handle);
      io.out({
        handle,
        state,
        ...(latest && {
          latest: {
            seq: String(latest.seq),
            action: latest.action,
            reason: latest.reason,
            decidedAt: latest.decidedAt.toISOString(),
          },
        }),
      });
    },
  },

  "profile-appeals": {
    usage: `[--limit 1..${MAX_PROFILE_APPEAL_QUEUE}] [--after <seq>]`,
    options: { limit: { type: "string" }, after: { type: "string" } },
    positionals: 0,
    async run(sql, _, values, io) {
      const limit = limitArg(values["limit"], MAX_PROFILE_APPEAL_QUEUE);
      const after = values["after"];
      const rows = await readProfileAppealQueue(
        sql,
        limit,
        typeof after === "string" ? bigintArg(after, 0n, "--after") : 0n,
      );
      // The profile and the decision appealed, never whose profile it is.
      for (const a of rows)
        io.out({
          decisionSeq: String(a.decisionSeq),
          handle: a.handle,
          action: "hide",
          reason: a.reason,
          decidedAt: a.decidedAt.toISOString(),
          filedAt: a.filedAt.toISOString(),
        });
      const last = rows.at(-1);
      if (rows.length === limit && last !== undefined) io.out({ next: String(last.decisionSeq) });
    },
  },

  "profile-appeal-decide": {
    usage: "<decision-seq> <upheld|rejected> --moderator <handle>",
    options: { moderator: { type: "string" } },
    positionals: 2,
    async run(sql, [seq, decision], values, io) {
      const decisionSeq = bigintArg(seq!, 1n, "decision-seq");
      const outcome = appealDecision(decision!);
      const moderator = moderatorArg(values["moderator"]);
      const review = await refusable(decideProfileAppeal(sql, decisionSeq, outcome, moderator));
      io.out({
        decisionSeq: seq,
        outcome: review.outcome,
        state: review.state,
        ...(review.restoreSeq !== undefined && { restoreSeq: String(review.restoreSeq) }),
      });
    },
  },
};
