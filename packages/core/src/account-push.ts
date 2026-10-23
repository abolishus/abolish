// The browsers an account asked to be told by web push ([[P2-27]] part 4;
// migrations/0043_account_push_subscriptions.sql). The account page
// subscribes a browser with its push service and hands us the endpoint;
// `sendNotices` (src/account-notices.ts) wakes each one when a moderation
// notice goes out, beside the e-mail, and `src/web-push.ts` sends it.
//
// T-10: account-side only, keyed by the account and the endpoint, never a
// poll, a decision or anything on the ballot path. T-76: only an endpoint
// on a known push service is kept (`parsePushEndpoint`), at most
// `MAX_PUSH_SUBSCRIPTIONS` an account, so an account can't make our server
// call an address of its choosing or fan one notice out without bound
// (T-52).

import { and, desc, eq, notInArray, sql as q } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { accountPushSubscriptions } from "./db/schema/index.ts";
import { parsePushEndpoint } from "./web-push.ts";

/** The most browsers an account is pushed to: subscribing another drops its oldest. */
export const MAX_PUSH_SUBSCRIPTIONS = 5;

export type SubscribePushResult = "subscribed" | "invalid-endpoint" | "unknown-account";

/**
 * Subscribes the browser behind `endpoint` for `userId` at `now`, taking it
 * from any other account it was subscribed for and dropping the account's
 * oldest beyond `MAX_PUSH_SUBSCRIPTIONS`. Subscribing again renews it.
 */
export async function subscribePush(
  client: Sql,
  userId: string,
  endpoint: string,
  now: Date,
): Promise<SubscribePushResult> {
  if (parsePushEndpoint(endpoint) !== endpoint) return "invalid-endpoint";
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError("now is no time");
  const s = accountPushSubscriptions;
  for (let attempt = 1; ; attempt++) {
    try {
      await drizzle({ client }).transaction(async (tx) => {
        // One subscribe at a time per account, so two side by side can't
        // both keep their own insert past the cap.
        await tx.execute(q`SELECT pg_advisory_xact_lock(hashtext(${`push:${userId}`}))`);
        await tx.delete(s).where(eq(s.endpoint, endpoint));
        await tx.insert(s).values({ endpoint, userId, createdAt: now });
        const kept = tx
          .select({ endpoint: s.endpoint })
          .from(s)
          .where(eq(s.userId, userId))
          .orderBy(desc(s.createdAt), desc(s.endpoint))
          .limit(MAX_PUSH_SUBSCRIPTIONS);
        await tx.delete(s).where(and(eq(s.userId, userId), notInArray(s.endpoint, kept)));
      });
      return "subscribed";
    } catch (e) {
      // Drizzle wraps the driver's error, which carries the code.
      const code = (e as { cause?: { code?: unknown } } | null)?.cause?.code;
      // The account went between its session's read and here.
      if (code === "23503") return "unknown-account";
      // The same endpoint subscribed for another account side by side: the
      // delete sees that one's row the next time.
      if (code !== "23505" || attempt === 3) throw e;
    }
  }
}

/** Unsubscribes `endpoint` from `userId`'s pushes; `false` if it wasn't that account's. */
export async function unsubscribePush(
  client: Sql,
  userId: string,
  endpoint: string,
): Promise<boolean> {
  const s = accountPushSubscriptions;
  const gone = await drizzle({ client })
    .delete(s)
    .where(and(eq(s.userId, userId), eq(s.endpoint, endpoint)))
    .returning({ endpoint: s.endpoint });
  return gone.length > 0;
}

/**
 * Whether `endpoint` is subscribed for `userId`: the account page asks so a
 * browser another account subscribed isn't shown as this one's (an endpoint
 * belongs to one account at a time).
 */
export async function pushSubscribed(
  client: Sql,
  userId: string,
  endpoint: string,
): Promise<boolean> {
  const s = accountPushSubscriptions;
  const rows = await drizzle({ client })
    .select({ endpoint: s.endpoint })
    .from(s)
    .where(and(eq(s.userId, userId), eq(s.endpoint, endpoint)));
  return rows.length > 0;
}
