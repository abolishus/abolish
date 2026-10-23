// Moderation notices by e-mail ([[P2-27]] part 3; docs/moderation-policy.md,
// Appeals): an author is told when a moderator delists, hides or restores
// their poll, hides or restores their profile, or turns down their appeal.
// These are always sent, whatever the account's other notification choices,
// since an appeal needs the author to know (the account page's mockup).
//
// T-73 ([[0038-verified-accounts]], Amendment (P2-27 part 3a)): the public
// log gives each decision's action, reason and time, so a notice that said
// any of them, or went out at the decision's time, would let the provider
// match the address to the poll or profile. So a notice says only that a
// moderator decided something, an account has at most one waiting, and it is
// due after the UTC midnight that follows the newest decision it carries: the
// provider learns that the address's account had a poll or profile moderated
// that day, never which. What was decided is on the account page.
//
// A notice is queued in the decision's own transaction (`queueNotice`, called
// by src/moderation.ts, src/appeals.ts and src/profile-moderation.ts), so a
// decision that commits always has its notice. `sendNotices` claims what is
// due with a try and a lease, sends to the account's verified address and
// deletes the notice unless a decision renewed it meanwhile; a refusal is
// tried again after `NOTICE_WAIT_SECONDS`, up to `NOTICE_TRIES` tries in all,
// and then the notice is dropped, as one for an account with no verified
// address is: the decision stays in the public log and on the account page.
// A sender that dies after the provider took a notice sends it again once
// its lease ends.
//
// Web push (part 4): the first try of each notice also wakes every browser
// the account subscribed (src/account-push.ts), once and whether or not an
// address takes the e-mail, and a push service's answer that a subscription
// has ended deletes it. A push carries no payload, and goes when the e-mail
// does, so the push service learns no more than the e-mail provider: that
// the account was moderated that day (T-73, T-76). Later tries are the
// e-mail's alone, so a refused e-mail never wakes a browser twice.
//
// A notice is written in the language its account verified its address in
// (P2-28 part 4c-3): a timer sends it, with no request to take one from.
//
// T-10: account-side only; nothing here reads the board or a ballot, and a
// notice keeps nothing to join the log on but its day. T-52: only a
// moderator's decision queues one, so no one else can make us mail an
// address, and an address gets one a day at most however many decisions.

import { and, asc, eq, lt, lte, sql as q } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { type EmailKeys, type EmailSender, unsealEmailAddress } from "./account-emails.ts";
import { accountEmails, accountNotices, accountPushSubscriptions } from "./db/schema/index.ts";
import type { ModerationTx } from "./moderation.ts";
import type { PushOutcome, PushSender } from "./web-push.ts";

/** Tries a notice gets, the first included, before it is dropped. */
export const NOTICE_TRIES = 5;
/**
 * Seconds a claimed notice waits before its next try: after each refused
 * try, and after the last one, how long it may take before a later run
 * drops it. Each is longer than a batch can take (`MAX_NOTICE_BATCH` sends
 * at the Postmark sender's 10-second timeout, each after its account's
 * pushes, sent side by side at the push sender's 5-second timeout), so no
 * run claims a notice another run is still sending.
 */
export const NOTICE_WAIT_SECONDS = [
  30 * 60,
  2 * 60 * 60,
  6 * 60 * 60,
  24 * 60 * 60,
  60 * 60,
] as const;
/** The most notices one `sendNotices` call claims. */
export const MAX_NOTICE_BATCH = 100;

const DAY = 24 * 60 * 60 * 1000;

/** The UTC midnight after `at`: when a notice for a decision made at `at` is due. */
export const noticeDue = (at: Date): Date => new Date(Math.floor(at.getTime() / DAY) * DAY + DAY);

/**
 * Queues a notice for `userId` about a decision made at `at`, inside the
 * decision's transaction. A notice already waiting carries this decision
 * too, due no sooner than this one would be and with its tries reset, so a
 * send in flight for the older decisions doesn't delete it.
 */
export async function queueNotice(
  tx: Pick<ModerationTx, "insert">,
  userId: string,
  at: Date,
): Promise<void> {
  const n = accountNotices;
  await tx
    .insert(n)
    .values({ userId, notBefore: noticeDue(at) })
    .onConflictDoUpdate({
      target: n.userId,
      set: { tries: 0, notBefore: q`greatest(${n.notBefore}, excluded.not_before)` },
    });
}

/** What one `sendNotices` call did. */
export interface NoticeRun {
  /** Taken by the provider. */
  readonly sent: number;
  /** Refused by the provider, and due again later. */
  readonly retrying: number;
  /** Deleted unsent: no verified address, no try left, or a final try that never finished. */
  readonly dropped: number;
  /** Pushes a push service took. */
  readonly pushed: number;
  /** Pushes a push service didn't take, a subscription that had ended aside. */
  readonly pushFailed: number;
}

export interface SendNoticesOptions {
  /** The provider's own answer: never a sender that reports `sent` for every message. */
  readonly sender: EmailSender;
  readonly keys: EmailKeys;
  /** Wakes the account's subscribed browsers; without it, nothing is pushed. */
  readonly push?: PushSender;
  readonly now: Date;
  /** At most `MAX_NOTICE_BATCH`. */
  readonly limit?: number;
}

/**
 * Sends the notices due at `now`, oldest first, at most `limit` of them.
 * Runs side by side with itself: each claims its notices with a try and a
 * lease before it sends them, skipping any another run holds.
 */
export async function sendNotices(
  client: Sql,
  { sender, keys, push, now, limit = MAX_NOTICE_BATCH }: SendNoticesOptions,
): Promise<NoticeRun> {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_NOTICE_BATCH)
    throw new RangeError(`limit must be 1 to ${MAX_NOTICE_BATCH}`);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError("now is no time");
  const db = drizzle({ client });
  const n = accountNotices;
  const { claimed, stale } = await db.transaction(async (tx) => {
    // Final tries whose lease ended: whether they went or not, the notice
    // has had all its tries.
    const stale = await tx
      .delete(n)
      .where(and(eq(n.tries, NOTICE_TRIES), lte(n.notBefore, now)))
      .returning({ userId: n.userId });
    const due = await tx
      .select({
        userId: n.userId,
        tries: n.tries,
        box: accountEmails.addressBox,
        key: accountEmails.boxKey,
        locale: accountEmails.locale,
      })
      .from(n)
      .leftJoin(accountEmails, eq(accountEmails.userId, n.userId))
      .where(and(lt(n.tries, NOTICE_TRIES), lte(n.notBefore, now)))
      .orderBy(asc(n.notBefore), asc(n.userId))
      .limit(limit)
      .for("update", { of: n, skipLocked: true });
    const claimed = [];
    for (const row of due) {
      const tries = row.tries + 1;
      // `tries` is 1 to NOTICE_TRIES, and the table holds no more.
      const lease = new Date(now.getTime() + NOTICE_WAIT_SECONDS[tries - 1]! * 1000);
      await tx.update(n).set({ tries, notBefore: lease }).where(eq(n.userId, row.userId));
      claimed.push({ ...row, tries, lease });
    }
    return { claimed, stale: stale.length };
  });
  let sent = 0;
  let retrying = 0;
  let dropped = stale;
  let pushed = 0;
  let pushFailed = 0;
  for (const c of claimed) {
    if (push !== undefined && c.tries === 1) {
      const outcomes = await pushTo(client, push, c.userId, now);
      pushed += outcomes.filter((o) => o === "sent").length;
      pushFailed += outcomes.filter((o) => o === "unavailable").length;
    }
    let outcome: "sent" | "unavailable" | "no-address" = "no-address";
    if (c.box !== null && c.key !== null && c.locale !== null) {
      let to: string | undefined;
      try {
        to = unsealEmailAddress(keys, c.userId, c.box, c.key);
      } catch {
        // A box under a key this deployment no longer holds: tried again,
        // in case the keyring is restored, then dropped like a refusal.
      }
      outcome =
        to === undefined
          ? "unavailable"
          : await sender.send({ kind: "notice", to, locale: c.locale });
    }
    if (outcome === "unavailable" && c.tries < NOTICE_TRIES) {
      retrying++;
      continue;
    }
    // Only the notice as claimed: one a decision renewed since is sent again.
    await db
      .delete(n)
      .where(and(eq(n.userId, c.userId), eq(n.tries, c.tries), eq(n.notBefore, c.lease)));
    if (outcome === "sent") sent++;
    else dropped++;
  }
  return { sent, retrying, dropped, pushed, pushFailed };
}

/**
 * Pushes to every browser `userId` subscribed, side by side, deleting each
 * that has ended. Never throws: a push or a cleanup that fails is a push not
 * taken, and the e-mail and the rest of the batch still go.
 */
async function pushTo(
  client: Sql,
  push: PushSender,
  userId: string,
  now: Date,
): Promise<PushOutcome[]> {
  const db = drizzle({ client });
  const s = accountPushSubscriptions;
  let endpoints: { endpoint: string }[];
  try {
    endpoints = await db.select({ endpoint: s.endpoint }).from(s).where(eq(s.userId, userId));
  } catch {
    return [];
  }
  return Promise.all(
    endpoints.map(async ({ endpoint }): Promise<PushOutcome> => {
      try {
        const outcome = await push.send(endpoint, now);
        if (outcome === "gone")
          await db.delete(s).where(and(eq(s.endpoint, endpoint), eq(s.userId, userId)));
        return outcome;
      } catch {
        return "unavailable";
      }
    }),
  );
}
