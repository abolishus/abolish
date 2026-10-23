// Moderation notices by e-mail ([[P2-27]] part 3; docs/moderation-policy.md,
// Appeals): an author is told when a moderator delists, hides or restores
// their poll, hides or restores their profile, or turns down their appeal.
// These are always sent, whatever the account's other notification choices,
// since an appeal needs the author to know (the account page's mockup).
//
// A notice is queued in the decision's own transaction (`queueNotice`, called
// by src/moderation.ts, src/appeals.ts and src/profile-moderation.ts), so a
// decision that commits always has its notice. `sendNotices` sends what is
// due to the account's verified address and deletes each notice once it is
// sent; a provider that doesn't take it is tried again later, up to
// `NOTICE_TRIES` times in all, and then the notice is dropped, as it is for
// an account with no verified address: the decision stays in the public log
// and on the account page either way. A notice is claimed before it is sent,
// so a sender that dies mid-send can repeat one, never lose it unclaimed.
//
// T-73: the provider is sent the address and words that name no poll or
// profile, only what was decided and on which ground, so it learns that the
// address has an account with a poll or a profile moderators acted on, not
// which. T-10: account-side only; nothing here reads the board or a ballot,
// and a notice keeps no decision's sequence number to join the log on.
// T-52: only a moderator's decision queues one, so no one else can make us
// mail an address.

import { and, asc, eq, gte, inArray, lt, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { type EmailKeys, type EmailSender, unsealEmailAddress } from "./account-emails.ts";
import { accountEmails, accountNotices } from "./db/schema/index.ts";
import type { ModerationTx, RemovalReason, RestoreReason } from "./moderation.ts";

/**
 * What moderation did, as a notice says it: never which poll or profile.
 * A restore cites a restore's reason, anything else a removal's; a profile
 * is hidden, never delisted.
 */
export type Notice =
  | {
      readonly subject: "poll";
      readonly event: "delist" | "hide" | "appeal-rejected";
      readonly reason: RemovalReason;
    }
  | {
      readonly subject: "profile";
      readonly event: "hide" | "appeal-rejected";
      readonly reason: RemovalReason;
    }
  | {
      readonly subject: "poll" | "profile";
      readonly event: "restore";
      readonly reason: RestoreReason;
    };

/** Tries a notice gets, the first included, before it is dropped. */
export const NOTICE_TRIES = 5;
/**
 * Seconds to wait after each try that the provider refused, before the
 * next: the last entry is how long a notice's final try may take before a
 * later run drops it unsent or not.
 */
export const NOTICE_WAIT_SECONDS = [5 * 60, 30 * 60, 2 * 60 * 60, 12 * 60 * 60, 60 * 60] as const;
/** The most notices one `sendNotices` call claims. */
export const MAX_NOTICE_BATCH = 100;

/** Queues `notice` for `userId`, due at `at`, inside the decision's transaction. */
export async function queueNotice(
  tx: Pick<ModerationTx, "insert">,
  userId: string,
  notice: Notice,
  at: Date,
): Promise<void> {
  await tx.insert(accountNotices).values({ userId, ...notice, notBefore: at });
}

/** What one `sendNotices` call did. */
export interface NoticeRun {
  /** Taken by the provider, and deleted. */
  readonly sent: number;
  /** Refused by the provider, and due again later. */
  readonly retrying: number;
  /** Deleted unsent: no verified address, no try left, or a final try that never finished. */
  readonly dropped: number;
}

export interface SendNoticesOptions {
  readonly sender: EmailSender;
  readonly keys: EmailKeys;
  readonly now: Date;
  /** At most `MAX_NOTICE_BATCH`. */
  readonly limit?: number;
}

/**
 * Sends the notices due at `now`, oldest first, at most `limit` of them.
 * Runs side by side with itself: each claims its notices with a try and a
 * later due time before it sends them, skipping any another run holds.
 */
export async function sendNotices(
  client: Sql,
  { sender, keys, now, limit = MAX_NOTICE_BATCH }: SendNoticesOptions,
): Promise<NoticeRun> {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_NOTICE_BATCH)
    throw new RangeError(`limit must be 1 to ${MAX_NOTICE_BATCH}`);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError("now is no time");
  const db = drizzle({ client });
  const n = accountNotices;
  const { claimed, stale } = await db.transaction(async (tx) => {
    // Final tries that never reported back: whether they went or not, the
    // notice has had all its tries.
    const stale = await tx
      .delete(n)
      .where(and(gte(n.tries, NOTICE_TRIES), lte(n.notBefore, now)))
      .returning({ id: n.id });
    const due = await tx
      .select()
      .from(n)
      .where(and(lt(n.tries, NOTICE_TRIES), lte(n.notBefore, now)))
      .orderBy(asc(n.notBefore), asc(n.id))
      .limit(limit)
      .for("update", { skipLocked: true });
    const claimed = [];
    for (const row of due) {
      const tries = row.tries + 1;
      // `tries` is 1 to NOTICE_TRIES, and the table holds no more.
      const wait = NOTICE_WAIT_SECONDS[tries - 1]!;
      await tx
        .update(n)
        .set({ tries, notBefore: new Date(now.getTime() + wait * 1000) })
        .where(eq(n.id, row.id));
      claimed.push({ ...row, tries });
    }
    return { claimed, stale: stale.length };
  });
  if (claimed.length === 0) return { sent: 0, retrying: 0, dropped: stale };
  const boxes = new Map(
    (
      await db
        .select({
          userId: accountEmails.userId,
          box: accountEmails.addressBox,
          key: accountEmails.boxKey,
        })
        .from(accountEmails)
        .where(inArray(accountEmails.userId, [...new Set(claimed.map((c) => c.userId))]))
    ).map((r) => [r.userId, r] as const),
  );
  let sent = 0;
  let retrying = 0;
  let dropped = stale;
  for (const c of claimed) {
    const box = boxes.get(c.userId);
    let outcome: "sent" | "unavailable" | "no-address" = "no-address";
    if (box !== undefined) {
      let to: string | undefined;
      try {
        to = unsealEmailAddress(keys, c.userId, box.box, box.key);
      } catch {
        // A box under a key this deployment no longer holds: tried again,
        // in case the keyring is restored, then dropped like a refusal.
      }
      // The table's checks admit only the combinations `Notice` names.
      const notice = { subject: c.subject, event: c.event, reason: c.reason } as Notice;
      outcome =
        to === undefined ? "unavailable" : await sender.send({ kind: "notice", to, notice });
    }
    if (outcome === "unavailable" && c.tries < NOTICE_TRIES) {
      retrying++;
      continue;
    }
    await db.delete(n).where(eq(n.id, c.id));
    if (outcome === "sent") sent++;
    else dropped++;
  }
  return { sent, retrying, dropped };
}
