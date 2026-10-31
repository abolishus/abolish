// A poll's results as its page shows them, read on the server from
// `GET /elections/results` (src/server/load.ts) and checked against the
// poll's own definition. Nothing here imports a decoder, so the pages'
// script doesn't carry one (P2-28 part 2b).

import type { PartitionCell, PollView, Tier } from "./poll.ts";
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

/**
 * One cell's results, in partition order: how many ballots it counted and,
 * once a registered seat's opening of it passed, each question's count per
 * option; else whether it is unopened (`missing`, the board's
 * `tally-missing`) or its openings failed the board's check (`failed`).
 * `signers` are the seats its passing openings are attributed to, ascending.
 */
export interface CellResults {
  readonly cell: PartitionCell;
  readonly counted: number;
  readonly state: "opened" | "missing" | "failed";
  readonly questions: readonly (readonly string[])[] | undefined;
  readonly signers: readonly number[];
}

/**
 * `served`'s cells for `poll`, as `resultsView` reads its tiers, or
 * `undefined` unless they fit the poll's partition: one report per cell in
 * partition order, each in its cell's tier, its counts the definition's
 * questions and options, none above the ballots it counted, and every tier
 * the sum of its cells, its counted ballots always and its counts exactly
 * once every cell has them (docs/spec/election-definition.md, Notes, Tally partition), and
 * its signers seats of the poll's panel, ascending, none for a cell with
 * nothing boarded (docs/spec/verifier.md, 7.2). So the page can't print a
 * cell's figures that disagree with its tier's, or under another cell, or
 * name a seat the poll doesn't have (T-34); whether either is right is the
 * verifier's to say.
 */
export function cellResultsView(
  poll: Pick<PollView, "version" | "questions" | "panelSize">,
  partition: readonly PartitionCell[],
  served: ServedResults,
): readonly CellResults[] | undefined {
  if (served.state === "unopened") return [];
  if (served.cells.length !== partition.length) return undefined;
  const cells: CellResults[] = [];
  for (const [i, c] of served.cells.entries()) {
    const cell = partition[i];
    if (cell === undefined || c.cell !== i || c.tier !== cell.tier) return undefined;
    const questions =
      c.counts === undefined ? undefined : poll.version === 5 ? c.byQuestion : [c.counts];
    if (c.counts !== undefined && !fits(poll.questions, c.counted, questions)) return undefined;
    const state =
      questions !== undefined ? "opened" : c.code === "tally-missing" ? "missing" : "failed";
    if (!seatsOf(poll.panelSize, c.signers) || (state === "missing" && c.signers.length > 0))
      return undefined;
    cells.push({ cell, counted: c.counted, state, questions, signers: c.signers });
  }
  if (!cells.every((c) => served.tiers.some((t) => t.tier === c.cell.tier))) return undefined;
  for (const t of served.tiers) {
    const own = cells.filter((c) => c.cell.tier === t.tier);
    if (own.reduce((n, c) => n + c.counted, 0) !== t.counted) return undefined;
    const counts =
      t.counts === undefined ? undefined : poll.version === 5 ? t.byQuestion : [t.counts];
    // A tier has counts exactly once every one of its cells does.
    if (counts === undefined) {
      if (own.length > 0 && own.every((c) => c.questions !== undefined)) return undefined;
      continue;
    }
    if (!fits(poll.questions, t.counted, counts)) return undefined;
    if (own.some((c) => c.questions === undefined)) return undefined;
    if (!counts.every((q, i) => q.every((n, j) => BigInt(n) === sumOf(own, i, j))))
      return undefined;
  }
  return cells;
}

// The cells' count of option `j` of question `i`.
function sumOf(cells: readonly CellResults[], i: number, j: number): bigint {
  return cells.reduce((n, c) => n + BigInt(c.questions?.[i]?.[j] ?? "0"), 0n);
}

// Seats of a panel of `size`, numbered from 1 (docs/spec/ceremony.md), each once and ascending.
function seatsOf(size: number, seats: readonly number[]): boolean {
  return seats.every((s, i) => s >= 1 && s <= size && (i === 0 || s > (seats[i - 1] ?? 0)));
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

/**
 * The one tier's counts a closed poll can be summed up by, or `undefined`
 * unless its electorate names one tier and that tier's every question is
 * counted, with at least one ballot. A poll of several tiers has no lead
 * across them, so it has no summary (ADR 0026; T-16).
 */
export function finalOf(
  poll: Pick<PollView, "electorate">,
  results: PollResults,
): (TierResults & { readonly questions: readonly (readonly string[])[] }) | undefined {
  if (results.kind !== "read" || !poll.electorate.every((g) => g.tier === poll.electorate[0]?.tier))
    return undefined;
  const [tier, ...rest] = results.tiers;
  if (tier === undefined || rest.length > 0 || tier.questions === undefined || tier.counted === 0)
    return undefined;
  return { ...tier, questions: tier.questions };
}
