// Discovery: the polls our front ends list (docs/moderation-policy.md,
// Actions). A poll is listed while its newest moderation decision, if any,
// restores it; a delisted or hidden poll is left out, though its definition,
// board and moderation state stay served to anyone who has its ID. Listing is
// a front-end courtesy, never a source of truth: a poll left out here still
// verifies from chain + IPFS (G-9), and anyone can enumerate the registry's
// events to find every poll (T-68).
//
// The stream's ways in (P2-23) are sorts over public chain data only: the
// registry's order and the definition's own times. None reads a ballot, the
// board or anything an account did, so no order can be bought by answering,
// and none is personalised or ranked by engagement.

import { and, asc, desc, eq, gt, lte, sql as q } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { isBytes } from "./bytes.ts";
import {
  electionDefinitions,
  electionRegistrations,
  electionSchedules,
  moderationActions,
} from "./db/schema/index.ts";

/** The most polls one page of the listing returns. */
export const MAX_LISTING_PAGE = 1000;

/**
 * The listing's orders. `id`: every listed poll, open or not, by election ID.
 * `new`: the polls open now, the latest registered on L2 first. `closing`:
 * the polls open now, the soonest to close first.
 */
export const LISTING_SORTS = ["id", "new", "closing"] as const;

export type ListingOrder =
  | { readonly sort: "id" }
  /** `now` in UNIX seconds, compared with each definition's `opens_at` and `closes_at`. */
  | { readonly sort: "new" | "closing"; readonly now: bigint };

export class ListingError extends Error {
  override readonly name = "ListingError";
  /** The cursor names no poll the order can place: none stored, or none registered for `new`. */
  readonly code = "unknown-cursor";
  constructor() {
    super("listing refused: unknown-cursor");
  }
}

const U64_MAX = (1n << 64n) - 1n;

/**
 * Up to `limit` listed polls after the poll `after` in `order` (or from the
 * first, without it). Fewer than `limit` means the listing ends there for
 * now.
 *
 * Under `id` the order is ascending election ID: an order nobody can choose
 * to put a poll first, since an election ID is a hash. A poll stored or
 * restored later below the cursor is seen on the next pass from the start,
 * and the cursor need not be a stored poll.
 *
 * Under `new` and `closing` only polls open at `now` (`opens_at ≤ now <
 * closes_at`) are listed. `new` takes the registry's order backwards, by L2
 * block and log index, and lists only polls whose registration is recorded;
 * `closing` takes `closes_at`, then election ID. Each is a public fact of the
 * chain the creator fixed at registration, so the order is the same for
 * everyone. The cursor must be a stored poll the order can place (a
 * `ListingError` otherwise), though it may since have closed, been delisted
 * or been hidden.
 */
export async function listPolls(
  client: Sql,
  after: Uint8Array | undefined,
  limit: number,
  order: ListingOrder = { sort: "id" },
): Promise<Uint8Array[]> {
  if (after !== undefined && (!isBytes(after) || after.length !== 32))
    throw new TypeError("after must be 32 bytes");
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LISTING_PAGE)
    throw new TypeError(`limit must be an integer from 1 to ${MAX_LISTING_PAGE}`);
  if (!(LISTING_SORTS as readonly unknown[]).includes(order.sort))
    throw new TypeError(`sort must be one of ${LISTING_SORTS.join(", ")}`);
  if (
    order.sort !== "id" &&
    (typeof order.now !== "bigint" || order.now < 0n || order.now > U64_MAX)
  )
    throw new TypeError("now must be a u64 bigint");
  const cursor = after === undefined ? undefined : new Uint8Array(after);
  const db = drizzle({ client });
  // The newest decision about each poll, through moderation_actions_by_election.
  const newest = db
    .select({ action: moderationActions.action })
    .from(moderationActions)
    .where(eq(moderationActions.electionId, electionDefinitions.electionId))
    .orderBy(desc(moderationActions.seq))
    .limit(1);
  const listed = q`coalesce((${newest}), 'restore') = 'restore'`;

  if (order.sort === "id") {
    const rows = await db
      .select({ electionId: electionDefinitions.electionId })
      .from(electionDefinitions)
      .where(
        cursor === undefined ? listed : and(gt(electionDefinitions.electionId, cursor), listed),
      )
      .orderBy(asc(electionDefinitions.electionId))
      .limit(limit);
    return rows.map((r) => new Uint8Array(r.electionId));
  }

  const open = and(
    lte(electionSchedules.opensAt, order.now),
    gt(electionSchedules.closesAt, order.now),
  );

  if (order.sort === "new") {
    let from;
    if (cursor !== undefined) {
      const [at] = await db
        .select({
          l2Block: electionRegistrations.l2Block,
          logIndex: electionRegistrations.logIndex,
        })
        .from(electionRegistrations)
        .innerJoin(
          electionDefinitions,
          eq(electionDefinitions.electionId, electionRegistrations.electionId),
        )
        .where(eq(electionRegistrations.electionId, cursor));
      if (at === undefined) throw new ListingError();
      from = q`(${electionRegistrations.l2Block}, ${electionRegistrations.logIndex}) < (${at.l2Block}, ${at.logIndex})`;
    }
    const rows = await db
      .select({ electionId: electionDefinitions.electionId })
      .from(electionDefinitions)
      .innerJoin(
        electionRegistrations,
        eq(electionRegistrations.electionId, electionDefinitions.electionId),
      )
      .innerJoin(
        electionSchedules,
        eq(electionSchedules.electionId, electionDefinitions.electionId),
      )
      .where(and(open, listed, from))
      .orderBy(desc(electionRegistrations.l2Block), desc(electionRegistrations.logIndex))
      .limit(limit);
    return rows.map((r) => new Uint8Array(r.electionId));
  }

  let from;
  if (cursor !== undefined) {
    const [at] = await db
      .select({ closesAt: electionSchedules.closesAt })
      .from(electionSchedules)
      .where(eq(electionSchedules.electionId, cursor));
    if (at === undefined) throw new ListingError();
    from = q`(${electionSchedules.closesAt}, ${electionSchedules.electionId}) > (${at.closesAt}::numeric, ${cursor})`;
  }
  const rows = await db
    .select({ electionId: electionDefinitions.electionId })
    .from(electionDefinitions)
    .innerJoin(electionSchedules, eq(electionSchedules.electionId, electionDefinitions.electionId))
    .where(and(open, listed, from))
    .orderBy(asc(electionSchedules.closesAt), asc(electionSchedules.electionId))
    .limit(limit);
  return rows.map((r) => new Uint8Array(r.electionId));
}
