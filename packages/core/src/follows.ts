// Following a poll ([[P2-25]] part 4): a signed-in account verified by
// e-mail ([[0038-verified-accounts]]), the address its notices go to, may
// follow a poll, to be told when its results land or a live batch is
// published ([[P2-27]]), and stop following it. Following is not answering
// and says nothing about it: the website offers it whether or not the
// account answered, never in the ballot client and never prompted by
// answering (part 4b).
//
// T-10: account-side rows that name an account and a poll, never a ballot,
// a nullifier, a receipt or the fact of having answered, and nothing here
// reads a board table but the definitions, to check the poll exists. There
// is no public count: who follows a poll is read only by that account, and
// by the sender of its notices.
//
// T-11: no follow has a time column. The database still orders and dates one
// (`xmin`, the WAL, backups, statement logs) for whoever holds them, and a
// follow made just after answering can then be lined up with a ballot
// boarded moments before: the residual T-11 states, as for reactions. T-52:
// one row per account and poll bounds the table by the accounts, and an
// account may make `MAX_FOLLOW_CHANGES_PER_HOUR` changes in each UTC hour,
// counted per hour with no poll. A hidden poll takes no new followers (T-68).
// Stopping is always allowed, by any account, so one whose address is later
// unlinked, or whose poll is hidden, can still stop.

import { and, eq, lt, sql as q } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { isBytes } from "./bytes.ts";
import { accountEmails, accountFollowHours, accountFollows } from "./db/schema/index.ts";
import { hasDefinition } from "./definitions.ts";
import { statusOf } from "./moderation.ts";

/** Follows set or stopped by one account in one UTC hour; the table's check holds it too. */
export const MAX_FOLLOW_CHANGES_PER_HOUR = 60;

export type FollowErrorCode =
  /** The account isn't verified by e-mail. */
  | "account"
  /** No stored definition has this election ID. */
  | "unknown-election"
  /** The poll is hidden by moderation. */
  | "hidden"
  /** The account has made `MAX_FOLLOW_CHANGES_PER_HOUR` changes this hour. */
  | "too-many-this-hour";

export class FollowError extends Error {
  override readonly name = "FollowError";
  readonly code: FollowErrorCode;
  constructor(code: FollowErrorCode) {
    super(`follow: ${code}`);
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

const hourOf = (now: Date) => {
  if (!(now instanceof Date) || Number.isNaN(now.getTime()))
    throw new TypeError("now must be a valid Date");
  return new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
};

/**
 * Follows (`on`) or stops following `electionId`'s poll for the signed-in
 * `accountId`, and returns whether anything changed: following a poll
 * already followed, or stopping one not followed, changes nothing and isn't
 * counted against the hour. Refused, with nothing written, when following:
 * an account not verified by e-mail (`account`), an election with no stored
 * definition (`unknown-election`) or a hidden poll (`hidden`, judged in the
 * write's own transaction); then a change past the hour's limit
 * (`too-many-this-hour`).
 */
export async function setFollow(
  client: Sql,
  accountId: string,
  electionId: Uint8Array,
  on: boolean,
  { now }: { readonly now: Date },
): Promise<boolean> {
  checkAccountId(accountId);
  checkElectionId(electionId);
  if (typeof on !== "boolean") throw new TypeError("on must be a boolean");
  const hour = hourOf(now);
  const id = new Uint8Array(electionId);
  const db = drizzle({ client });
  if (on) {
    if ((await db.$count(accountEmails, eq(accountEmails.userId, accountId))) === 0)
      throw new FollowError("account");
    if (!(await hasDefinition(client, id))) throw new FollowError("unknown-election");
  }
  return db.transaction(async (tx) => {
    // In the transaction, so a poll hidden since the checks above is seen.
    if (on && (await statusOf(tx, id)).state === "hidden") throw new FollowError("hidden");
    const f = accountFollows;
    const changed = on
      ? await tx
          .insert(f)
          .values({ userId: accountId, electionId: id })
          .onConflictDoNothing()
          .returning({ one: q<number>`1` })
      : await tx
          .delete(f)
          .where(and(eq(f.userId, accountId), eq(f.electionId, id)))
          .returning({ one: q<number>`1` });
    if (changed.length === 0) return false;
    const h = accountFollowHours;
    // Counted in the same statement that checks the limit, so two changes at
    // once can't both take the hour's last one.
    const [counted] = await tx
      .insert(h)
      .values({ userId: accountId, hour, changes: 1 })
      .onConflictDoUpdate({
        target: [h.userId, h.hour],
        set: { changes: q`${h.changes} + 1` },
        setWhere: q`${h.changes} < ${MAX_FOLLOW_CHANGES_PER_HOUR}`,
      })
      .returning({ changes: h.changes });
    // Rolls back the follow with the refusal.
    if (counted === undefined) throw new FollowError("too-many-this-hour");
    return true;
  });
}

/**
 * Whether the signed-in `accountId` follows `electionId`'s poll: for that
 * account's own page only, never anyone else's. Answered for a hidden poll
 * too, so the account can still see it is following and stop.
 */
export async function isFollowing(
  client: Sql,
  accountId: string,
  electionId: Uint8Array,
): Promise<boolean> {
  checkAccountId(accountId);
  checkElectionId(electionId);
  const f = accountFollows;
  const n = await drizzle({ client }).$count(
    f,
    and(eq(f.userId, accountId), eq(f.electionId, new Uint8Array(electionId))),
  );
  return n > 0;
}

/**
 * Deletes the change counts of hours before the one before `now`'s,
 * returning how many. The hour's margin keeps an instance whose clock runs
 * ahead from wiping the current hour's counts, and every account's limit with
 * them. Run with the other account prunes on their timer.
 */
export async function pruneFollowHours(client: Sql, now: Date): Promise<number> {
  const hour = new Date(hourOf(now).getTime() - 3_600_000);
  const rows = await drizzle({ client })
    .delete(accountFollowHours)
    .where(lt(accountFollowHours.hour, hour))
    .returning({ one: q<number>`1` });
  return rows.length;
}
