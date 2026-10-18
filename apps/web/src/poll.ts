// What a poll page shows, built from the API's answers. Nothing here is
// trusted: the definition is decoded and checked with @abolishus/crypto, the
// same code the verifier runs, and anything that doesn't decode, or names
// another election, is refused rather than shown (T-31, T-34). Whether the
// definition is the one registered on chain is for the verifier; the page
// shows its hash so a reader can compare (T-34). The page reads the
// definition versions the API stores, 1 and 5 (several questions), and no
// other: a version it can't read is undecodable here, never guessed at.

import {
  DecodeError,
  decodeElectionDefinition,
  decodeElectionDefinitionV5,
  ELECTION_TYPES,
  electionDefinitionHash,
  type ElectionDefinition,
  electionDefinitionRule,
  type ElectionDefinitionV5,
  electionDefinitionV5Hash,
  electionDefinitionV5Rule,
  type ElectionDefinitionV5Rule,
  RECORD_TYPES,
} from "@abolishus/crypto";

import { fromHex, toHex } from "./values.ts";

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

// Only the version byte routes the record, as the API's store routes it
// (packages/core, `decodeStoredDefinition`); each decoder checks the
// definition's own pin again, and version 1's refuses every later version.
const isVersion5 = (bytes: Uint8Array) =>
  bytes.length >= 3 &&
  bytes[0] === 0 &&
  bytes[1] === RECORD_TYPES.electionDefinition &&
  bytes[2] === 5;

function times(d: {
  readonly threshold: number;
  readonly panel_size: number;
  readonly opens_at: bigint;
  readonly closes_at: bigint;
}): Pick<PollView, "threshold" | "panelSize" | "opensAt" | "closesAt"> {
  return {
    threshold: d.threshold,
    panelSize: d.panel_size,
    opensAt: instant(d.opens_at),
    closesAt: instant(d.closes_at),
  };
}

function viewV5(d: ElectionDefinitionV5): PollView {
  const failure = electionDefinitionV5Rule(d);
  return {
    electionId: toHex(d.election_id),
    version: 5,
    definitionHash: toHex(electionDefinitionV5Hash(d)),
    illFormed:
      failure === undefined
        ? undefined
        : { rule: failure.rule, question: "question" in failure ? failure.question : undefined },
    counting: "questions",
    questions: d.questions.map((q) => ({
      optionCount: q.option_count,
      minSelections: q.min_selections,
      maxSelections: q.max_selections,
    })),
    electorate: d.electorate.map((t) => ({
      tier: t.tier,
      groupSize: t.regions.reduce((sum, members) => sum + members, 0n).toString(),
    })),
    ...times(d),
  };
}

function viewV1(d: ElectionDefinition): PollView {
  const rule = electionDefinitionRule(d);
  return {
    electionId: toHex(d.election_id),
    version: 1,
    definitionHash: toHex(electionDefinitionHash(d)),
    illFormed: rule === undefined ? undefined : { rule, question: undefined },
    counting: d.election_type === ELECTION_TYPES.approval ? "approval" : "plurality",
    questions: [
      {
        optionCount: d.option_count,
        minSelections: d.min_selections,
        maxSelections: d.max_selections,
      },
    ],
    electorate: d.electorate.map((g) => ({ tier: g.tier, groupSize: g.group_size.toString() })),
    ...times(d),
  };
}

/** The poll page's view of `definitionHex`, served by the API for `electionId`. */
export function definitionView(electionId: string, definitionHex: string): DefinitionResult {
  let definition;
  try {
    const bytes = fromHex(definitionHex);
    definition = isVersion5(bytes)
      ? { version: 5 as const, value: decodeElectionDefinitionV5(bytes) }
      : { version: 1 as const, value: decodeElectionDefinition(bytes) };
  } catch (error) {
    if (error instanceof DecodeError || error instanceof RangeError)
      return { ok: false, problem: "undecodable" };
    throw error;
  }
  const poll = definition.version === 5 ? viewV5(definition.value) : viewV1(definition.value);
  if (poll.electionId !== electionId) return { ok: false, problem: "another-election" };
  return { ok: true, poll };
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
