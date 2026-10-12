// Discovery: the polls our front ends list (docs/moderation-policy.md,
// Actions). A poll is listed while its newest moderation decision, if any,
// restores it; a delisted or hidden poll is left out, though its definition,
// board and moderation state stay served to anyone who has its ID. Listing is
// a front-end courtesy, never a source of truth: a poll left out here still
// verifies from chain + IPFS (G-9), and anyone can enumerate the registry's
// events to find every poll (T-68).

import { and, asc, desc, eq, gt, sql as q } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { isBytes } from "./bytes.ts";
import { electionDefinitions, moderationActions } from "./db/schema/index.ts";

/** The most polls one page of the listing returns. */
export const MAX_LISTING_PAGE = 1000;

/**
 * Up to `limit` listed polls whose election ID is above `after` (or from the
 * first, without it), in ascending order of election ID: an order nobody can
 * choose to put a poll first, since an election ID is a hash. Fewer than
 * `limit` means the listing ends there for now; a poll stored or restored
 * later below the cursor is seen on the next pass from the start.
 */
export async function listPolls(
  client: Sql,
  after: Uint8Array | undefined,
  limit: number,
): Promise<Uint8Array[]> {
  if (after !== undefined && (!isBytes(after) || after.length !== 32))
    throw new TypeError("after must be 32 bytes");
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LISTING_PAGE)
    throw new TypeError(`limit must be an integer from 1 to ${MAX_LISTING_PAGE}`);
  const db = drizzle({ client });
  // The newest decision about each poll, through moderation_actions_by_election.
  const newest = db
    .select({ action: moderationActions.action })
    .from(moderationActions)
    .where(eq(moderationActions.electionId, electionDefinitions.electionId))
    .orderBy(desc(moderationActions.seq))
    .limit(1);
  const listed = q`coalesce((${newest}), 'restore') = 'restore'`;
  const rows = await db
    .select({ electionId: electionDefinitions.electionId })
    .from(electionDefinitions)
    .where(
      after === undefined
        ? listed
        : and(gt(electionDefinitions.electionId, new Uint8Array(after)), listed),
    )
    .orderBy(asc(electionDefinitions.electionId))
    .limit(limit);
  return rows.map((r) => new Uint8Array(r.electionId));
}
