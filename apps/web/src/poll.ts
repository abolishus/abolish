// What a poll page shows, built on the server from the API's answers
// (src/server/definition.ts, which decodes and checks the definition), and
// what the pages read of it. Nothing here imports a decoder, so the pages'
// script doesn't carry one (P2-28 part 2b).

import type { ElectionDefinitionV5Rule } from "@abolishus/crypto";

export type Tier = 0 | 1 | 2;

/** Seconds since the Unix epoch, as the definition holds them, and as a date if one fits. */
export interface Instant {
  readonly seconds: string;
  /** ISO 8601 in UTC, or `undefined` past the year 275760, where `Date` stops. */
  readonly iso: string | undefined;
}

/**
 * One question's limits, as the definition states them: the validity proof
 * enforces these, so the page renders its instruction from them and from no
 * label (docs/spec/election-definition.md, Methods are limits; T-34).
 */
export interface PollQuestion {
  readonly optionCount: number;
  readonly minSelections: number;
  readonly maxSelections: number;
}

/**
 * How a poll is counted: version 1's election type, or question by question
 * under version 5, where each question carries only its limits.
 */
export type Counting = "plurality" | "approval" | "questions";

export const COUNTINGS = [
  "plurality",
  "approval",
  "questions",
] as const satisfies readonly Counting[];

/** The first well-formedness rule the definition breaks, and the question it names if any. */
export interface IllFormed {
  readonly rule: ElectionDefinitionV5Rule;
  readonly question: number | undefined;
}

export interface PollView {
  readonly electionId: string;
  /** The definition's record version: 1, or 5 with several questions. */
  readonly version: 1 | 5;
  readonly definitionHash: string;
  /** The first well-formedness rule the definition breaks, if any: the verifier fails such an election. */
  readonly illFormed: IllFormed | undefined;
  readonly counting: Counting;
  /** In ballot order; version 1 has exactly one. */
  readonly questions: readonly PollQuestion[];
  /**
   * Each tier and its members: version 1's group size, or under version 5
   * the sum of the tier's region counts, the members its cells hold.
   */
  readonly electorate: readonly { readonly tier: Tier; readonly groupSize: string }[];
  readonly threshold: number;
  readonly panelSize: number;
  readonly opensAt: Instant;
  readonly closesAt: Instant;
}

/** Why a definition the API served isn't shown. */
export type DefinitionProblem = "undecodable" | "another-election";

// `Date` holds ±8.64e15 ms from the epoch.
const MAX_DATE_SECONDS = 8_640_000_000_000n;

export function instant(seconds: bigint): Instant {
  return {
    seconds: seconds.toString(),
    iso: seconds <= MAX_DATE_SECONDS ? new Date(Number(seconds) * 1000).toISOString() : undefined,
  };
}

/**
 * The instruction a question's limits give, as the ballot client words it
 * (apps/ballot, `instructionOf`). The owner's four methods are limits: pick
 * one `(0, 1)`, pick any `(0, m)`, pick up to N `(0, N)`, pick exactly N
 * `(N, N)`; any other range the rules allow is at least N or from N to M.
 */
export type Instruction =
  | { readonly kind: "one" }
  | { readonly kind: "any" }
  | { readonly kind: "upTo"; readonly max: number }
  | { readonly kind: "exactly"; readonly count: number }
  | { readonly kind: "atLeast"; readonly min: number }
  | { readonly kind: "between"; readonly min: number; readonly max: number };

export function instructionOf(q: PollQuestion): Instruction {
  const { minSelections: min, maxSelections: max, optionCount: all } = q;
  if (min === 0) {
    if (max === 1) return { kind: "one" };
    return max === all ? { kind: "any" } : { kind: "upTo", max };
  }
  if (min === max) return { kind: "exactly", count: min };
  return max === all ? { kind: "atLeast", min } : { kind: "between", min, max };
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
