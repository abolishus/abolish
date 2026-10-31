// What a rolling tier's result says about its electorate (docs/spec/
// verifier.md, Counted set and tally, step 8; 8.1; docs/spec/membership.md,
// Reported counts; P2-17 part 4e-1): its member counts at opening, at its
// last boundary and at the smallest step its ballots used, its eligible
// count, its growth per anchoring period and, under a live definition, its
// eligible count at each release the tier chose, each computed by
// @abolishus/crypto's `rollingTierReport` from the chain the ballots were
// judged against, never read from the definition, a release or a submitter
// (T-16, T-13, T-01, T-06). A rolling result describes the people who
// answered, from an electorate that grew during the poll, so no single size
// stands for it.

import {
  type AnchorClock,
  type ElectionDefinitionV7Record,
  type RollingBallotChain,
  rollingTierReport,
} from "@abolishus/crypto";
import type { RollingBallotStep } from "./ballots.ts";

/** A rolling tier's electorate, as the report gives it beside its counts (8.1). */
export interface RollingElectorateReport {
  /** The opening state's member count, which 2.4 checked is the definition's `group_size`. */
  readonly opening: { readonly members: number };
  /** The distinct commitments live at some accepted step: who could answer during the poll. */
  readonly eligible: number;
  /** The last boundary at or before `closes_at`, if later than the registration. */
  readonly close: {
    readonly step: number;
    readonly members: number;
    readonly accepted: boolean;
  } | null;
  /** The step with the fewest members that a verifying proof named, the lowest on a tie. */
  readonly smallestStep: { readonly step: number; readonly members: number } | null;
  /** One row per anchoring period with an event after the opening block, up to the close. */
  readonly growth: readonly {
    /** A decimal string: periods before the clock's epoch are negative. */
    readonly period: string;
    readonly added: number;
    readonly removed: number;
    readonly members: number;
  }[];
  /**
   * Under a live definition whose releases were read, each release the tier
   * chose, in snapshot order: `E(n_r)` with `n_r`, or with `step` `null` the
   * opening count, labelled as at opening.
   */
  readonly releases?: readonly {
    readonly snapshot: number;
    readonly step: number | null;
    readonly count: number;
  }[];
}

/** A release a rolling tier chose: snapshot `r`, from 1, the board through segment `σ_r`. */
export interface RollingChosenRelease {
  readonly snapshot: number;
  readonly segment: number;
}

/**
 * Each rolling tier's electorate, in `rolling_electorate` order (its cells'
 * order), from `chain` and `steps`, the copies whose membership proofs
 * verify against their steps' roots, admitted or not. Only those in the
 * counted extent, the entries before `extent`, are read: the sealed board's
 * whole. Each such step is one the poll accepts (5.1), so `rollingTierReport`
 * never refuses it. `releases`, given under a live definition whose releases
 * were read, maps each rolling tier to the releases it chose: a release's
 * snapshot holds the copies boarded through its segment, whose steps join
 * `n_r` since a segment's label isn't tied to its ballots' L1 references
 * (docs/spec/membership.md, Reported counts, At a live release).
 */
export function rollingElectorates(
  definition: ElectionDefinitionV7Record,
  chain: RollingBallotChain,
  clock: AnchorClock,
  steps: readonly RollingBallotStep[],
  extent: number,
  releases?: ReadonlyMap<number, readonly RollingChosenRelease[]>,
): readonly RollingElectorateReport[] {
  const d = definition.value;
  return d.rolling_electorate.map((tier, cell) => {
    const own = steps.filter((s) => s.cell === cell && s.entry < extent);
    const chosen = releases?.get(tier.tier);
    // The releases report lists every tier of the same definition, so a
    // missing one is the caller's error, never a tier that chose none.
    if (releases !== undefined && chosen === undefined)
      throw new Error(`rollingElectorates: no releases for tier ${tier.tier}`);
    const r = rollingTierReport(
      chain.events,
      {
        groups: tier.groups,
        rootL2Block: tier.root_l2_block,
        registeredAt: chain.registeredAt,
        closesAt: d.closes_at,
      },
      {
        clock: { epoch: clock.epoch, period: clock.period },
        ballotSteps: own.map((s) => BigInt(s.step)),
        releases: (chosen ?? []).map((c) => ({
          segment: BigInt(c.segment),
          snapshotSteps: own.filter((s) => s.segment <= c.segment).map((s) => BigInt(s.step)),
        })),
      },
    );
    return {
      opening: r.opening,
      eligible: r.eligible,
      close:
        r.close === null
          ? null
          : { step: Number(r.close.step), members: r.close.members, accepted: r.close.accepted },
      smallestStep:
        r.smallestStep === null
          ? null
          : { step: Number(r.smallestStep.step), members: r.smallestStep.members },
      growth: r.growth.map((g) => ({
        period: g.period.toString(),
        added: g.added,
        removed: g.removed,
        members: g.members,
      })),
      ...(chosen !== undefined && {
        releases: chosen.map((c, i) => {
          // One per release given, in order.
          const got = r.releases[i];
          if (got === undefined) throw new Error("rollingElectorates: a release without its count");
          return {
            snapshot: c.snapshot,
            step: got.step === null ? null : Number(got.step),
            count: got.count,
          };
        }),
      }),
    };
  });
}
