// What a poll page shows, built from the API's answers. Nothing here is
// trusted: the definition is decoded and checked with @abolishus/crypto, the
// same code the verifier runs, and anything that doesn't decode, or names
// another election, is refused rather than shown (T-31, T-34). Whether the
// definition is the one registered on chain is for the verifier; the page
// shows its hash so a reader can compare (T-34).

import {
  DecodeError,
  decodeElectionDefinition,
  ELECTION_TYPES,
  electionDefinitionHash,
  electionDefinitionRule,
  type ElectionDefinitionRule,
} from "@abolishus/crypto";

import { fromHex, toHex } from "./values.ts";

export type Tier = 0 | 1 | 2;

/** Seconds since the Unix epoch, as the definition holds them, and as a date if one fits. */
export interface Instant {
  readonly seconds: string;
  /** ISO 8601 in UTC, or `undefined` past the year 275760, where `Date` stops. */
  readonly iso: string | undefined;
}

export interface PollView {
  readonly electionId: string;
  readonly definitionHash: string;
  /** The first well-formedness rule the definition breaks, if any: the verifier fails such an election. */
  readonly illFormed: ElectionDefinitionRule | undefined;
  readonly electionType: "plurality" | "approval";
  readonly optionCount: number;
  readonly minSelections: number;
  readonly maxSelections: number;
  readonly electorate: readonly { readonly tier: Tier; readonly groupSize: string }[];
  readonly threshold: number;
  readonly panelSize: number;
  readonly opensAt: Instant;
  readonly closesAt: Instant;
}

/** Why a definition the API served isn't shown. */
export type DefinitionProblem = "undecodable" | "another-election";

export type DefinitionResult =
  | { readonly ok: true; readonly poll: PollView }
  | { readonly ok: false; readonly problem: DefinitionProblem };

// `Date` holds ±8.64e15 ms from the epoch.
const MAX_DATE_SECONDS = 8_640_000_000_000n;

export function instant(seconds: bigint): Instant {
  return {
    seconds: seconds.toString(),
    iso: seconds <= MAX_DATE_SECONDS ? new Date(Number(seconds) * 1000).toISOString() : undefined,
  };
}

/** The poll page's view of `definitionHex`, served by the API for `electionId`. */
export function definitionView(electionId: string, definitionHex: string): DefinitionResult {
  let definition;
  try {
    definition = decodeElectionDefinition(fromHex(definitionHex));
  } catch (error) {
    if (error instanceof DecodeError || error instanceof RangeError)
      return { ok: false, problem: "undecodable" };
    throw error;
  }
  if (toHex(definition.election_id) !== electionId)
    return { ok: false, problem: "another-election" };
  return {
    ok: true,
    poll: {
      electionId,
      definitionHash: toHex(electionDefinitionHash(definition)),
      illFormed: electionDefinitionRule(definition),
      electionType: definition.election_type === ELECTION_TYPES.approval ? "approval" : "plurality",
      optionCount: definition.option_count,
      minSelections: definition.min_selections,
      maxSelections: definition.max_selections,
      electorate: definition.electorate.map((g) => ({
        tier: g.tier,
        groupSize: g.group_size.toString(),
      })),
      threshold: definition.threshold,
      panelSize: definition.panel_size,
      opensAt: instant(definition.opens_at),
      closesAt: instant(definition.closes_at),
    },
  };
}

/** Where a poll is in its window: before `opens_at`, up to `closes_at`, or after. */
export type PollStatus = "scheduled" | "open" | "closed";

export const POLL_STATUSES = [
  "open",
  "scheduled",
  "closed",
] as const satisfies readonly PollStatus[];

/**
 * `poll`'s status at `now`, from the definition's own times. A ballot counts
 * up to and including `closes_at` (docs/spec/revoting.md), so a poll is open
 * through that second. This is the page's reading of a claimed definition
 * against the server's clock, never the close rule the verifier applies.
 */
export function pollStatus(poll: Pick<PollView, "opensAt" | "closesAt">, now: Instant): PollStatus {
  const at = BigInt(now.seconds);
  if (at < BigInt(poll.opensAt.seconds)) return "scheduled";
  return at <= BigInt(poll.closesAt.seconds) ? "open" : "closed";
}
