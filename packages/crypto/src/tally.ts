// The homomorphic tally of docs/spec/tally.md (ADR 0002 option B, ADR 0003
// option C, ADR 0015 option C): per cell of the partition, the product of the
// counted ballots' VSS commitments, each trustee's summed shares checked
// against it, the opening of each option's aggregate commitment from any k
// valid summed shares, and the verifier's check of the published opening
// (CFSY 1996, Section 3; T-29, T-54, T-16, T-15). Group operations are @noble's;
// this module only composes them with scalar arithmetic modulo ℓ.

import {
  checkShares,
  type CommittedVote,
  type QuestionRules,
  type Share,
} from "./ballot-validity.ts";
import {
  electionDefinitionRule,
  electionDefinitionV3Rule,
  electionDefinitionV4Rule,
  type ElectionDefinitionV5,
  electionDefinitionV5Rule,
  type ElectionDefinitionV6,
} from "./election-definition.ts";
import { type Element, G, GENERATOR_H, GROUP_ORDER, IDENTITY } from "./group.ts";
import { PARAMETERS } from "./parameters.ts";
import {
  type AnyElectionDefinitionRecord,
  type ElectionDefinitionV7Record,
  type PanelledDefinition,
  panelledFacts,
  type PanelledFacts,
  UnsupportedVersionError,
} from "./protocol.ts";
import { RECORD_TYPES } from "./record.ts";

const { MAX_OPTIONS, MAX_QUESTIONS, MAX_TRUSTEES } = PARAMETERS;

/** The election's rules a cell is tallied under, from its registered definition. */
export interface TallyRules {
  /** `m`: under definition version 5, `T`, the total over the questions, in flat order. */
  readonly optionCount: number;
  /** `k`: how many valid summed shares open a cell. */
  readonly threshold: number;
  /** `n`: summed shares come from seats 1 to `n`. */
  readonly panelSize: number;
  /**
   * Under definition version 5, each question's option count and limits, in
   * order; their option counts sum to `optionCount`. Absent under versions 1,
   * 3 and 4, which ask one question and have no `tally-question-range`.
   */
  readonly questions?: readonly QuestionRules[];
  /**
   * Under tally-opening version 3, the panel whose half these rules tally:
   * 1 the default panel, 2 the author panel (`panelTallyRules`). Absent
   * under version 1, which tallies the whole opening.
   */
  readonly panel?: 1 | 2;
}

/** For each option, the cell's `k` aggregate VSS commitments `Ê_{j,0}, …, Ê_{j,k−1}`; `Ê_{j,0}` is `Ĉ_j`. */
export type CellAggregate = readonly (readonly Element[])[];

export type TallyCode = "tally-quorum" | "tally-opening" | "tally-range" | "tally-question-range";

/** The verifier's codes for a cell's published opening (docs/spec/tally.md, Opening checks). */
export type OpeningCode =
  | "tally-missing"
  | "tally-opening"
  | "tally-range"
  | "tally-question-range";

/** A failing check on an opening: `option` for `tally-opening` and `tally-range`, `question` for `tally-question-range`. */
type OpeningFailure<C> = {
  readonly ok: false;
  readonly code: C;
  readonly option?: number;
  readonly question?: number;
};

export type OpeningResult =
  | { readonly ok: true; readonly counts: readonly bigint[] }
  | OpeningFailure<OpeningCode>;

export type CellOpening =
  | {
      readonly ok: true;
      /** `V_j`: option `j`'s count in the cell. */
      readonly counts: readonly bigint[];
      /** `R_j`: the randomness opening `Ĉ_j`. */
      readonly randomness: readonly bigint[];
      /** `Q`: the seats combined, the `k` lowest whose summed shares pass. */
      readonly combined: readonly number[];
      /** Seats whose summed shares failed the check, ascending. */
      readonly excluded: readonly number[];
    }
  | (OpeningFailure<TallyCode> & { readonly excluded: readonly number[] });

const isScalar = (x: unknown) => typeof x === "bigint" && x >= 0n && x < GROUP_ORDER;

const mod = (x: bigint) => ((x % GROUP_ORDER) + GROUP_ORDER) % GROUP_ORDER;

// @noble rejects a multiplier of 0, which openings of empty cells use.
function mul(p: Element, s: bigint): Element {
  const e = mod(s);
  return e === 0n ? IDENTITY : p.multiply(e);
}

/** Throws unless `rules` are well formed. Not exported from the package: its callers' own checks. */
export function checkRules(rules: TallyRules): void {
  const { optionCount: m, threshold: k, panelSize: n, questions, panel } = rules;
  if (![m, k, n].every((x) => Number.isSafeInteger(x)))
    throw new TypeError("rules: expected integers");
  if (m < 1 || m > MAX_OPTIONS) throw new RangeError("rules: optionCount out of range");
  if (panel !== undefined && panel !== 1 && panel !== 2)
    throw new RangeError("rules: panel is 1 or 2");
  // Only an author panel may have k = 1 (trustee-identity, Author panel
  // identifier, rule 2); a default panel's threshold is at least 2.
  if (k < (panel === 2 ? 1 : 2) || k > n || n > MAX_TRUSTEES)
    throw new RangeError("rules: panel out of range");
  if (questions === undefined) return;
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > MAX_QUESTIONS)
    throw new RangeError("rules: from 1 to MAX_QUESTIONS questions");
  let total = 0;
  for (const q of questions as readonly QuestionRules[]) {
    const { optionCount: mq, minSelections: min, maxSelections: max } = q;
    if (![mq, min, max].every((x) => Number.isSafeInteger(x)))
      throw new TypeError("rules: expected integers");
    if (mq < 1 || min < 0 || min > max || max > mq)
      throw new RangeError("rules: a question's limits out of range");
    total += mq;
  }
  // The flat options are the questions' options in order (T-28): a question
  // list over another number of options would slice the opening wrongly.
  if (total !== m) throw new RangeError("rules: the questions' options don't sum to optionCount");
}

/**
 * The rules a cell of a registered definition is tallied under
 * (docs/spec/tally.md, Context): `m`, `k` and `n`, and under versions 5 to 7
 * each question's option count and limits. A version-6 definition's ballots
 * are version 4: without an author panel their default half is the whole
 * sharing, tallied by the default panel exactly as version 5's ballots are,
 * so the rules are version 5's; with one, its halves are tallied per panel
 * (`panelTallyRules`) and it is refused here, so no caller sums a half under
 * one panel's rules as the whole vote (T-28, T-37). A version-7 definition
 * under a fixed electorate is read as version 6 is (`panelledFacts`); a
 * rolling one, and any later version, is `UnsupportedVersionError` (T-36). A definition that isn't well-formed is
 * refused: its questions could hold limits no ballot proves, which would
 * make `tally-question-range` judge an honest cell (T-28, T-34).
 */
export function tallyRules(
  definition: AnyElectionDefinitionRecord | ElectionDefinitionV7Record,
): TallyRules {
  const rules = (d: { readonly threshold: number; readonly panel_size: number }) => ({
    threshold: d.threshold,
    panelSize: d.panel_size,
  });
  switch (definition.version) {
    case 1:
      if (electionDefinitionRule(definition.value) !== undefined)
        throw new RangeError("tallyRules: the definition isn't well-formed");
      return { optionCount: definition.value.option_count, ...rules(definition.value) };
    case 3:
    case 4: {
      const failure =
        definition.version === 3
          ? electionDefinitionV3Rule(definition.value)
          : electionDefinitionV4Rule(definition.value);
      if (failure !== undefined)
        throw new RangeError("tallyRules: the definition isn't well-formed");
      return { optionCount: definition.value.option_count, ...rules(definition.value) };
    }
    case 5:
    case 6:
    case 7: {
      const notWellFormed = () => new RangeError("tallyRules: the definition isn't well-formed");
      let d: ElectionDefinitionV5 | PanelledDefinition;
      if (definition.version === 5) {
        if (electionDefinitionV5Rule(definition.value) !== undefined) throw notWellFormed();
        d = definition.value;
      } else {
        // Read from its one decoded copy, which its rules were judged on.
        const facts = panelledOf(definition);
        if (!facts.wellFormed) throw notWellFormed();
        if (facts.value.author_keys.length !== 0)
          throw new RangeError("tallyRules: an author panel's halves are tallied per panel");
        d = facts.value;
      }
      const questions = Object.freeze(
        d.questions.map((q) =>
          Object.freeze({
            optionCount: q.option_count,
            minSelections: q.min_selections,
            maxSelections: q.max_selections,
          }),
        ),
      );
      return Object.freeze({
        optionCount: questions.reduce((t, q) => t + q.optionCount, 0),
        ...rules(d),
        questions,
      });
    }
    default: {
      // Every version the type admits is read above; a caller's cast can
      // still pass another, which is refused, never guessed (T-36).
      const unread = definition as { readonly version: number };
      throw new UnsupportedVersionError(RECORD_TYPES.electionDefinition, unread.version);
    }
  }
}

// `panelledFacts` for a record: its value's own pin must be the record's
// version, so a value can't be read under another version's hash or rules.
function panelledOf(
  definition:
    | { readonly version: 6; readonly value: ElectionDefinitionV6 }
    | ElectionDefinitionV7Record,
): PanelledFacts {
  const facts = panelledFacts(definition.value);
  if (facts.version !== definition.version)
    throw new UnsupportedVersionError(RECORD_TYPES.electionDefinition, definition.version);
  return facts;
}

/**
 * The rules panel `panel` tallies its half of a cell under, for a version-6
 * definition, or a version-7 one under a fixed electorate, with an author
 * panel, which pins tally-opening version 3
 * (docs/spec/tally.md, Author panel, Panels and counted set): the default
 * panel's `threshold` and `panel_size`, or the author panel's
 * `author_threshold` and number of `author_keys`, with the definition's
 * questions either way. A definition without an author panel tallies its one
 * half under version 1 or 2, never here, and one that isn't well-formed is
 * refused (T-28, T-36, T-37).
 */
export function panelTallyRules(
  definition:
    | { readonly version: 6; readonly value: ElectionDefinitionV6 }
    | ElectionDefinitionV7Record,
  panel: 1 | 2,
): TallyRules {
  if (definition.version !== 6 && definition.version !== 7)
    throw new UnsupportedVersionError(
      RECORD_TYPES.electionDefinition,
      (definition as { readonly version: number }).version,
    );
  const facts = panelledOf(definition);
  if (!facts.wellFormed) throw new RangeError("panelTallyRules: the definition isn't well-formed");
  const d = facts.value;
  if (d.author_keys.length === 0)
    throw new RangeError("panelTallyRules: the definition has no author panel");
  if (panel !== 1 && panel !== 2) throw new RangeError("panelTallyRules: panel is 1 or 2");
  const questions = Object.freeze(
    d.questions.map((q) =>
      Object.freeze({
        optionCount: q.option_count,
        minSelections: q.min_selections,
        maxSelections: q.max_selections,
      }),
    ),
  );
  return Object.freeze({
    optionCount: questions.reduce((t, q) => t + q.optionCount, 0),
    threshold: panel === 1 ? d.threshold : d.author_threshold,
    panelSize: panel === 1 ? d.panel_size : d.author_keys.length,
    questions,
    panel,
  });
}

/**
 * The cell's aggregates: for each option `j` and `t`, the product over the
 * counted ballots of `E_{j,t}` (docs/spec/tally.md, Aggregates). Every ballot
 * must have passed `validity-shape`; one that didn't is a caller's error,
 * because only admitted ballots are counted.
 */
export function aggregateCell(
  rules: TallyRules,
  ballots: readonly CommittedVote["vss"][],
): CellAggregate {
  checkRules(rules);
  const { optionCount: m, threshold: k } = rules;
  const acc: Element[][] = Array.from({ length: m }, () =>
    Array.from({ length: k }, () => IDENTITY),
  );
  for (const vss of ballots) {
    if (vss.length !== m || vss.some((e) => e.length !== k))
      throw new RangeError("aggregateCell: a ballot doesn't match the election's shape");
    vss.forEach((e, j) => {
      const row = acc[j] as Element[];
      e.forEach((x, t) => {
        row[t] = (row[t] as Element).add(x);
      });
    });
  }
  return acc;
}

/**
 * A trustee's summed shares for a cell: per option, the sums modulo ℓ of its
 * shares of every counted ballot (docs/spec/tally.md, Summed shares). `shares`
 * holds the trustee's list for each ballot of the cell, in any order.
 */
export function sumShares(rules: TallyRules, shares: readonly (readonly Share[])[]): Share[] {
  checkRules(rules);
  const m = rules.optionCount;
  const v = Array.from({ length: m }, () => 0n);
  const r = Array.from({ length: m }, () => 0n);
  for (const list of shares) {
    if (list.length !== m) throw new RangeError("sumShares: one share per option");
    list.forEach((s, j) => {
      if ([s.v, s.r].some((x) => typeof x !== "bigint" || x < 0n || x >= GROUP_ORDER))
        throw new RangeError("sumShares: shares must be scalars");
      v[j] = mod((v[j] as bigint) + s.v);
      r[j] = mod((r[j] as bigint) + s.r);
    });
  }
  return v.map((x, j) => ({ v: x, r: r[j] as bigint }));
}

/**
 * The summed-share check (docs/spec/tally.md; verifier 7.2): seat `seat`'s
 * list has one entry per option and each is the evaluation at `seat` of the
 * polynomials the aggregate commits to, each a canonical scalar. The same
 * equation as a trustee's check of one ballot's shares (Pedersen 1991).
 */
export function checkSummedShares(
  aggregate: CellAggregate,
  seat: number,
  summed: readonly Share[],
): boolean {
  // A value that isn't a canonical scalar has no encoding, so no message can
  // carry it: it fails here rather than being reduced mod ℓ by the equation.
  if (!Array.isArray(summed) || !summed.every((s) => isScalar(s?.v) && isScalar(s?.r)))
    return false;
  return checkShares(aggregate, seat, summed);
}

/** `x^{−1} mod ℓ`, by Fermat: ℓ is prime and `x` isn't 0 mod ℓ. */
function invert(x: bigint): bigint {
  let result = 1n;
  let base = mod(x);
  let e = GROUP_ORDER - 2n;
  while (e > 0n) {
    if (e & 1n) result = (result * base) % GROUP_ORDER;
    base = (base * base) % GROUP_ORDER;
    e >>= 1n;
  }
  return result;
}

/** `λ_i = Π_{l ≠ i} l · (l − i)^{−1} mod ℓ`, for each seat of `seats` in order (distinct, from 1). */
export function lagrangeAtZero(seats: readonly number[]): bigint[] {
  if (seats.some((s) => !Number.isSafeInteger(s) || s < 1 || s > MAX_TRUSTEES))
    throw new RangeError("lagrangeAtZero: seats are from 1 to MAX_TRUSTEES");
  if (new Set(seats).size !== seats.length) throw new RangeError("lagrangeAtZero: distinct seats");
  return seats.map((i) =>
    seats.reduce((acc, l) => (l === i ? acc : mod(acc * BigInt(l) * invert(BigInt(l - i)))), 1n),
  );
}

/**
 * `tally-question-range` (docs/spec/tally.md, Opening checks), on an opening
 * that passed `tally-range`: under definition version 5, the first question
 * whose counts, summed, lie outside `[min_q · |S_c|, max_q · |S_c|]`, or
 * `null`. Each question's result is its slice of the opening and rests on
 * this check, though it can't fail while binding holds (T-29, T-28).
 */
export function firstQuestionOutside(
  rules: TallyRules,
  ballotCount: number,
  counts: readonly bigint[],
): number | null {
  checkRules(rules);
  if (!Number.isSafeInteger(ballotCount) || ballotCount < 0)
    throw new RangeError("firstQuestionOutside: a ballot count");
  if (!Array.isArray(counts) || counts.length !== rules.optionCount)
    throw new RangeError("firstQuestionOutside: one count per option");
  const s = BigInt(ballotCount);
  let offset = 0;
  for (const [q, { optionCount, minSelections, maxSelections }] of (
    rules.questions ?? []
  ).entries()) {
    const total = counts.slice(offset, offset + optionCount).reduce((a, v) => a + v, 0n);
    offset += optionCount;
    if (total < BigInt(minSelections) * s || total > BigInt(maxSelections) * s) return q;
  }
  return null;
}

/**
 * The opening checks in the spec's order against the aggregate:
 * `tally-opening` for every option, then `tally-range` for every option,
 * then `tally-question-range` for every question.
 */
function checkAgainst(
  rules: TallyRules,
  aggregate: CellAggregate,
  ballotCount: number,
  opening: readonly Share[],
):
  | { readonly ok: true; readonly counts: readonly bigint[] }
  | OpeningFailure<"tally-opening" | "tally-range" | "tally-question-range"> {
  for (let j = 0; j < aggregate.length; j++) {
    const { v, r } = opening[j] as Share;
    const opens = mul(G, v)
      .add(mul(GENERATOR_H, r))
      .equals((aggregate[j] as readonly Element[])[0] as Element);
    if (!opens) return { ok: false, code: "tally-opening", option: j };
  }
  const counts = opening.map((s) => s.v);
  const over = counts.findIndex((v) => v > BigInt(ballotCount));
  if (over !== -1) return { ok: false, code: "tally-range", option: over };
  const question = firstQuestionOutside(rules, ballotCount, counts);
  if (question !== null) return { ok: false, code: "tally-question-range", question };
  return { ok: true, counts };
}

/**
 * The verifier's check of a cell's published opening (docs/spec/tally.md,
 * Opening checks; verifier 7.2): one `(V_j, R_j)` per option, each a
 * canonical scalar, opening the product of the counted ballots' commitments
 * with a count of at most the cell's ballots and, under definition version
 * 5, every question's total within its limits. `opening` comes from the board
 * and may be anything, or nothing (`undefined`).
 */
export function checkOpening(
  rules: TallyRules,
  ballots: readonly CommittedVote["vss"][],
  opening: readonly Share[] | undefined,
): OpeningResult {
  const aggregate = aggregateCell(rules, ballots);
  if (
    !Array.isArray(opening) ||
    opening.length !== rules.optionCount ||
    !opening.every((s) => isScalar(s?.v) && isScalar(s?.r))
  )
    return { ok: false, code: "tally-missing" };
  return checkAgainst(rules, aggregate, ballots.length, opening);
}

/** The `k` lowest seats whose summed shares pass, and the opening they combine to. */
function combineSummed(
  rules: TallyRules,
  aggregate: CellAggregate,
  summed: ReadonlyMap<number, readonly Share[]>,
):
  | {
      readonly ok: true;
      readonly opening: Share[];
      readonly combined: number[];
      readonly excluded: number[];
    }
  | { readonly ok: false; readonly excluded: number[] } {
  const { threshold: k, panelSize: n } = rules;
  const seats = [...summed.keys()].sort((a, b) => a - b);
  for (const seat of seats)
    if (!Number.isSafeInteger(seat) || seat < 1 || seat > n)
      throw new RangeError("openCell: seats are from 1 to the panel size");
  const passing: number[] = [];
  const excluded: number[] = [];
  for (const seat of seats)
    (checkSummedShares(aggregate, seat, summed.get(seat) as readonly Share[])
      ? passing
      : excluded
    ).push(seat);
  if (passing.length < k) return { ok: false, excluded };
  const combined = passing.slice(0, k);
  const lambda = lagrangeAtZero(combined);
  const opening = aggregate.map((_, j) =>
    combined.reduce(
      (acc, seat, q) => {
        const s = (summed.get(seat) as readonly Share[])[j] as Share;
        const l = lambda[q] as bigint;
        return { v: mod(acc.v + l * s.v), r: mod(acc.r + l * s.r) };
      },
      { v: 0n, r: 0n },
    ),
  );
  return { ok: true, opening, combined, excluded };
}

/**
 * A trustee's combination of one cell (docs/spec/tally.md, Combination):
 * aggregates the counted ballots, checks every summed share it received,
 * combines the `k` lowest passing seats, and runs the opening checks on the
 * result before it is published. `summed` maps each sending seat to its
 * summed shares, which come from other trustees and may be anything.
 */
export function openCell(
  rules: TallyRules,
  ballots: readonly CommittedVote["vss"][],
  summed: ReadonlyMap<number, readonly Share[]>,
): CellOpening {
  // A panel's half is opened by openPartialCell: its V is uniform, so the
  // range checks here would refuse an honest partial opening.
  if (rules.panel !== undefined)
    throw new RangeError("openCell: a panel's half is opened with openPartialCell");
  const aggregate = aggregateCell(rules, ballots);
  const c = combineSummed(rules, aggregate, summed);
  if (!c.ok) return { ok: false, code: "tally-quorum", excluded: c.excluded };
  const checked = checkAgainst(rules, aggregate, ballots.length, c.opening);
  if (!checked.ok) return { ...checked, excluded: c.excluded };
  return {
    ok: true,
    counts: c.opening.map((s) => s.v),
    randomness: c.opening.map((s) => s.r),
    combined: c.combined,
    excluded: c.excluded,
  };
}

export type PartialCellOpening =
  | {
      readonly ok: true;
      /** `(V^P_j, R^P_j)` for each option: the panel's partial opening, which opens `Ĉ^P_j`. */
      readonly opening: readonly Share[];
      /** `Q`: the `k_P` lowest seats of the panel whose summed shares pass. */
      readonly combined: readonly number[];
      readonly excluded: readonly number[];
    }
  | {
      readonly ok: false;
      readonly code: "tally-quorum" | "tally-opening";
      readonly option?: number;
      readonly excluded: readonly number[];
    };

/**
 * A seat's combination of its own panel's half of one cell under
 * tally-opening version 3 (docs/spec/tally.md, Author panel, Partial
 * openings): `rules` from `panelTallyRules`, `halves` each counted ballot's
 * commitments of that panel (`vss` for the default panel, `author_vss` for
 * the author panel), `summed` the panel's own seats' summed shares. The
 * result opens the panel's aggregate commitments and is checked against them
 * before it is published; its `V^P_j` is uniform on its own, so it is never
 * range-checked: the range checks run on the sum of both panels' openings
 * (`checkPartialTally`).
 */
export function openPartialCell(
  rules: TallyRules,
  halves: readonly CommittedVote["vss"][],
  summed: ReadonlyMap<number, readonly Share[]>,
): PartialCellOpening {
  if (rules.panel === undefined)
    throw new RangeError("openPartialCell: the rules must name a panel (panelTallyRules)");
  const aggregate = aggregateCell(rules, halves);
  const c = combineSummed(rules, aggregate, summed);
  if (!c.ok) return { ok: false, code: "tally-quorum", excluded: c.excluded };
  for (let j = 0; j < aggregate.length; j++) {
    const { v, r } = c.opening[j] as Share;
    const opens = mul(G, v)
      .add(mul(GENERATOR_H, r))
      .equals((aggregate[j] as readonly Element[])[0] as Element);
    if (!opens) return { ok: false, code: "tally-opening", option: j, excluded: c.excluded };
  }
  return { ok: true, opening: c.opening, combined: c.combined, excluded: c.excluded };
}

/**
 * A coarser total: per option, the sum of the given cells' counts
 * (docs/spec/tally.md, Coarser totals). Derived, never opened. The caller
 * passes each cell once: nothing here can tell two equal cells apart.
 */
export function deriveTotal(cells: readonly (readonly bigint[])[]): bigint[] {
  if (cells.length === 0) throw new RangeError("deriveTotal: at least one cell");
  const m = (cells[0] as readonly bigint[]).length;
  if (cells.some((c) => c.length !== m)) throw new RangeError("deriveTotal: one count per option");
  return Array.from({ length: m }, (_, j) => cells.reduce((acc, c) => acc + (c[j] as bigint), 0n));
}

/**
 * Each question's result: its slice of a cell's counts, or of a coarser
 * total, at its options in flat order (docs/spec/tally.md, Opening checks,
 * Notes; election-definition.md, Questions). Under definition versions 1, 3
 * and 4 the one question is every option. Nothing here relates two
 * questions: a joint figure would need individual ballots, which no opening
 * reveals (ADR 0026, No cross-tabulation; T-29, T-16).
 */
export function questionResults(
  rules: TallyRules,
  counts: readonly bigint[],
): (readonly bigint[])[] {
  checkRules(rules);
  if (!Array.isArray(counts) || counts.length !== rules.optionCount)
    throw new RangeError("questionResults: one count per option");
  let offset = 0;
  return (rules.questions ?? [{ optionCount: rules.optionCount }]).map(({ optionCount }) =>
    counts.slice(offset, (offset += optionCount)),
  );
}
