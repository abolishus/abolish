// What the database knows of one creation key, for the worker's status
// command (the poll-creation runbook, Rotation and Compromise;
// [[0032-poll-creation-operations]], rules 4 and 12; P2-22 part 3b-3): the
// polls the key still has to finish, which an operator waits out before
// retiring it, and its ledger set against the node's nonce counts, where a
// transaction the worker never recorded is the runbook's first sign of
// compromise.
//
// T-10: poll identifiers, states and election identifiers only, never an
// author or a draft. T-72: the counts are what the runbook's checks read.

import { and, asc, count, eq, gte, inArray, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { accountPolls, pollCreationTxs } from "./db/schema/index.ts";
import type { PollState } from "./poll-drafts.ts";

/**
 * The states in which a poll still needs the key that created it: its
 * creation can be in flight from `submitted` on, and only that key can
 * register it (rule 4).
 */
export const NEEDS_CREATION_KEY = [
  "submitted",
  "created",
  "rooted",
  "ceremony",
] as const satisfies readonly PollState[];

/** A poll the key still has to finish. */
export interface KeyPoll {
  readonly id: string;
  readonly state: (typeof NEEDS_CREATION_KEY)[number];
  /** The identifier its finalized creation gave, once there is one. */
  readonly electionId: Uint8Array | null;
}

export interface CreationKeyRecords {
  /** Oldest submission first, at most `KEY_POLLS_LISTED`. */
  readonly polls: readonly KeyPoll[];
  /** How many polls are in `NEEDS_CREATION_KEY`, listed or not. */
  readonly pollCount: number;
  /** Ledger rows for the key. */
  readonly recorded: number;
  /** Recorded at a nonce the node hasn't seen included: still being sent. */
  readonly unincluded: number;
  /** Recorded at a nonce not yet spent in finalized history. */
  readonly unfinalized: number;
  /** Recorded in the 24 hours before `now`, the window the daily ceiling counts. */
  readonly lastDay: number;
  /**
   * Nonces the node has seen included with no ledger row: transactions of
   * the key the worker didn't send. The sweep is one of them; anything else
   * is the runbook's sign of compromise.
   */
  readonly unrecorded: bigint;
}

/** The most polls the status lists; `pollCount` counts the rest. */
export const KEY_POLLS_LISTED = 100;

const DAY_MS = 24 * 60 * 60_000;

/**
 * The key's polls and ledger, judged against the node's nonce counts for it
 * (`PollCreationChain.nonces`). Reads only.
 */
export async function creationKeyRecords(
  client: Sql,
  creator: Uint8Array,
  nonces: { readonly finalized: bigint; readonly latest: bigint },
  now: Date,
): Promise<CreationKeyRecords> {
  if (creator.length !== 20) throw new RangeError("the creator must be a 20-byte address");
  if (nonces.finalized < 0n || nonces.latest < nonces.finalized)
    throw new RangeError("the nonce counts are out of order");
  const db = drizzle({ client });
  const key = creator.slice();
  const ofKey = and(
    eq(accountPolls.creatorAddress, key),
    inArray(accountPolls.state, [...NEEDS_CREATION_KEY]),
  );
  const polls = await db
    .select({ id: accountPolls.id, state: accountPolls.state, electionId: accountPolls.electionId })
    .from(accountPolls)
    .where(ofKey)
    .orderBy(asc(accountPolls.submittedAt), asc(accountPolls.id))
    .limit(KEY_POLLS_LISTED);
  const [polled] = await db.select({ n: count() }).from(accountPolls).where(ofKey);
  const counted = async (where?: ReturnType<typeof and>) => {
    const [r] = await db
      .select({ n: count() })
      .from(pollCreationTxs)
      .where(and(eq(pollCreationTxs.creatorAddress, key), where));
    return r?.n ?? 0;
  };
  const [recorded, unincluded, unfinalized, lastDay, included] = await Promise.all([
    counted(),
    counted(gte(pollCreationTxs.nonce, nonces.latest)),
    counted(gte(pollCreationTxs.nonce, nonces.finalized)),
    counted(gte(pollCreationTxs.sentAt, new Date(now.getTime() - DAY_MS))),
    counted(lt(pollCreationTxs.nonce, nonces.latest)),
  ]);
  return {
    polls: polls.map((p) => ({
      id: p.id,
      state: p.state as KeyPoll["state"],
      electionId: p.electionId,
    })),
    pollCount: polled?.n ?? 0,
    recorded,
    unincluded,
    unfinalized,
    lastDay,
    // One row per key and nonce, so the rows below `latest` are distinct
    // included nonces.
    unrecorded: nonces.latest - BigInt(included),
  };
}
