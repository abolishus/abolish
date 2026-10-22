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
// T-10: the row names an election and its two tags. The fill reads the
// author's record of a poll it opened, as the opening step does, and writes
// nothing about an account or anything a voter did.

import { and, asc, eq, gt, isNull, or, sql as q } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { isBytes } from "./bytes.ts";
import { accountPolls, pollTags } from "./db/schema/index.ts";
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
 * Writes `electionId`'s tags, unless it has a row already: the first tags
 * written for a poll are the ones it was filed under. A draft with neither
 * tag writes nothing. Refuses tags `pollDraftProblem` would (a `TypeError`):
 * every draft write checks them, so a stored draft holding others is
 * malformed.
 */
export async function insertPollTags(
  client: Sql,
  electionId: Uint8Array,
  tags: PollTags,
): Promise<void> {
  if (!isBytes(electionId) || electionId.length !== 32)
    throw new TypeError("electionId must be 32 bytes");
  const { topic, place } = tags;
  if (topic === undefined && place === undefined) return;
  if (topic !== undefined && !(POLL_TOPICS as readonly unknown[]).includes(topic))
    throw new TypeError("topic is not one of POLL_TOPICS");
  let key: string | undefined;
  if (place !== undefined) {
    if (!placeIsWellFormed(place)) throw new TypeError("place is not well formed");
    key = placeKey(place);
    if (key === undefined) throw new TypeError("place has no key");
  }
  await drizzle({ client })
    .insert(pollTags)
    .values({
      electionId: new Uint8Array(electionId),
      topic: topic ?? null,
      place: place ?? null,
      placeKey: key ?? null,
    })
    .onConflictDoNothing({ target: pollTags.electionId });
}

/** How many polls `fillPollTags` reads at a time. */
const FILL_BATCH = 100;

/**
 * Writes the tags of every open poll whose draft has a tag and which has no
 * row: those opened before migration 0035 added the table, or by an opening
 * step interrupted between its writes. Returns how many it wrote.
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
      const draft = row.draft as PollTags;
      await insertPollTags(client, Uint8Array.from(row.electionId as Uint8Array), {
        ...(draft.topic === undefined ? {} : { topic: draft.topic }),
        ...(draft.place === undefined ? {} : { place: draft.place }),
      });
      written++;
      after = row.id;
    }
    if (rows.length < FILL_BATCH) return written;
  }
}
