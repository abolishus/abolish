// The chain a rolling poll's ballots are judged against (docs/spec/verifier.md,
// Electorate, The rolling chain; P2-17 part 4d-2b): the group registry's
// events through close, which `packages/crypto` computes each step's root
// from, and the definition's registration time, before which no step is
// accepted (5.1's `root-step-range`). Both come from the registries' records
// and only from records the verifier's own checks passed: the events from
// 2.4's rolling replay, given only where the recount passes, and the time
// from the one `DefinitionRegistered` that registered the definition (2.1).
// So no step root is taken from a ballot, a relay or records that break a
// group's history, and no step before registration is opened by a time
// anyone but the registry wrote (T-08, T-13, T-25, T-34, T-71).
//
// As with the recount, the records are the caller's: a pass here is a
// pass over them, and the step roots it gives are relied on only once the
// records are proven complete through close (verifier 2.4, Residuals).

import type {
  ContractEventRecord,
  ElectionDefinitionV7Record,
  RollingBallotChain,
} from "@abolishus/crypto";
import { type ElectorateStop, type GroupRegistryRelease, rollingElectorate } from "./electorate.ts";
import type { ContractSequence } from "./replay.ts";
import {
  type DefinitionRegistrationOutcome,
  definitionRegistration,
  type ElectionRegistryRelease,
} from "./registration.ts";

/** The group registry, its registrars and the election registry, as the release pins them. */
export interface RollingChainRelease extends GroupRegistryRelease, ElectionRegistryRelease {}

/**
 * The group registry, its registrars and threshold and the election registry
 * this release pins (docs/spec/verifier.md, Pinned trust roots), which
 * `verifyBundle` builds a rolling poll's chain under. No release pins them
 * yet: they are pinned by the release that deploys the registries (P1-18),
 * so until then the run builds no chain and stops a rolling poll at 2.3.
 * Changing them is a new release (T-64, T-71).
 */
export const PINNED_REGISTRIES: RollingChainRelease | undefined = undefined;

/** The chain, or the first of 2.4's recount and the registration that stops it. */
export type RollingChainOutcome =
  | { readonly status: "pass"; readonly chain: RollingBallotChain }
  | { readonly check: "2.4"; readonly outcome: ElectorateStop }
  | {
      readonly check: "registration";
      readonly outcome: Exclude<DefinitionRegistrationOutcome, { readonly status: "pass" }>;
    };

/**
 * The chain of a rolling `definition` (version 7 under `electorate_mode` 2)
 * from `records`, the registries' records (each contract's in order of `n`;
 * other contracts' ignored), under `release`: 2.4's recount must pass, then
 * the definition's registration must be found. `definition` must be well
 * formed (2.1). Throws `TypeError` for a fixed definition, and `TypeError`
 * or `RangeError` for malformed arguments.
 */
export function rollingChain(
  definition: ElectionDefinitionV7Record,
  records: readonly ContractEventRecord[],
  release: RollingChainRelease,
): RollingChainOutcome {
  const electorate = rollingElectorate(definition, records, release);
  if (electorate.status !== "pass") return { check: "2.4", outcome: electorate };
  const registration = definitionRegistration(definition, records, release);
  if (registration.status !== "pass") return { check: "registration", outcome: registration };
  // Only Tier 0 is recounted (2.4, step 3), and no tier is listed twice
  // (2.1's `electorate`), so a recount that passes has one tier, and its
  // events are already in chain order.
  if (electorate.events.length !== 1)
    throw new Error("rollingChain: a passing recount of other than one tier");
  return {
    status: "pass",
    chain: {
      events: electorate.events[0] as (typeof electorate.events)[number],
      registeredAt: registration.record.l2_timestamp,
    },
  };
}

/**
 * The chain of a rolling `definition` from the archive's replay (4.4's, in
 * role order; docs/spec/verifier.md, Electorate, The rolling chain, From
 * the archive): each registry's events the replay holds, given only where
 * one of its archived records that the sequence reproduces is at an L2 block
 * whose timestamp is after `closes_at` and that is at or after every rolling
 * tier's `root_l2_block`, so every event the recount and the step roots read
 * is among them (L2 timestamps never decrease along the chain). An
 * archive the replay doesn't reach that far, or whose walk kept no more
 * evidence, gives no chain, and neither does a recount or registration that
 * doesn't pass: the run then leaves the poll unverifiable (T-08, T-53, T-71).
 */
export function archivedChain(
  definition: ElectionDefinitionV7Record,
  replay: {
    readonly contracts: readonly ContractSequence[];
    readonly findings: readonly unknown[];
  },
  release: RollingChainRelease,
): RollingBallotChain | undefined {
  // The walk's own findings only: a contract's evidence and run findings
  // needn't be read, since a reproduced record past the close and every
  // `root_l2_block` already makes the held prefix the contract's events.
  if (replay.findings.length > 0) return undefined;
  const { closes_at: closesAt, rolling_electorate: tiers } = definition.value;
  const rootBlock = tiers.reduce((b, t) => (t.root_l2_block > b ? t.root_l2_block : b), 0n);
  const records: ContractEventRecord[] = [];
  for (const role of ["election-registry", "group-registry"] as const) {
    const sequence = replay.contracts.find((c) => c.role === role);
    if (
      sequence === undefined ||
      !sequence.evidence.records.some(
        (r) =>
          r.replay === null &&
          r.accumulator.timestamp > closesAt &&
          r.accumulator.block >= rootBlock,
      )
    )
      return undefined;
    records.push(...sequence.records.slice(0, Number(sequence.held)));
  }
  const outcome = rollingChain(definition, records, release);
  return "status" in outcome ? outcome.chain : undefined;
}
