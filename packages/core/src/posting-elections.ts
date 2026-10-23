// The registered elections the forced path weighs (docs/spec/posting-relay.md,
// Forced through L1; T-54): every election of the index the route judges by,
// `election_registrations` as the registry sync recorded it from finalized
// L2 blocks, with its `closes_at` and `l1_inclusion_bound` read from its
// stored definition, so a deposit's landing span is kept out of every
// receipt and complaint interval the trustees' capacity check counts on.
//
// The index lags the chain by the sync's output roots, so its progress is
// checked against the registry's own `DefinitionRegistered` events at the
// L2's finalized head: one older than `POSTING_INDEX_LAG` that the index
// doesn't hold means the index stopped, and nothing is judged until it
// catches up. A younger one is harmless, since no registered election's
// intervals start within `POSTING_INDEX_LAG + POSTING_DEPOSIT_SPAN` of its
// registration (`postingIndexLagFits`).
//
// T-11: nothing here names an election in a report; a refusal is one
// undefined, which the deposits count as `unjudged`.

import { COMPLAINT_WINDOW, DELIVERY_WINDOW, PARAMETERS } from "@abolishus/crypto";
import { PINNED_FORCED_INCLUSION, PINNED_MARGIN } from "@abolishus/verifier";
import { eq, gte, isNull, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { isBytes } from "./bytes.ts";
import { electionRegistrations, electionSchedules } from "./db/schema/index.ts";
import { decodeStoredDefinition, readDefinition } from "./definitions.ts";
import { POSTING_DEPOSIT_SPAN } from "./posting-ledger.ts";
import {
  postingCapacityIntervals,
  type PostingElectionTimes,
  type PostingRegisteredElections,
} from "./posting-deposits.ts";
import { POSTING_HEAD_AGE } from "./posting-worker.ts";
import { latestRegistration, registeredElection } from "./registrations.ts";

/**
 * Seconds a registration may stay out of the index after its L2 block
 * before the index counts as stopped (Values): six hours, far beyond the
 * sync's ordinary lag behind the output roots, and far within the 34 hours
 * before a registered election's first interval can start.
 */
export const POSTING_INDEX_LAG = 21_600n;

/** Elections whose times are kept in memory: the oldest asked of is let go past it, and read again if asked of. */
const KEPT_TIMES = 4_096;

const U64_MAX = (1n << 64n) - 1n;

/** A `DefinitionRegistered` event of the election registry, as the L2 node shows it in a finalized block. */
export interface PostingRegistration {
  readonly definitionHash: Uint8Array;
  readonly l2Block: bigint;
  /** Its block's timestamp, in UNIX seconds. */
  readonly timestamp: bigint;
}

/** The election registry's events from the L2 node. A call that can't reach the node rejects. */
export interface PostingRegistryLog {
  /** Every `DefinitionRegistered` of the registry in finalized L2 blocks numbered `from` or later. */
  registered(from: bigint): Promise<readonly PostingRegistration[]>;
}

/**
 * Whether a registration `lag` seconds out of the index can't hide an
 * interval a landing span meets: a definition registers only before it
 * opens (the registry's `AlreadyOpen`), so its receipt interval starts at
 * least `DELIVERY_WINDOW − F − R` after its L2 block, whose time is at most
 * `MAX_SEQUENCER_DRIFT` ahead of L1's, and a span signed now ends
 * `POSTING_DEPOSIT_SPAN` after an L1 head no newer than the clock.
 */
export function postingIndexLagFits(
  lag: bigint,
  constants: { readonly forcedInclusion: bigint; readonly margin: bigint },
): boolean {
  const drift = BigInt(PARAMETERS.MAX_SEQUENCER_DRIFT);
  return (
    lag + POSTING_DEPOSIT_SPAN + drift <=
    DELIVERY_WINDOW - constants.forcedInclusion - constants.margin
  );
}

export interface PostgresPostingElectionsOptions {
  readonly sql: Sql;
  readonly registry: PostingRegistryLog;
  /** UNIX time in seconds. */
  readonly now: () => number;
  /** The release's `F` and `R`; the verifier's pinned values by default. */
  readonly forcedInclusion?: bigint;
  readonly margin?: bigint;
}

/** The registered elections over the route's index in Postgres, its progress checked against the registry's events. */
export class PostgresPostingElections implements PostingRegisteredElections {
  readonly #sql: Sql;
  readonly #registry: PostingRegistryLog;
  readonly #now: () => number;
  readonly #constants: { readonly forcedInclusion: bigint; readonly margin: bigint };
  // A definition never changes once stored, so its times are read once.
  readonly #times = new Map<string, PostingElectionTimes>();

  constructor(options: PostgresPostingElectionsOptions) {
    const { forcedInclusion = PINNED_FORCED_INCLUSION, margin = PINNED_MARGIN } = options;
    if (typeof forcedInclusion !== "bigint" || typeof margin !== "bigint")
      throw new RangeError("forcedInclusion and margin must be bigints");
    // T-54: a lag the windows don't cover would let a stopped index hide an
    // interval a deposit lands in.
    if (
      forcedInclusion < 0n ||
      margin < 0n ||
      !postingIndexLagFits(POSTING_INDEX_LAG, { forcedInclusion, margin })
    )
      throw new RangeError("POSTING_INDEX_LAG doesn't fit these F and R");
    this.#sql = options.sql;
    this.#registry = options.registry;
    this.#now = options.now;
    this.#constants = { forcedInclusion, margin };
  }

  /**
   * Every registered election not known to be past its `c_K` by the clock
   * less `POSTING_HEAD_AGE` (no landing span can start earlier), or
   * undefined if one of them has no stored definition, or the index misses
   * a registration older than `POSTING_INDEX_LAG` at the L2's finalized head.
   */
  async times(): Promise<readonly PostingElectionTimes[] | undefined> {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) throw new RangeError("now must be a UNIX time");
    const clock = BigInt(now);
    if (!(await this.#current(clock))) return undefined;

    const floor = clock - BigInt(POSTING_HEAD_AGE);
    // A prefilter only: an election closed before this is past its `c_K`
    // whatever its bound, which the registry keeps at most
    // `MAX_INCLUSION_BOUND`; each kept one is judged exactly below.
    const closed = floor - COMPLAINT_WINDOW - BigInt(PARAMETERS.MAX_INCLUSION_BOUND);
    const r = electionRegistrations;
    const s = electionSchedules;
    const rows = await drizzle({ client: this.#sql })
      .select({ electionId: r.electionId })
      .from(r)
      .leftJoin(s, eq(s.electionId, r.electionId))
      .where(or(isNull(s.electionId), gte(s.closesAt, closed < 0n ? 0n : closed)));
    const times: PostingElectionTimes[] = [];
    for (const row of rows) {
      const t = await this.#read(new Uint8Array(row.electionId));
      // T-54: an election whose intervals are unknown might have one anywhere.
      if (t === undefined) return undefined;
      const [, complaint] = postingCapacityIntervals(t, this.#constants);
      if (complaint.to >= floor) times.push(t);
    }
    return times;
  }

  /** Whether the index holds every registration older than `POSTING_INDEX_LAG` at the finalized head. */
  async #current(clock: bigint): Promise<boolean> {
    const latest = await latestRegistration(this.#sql);
    // From the latest recorded registration's block, which may hold later ones.
    const seen = await this.#registry.registered(latest?.l2Block ?? 0n);
    if (!Array.isArray(seen)) throw new TypeError("the registry's events are out of form");
    for (const e of seen) {
      if (
        !isBytes(e.definitionHash) ||
        e.definitionHash.length !== 32 ||
        typeof e.timestamp !== "bigint" ||
        e.timestamp < 0n ||
        e.timestamp > U64_MAX
      )
        throw new TypeError("the registry's events are out of form");
      if (clock - e.timestamp < POSTING_INDEX_LAG) continue;
      if ((await registeredElection(this.#sql, e.definitionHash)) === undefined) return false;
    }
    return true;
  }

  async #read(electionId: Uint8Array): Promise<PostingElectionTimes | undefined> {
    const id = Buffer.from(electionId).toString("hex");
    const kept = this.#times.get(id);
    if (kept !== undefined) return kept;
    const bytes = await readDefinition(this.#sql, electionId);
    if (bytes === undefined) return undefined;
    // Every stored definition decoded when it was stored.
    const { value } = decodeStoredDefinition(bytes);
    const t = { closesAt: value.closes_at, l1InclusionBound: BigInt(value.l1_inclusion_bound) };
    this.#times.set(id, t);
    while (this.#times.size > KEPT_TIMES)
      this.#times.delete(this.#times.keys().next().value as string);
    return t;
  }
}
