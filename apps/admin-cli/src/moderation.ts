// Moderation commands (docs/moderation-policy.md; T-68): the moderators' queue
// of reports, reviewing them, recording decisions and reading the log. Until
// the owner names moderators, the operator of the deployment is the only one
// (docs/moderation-policy.md, Moderators), so this tooling is a command line
// on the operator's own connection rather than a page anyone can reach.

import {
  MAX_MODERATION_PAGE,
  MAX_REPORT_QUEUE,
  moderate,
  type ModerationDecision,
  ModerationError,
  moderationStatus,
  readModerationLog,
  readReportQueue,
  REMOVAL_REASONS,
  type RemovalReason,
  RESTORE_REASONS,
  type RestoreReason,
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

function limitArg(s: unknown, max: number): number {
  if (s === undefined) return DEFAULT_PAGE;
  if (typeof s !== "string" || !/^[1-9][0-9]{0,3}$/.test(s) || Number(s) > max)
    throw new UsageError(`--limit is from 1 to ${max}`);
  return Number(s);
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
    if (e instanceof ModerationError) throw new CliError(e.code);
    throw e;
  }
}

/**
 * A queue cursor: the last row's hour, election ID and ground, as `queue`
 * prints it in `next`. Opaque to the operator; parsed strictly so a typo is a
 * usage error rather than a page that silently starts elsewhere.
 */
function queueCursor(s: string) {
  const m = /^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:00:00\.000Z)\/([0-9a-f]{64})\/([a-z-]+)$/.exec(
    s,
  );
  const pendingSince = m?.[1] === undefined ? undefined : new Date(m[1]);
  if (m === null || pendingSince === undefined || pendingSince.toISOString() !== m[1])
    throw new UsageError("--after is a cursor as `queue` printed it in `next`");
  // Groups 2 and 3 aren't optional, so a match has both.
  return { pendingSince, electionId: electionId(m[2]!), reason: removalReason(m[3]!) };
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
        typeof after === "string" ? queueCursor(after) : undefined,
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
          next: `${last.pendingSince.toISOString()}/${hex(last.electionId)}/${last.reason}`,
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
      const moderator = values["moderator"];
      // Every decision names who made it, for the operator's own records;
      // the public log omits it (docs/moderation-policy.md, Transparency).
      if (typeof moderator !== "string") throw new UsageError("--moderator is required");
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
      const entries = await readModerationLog(
        sql,
        typeof after === "string" ? bigintArg(after, 0n, "--after") : 0n,
        limit,
      );
      // The public log, as GET /moderation/log serves it: no moderator.
      for (const e of entries)
        io.out({
          seq: String(e.seq),
          electionId: hex(e.electionId),
          action: e.action,
          reason: e.reason,
          decidedAt: e.decidedAt.toISOString(),
        });
      const last = entries.at(-1);
      if (entries.length === limit && last !== undefined) io.out({ next: String(last.seq) });
    },
  },
};
