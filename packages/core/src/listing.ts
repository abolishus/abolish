// Discovery: the polls our front ends list (docs/moderation-policy.md,
// Actions). A poll is listed while its newest moderation decision, if any,
// restores it; a delisted or hidden poll is left out, though its definition,
// board and moderation state stay served to anyone who has its ID. Listing is
// a front-end courtesy, never a source of truth: a poll left out here still
// verifies from chain + IPFS (G-9), and anyone can enumerate the registry's
// events to find every poll (T-68).
//
// The stream's ways in (P2-23) are sorts over public data only: the
// registry's order, the definition's own times and, for `answered`, a count
// of the public board. None reads anything an account did, so none is
// personalised, and the one count is of distinct voters, never of views,
// reactions or shares.

import type { PeriodClock } from "@abolishus/crypto";
import { and, asc, desc, eq, gt, lte, or, sql as q } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { isBytes } from "./bytes.ts";
import {
  boardBallotKeys,
  boardEntries,
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
 * the polls open now, the soonest to close first. `answered`: the polls open
 * now, the most answered in the last week first.
 */
export const LISTING_SORTS = ["id", "new", "closing", "answered"] as const;

/** `answered`'s window: the anchoring periods ending in the last seven days. */
export const ANSWERED_WINDOW_SECONDS = 7n * 24n * 3600n;

export type ListingOrder =
  | { readonly sort: "id" }
  /** `now` in UNIX seconds, compared with each definition's `opens_at` and `closes_at`. */
  | { readonly sort: "new" | "closing"; readonly now: bigint }
  /** `clock`: the anchoring clock by which our boards label each entry's segment. */
  | { readonly sort: "answered"; readonly now: bigint; readonly clock: PeriodClock };

export class ListingError extends Error {
  override readonly name = "ListingError";
  /** The cursor names no poll the order can place: none stored, or none registered for `new`. */
  readonly code = "unknown-cursor";
  constructor() {
    super("listing refused: unknown-cursor");
  }
}

const U64_MAX = (1n << 64n) - 1n;
const MAX_SEGMENT = 2n ** 32n - 1n;

/**
 * The segments `answered` counts at `now`: the last whole periods covering
 * `ANSWERED_WINDOW_SECONDS`, up to the one before `now`'s. The current period
 * is left out, so the order moves once a period, not with each ballot, and
 * the counts are of segments every board copy will hold once anchored.
 * `from > to` is an empty window (before the clock's epoch, say).
 */
export function answeredWindow(now: bigint, clock: PeriodClock): { from: bigint; to: bigint } {
  if (typeof now !== "bigint" || now < 0n || now > U64_MAX)
    throw new TypeError("now must be a u64 bigint");
  if (
    typeof clock !== "object" ||
    clock === null ||
    typeof clock.epoch !== "bigint" ||
    clock.epoch < 0n ||
    clock.epoch > U64_MAX ||
    typeof clock.period !== "bigint" ||
    clock.period < 1n ||
    clock.period > U64_MAX
  )
    throw new TypeError("clock must be a u64 epoch and a period of at least 1");
  if (now < clock.epoch) return { from: 0n, to: -1n };
  const current = (now - clock.epoch) / clock.period;
  const periods = (ANSWERED_WINDOW_SECONDS + clock.period - 1n) / clock.period;
  const to = current - 1n;
  const from = current > periods ? current - periods : 0n;
  // Board segments are u32s: past the last one, nothing is counted.
  return from > MAX_SEGMENT
    ? { from: 0n, to: -1n }
    : { from, to: to > MAX_SEGMENT ? MAX_SEGMENT : to };
}

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
 *
 * Under `answered` the polls open at `now` are ordered by how many voters
 * answered in `answeredWindow`, most first, then by election ID: the
 * distinct (tier, nullifier) pairs of the ballots boarded in those
 * segments. A re-vote is the same voter again, so a voter counts once
 * however often they cast, and a poll climbs only by more voters (T-01).
 * Every input is on the public board, where each entry already carries its
 * segment, so the count keeps no time of its own and anyone can recompute it
 * from a copy of the board (T-11). The cursor is a stored poll placed by its
 * count now; a poll whose count crosses the cursor's between pages may be
 * seen twice or not at all, which the period-long window keeps rare.
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
  const window = order.sort === "answered" ? answeredWindow(order.now, order.clock) : undefined;
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

  if (window !== undefined) {
    // Voters, not ballots: each (tier, nullifier) once, through the keys
    // the board stores with each ballot it boards, and the entries'
    // segments through board_entries_by_segment.
    const answered = q<number>`(SELECT count(*)::int FROM (SELECT DISTINCT ${boardBallotKeys.tier}, ${boardBallotKeys.nullifier} FROM ${boardBallotKeys} JOIN ${boardEntries} ON ${boardEntries.electionId} = ${boardBallotKeys.electionId} AND ${boardEntries.idx} = ${boardBallotKeys.idx} WHERE ${boardBallotKeys.electionId} = ${electionDefinitions.electionId} AND ${boardEntries.segment} BETWEEN ${window.from} AND ${window.to}) AS voters)`;
    let from;
    if (cursor !== undefined) {
      const [at] = await db
        .select({ answered })
        .from(electionDefinitions)
        .innerJoin(
          electionSchedules,
          eq(electionSchedules.electionId, electionDefinitions.electionId),
        )
        .where(eq(electionDefinitions.electionId, cursor));
      if (at === undefined) throw new ListingError();
      from = { answered: at.answered, cursor };
    }
    const ranked = db.$with("ranked").as(
      db
        .select({ electionId: electionDefinitions.electionId, answered: answered.as("answered") })
        .from(electionDefinitions)
        .innerJoin(
          electionSchedules,
          eq(electionSchedules.electionId, electionDefinitions.electionId),
        )
        .where(and(open, listed)),
    );
    const rows = await db
      .with(ranked)
      .select({ electionId: ranked.electionId })
      .from(ranked)
      .where(
        from === undefined
          ? undefined
          : or(
              q`${ranked.answered} < ${from.answered}`,
              and(q`${ranked.answered} = ${from.answered}`, gt(ranked.electionId, from.cursor)),
            ),
      )
      .orderBy(desc(ranked.answered), asc(ranked.electionId))
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
    // As text: postgres.js would send a bigint as int8, which can't hold a
    // u64 from 2^63 up, before the cast.
    from = q`(${electionSchedules.closesAt}, ${electionSchedules.electionId}) > (${at.closesAt.toString()}::numeric, ${cursor})`;
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
