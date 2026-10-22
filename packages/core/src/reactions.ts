// Reactions on a poll ([[P2-25]] part 5; the owner, 2026-10-21): a signed-in
// account verified by e-mail ([[0038-verified-accounts]]) may set each of
// `REACTIONS` on a poll once, and take it back. Reactions are on the poll
// itself, never on an answer: the set holds no agree or disagree, thumbs or
// the like, so no count reads as a second, unverified tally beside the
// poll's own. It is fixed, so a reaction carries no text to moderate (T-17,
// T-68), and the website draws each one.
//
// T-10: account-side rows that name an account, a poll and a reaction, never
// a ballot, a nullifier, a receipt or the fact of having answered, and
// nothing here reads a board table but the definitions, to check the poll
// exists. Reacting is not answering and says nothing about it. The counts
// are public; which account set which is read only by that account.
//
// T-11: no reaction has a time column. The database still orders and dates
// one (`xmin`, the WAL, backups, statement logs) for whoever holds them, and
// a reaction made just after answering can then be lined up with a ballot
// boarded moments before: a residual T-11 states. T-52: one row per account,
// poll and reaction bounds the table by the accounts, and an account may make
// `MAX_REACTION_CHANGES_PER_HOUR` changes in each UTC hour, counted per hour
// with no poll. A hidden poll takes no new reactions and shows no counts
// (T-68). Taking one back is always allowed, by any account, so one whose
// address is later unlinked, or whose poll is hidden, can still withdraw it.

import { and, eq, lt, sql as q } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { isBytes } from "./bytes.ts";
import { accountEmails, accountReactionHours, accountReactions } from "./db/schema/index.ts";
import { hasDefinition } from "./definitions.ts";
import { moderationStatus, statusOf } from "./moderation.ts";

/** The reactions an account may set on a poll, in the order they are shown. */
export const REACTIONS = ["heart", "laugh", "wow", "thinking", "sad", "clap"] as const;
export type Reaction = (typeof REACTIONS)[number];

/** Reactions set or taken back by one account in one UTC hour; the table's check holds it too. */
export const MAX_REACTION_CHANGES_PER_HOUR = 60;

export type ReactionErrorCode =
  /** The account isn't verified by e-mail. */
  | "account"
  /** Not one of `REACTIONS`. */
  | "invalid"
  /** No stored definition has this election ID. */
  | "unknown-election"
  /** The poll is hidden by moderation. */
  | "hidden"
  /** The account has made `MAX_REACTION_CHANGES_PER_HOUR` changes this hour. */
  | "too-many-this-hour";

export class ReactionError extends Error {
  override readonly name = "ReactionError";
  readonly code: ReactionErrorCode;
  constructor(code: ReactionErrorCode) {
    super(`reaction: ${code}`);
    this.code = code;
  }
}

/** An account ID as `newAccountId` makes them. */
const ACCOUNT_ID = /^[a-z0-9]{32}$/;

function checkAccountId(accountId: string): void {
  if (!ACCOUNT_ID.test(accountId)) throw new RangeError("not an account ID");
}

function checkElectionId(electionId: unknown): asserts electionId is Uint8Array {
  if (!isBytes(electionId) || electionId.length !== 32)
    throw new TypeError("electionId must be 32 bytes");
}

const isReaction = (reaction: unknown): reaction is Reaction =>
  (REACTIONS as readonly unknown[]).includes(reaction);

const hourOf = (now: Date) => {
  if (!(now instanceof Date) || Number.isNaN(now.getTime()))
    throw new TypeError("now must be a valid Date");
  return new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
};

/**
 * Sets (`on`) or takes back `reaction` on `electionId`'s poll for the
 * signed-in `accountId`, and returns whether anything changed: setting one
 * already set, or taking back one not set, changes nothing and isn't counted
 * against the hour. Refused, with nothing written, in this order: a reaction
 * outside `REACTIONS` (`invalid`), and, when setting, an account not
 * verified by e-mail (`account`), an election with no stored definition
 * (`unknown-election`) or a hidden poll (`hidden`, judged in the write's own
 * transaction); then a change past the hour's limit (`too-many-this-hour`).
 */
export async function setReaction(
  client: Sql,
  accountId: string,
  electionId: Uint8Array,
  reaction: Reaction,
  on: boolean,
  { now }: { readonly now: Date },
): Promise<boolean> {
  checkAccountId(accountId);
  checkElectionId(electionId);
  if (typeof on !== "boolean") throw new TypeError("on must be a boolean");
  const hour = hourOf(now);
  if (!isReaction(reaction)) throw new ReactionError("invalid");
  const id = new Uint8Array(electionId);
  const db = drizzle({ client });
  if (on) {
    if ((await db.$count(accountEmails, eq(accountEmails.userId, accountId))) === 0)
      throw new ReactionError("account");
    if (!(await hasDefinition(client, id))) throw new ReactionError("unknown-election");
  }
  return db.transaction(async (tx) => {
    // In the transaction, so a poll hidden since the checks above is seen.
    if (on && (await statusOf(tx, id)).state === "hidden") throw new ReactionError("hidden");
    const r = accountReactions;
    const changed = on
      ? await tx
          .insert(r)
          .values({ userId: accountId, electionId: id, reaction })
          .onConflictDoNothing()
          .returning({ one: q<number>`1` })
      : await tx
          .delete(r)
          .where(and(eq(r.userId, accountId), eq(r.electionId, id), eq(r.reaction, reaction)))
          .returning({ one: q<number>`1` });
    if (changed.length === 0) return false;
    const h = accountReactionHours;
    // Counted in the same statement that checks the limit, so two changes at
    // once can't both take the hour's last one.
    const [counted] = await tx
      .insert(h)
      .values({ userId: accountId, hour, changes: 1 })
      .onConflictDoUpdate({
        target: [h.userId, h.hour],
        set: { changes: q`${h.changes} + 1` },
        setWhere: q`${h.changes} < ${MAX_REACTION_CHANGES_PER_HOUR}`,
      })
      .returning({ changes: h.changes });
    // Rolls back the reaction with the refusal.
    if (counted === undefined) throw new ReactionError("too-many-this-hour");
    return true;
  });
}

/** How many accounts set each reaction on a poll; every one of `REACTIONS`, zero included. */
export type ReactionCounts = Readonly<Record<Reaction, number>>;

/**
 * The public counts of each reaction on `electionId`'s poll. Refused for a
 * hidden poll (`hidden`), whose page shows none of it; a poll nobody
 * reacted to, or with no stored definition, counts zero throughout.
 */
export async function readReactionCounts(
  client: Sql,
  electionId: Uint8Array,
): Promise<ReactionCounts> {
  checkElectionId(electionId);
  const id = new Uint8Array(electionId);
  if ((await moderationStatus(client, id)).state === "hidden") throw new ReactionError("hidden");
  const r = accountReactions;
  const rows = await drizzle({ client })
    .select({ reaction: r.reaction, n: q<number>`count(*)::integer` })
    .from(r)
    .where(eq(r.electionId, id))
    .groupBy(r.reaction);
  const counts = Object.fromEntries(REACTIONS.map((x) => [x, 0])) as Record<Reaction, number>;
  for (const row of rows) {
    // The table's check constraint admits only `REACTIONS`.
    if (!isReaction(row.reaction)) throw new Error(`account_reactions holds ${row.reaction}`);
    counts[row.reaction] = row.n;
  }
  return counts;
}

/**
 * The reactions the signed-in `accountId` has set on `electionId`'s poll, in
 * `REACTIONS` order: for that account's own page only, never anyone else's.
 */
export async function readOwnReactions(
  client: Sql,
  accountId: string,
  electionId: Uint8Array,
): Promise<Reaction[]> {
  checkAccountId(accountId);
  checkElectionId(electionId);
  const r = accountReactions;
  const rows = await drizzle({ client })
    .select({ reaction: r.reaction })
    .from(r)
    .where(and(eq(r.userId, accountId), eq(r.electionId, new Uint8Array(electionId))));
  const set = new Set(rows.map((row) => row.reaction));
  return REACTIONS.filter((x) => set.has(x));
}

/**
 * Deletes the change counts of hours before the one before `now`'s,
 * returning how many. The hour's margin keeps an instance whose clock runs
 * ahead from wiping the current hour's counts, and every account's limit with
 * them. Run with the other account prunes on their timer.
 */
export async function pruneReactionHours(client: Sql, now: Date): Promise<number> {
  const hour = new Date(hourOf(now).getTime() - 3_600_000);
  const rows = await drizzle({ client })
    .delete(accountReactionHours)
    .where(lt(accountReactionHours.hour, hour))
    .returning({ one: q<number>`1` });
  return rows.length;
}
