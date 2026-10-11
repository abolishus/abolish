// The homomorphic tally of docs/spec/tally.md (ADR 0002 option B, ADR 0003
// option C, ADR 0015 option C): per cell of the partition, the product of the
// counted ballots' VSS commitments, each trustee's summed shares checked
// against it, the opening of each option's aggregate commitment from any k
// valid summed shares, and the verifier's check of the published opening
// (CFSY 1996, Section 3; T-29, T-54, T-16, T-15). Group operations are @noble's;
// this module only composes them with scalar arithmetic modulo ℓ.

import { checkShares, type CommittedVote, type Share } from "./ballot-validity.ts";
import { type Element, G, GENERATOR_H, GROUP_ORDER, IDENTITY } from "./group.ts";
import { PARAMETERS } from "./parameters.ts";

const { MAX_OPTIONS, MAX_TRUSTEES } = PARAMETERS;

/** The election's rules a cell is tallied under, from its registered definition. */
export interface TallyRules {
  readonly optionCount: number;
  /** `k`: how many valid summed shares open a cell. */
  readonly threshold: number;
  /** `n`: summed shares come from seats 1 to `n`. */
  readonly panelSize: number;
}

/** For each option, the cell's `k` aggregate VSS commitments `Ê_{j,0}, …, Ê_{j,k−1}`; `Ê_{j,0}` is `Ĉ_j`. */
export type CellAggregate = readonly (readonly Element[])[];

export type TallyCode = "tally-quorum" | "tally-opening" | "tally-range";

/** The verifier's codes for a cell's published opening (docs/spec/tally.md, Opening checks). */
export type OpeningCode = "tally-missing" | "tally-opening" | "tally-range";

export type OpeningResult =
  | { readonly ok: true; readonly counts: readonly bigint[] }
  | { readonly ok: false; readonly code: OpeningCode; readonly option?: number };

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
  | {
      readonly ok: false;
      readonly code: TallyCode;
      readonly option?: number;
      readonly excluded: readonly number[];
    };

const mod = (x: bigint) => ((x % GROUP_ORDER) + GROUP_ORDER) % GROUP_ORDER;

// @noble rejects a multiplier of 0, which openings of empty cells use.
function mul(p: Element, s: bigint): Element {
  const e = mod(s);
  return e === 0n ? IDENTITY : p.multiply(e);
}

function checkRules(rules: TallyRules): void {
  const { optionCount: m, threshold: k, panelSize: n } = rules;
  if (![m, k, n].every((x) => Number.isSafeInteger(x)))
    throw new TypeError("rules: expected integers");
  if (m < 1 || m > MAX_OPTIONS) throw new RangeError("rules: optionCount out of range");
  if (k < 2 || k > n || n > MAX_TRUSTEES) throw new RangeError("rules: panel out of range");
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
 * polynomials the aggregate commits to. The same equation as a trustee's
 * check of one ballot's shares (Pedersen 1991).
 */
export function checkSummedShares(
  aggregate: CellAggregate,
  seat: number,
  summed: readonly Share[],
): boolean {
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

const isScalar = (x: unknown) => typeof x === "bigint" && x >= 0n && x < GROUP_ORDER;

/** `tally-opening` then `tally-range` for each option in order, against the aggregate. */
function checkAgainst(
  aggregate: CellAggregate,
  ballotCount: number,
  opening: readonly Share[],
):
  | { readonly ok: true; readonly counts: readonly bigint[] }
  | {
      readonly ok: false;
      readonly code: "tally-opening" | "tally-range";
      readonly option: number;
    } {
  for (let j = 0; j < aggregate.length; j++) {
    const { v, r } = opening[j] as Share;
    const opens = mul(G, v)
      .add(mul(GENERATOR_H, r))
      .equals((aggregate[j] as readonly Element[])[0] as Element);
    if (!opens) return { ok: false, code: "tally-opening", option: j };
    if (v > BigInt(ballotCount)) return { ok: false, code: "tally-range", option: j };
  }
  return { ok: true, counts: opening.map((s) => s.v) };
}

/**
 * The verifier's check of a cell's published opening (docs/spec/tally.md,
 * Opening checks; verifier 7.2): one `(V_j, R_j)` per option, each a
 * canonical scalar, opening the product of the counted ballots' commitments
 * with a count of at most the cell's ballots. `opening` comes from the board
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
  return checkAgainst(aggregate, ballots.length, opening);
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
  const aggregate = aggregateCell(rules, ballots);
  const { threshold: k, panelSize: n } = rules;
  const seats = [...summed.keys()].sort((a, b) => a - b);
  for (const seat of seats)
    if (!Number.isSafeInteger(seat) || seat < 1 || seat > n)
      throw new RangeError("openCell: seats are from 1 to the panel size");
  const passing: number[] = [];
  const excluded: number[] = [];
  // A value that isn't a canonical scalar has no encoding, so no message can
  // carry it: it fails here rather than being reduced mod ℓ by the check.
  const canonical = (shares: readonly Share[]) =>
    Array.isArray(shares) && shares.every((s) => isScalar(s?.v) && isScalar(s?.r));
  for (const seat of seats)
    (canonical(summed.get(seat) as readonly Share[]) &&
    checkSummedShares(aggregate, seat, summed.get(seat) as readonly Share[])
      ? passing
      : excluded
    ).push(seat);
  if (passing.length < k) return { ok: false, code: "tally-quorum", excluded };
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
  const checked = checkAgainst(aggregate, ballots.length, opening);
  if (!checked.ok) return { ...checked, excluded };
  return {
    ok: true,
    counts: opening.map((s) => s.v),
    randomness: opening.map((s) => s.r),
    combined,
    excluded,
  };
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
