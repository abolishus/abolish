// The creator's per-slot check of a created poll's identifier
// (docs/spec/contracts.md, Board anchor, Verification, Pre-creation anchors;
// [[0032-poll-creation-operations]], rules 12 and 14; P2-22 part 3b-1).
// Identifiers are predictable, so whoever held the anchoring quorum for a
// moment could have anchored checkpoints for one before its creation. The
// `f` rule leaves only those made between the creation's L1 origin and the
// creation itself, so once the creation is final and before any ceremony is
// asked for, the creator proves at a finalized L1 block `C`, later than the
// origin by more than the drift, that the checkpoint word of every segment
// from `f` to the last period that ended before `C` is zero. If one isn't,
// the identifier is abandoned and the poll created again; an abandoned
// identifier never gets a definition, so it holds no result.
//
// It checks those slots, never the lowest-segment word: anchors below `f`
// don't count, and refusing an identifier with any anchor at all would let
// one compulsion that anchored the current segment for thousands of future
// identifiers block every election. The third abandoned identifier fails the
// poll instead, so a quorum anchoring ahead for good can't keep a poll
// spending creations; the daily ceiling bounds the rest (rule 18).
//
// T-10: only public chain data and the poll's own record. T-69: a compelled
// quorum's anchor ahead of creation costs an identifier, never an election.

import { PARAMETERS } from "@abolishus/crypto";
import { PINNED_SEQUENCER_DRIFT } from "@abolishus/verifier";
import { and, asc, eq, isNull, sql as q } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { accountPolls } from "./db/schema/index.ts";

/** An L1 block, as the check proves at it. */
export interface L1Block {
  readonly number: bigint;
  /** Its hash, 32 bytes: the words are proven against this block's header. */
  readonly hash: Uint8Array;
  readonly timestamp: bigint;
}

/** The board anchor on L1, as the check reads it (the worker's `ViemCreationAnchors`). */
export interface CreationAnchors {
  /** The anchor's clock, fixed in its code. */
  readonly clock: { readonly epoch: bigint; readonly period: bigint };
  /** The node's finalized L1 block. */
  finalized(): Promise<L1Block>;
  /**
   * Each segment's checkpoint word for the election, in the order given,
   * proven against `block`'s state root: all zero where nothing was anchored.
   */
  words(block: L1Block, electionId: Uint8Array, segments: readonly number[]): Promise<Uint8Array[]>;
}

/**
 * Identifiers a poll may abandon for an anchor found ahead of its ceremony;
 * the next one found fails it with `creation-anchored`.
 */
export const MAX_ABANDONED_IDS = 3;

/** Most segments one identifier's check reads: about a year of hourly periods. */
export const MAX_ANCHOR_CHECK_SEGMENTS = 10_000;

/** Most polls one run checks; the next run takes the rest. */
export const ANCHOR_CHECKS_PER_RUN = 20;

/**
 * How long after its L1 origin a creation's slots are read: the larger of the
 * drift the verifier release pins for an event's origin and the ceiling on
 * any definition's `max_sequencer_drift`, so neither can be raised without
 * lengthening the check to match ([[contracts]], Election registry, Events).
 */
export const ANCHOR_CHECK_DELAY =
  PINNED_SEQUENCER_DRIFT > BigInt(PARAMETERS.MAX_SEQUENCER_DRIFT)
    ? PINNED_SEQUENCER_DRIFT
    : BigInt(PARAMETERS.MAX_SEQUENCER_DRIFT);

/** One run's outcome, in counts only (T-10, T-67). */
export interface AnchorCheckReport {
  /** Identifiers proven clear: their polls may go on. */
  checked: number;
  /** Polls whose `C` isn't finalized yet. */
  waiting: number;
  /** Identifiers abandoned, their polls returned to the creation step. */
  abandoned: number;
  /**
   * Of those, identifiers abandoned because their range was too long to
   * read (a check left for over a year): not counted toward the poll's
   * `MAX_ABANDONED_IDS`, since no anchor was found.
   */
  overdue: number;
  /** Polls failed with `creation-anchored`. */
  failed: number;
}

/**
 * The segments the check reads for a creation whose L1 origin is at
 * `origin`, proven at a block at `at`: from the period containing the origin
 * (`f`) to the last period that ended before `at`, since no later one can
 * hold an anchor yet. Undefined if `at` is too early for the check; empty if
 * no period from `f` has ended.
 */
export function anchorCheckSegments(
  clock: { readonly epoch: bigint; readonly period: bigint },
  origin: bigint,
  at: bigint,
): number[] | undefined {
  if (at <= origin + ANCHOR_CHECK_DELAY) return undefined;
  const { epoch, period } = clock;
  // Anchors count from segment 0 up, so an origin before the epoch is `f` = 0.
  const first = origin < epoch ? 0n : (origin - epoch) / period;
  if (at < epoch + period) return [];
  const last = (at - epoch) / period - 1n;
  // u32 segments; past that no period can be anchored at all.
  const end = last > 0xffffffffn ? 0xffffffffn : last;
  // A check runs within hours of its creation; this many is a node's
  // malformed answer or a worker down for a year, and the caller abandons
  // the identifier rather than read it.
  if (end - first + 1n > BigInt(MAX_ANCHOR_CHECK_SEGMENTS))
    throw new RangeError("too many segments to check");
  const out: number[] = [];
  for (let s = first; s <= end; s++) out.push(Number(s));
  return out;
}

/**
 * One run of the check over created polls not yet checked, oldest first:
 * each whose `C` is finalized is marked checked at that block if every word
 * is zero, or abandons its identifier (back to `submitted`, its creation
 * cleared, so the creation step creates it again) or, at the
 * `MAX_ABANDONED_IDS`th abandoned one, fails. `C` must also be no earlier
 * than when the poll was seen `created`: after a sequencer stall an event's
 * L2 time, and so its origin, can lag the creation's real time, and only a
 * block after the creation itself shows every anchor made before it. Each
 * step is safe to rerun after a crash at any point: a poll moves only from
 * `created` unchecked, holding the identifier it was read with.
 */
export async function checkCreationAnchors(
  client: Sql,
  anchors: CreationAnchors,
  options: { readonly now: Date },
): Promise<AnchorCheckReport> {
  const { epoch, period } = anchors.clock;
  if (period < 1n || epoch < 0n) throw new RangeError("the anchor's clock is malformed");
  const db = drizzle({ client });
  const report: AnchorCheckReport = {
    checked: 0,
    waiting: 0,
    abandoned: 0,
    overdue: 0,
    failed: 0,
  };
  const polls = await db
    .select({
      id: accountPolls.id,
      electionId: accountPolls.electionId,
      origin: accountPolls.l1OriginTimestamp,
      abandoned: accountPolls.abandonedIds,
      seen: accountPolls.updatedAt,
    })
    .from(accountPolls)
    .where(and(eq(accountPolls.state, "created"), isNull(accountPolls.anchorsCheckedBlock)))
    .orderBy(asc(accountPolls.updatedAt), asc(accountPolls.id))
    .limit(ANCHOR_CHECKS_PER_RUN);
  if (polls.length === 0) return report;
  // One block for the run, read once: every poll is judged at the same `C`.
  const block = await anchors.finalized();
  if (block.hash.length !== 32) throw new Error("the L1 node gave a malformed block hash");
  // Keyed by the identifier too: a poll another run abandoned and the
  // creation step created again holds a new identifier this run never read.
  const unchecked = (id: string, electionId: Uint8Array) =>
    and(
      eq(accountPolls.id, id),
      eq(accountPolls.state, "created"),
      isNull(accountPolls.anchorsCheckedBlock),
      eq(accountPolls.electionId, electionId),
    );
  // The creation's transaction stays in the ledger, still counted against
  // the ceiling; the creation step takes the poll again by its submission
  // time.
  const abandon = async (id: string, electionId: Uint8Array, counted: boolean) => {
    const moved = await db
      .update(accountPolls)
      .set({
        state: "submitted",
        creatorAddress: null,
        createTxHash: null,
        electionId: null,
        createdBlock: null,
        l1OriginTimestamp: null,
        ...(counted && { abandonedIds: q`${accountPolls.abandonedIds} + 1` }),
        updatedAt: options.now,
      })
      .where(unchecked(id, electionId))
      .returning({ id: accountPolls.id });
    return moved.length;
  };
  for (const p of polls) {
    // The table requires both from `created` on.
    const electionId = p.electionId as Uint8Array;
    if (block.timestamp < BigInt(Math.floor(p.seen.getTime() / 1000))) {
      report.waiting++;
      continue;
    }
    let segments: number[] | undefined;
    try {
      segments = anchorCheckSegments(anchors.clock, p.origin as bigint, block.timestamp);
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      // Too long to read, never a reason to hold up the polls behind it:
      // abandoning is always safe.
      const n = await abandon(p.id, electionId, false);
      report.abandoned += n;
      report.overdue += n;
      continue;
    }
    if (segments === undefined) {
      report.waiting++;
      continue;
    }
    const words = segments.length === 0 ? [] : await anchors.words(block, electionId, segments);
    if (words.length !== segments.length || words.some((w) => w.length !== 32))
      throw new Error("the L1 reader gave the wrong words");
    if (words.every((w) => w.every((x) => x === 0))) {
      const moved = await db
        .update(accountPolls)
        .set({ anchorsCheckedBlock: block.number, updatedAt: options.now })
        .where(unchecked(p.id, electionId))
        .returning({ id: accountPolls.id });
      report.checked += moved.length;
    } else if (p.abandoned + 1 >= MAX_ABANDONED_IDS) {
      // The identifier stays on the failed record, so the runbook can find
      // the anchor that took it (T-69); retry and discard delete it, so the
      // operator records it before the author does either.
      const moved = await db
        .update(accountPolls)
        .set({
          state: "failed",
          failure: "creation-anchored",
          abandonedIds: q`${accountPolls.abandonedIds} + 1`,
          updatedAt: options.now,
        })
        .where(unchecked(p.id, electionId))
        .returning({ id: accountPolls.id });
      report.failed += moved.length;
    } else report.abandoned += await abandon(p.id, electionId, true);
  }
  return report;
}
