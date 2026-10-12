// Regional cells of election-definition version 3
// (docs/spec/election-definition.md, Regional cells; docs/spec/membership.md,
// Cell tree; 0019-regional-cells): the first-occurrence rule over a tier's
// groups, region counts, the owner's fold of small regions into one remainder
// cell, and each cell's tree. The verifier recomputes all of it from the
// board (2.4, 2.8), so the creator's only choice is which groups make up each
// region (T-16, T-34).

import type { TierElectorate } from "./election-definition.ts";
import { tierTreeRoot } from "./tier-tree.ts";

/**
 * `MIN_CELL_ELECTORATE` of docs/spec/parameters.md, written out rather than
 * read from PARAMETERS: it is a constant of definition version 3 and must
 * never change what that version accepts. A test ties it to PARAMETERS.
 */
export const DEFINITION_V3_FLOOR = 1000n;

/**
 * The fold of the owner's small-cell rule ([[0006-trustees]], Small cells):
 * each region with at least the floor's members is a cell on its own, in
 * region order, and the rest fold into one remainder cell, last. The tier is
 * split only if that gives at least two cells and the remainder (if any)
 * reaches the floor; otherwise it is one cell of every region. Fixed, never
 * chosen: no large region is merged to rescue a split (T-16). Returns each
 * cell's region indices.
 */
export function foldRegions(members: readonly bigint[]): number[][] {
  if (!Array.isArray(members) || members.length === 0)
    throw new RangeError("foldRegions: expected at least one region count");
  const large: number[] = [];
  const small: number[] = [];
  let smallSum = 0n;
  for (const [i, n] of members.entries()) {
    if (typeof n !== "bigint" || n < 0n)
      throw new RangeError("foldRegions: a count is a non-negative bigint");
    if (n >= DEFINITION_V3_FLOOR) large.push(i);
    else {
      small.push(i);
      smallSum += n;
    }
  }
  const candidates = large.map((i) => [i]);
  if (small.length > 0) candidates.push(small);
  const split = candidates.length >= 2 && (small.length === 0 || smallSum >= DEFINITION_V3_FLOOR);
  return split ? candidates : [members.map((_, i) => i)];
}

/**
 * The first-occurrence rule (docs/spec/membership.md, Cell tree): walking a
 * tier's groups in the order given (ascending `group_id`), each group's leaves
 * in index order, a nonzero leaf equal to an earlier nonzero leaf becomes 0.
 * So one commitment counts once per tier, in the first group holding it: one
 * secret has one cell and one nullifier per tier (G-2), and a repeat can't
 * inflate a region past the floor (T-16).
 */
export function firstOccurrence(groups: readonly (readonly bigint[])[]): bigint[][] {
  const seen = new Set<bigint>();
  return groups.map((leaves) =>
    leaves.map((leaf) => {
      if (leaf === 0n) return 0n;
      if (seen.has(leaf)) return 0n;
      seen.add(leaf);
      return leaf;
    }),
  );
}

export interface DerivedCell {
  /** The cell's regions, by index in the tier's `regions`. */
  readonly regions: readonly number[];
  /** The cell's groups, in ascending `group_id`. */
  readonly groups: readonly bigint[];
  /** The cell tree's leaves: its groups' leaves after first occurrence, concatenated. */
  readonly leaves: readonly bigint[];
  readonly root: bigint;
  readonly members: bigint;
}

export interface DerivedTier {
  /** Each region's member count, after first occurrence. */
  readonly regions: readonly bigint[];
  readonly cells: readonly DerivedCell[];
}

/**
 * A tier's region counts and cells, recomputed from its groups' tier-tree
 * leaves at the tier's `root_l2_block` (`leavesOf`: each group's leaves as
 * the lenient or strict replay gives them, 0 for a removed or forbidden
 * addition). Only the tier's `groups` and the number of its `regions` are
 * read: the stated counts and cells are what this recomputes, never inputs.
 * The caller has checked the definition's `electorate` rule. A member's
 * path is `tierTreePath(cell.leaves, index)`, with `index` its leaf's
 * position in `cell.leaves` (P2-8).
 */
export function deriveTierCells(
  tier: Pick<TierElectorate, "groups" | "regions">,
  leavesOf: ReadonlyMap<bigint, readonly bigint[]>,
): DerivedTier {
  const groupIds = tier.groups.map((g) => g.group_id);
  for (let i = 1; i < groupIds.length; i++)
    if ((groupIds[i - 1] as bigint) >= (groupIds[i] as bigint))
      throw new RangeError("deriveTierCells: groups must be in strictly ascending group_id");
  if (tier.groups.some((g) => g.region >= tier.regions.length))
    throw new RangeError("deriveTierCells: a group names a region the tier doesn't have");
  const raw = groupIds.map((id) => {
    const leaves = leavesOf.get(id);
    if (leaves === undefined) throw new RangeError(`deriveTierCells: no leaves for group ${id}`);
    return leaves;
  });
  const leaves = firstOccurrence(raw);
  const counted = (xs: readonly bigint[]) => BigInt(xs.reduce((n, x) => (x === 0n ? n : n + 1), 0));
  const regions = tier.regions.map(() => 0n);
  for (const [i, g] of tier.groups.entries())
    regions[g.region] = (regions[g.region] as bigint) + counted(leaves[i] as bigint[]);
  const cells = foldRegions(regions).map((cellRegions): DerivedCell => {
    const inCell = new Set(cellRegions);
    const at = tier.groups.flatMap((g, i) => (inCell.has(g.region) ? [i] : []));
    // tierTreeRoot refuses more than 2^32 leaves, which no cell tree has.
    const cellLeaves = at.flatMap((i) => leaves[i] as bigint[]);
    return {
      regions: cellRegions,
      groups: at.map((i) => groupIds[i] as bigint),
      leaves: cellLeaves,
      root: tierTreeRoot(cellLeaves),
      members: cellRegions.reduce((n, r) => n + (regions[r] as bigint), 0n),
    };
  });
  return { regions, cells };
}

/** Where a definition's stated electorate for one tier disagrees with the board. */
export type TierElectorateMismatch =
  | { readonly field: "regions"; readonly region: number }
  | { readonly field: "cells"; readonly count: number }
  | { readonly field: "cell-root" | "cell-members"; readonly cell: number };

/**
 * The first place a tier's stated `regions` and `cells` differ from what
 * `deriveTierCells` recomputes, or `undefined` if they agree; any difference
 * fails the definition ([[verifier]] 2.4, 2.8; T-13, T-16). `cell` is the
 * index within the tier.
 */
export function tierElectorateMismatch(
  tier: TierElectorate,
  derived: DerivedTier,
): TierElectorateMismatch | undefined {
  for (const [region, n] of derived.regions.entries())
    if (tier.regions[region] !== n) return { field: "regions", region };
  if (tier.cells.length !== derived.cells.length)
    return { field: "cells", count: derived.cells.length };
  for (const [cell, d] of derived.cells.entries()) {
    const stated = tier.cells[cell] as (typeof tier.cells)[number];
    if (stated.root !== d.root) return { field: "cell-root", cell };
    if (stated.members !== d.members) return { field: "cell-members", cell };
  }
  return undefined;
}
