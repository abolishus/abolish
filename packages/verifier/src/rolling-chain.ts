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
import {
  type DefinitionRegistrationOutcome,
  definitionRegistration,
  type ElectionRegistryRelease,
} from "./registration.ts";

/** The group registry, its registrars and the election registry, as the release pins them. */
export interface RollingChainRelease extends GroupRegistryRelease, ElectionRegistryRelease {}

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
