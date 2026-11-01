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
// reactions or shares. Search (src/search.ts) and the listing tags
// (src/poll-tags.ts) only filter an order: they rank nothing.

import type { PeriodClock } from "@abolishus/crypto";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  lt,
  lte,
  or,
  sql as q,
} from "drizzle-orm";
import { bytesToHex } from "@noble/hashes/utils.js";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { isBytes } from "./bytes.ts";
import { POLL_TOPICS, type PollTopic } from "./poll-draft-rules.ts";
import { MAX_LISTED_POLLS } from "./poll-drafts.ts";
import { MAX_SEARCH_TERMS } from "./search.ts";
import {
  boardBallotKeys,
  boardEntries,
  displayTextSearch,
  electionDefinitions,
  electionRegistrations,
  electionSchedules,
  moderationActions,
  pollTags,
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

/**
 * The listing's tag filters ([[0041-poll-topics-and-places]]): a topic, and a
 * place by its key (`placeKey`).
 */
export interface ListingTags {
  readonly topic?: PollTopic;
  readonly placeKey?: string;
}

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
 * is left out, so the order settles once a period rather than moving with
 * each ballot: only a ballot labelled just before a boundary and boarded just
 * after it still lands in the window late.
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
 * Whether the row's poll is listed: its newest moderation decision, if any,
 * restores it (through moderation_actions_by_election).
 */
function restoredPoll(db: ReturnType<typeof drizzle>) {
  const newest = db
    .select({ action: moderationActions.action })
    .from(moderationActions)
    .where(eq(moderationActions.electionId, electionDefinitions.electionId))
    .orderBy(desc(moderationActions.seq))
    .limit(1);
  return q`coalesce((${newest}), 'restore') = 'restore'`;
}

/** Refuses search terms and tags `listPolls` and `listPollsBefore` can't take. */
function checkFilters(terms: readonly string[], tags: ListingTags): void {
  if (
    !Array.isArray(terms) ||
    terms.length > MAX_SEARCH_TERMS ||
    !terms.every((t) => typeof t === "string" && t !== "")
  )
    throw new TypeError(`terms must be up to ${MAX_SEARCH_TERMS} non-empty strings`);
  if (
    typeof tags !== "object" ||
    tags === null ||
    (tags.topic !== undefined && !(POLL_TOPICS as readonly unknown[]).includes(tags.topic)) ||
    (tags.placeKey !== undefined && (typeof tags.placeKey !== "string" || tags.placeKey === ""))
  )
    throw new TypeError("tags must be a topic of POLL_TOPICS and a non-empty place key");
}

/**
 * The listing's condition on a poll's row: listed (`restoredPoll`), its text
 * holding every term and filed under the tags.
 */
function listedWhere(db: ReturnType<typeof drizzle>, terms: readonly string[], tags: ListingTags) {
  const restored = restoredPoll(db);
  // Every term somewhere in the text, through the row's primary key.
  const matched =
    terms.length === 0
      ? undefined
      : exists(
          db
            .select({ one: q`1` })
            .from(displayTextSearch)
            .where(
              and(
                eq(displayTextSearch.electionId, electionDefinitions.electionId),
                ...terms.map((t) => q`strpos(${displayTextSearch.searchText}, ${t}) > 0`),
              ),
            ),
        );
  // The poll's row, through its primary key.
  const tagged =
    tags.topic === undefined && tags.placeKey === undefined
      ? undefined
      : exists(
          db
            .select({ one: q`1` })
            .from(pollTags)
            .where(
              and(
                eq(pollTags.electionId, electionDefinitions.electionId),
                tags.topic === undefined ? undefined : eq(pollTags.topic, tags.topic),
                tags.placeKey === undefined ? undefined : eq(pollTags.placeKey, tags.placeKey),
              ),
            ),
        );
  return and(restored, matched, tagged);
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
 * from a copy of the board, counting the ballots our API boarded (T-11).
 * Direct-submitted ballots, boarded as contract events, aren't counted yet.
 * The cursor is a stored poll placed by its count now; a poll whose count
 * crosses the cursor's between pages may be seen twice or not at all.
 *
 * Each call counts every open poll's ballots in the window, whatever
 * `limit` is: a cost the API's slots and deadline bound (T-52), until the
 * counts, which change only around each period's boundary, are cached.
 *
 * With `terms` (from `searchTerms`), only the polls whose search text
 * contains every term are listed, in the same order; the cursor is placed as
 * without them, so it need not match. A poll whose display text was never
 * stored, or has been deleted, matches no search.
 *
 * With `tags`, only the polls filed under that topic, or at the place with
 * that key, or both, are listed, in the same order and with the cursor
 * placed as without them. An untagged poll matches no tag filter.
 */
export async function listPolls(
  client: Sql,
  after: Uint8Array | undefined,
  limit: number,
  order: ListingOrder = { sort: "id" },
  terms: readonly string[] = [],
  tags: ListingTags = {},
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
  checkFilters(terms, tags);
  const window = order.sort === "answered" ? answeredWindow(order.now, order.clock) : undefined;
  const cursor = after === undefined ? undefined : new Uint8Array(after);
  const db = drizzle({ client });
  const listed = listedWhere(db, terms, tags);

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
    // the board stores with each ballot it boards. Driven from the poll's
    // entries in the window, which board_entries_by_segment reaches by range.
    const answered = q<number>`(SELECT count(*)::int FROM (SELECT DISTINCT ${boardBallotKeys.tier}, ${boardBallotKeys.nullifier} FROM ${boardEntries} JOIN ${boardBallotKeys} ON ${boardBallotKeys.electionId} = ${boardEntries.electionId} AND ${boardBallotKeys.idx} = ${boardEntries.idx} WHERE ${boardEntries.electionId} = ${electionDefinitions.electionId} AND ${boardEntries.segment} BETWEEN ${window.from} AND ${window.to}) AS voters)`;
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

/**
 * Up to `limit` listed polls just before `before` in the `id` order, in
 * that order (ascending election ID): the page a reader of a later page
 * turns back to, filtered by `terms` and `tags` as `listPolls` filters it.
 * Fewer than `limit` means none earlier. Like `after`, `before` need not be
 * a stored poll. Only the `id` order reads backward: the others are of polls
 * open now and move as they open, close or are answered, so a page back from
 * a cursor would not be the page a reader came forward through (T-68).
 */
export async function listPollsBefore(
  client: Sql,
  before: Uint8Array,
  limit: number,
  terms: readonly string[] = [],
  tags: ListingTags = {},
): Promise<Uint8Array[]> {
  if (!isBytes(before) || before.length !== 32) throw new TypeError("before must be 32 bytes");
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LISTING_PAGE)
    throw new TypeError(`limit must be an integer from 1 to ${MAX_LISTING_PAGE}`);
  checkFilters(terms, tags);
  const db = drizzle({ client });
  // Backward through the primary key, then turned round.
  const rows = await db
    .select({ electionId: electionDefinitions.electionId })
    .from(electionDefinitions)
    .where(
      and(lt(electionDefinitions.electionId, new Uint8Array(before)), listedWhere(db, terms, tags)),
    )
    .orderBy(desc(electionDefinitions.electionId))
    .limit(limit);
  return rows.map((r) => new Uint8Array(r.electionId)).toReversed();
}

/** How many voters a poll's board holds in one tier. */
export interface TierAnswered {
  readonly tier: number;
  readonly voters: bigint;
}

/**
 * How many voters have answered `electionId`'s poll so far, tier by tier
 * (ascending, only tiers with a voter): the distinct (tier, nullifier)
 * pairs of the ballots our board holds, so a re-vote never counts twice, as
 * `answered`'s order counts them. Tiers are never added together, since one
 * figure would mostly report whoever opened the most accounts (T-01). The
 * count is of the public board, which anyone can recount, and says nothing
 * a reader of the board can't already see (T-10, T-11). `undefined` for an
 * election with no stored definition. Delisting and hiding withhold
 * nothing here, as they withhold nothing of the board (T-68).
 */
export async function answeredByTier(
  client: Sql,
  electionId: Uint8Array,
): Promise<readonly TierAnswered[] | undefined> {
  const [answered] = await answeredByTiers(client, [electionId]);
  return answered;
}

/** The most elections `answeredByTiers` reads at once: as many as an account's list of polls holds. */
export const MAX_ANSWERED_ELECTIONS = MAX_LISTED_POLLS;

/**
 * `answeredByTier` for each of `electionIds` (1 to `MAX_ANSWERED_ELECTIONS`
 * distinct IDs), in their order, from one snapshot and one statement over
 * the board's keys, so a page that shows several polls' counts costs one
 * read rather than one per poll (T-52). Each election's tiers stay on their
 * own (T-01), and an election with no stored definition is `undefined`.
 */
export async function answeredByTiers(
  client: Sql,
  electionIds: readonly Uint8Array[],
): Promise<(readonly TierAnswered[] | undefined)[]> {
  if (
    !Array.isArray(electionIds) ||
    electionIds.length === 0 ||
    electionIds.length > MAX_ANSWERED_ELECTIONS
  )
    throw new TypeError(`electionIds must hold 1 to ${MAX_ANSWERED_ELECTIONS} IDs`);
  for (const id of electionIds)
    if (!isBytes(id) || id.length !== 32) throw new TypeError("electionId must be 32 bytes");
  const ids = electionIds.map((id) => new Uint8Array(id));
  const hexes = ids.map(bytesToHex);
  if (new Set(hexes).size !== hexes.length) throw new TypeError("electionIds must be distinct");
  return drizzle({ client }).transaction(
    async (tx) => {
      const stored = await tx
        .select({ id: electionDefinitions.electionId })
        .from(electionDefinitions)
        .where(inArray(electionDefinitions.electionId, ids));
      // The keys' primary key leads with (election, tier, nullifier), so
      // this reads each poll's own keys by range.
      const rows = await tx
        .select({
          id: boardBallotKeys.electionId,
          tier: boardBallotKeys.tier,
          voters: q<string>`count(DISTINCT ${boardBallotKeys.nullifier})::text`,
        })
        .from(boardBallotKeys)
        .where(inArray(boardBallotKeys.electionId, ids))
        .groupBy(boardBallotKeys.electionId, boardBallotKeys.tier)
        .orderBy(asc(boardBallotKeys.tier));
      const known = new Set(stored.map((r) => bytesToHex(r.id)));
      const counts = new Map<string, TierAnswered[]>();
      for (const r of rows) {
        const key = bytesToHex(r.id);
        const tiers = counts.get(key) ?? [];
        tiers.push({ tier: r.tier, voters: BigInt(r.voters) });
        counts.set(key, tiers);
      }
      return hexes.map((key) => (known.has(key) ? (counts.get(key) ?? []) : undefined));
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/**
 * How many polls the listing holds at `now` (UNIX seconds): every listed
 * poll, as the `id` order lists them; those open now (`opens_at ≤ now <
 * closes_at`), as `closing` lists them; and those not open yet (`now <
 * opens_at`). A poll whose times aren't stored yet is counted only among
 * the listed. The three come from one statement, so one snapshot, and each
 * is a count of public chain data under the public moderation log, the same
 * for everyone and moved by nothing a voter or an account does (T-68).
 * Anyone can recount them from the registry's events and the log, give or
 * take what this server stores.
 */
export interface ListingCounts {
  readonly listed: bigint;
  readonly open: bigint;
  readonly scheduled: bigint;
}

/** The listing's `ListingCounts` at `now`, as `GET /elections/counts` serves them. */
export async function countListedPolls(client: Sql, now: bigint): Promise<ListingCounts> {
  if (typeof now !== "bigint" || now < 0n || now > U64_MAX)
    throw new TypeError("now must be a u64 bigint");
  const db = drizzle({ client });
  const s = electionSchedules;
  const [row] = await db
    .select({
      listed: q<string>`count(*)::text`,
      // Through the columns' own comparisons, which bind `now` as a numeric:
      // bound bare, it goes as an int8, refused from 2^63 up.
      open: q<string>`(count(*) FILTER (WHERE ${and(lte(s.opensAt, now), gt(s.closesAt, now))}))::text`,
      scheduled: q<string>`(count(*) FILTER (WHERE ${gt(s.opensAt, now)}))::text`,
    })
    .from(electionDefinitions)
    .leftJoin(s, eq(s.electionId, electionDefinitions.electionId))
    .where(restoredPoll(db));
  return {
    listed: BigInt(row?.listed ?? "0"),
    open: BigInt(row?.open ?? "0"),
    scheduled: BigInt(row?.scheduled ?? "0"),
  };
}

/** The most places `listedPlaces` returns. */
export const MAX_LISTED_PLACES = 100;

/**
 * The places listed polls are filed at, as `GET /elections/places` serves
 * them for the register's place box to suggest: one spelling per place key
 * (`placeKey`), the one most of its listed polls carry (the first by code
 * point where they tie), for the `MAX_LISTED_PLACES` keys with the most
 * listed polls (by key where they tie), in order of key. Only listed polls
 * count, so a place filed only on delisted or hidden polls is never
 * suggested, and a hidden poll's place, its author's words, stays withheld
 * (T-68). Like the listing, these are the authors' tags under the public
 * moderation log, the same for everyone and moved by nothing a voter does;
 * a key's count only chooses which places fit, never their order.
 */
export async function listedPlaces(client: Sql): Promise<readonly string[]> {
  const db = drizzle({ client });
  const ranked = db
    .select({
      key: pollTags.placeKey,
      place: q<string>`mode() WITHIN GROUP (ORDER BY ${pollTags.place} COLLATE "C")`.as("place"),
    })
    .from(pollTags)
    .innerJoin(electionDefinitions, eq(electionDefinitions.electionId, pollTags.electionId))
    .where(and(isNotNull(pollTags.placeKey), isNotNull(pollTags.place), restoredPoll(db)))
    .groupBy(pollTags.placeKey)
    .orderBy(desc(q`count(*)`), q`${pollTags.placeKey} COLLATE "C"`)
    .limit(MAX_LISTED_PLACES)
    .as("ranked");
  const rows = await db
    .select({ place: ranked.place })
    .from(ranked)
    .orderBy(q`${ranked.key} COLLATE "C"`);
  return rows.map((r) => r.place);
}
