// A poll's listing tags ([[0041-poll-topics-and-places]]; P2-26 part 1c): the
// topic and place its author chose on the draft, carried to poll_tags
// (migrations/0035_poll_tags.sql) when the poll opens, so the listing can
// filter by them (src/listing.ts). They are the listing's, never words of the
// poll: the definition doesn't commit to them, so nothing a verifier checks
// reads them, and a wipe loses them but no result (T-53, T-68).
//
// A place is matched as search matches text (rule 2): NFKC, lower case, and
// single-spaced, by equality, so "Riverside" and "RIVERSIDE" are one place's
// page. Nothing ranks one tagged poll over another.
//
// After the opening step files a poll, only moderation changes its tags
// (rule 3): `refilePoll` sets them under a ground, in the moderation log
// (migrations/0036; T-68).
//
// T-10: the row names an election and its two tags. The fill reads the
// author's record of a poll it opened, as the opening step does, and writes
// nothing about an account or anything a voter did.

import { and, asc, eq, gt, isNull, or, sql as q } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { isBytes } from "./bytes.ts";
import { accountPolls, electionDefinitions, pollTagActions, pollTags } from "./db/schema/index.ts";
import {
  createdBy,
  HANDLE,
  lockModeration,
  ModerationError,
  type ModerationState,
  moderatorAccount,
  type ModerationTx,
  REMOVAL_REASONS,
  statusOf,
} from "./moderation.ts";
import {
  MAX_PLACE_LENGTH,
  placeIsWellFormed,
  POLL_TOPICS,
  type PollTopic,
} from "./poll-draft-rules.ts";
import { normalizeSearchText } from "./search.ts";

/** A draft's tags, as `PollDraft` holds them. */
export interface PollTags {
  readonly topic?: PollTopic;
  readonly place?: string;
}

const spaced = (s: string) => s.replace(/\s+/gu, " ").trim();

/**
 * The key a place is matched by: `place` single-spaced, then NFKC and lower
 * case (`normalizeSearchText`), single-spaced again. `undefined` for one no
 * stored place could match: blank, or longer than `MAX_PLACE_LENGTH` code
 * points once single-spaced. A well-formed place and the same place typed
 * with other spacing or case have one key.
 */
export function placeKey(place: string): string | undefined {
  if (typeof place !== "string") throw new TypeError("place must be a string");
  const tidy = spaced(place);
  if (tidy === "" || Array.from(tidy).length > MAX_PLACE_LENGTH) return undefined;
  const key = spaced(normalizeSearchText(tidy));
  return key === "" ? undefined : key;
}

/**
 * The tags of a stored draft that a draft can hold: its topic if one of
 * `POLL_TOPICS`, its place if `placeIsWellFormed`. Every draft write checks
 * them, so a stored draft holding others is malformed; a malformed tag is
 * left out rather than refused, since a listing tag must never stop a
 * registered poll opening ([[0041-poll-topics-and-places]], rule 4).
 */
export function storedPollTags(draft: unknown): PollTags {
  if (typeof draft !== "object" || draft === null) return {};
  const { topic, place } = draft as { topic?: unknown; place?: unknown };
  return {
    ...((POLL_TOPICS as readonly unknown[]).includes(topic) ? { topic: topic as PollTopic } : {}),
    ...(typeof place === "string" && placeIsWellFormed(place) && placeKey(place) !== undefined
      ? { place }
      : {}),
  };
}

/** Why `tags` are tags no draft could hold, or `undefined` if a draft could. */
function tagsProblem(tags: PollTags): string | undefined {
  if (typeof tags !== "object" || tags === null) return "tags must be an object";
  const { topic, place } = tags;
  if (topic !== undefined && !(POLL_TOPICS as readonly unknown[]).includes(topic))
    return "topic is not one of POLL_TOPICS";
  if (place === undefined) return undefined;
  if (!placeIsWellFormed(place)) return "place is not well formed";
  if (placeKey(place) === undefined) return "place has no key";
  return undefined;
}

function checkElectionId(electionId: unknown): asserts electionId is Uint8Array {
  if (!isBytes(electionId) || electionId.length !== 32)
    throw new TypeError("electionId must be 32 bytes");
}

/** `tags` as a row of `poll_tags` holds them, for tags `tagsProblem` passes. */
const columns = ({ topic, place }: PollTags) => ({
  topic: topic ?? null,
  place: place ?? null,
  placeKey: place === undefined ? null : (placeKey(place) ?? null),
});

/**
 * Writes `electionId`'s tags, unless it has a row already: the first tags
 * written for a poll are the ones it was filed under, and only `refilePoll`
 * changes them. Tags with neither write nothing. Refuses tags
 * `pollDraftProblem` would (a `TypeError`). Returns whether a row was
 * written.
 */
export async function insertPollTags(
  client: Sql,
  electionId: Uint8Array,
  tags: PollTags,
): Promise<boolean> {
  checkElectionId(electionId);
  const problem = tagsProblem(tags);
  if (problem !== undefined) throw new TypeError(problem);
  if (tags.topic === undefined && tags.place === undefined) return false;
  const written = await drizzle({ client })
    .insert(pollTags)
    .values({ electionId: new Uint8Array(electionId), ...columns(tags) })
    .onConflictDoNothing({ target: pollTags.electionId })
    .returning({ electionId: pollTags.electionId });
  return written.length > 0;
}

/**
 * Grounds for refiling a poll (docs/moderation-policy.md, Refiling):
 * `misfiled`, when its topic or place doesn't fit it (or an earlier refiling
 * got them wrong), or a removal ground its place breaks, such as a street
 * address under `personal-data`.
 */
export const REFILE_REASONS = ["misfiled", ...REMOVAL_REASONS] as const;
export type RefileReason = (typeof REFILE_REASONS)[number];

/** A refiling: the tags a poll is filed under from now, under a ground, by a moderator. */
export interface RefileDecision {
  /** Either tag, both or neither: an absent tag is cleared. */
  readonly tags: PollTags;
  readonly reason: RefileReason;
  readonly moderator: string;
}

/**
 * Files `electionId`'s poll under `decision.tags`, replacing whatever it was
 * filed under (its author's tags, an earlier refiling's, or none), and
 * returns the refiling's log sequence number. Taken under the moderation
 * lock and dated by the database clock, as `moderate` does, so its number
 * orders it among every other decision. The log records only the tags it
 * set, never one it kept or the value it replaced (migration 0036), so a
 * moderator changing only the topic must pass the place back, and it isn't
 * logged. A poll refiled under neither tag
 * keeps an empty row, so a later opening step or `fillPollTags` never puts
 * its author's tags back. Refused, with nothing written, as `moderate`
 * refuses: malformed (`invalid`: tags no draft could hold, a reason outside
 * `REFILE_REASONS`, a bad handle), an election with no stored definition
 * (`unknown-election`), a handle that isn't an active moderator's
 * (`unknown-moderator`), a moderator refiling a poll their account created
 * (`own-poll`), and tags the poll is already filed under (`no-change`; a
 * poll with no row is filed under nothing, so even `{}` files it). As
 * for `moderate`, the app role can write the table directly, so the rules
 * hold for the tooling, not against an insider (T-68).
 */
export async function refilePoll(
  client: Sql,
  electionId: Uint8Array,
  decision: RefileDecision,
): Promise<{ readonly seq: bigint }> {
  checkElectionId(electionId);
  if (
    typeof decision !== "object" ||
    decision === null ||
    !(REFILE_REASONS as readonly unknown[]).includes(decision.reason) ||
    typeof decision.moderator !== "string" ||
    !HANDLE.test(decision.moderator) ||
    tagsProblem(decision.tags) !== undefined
  )
    throw new ModerationError("invalid");
  const id = new Uint8Array(electionId);
  const { reason, moderator } = decision;
  // Only the two tags, whatever else the caller's object carries.
  const tags: PollTags = {
    ...(decision.tags.topic === undefined ? {} : { topic: decision.tags.topic }),
    ...(decision.tags.place === undefined ? {} : { place: decision.tags.place }),
  };
  return drizzle({ client }).transaction(
    async (tx) => {
      await lockModeration(tx);
      const [clock] = await tx.execute<{ now: Date | string }>(q`SELECT clock_timestamp() AS now`);
      // SELECT without FROM yields exactly one row.
      const decidedAt = new Date(clock!.now);
      const [stored] = await tx
        .select({ id: electionDefinitions.electionId })
        .from(electionDefinitions)
        .where(eq(electionDefinitions.electionId, id));
      if (stored === undefined) throw new ModerationError("unknown-election");
      const account = await moderatorAccount(tx, moderator);
      if (account === undefined) throw new ModerationError("unknown-moderator");
      if (await createdBy(tx, id, account)) throw new ModerationError("own-poll");
      // An empty row first, if the poll has none, so an opening step
      // writing its author's tags meanwhile waits for this transaction and
      // then leaves the row alone; then the row, locked, is what this
      // refiling changes.
      const created = await tx
        .insert(pollTags)
        .values({ electionId: id })
        .onConflictDoNothing({ target: pollTags.electionId })
        .returning({ electionId: pollTags.electionId });
      const [current] = await tx
        .select({ topic: pollTags.topic, place: pollTags.place })
        .from(pollTags)
        .where(eq(pollTags.electionId, id))
        .for("update");
      // A poll with no row is filed under nothing yet, so every refiling of
      // it sets both tags, even to none.
      const topicSet = created.length > 0 || (current?.topic ?? undefined) !== tags.topic;
      const placeSet = created.length > 0 || (current?.place ?? undefined) !== tags.place;
      if (!topicSet && !placeSet) throw new ModerationError("no-change");
      await tx.update(pollTags).set(columns(tags)).where(eq(pollTags.electionId, id));
      const [row] = await tx
        .insert(pollTagActions)
        .values({
          // The insert trigger draws `seq` from the poll log's sequence.
          seq: 0n,
          electionId: id,
          // Only what changed: never a kept tag, or the value a set one
          // replaced (migration 0036).
          topicSet,
          topic: topicSet ? (tags.topic ?? null) : null,
          placeSet,
          place: placeSet ? (tags.place ?? null) : null,
          reason,
          moderator,
          decidedAt,
        })
        .returning({ seq: pollTagActions.seq });
      // INSERT … RETURNING yields exactly the one row inserted.
      return { seq: row!.seq };
    },
    // The row must be read after the lock is taken, as `moderate` reads
    // the newest decisions: a snapshot older than the lock could miss a
    // refiling and record one that changes nothing.
    { isolationLevel: "read committed" },
  );
}

/** The largest Postgres `bigint`. */
const INT8_MAX = (1n << 63n) - 1n;

/**
 * One refiling as the public log shows it: everything but the moderator and
 * the place's words. The topic is one of `POLL_TOPICS`, so it can say nothing
 * of anyone; the place is free text, and a place a moderator set may be one a
 * later refiling clears for personal data, so the log says only that it
 * changed or was cleared, and the poll's page shows the place it is filed
 * under now (`readPollTags`; T-17, T-68).
 */
export interface PublicRefilingEntry {
  readonly seq: bigint;
  readonly electionId: Uint8Array;
  readonly reason: RefileReason;
  readonly decidedAt: Date;
  /** The topic it filed the poll under, `null` if it cleared it; absent if it kept it. */
  readonly topic?: PollTopic | null;
  /** Absent if it kept the place. */
  readonly place?: "changed" | "cleared";
}

/**
 * Up to `limit` refilings with a sequence number above `after`, oldest first,
 * in a transaction the caller holds, with arguments it has checked: the
 * refilings' half of the public log (`readPublicModerationLog`).
 */
export async function refilingLogOf(
  db: Pick<ModerationTx, "select">,
  after: bigint,
  limit: number,
): Promise<PublicRefilingEntry[]> {
  // Past the largest Postgres `bigint` there is nothing, and Postgres would
  // refuse the comparison rather than say so.
  if (after >= INT8_MAX) return [];
  const t = pollTagActions;
  const rows = await db
    .select({
      seq: t.seq,
      electionId: t.electionId,
      topicSet: t.topicSet,
      topic: t.topic,
      placeSet: t.placeSet,
      placeCleared: q<boolean>`${t.place} IS NULL`,
      reason: t.reason,
      decidedAt: t.decidedAt,
    })
    .from(t)
    .where(gt(t.seq, after))
    .orderBy(asc(t.seq))
    .limit(limit);
  return rows.map((r) => ({
    seq: r.seq,
    electionId: new Uint8Array(r.electionId),
    // The table's check admits only `REFILE_REASONS`, and only `refilePoll`
    // writes rows, with tags `tagsProblem` passed.
    reason: r.reason as RefileReason,
    decidedAt: r.decidedAt,
    ...(r.topicSet ? { topic: (r.topic ?? null) as PollTopic | null } : {}),
    ...(r.placeSet ? { place: r.placeCleared ? ("cleared" as const) : ("changed" as const) } : {}),
  }));
}

/** The tags `electionId`'s poll is filed under: none if it has no row. */
async function tagsOf(db: Pick<ModerationTx, "select">, electionId: Uint8Array): Promise<PollTags> {
  const [row] = await db
    .select({ topic: pollTags.topic, place: pollTags.place })
    .from(pollTags)
    .where(eq(pollTags.electionId, electionId));
  return {
    // Only `insertPollTags` and `refilePoll` write rows, each with tags
    // `tagsProblem` passed.
    ...(row?.topic == null ? {} : { topic: row.topic as PollTopic }),
    ...(row?.place == null ? {} : { place: row.place }),
  };
}

/** A poll's moderation state and, unless it is hidden, the tags it is filed under. */
export interface PollTagsView {
  readonly state: ModerationState;
  /** Absent while the poll is hidden: a place is the author's words (T-68). */
  readonly tags?: PollTags;
}

/**
 * The tags `electionId`'s poll is filed under, for its page: withheld while
 * it is hidden, as its text is, and shown while delisted, as its text is
 * to anyone with the link. `undefined` for an election with no stored
 * definition. Read from one snapshot, so the tags shown are never those of
 * a poll hidden since the state was read.
 */
export async function readPollTags(
  client: Sql,
  electionId: Uint8Array,
): Promise<PollTagsView | undefined> {
  checkElectionId(electionId);
  const id = new Uint8Array(electionId);
  return drizzle({ client }).transaction(
    async (tx) => {
      const [stored] = await tx
        .select({ id: electionDefinitions.electionId })
        .from(electionDefinitions)
        .where(eq(electionDefinitions.electionId, id));
      if (stored === undefined) return undefined;
      const { state } = await statusOf(tx, id);
      return state === "hidden" ? { state } : { state, tags: await tagsOf(tx, id) };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/** How many polls `fillPollTags` reads at a time. */
const FILL_BATCH = 100;

/**
 * Writes the tags of every open poll whose draft has a tag and which has no
 * row: those opened before migration 0035 added the table, or by an opening
 * step interrupted between its writes. Returns how many it wrote; a draft
 * whose tags are all malformed (`storedPollTags`) writes none.
 */
export async function fillPollTags(client: Sql): Promise<number> {
  const db = drizzle({ client });
  let written = 0;
  let after = "";
  for (;;) {
    const rows = await db
      .select({
        id: accountPolls.id,
        electionId: accountPolls.electionId,
        draft: accountPolls.draft,
      })
      .from(accountPolls)
      .leftJoin(pollTags, eq(pollTags.electionId, accountPolls.electionId))
      .where(
        and(
          eq(accountPolls.state, "open"),
          isNull(pollTags.electionId),
          or(q`${accountPolls.draft} ? 'topic'`, q`${accountPolls.draft} ? 'place'`),
          gt(accountPolls.id, after),
        ),
      )
      .orderBy(asc(accountPolls.id))
      .limit(FILL_BATCH);
    for (const row of rows) {
      // An open poll has its identifier: the table requires one outside
      // `drafted`, `submitted` and `failed`.
      if (
        await insertPollTags(
          client,
          Uint8Array.from(row.electionId as Uint8Array),
          storedPollTags(row.draft),
        )
      )
        written++;
      after = row.id;
    }
    if (rows.length < FILL_BATCH) return written;
  }
}
