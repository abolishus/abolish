// A poll's results as its page shows them, read on the server from
// `GET /elections/results` (src/server/load.ts) and checked against the
// poll's own definition. Nothing here imports a decoder, so the pages'
// script doesn't carry one (P2-28 part 2b).

import type { PollView, Tier } from "./poll.ts";
import type { Api } from "./server/api.ts";

export type ServedResults = Awaited<ReturnType<Api["elections"]["getResults"]>>;

/**
 * One tier's results: how many ballots it counted and, once every one of
 * its cells is opened, each question's count per option as a decimal
 * string, in the definition's order. Never a figure across tiers or
 * questions (ADR 0026; T-16).
 */
export interface TierResults {
  readonly tier: Tier;
  readonly counted: number;
  readonly questions: readonly (readonly string[])[] | undefined;
}

/**
 * What the page says of a poll's results: none opened yet, none this
 * server counts, none it could read now (`not-ready`, or `unavailable` for a
 * failed or slow read, or an answer that doesn't fit the poll's definition),
 * or the tiers' results as the board's openings give them.
 */
export type PollResults =
  | { readonly kind: "unopened" }
  | { readonly kind: "not-counted" }
  | { readonly kind: "not-ready" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "read"; readonly tiers: readonly TierResults[] };

const TIERS: readonly number[] = [0, 1, 2];

/**
 * `served`'s results for `poll`, or `unavailable` unless they fit it: each
 * tier one the poll's electorate holds, named once, and its counts exactly
 * the definition's questions and options, none above the ballots counted. The API's word is checked only
 * for shape, so a page can't print counts under the wrong options or
 * question (T-34); whether the counts are right is the verifier's to say.
 */
export function resultsView(
  poll: Pick<PollView, "version" | "questions" | "electorate">,
  served: ServedResults,
): PollResults {
  if (served.state === "unopened") return { kind: "unopened" };
  const tiers: TierResults[] = [];
  for (const t of served.tiers) {
    if (!TIERS.includes(t.tier) || !poll.electorate.some((g) => g.tier === t.tier))
      return { kind: "unavailable" };
    if (tiers.some((seen) => seen.tier === t.tier)) return { kind: "unavailable" };
    // Version 1 has one question, its counts; version 5 has each question's slice.
    const questions =
      t.counts === undefined ? undefined : poll.version === 5 ? t.byQuestion : [t.counts];
    if (t.counts !== undefined && !fits(poll.questions, t.counted, questions))
      return { kind: "unavailable" };
    tiers.push({ tier: t.tier as Tier, counted: t.counted, questions });
  }
  return { kind: "read", tiers };
}

// No option is picked on more ballots than were counted.
function fits(
  questions: PollView["questions"],
  counted: number,
  counts: readonly (readonly string[])[] | undefined,
): boolean {
  return (
    counts !== undefined &&
    counts.length === questions.length &&
    counts.every(
      (c, i) =>
        c.length === questions[i]?.optionCount && c.every((n) => BigInt(n) <= BigInt(counted)),
    )
  );
}

/**
 * `count` out of `counted` ballots, from 0 to 1: the share of those who
 * answered who picked the option. Scaled in bigint first, so a large count
 * loses no precision; 0 when nobody answered.
 */
export function shareOf(count: string, counted: number): number {
  if (counted === 0) return 0;
  return Number((BigInt(count) * 1_000_000n) / BigInt(counted)) / 1_000_000;
}

/**
 * The options picked most, by index in option order: every option tied at
 * the top, or none when nothing was picked at all.
 */
export function leadersOf(counts: readonly string[]): readonly number[] {
  const values = counts.map(BigInt);
  const most = values.reduce((top, n) => (n > top ? n : top), 0n);
  if (most === 0n) return [];
  return values.flatMap((n, i) => (n === most ? [i] : []));
}
