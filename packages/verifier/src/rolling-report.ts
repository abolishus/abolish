// What a rolling tier's result says about its electorate (docs/spec/
// verifier.md, Counted set and tally, step 8; 8.1; docs/spec/membership.md,
// Reported counts; P2-17 part 4e-1): its member counts at opening, at its
// last boundary and at the smallest step its ballots used, its eligible
// count and its growth per anchoring period, each computed by
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
}

/**
 * Each rolling tier's electorate, in `rolling_electorate` order (its cells'
 * order), from `chain` and `steps`, the copies whose membership proofs
 * verify against their steps' roots, admitted or not. Only those in the
 * counted extent, the entries before `extent`, are read: the sealed board's
 * whole. Each such step is one the poll accepts (5.1), so `rollingTierReport`
 * never refuses it.
 */
export function rollingElectorates(
  definition: ElectionDefinitionV7Record,
  chain: RollingBallotChain,
  clock: AnchorClock,
  steps: readonly RollingBallotStep[],
  extent: number,
): readonly RollingElectorateReport[] {
  const d = definition.value;
  return d.rolling_electorate.map((tier, cell) => {
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
        ballotSteps: steps
          .filter((s) => s.cell === cell && s.entry < extent)
          .map((s) => BigInt(s.step)),
        releases: [],
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
    };
  });
}
