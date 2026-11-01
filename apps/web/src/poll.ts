// What a poll page shows, built on the server from the API's answers
// (src/server/definition.ts, which decodes and checks the definition), and
// what the pages read of it. Nothing here imports a decoder, so the pages'
// script doesn't carry one (P2-28 part 2b).

import type { PollTopic } from "@abolishus/core/poll-topics";
import type { ElectionDefinitionV7Rule } from "@abolishus/crypto";

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
 * under versions 5 and 7, where each question carries only its limits.
 */
export type Counting = "plurality" | "approval" | "questions";

export const COUNTINGS = [
  "plurality",
  "approval",
  "questions",
] as const satisfies readonly Counting[];

/**
 * The poll's class, as its definition states it: an everyday poll, or one
 * of the two classes on the civic record, an organisational vote or a civic
 * referendum (version 7's `poll_class`; versions 1 and 5 carry none and are
 * everyday polls). A class on the civic record needs a panel of independent
 * trustees, so no poll under the launch panel is on it (verifier 2.5,
 * `panel-kind`; [[0027-trustee-panels-and-live-results]], Part 3; T-14).
 */
export type PollClass = "everyday" | "organisational" | "civic";

export const POLL_CLASSES = [
  "everyday",
  "organisational",
  "civic",
] as const satisfies readonly PollClass[];

/** The first well-formedness rule the definition breaks, and the question it names if any. */
export interface IllFormed {
  readonly rule: ElectionDefinitionV7Rule;
  readonly question: number | undefined;
}

export interface PollView {
  readonly electionId: string;
  /**
   * The definition's record version: 1, or 5 with several questions, or 7,
   * version 5's questions with an electorate mode.
   */
  readonly version: 1 | 5 | 7;
  readonly definitionHash: string;
  /** The first well-formedness rule the definition breaks, if any: the verifier fails such an election. */
  readonly illFormed: IllFormed | undefined;
  readonly pollClass: PollClass;
  readonly counting: Counting;
  /** In ballot order; version 1 has exactly one. */
  readonly questions: readonly PollQuestion[];
  /**
   * Whether the electorate is rolling (version 7 under `electorate_mode` 2):
   * whoever joins one of a tier's groups before the close can answer, so the
   * tier's `groupSize` is its members when the poll opened, not who could
   * answer by the close ([[0028-rolling-electorates]]; T-01, T-16).
   */
  readonly rolling: boolean;
  /**
   * Each tier and its members: version 1's group size, under versions 5 and
   * 7 the sum of the tier's region counts, the members its cells hold, or
   * under a rolling electorate the tier's members at the opening root.
   */
  readonly electorate: readonly { readonly tier: Tier; readonly groupSize: string }[];
  readonly threshold: number;
  readonly panelSize: number;
  readonly opensAt: Instant;
  readonly closesAt: Instant;
}

/**
 * One cell of a poll's tally partition, in partition order: the tier it lies
 * in, its member count as the definition states it (its anonymity set,
 * reported with its results; T-16) and, under versions 5 and 7, the regions
 * it holds by index, as the fold derives them from the tier's region counts
 * (docs/spec/election-definition.md, Regional cells). Version 1 has one cell
 * per tier, of its one group, and so has a rolling electorate, of its tier's
 * groups, whose count is the members at the opening root: more may join by
 * the close (docs/spec/election-definition.md, Tally partition).
 */
export interface PartitionCell {
  readonly tier: Tier;
  readonly members: string;
  /** `undefined` under version 1, or where the stated cells aren't the fold's. */
  readonly regions: readonly number[] | undefined;
}

/**
 * Where a poll is listed: the topic and place our server files it under, its
 * author's or moderation's once it refiled the poll
 * ([[0041-poll-topics-and-places]]). They sit beside the poll, which doesn't
 * commit to them, so they are the server's claim (T-68).
 */
export interface PollTags {
  readonly topic: PollTopic | undefined;
  readonly place: string | undefined;
}

export const NO_TAGS: PollTags = { topic: undefined, place: undefined };

/**
 * Who asked a poll: the profile its author chose to show it on
 * ([[0040-creator-profiles]]), by its handle and name. Our database's word,
 * never part of the poll anyone can verify (T-75).
 */
export interface AskedBy {
  readonly handle: string;
  readonly name: string;
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
