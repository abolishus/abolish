import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  DEFINITION_V3_FLOOR,
  deriveTierCells,
  firstOccurrence,
  foldRegions,
  PARAMETERS,
  poseidon2,
  replayTierGroup,
  type TierElectorate,
  tierElectorateMismatch,
  type TierGroupEvent,
  tierTreePath,
  tierTreeRoot,
} from "../src/index.ts";
import { SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/regional-cells.json comes from an independent Python
// implementation (scripts/regional-cells-vectors.py) of the fold, the
// first-occurrence rule and cell trees, so no expected value here comes from
// the code under test (docs/spec/election-definition.md, Regional cells;
// docs/spec/membership.md, Cell tree; T-16).

type RawEvent =
  | { readonly add: string }
  | { readonly addRange: readonly [string, string] }
  | { readonly remove: string };

interface RegionalCellsVectors {
  readonly format: string;
  readonly floor: string;
  readonly folds: readonly {
    readonly id: string;
    readonly members: readonly string[];
    readonly cells: readonly (readonly number[])[];
  }[];
  readonly tiers: readonly {
    readonly id: string;
    readonly groups: readonly {
      readonly groupId: string;
      readonly region: number;
      readonly events: readonly RawEvent[];
    }[];
    readonly regionCount: number;
    readonly leaves?: readonly (readonly string[])[];
    readonly regions: readonly string[];
    readonly cells: readonly {
      readonly regions: readonly number[];
      readonly groups: readonly string[];
      readonly root: string;
      readonly members: string;
      readonly leafCount: number;
      readonly paths: readonly {
        readonly index: number;
        readonly leaf: string;
        readonly siblings: readonly string[];
      }[];
    }[];
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("regional-cells.json", SPEC_VECTORS), "utf8"),
) as RegionalCellsVectors;

const decimal = (s: string | undefined) => {
  if (s === undefined || !/^(?:0|[1-9][0-9]*)$/.test(s)) throw new Error(`not a decimal: ${s}`);
  return BigInt(s);
};
const events = (raw: readonly RawEvent[]): TierGroupEvent[] =>
  raw.flatMap((e): TierGroupEvent[] => {
    if ("remove" in e) return [{ kind: "remove", index: decimal(e.remove) }];
    if ("add" in e) return [{ kind: "add", commitment: decimal(e.add) }];
    const [from, count] = [decimal(e.addRange[0]), Number(decimal(e.addRange[1]))];
    return Array.from({ length: count }, (_, i) => ({
      kind: "add",
      commitment: from + BigInt(i),
    }));
  });

/** The tier's groups as a definition lists them, and their replayed leaves. */
function tierOf(v: RegionalCellsVectors["tiers"][number]) {
  const tier: Pick<TierElectorate, "groups" | "regions"> = {
    groups: v.groups.map((g) => ({ group_id: decimal(g.groupId), region: g.region })),
    regions: Array.from({ length: v.regionCount }, () => 0n),
  };
  const leavesOf = new Map(
    v.groups.map((g) => [decimal(g.groupId), replayTierGroup(events(g.events)).leaves] as const),
  );
  return { tier, leavesOf };
}

/** The root a path climbs to, as Semaphore's circuit computes it with len = 32. */
function climb(leaf: bigint, index: number, siblings: readonly bigint[]): bigint {
  let node = leaf;
  for (const [h, sibling] of siblings.entries())
    node =
      Math.floor(index / 2 ** h) % 2 === 0 ? poseidon2(node, sibling) : poseidon2(sibling, node);
  return node;
}

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

describe("regional-cells vectors (docs/spec/vectors/regional-cells.json)", () => {
  test("uses the format this reader knows, at the parameters' floor", () => {
    expect(vectors.format).toBe("abolish-regional-cells-vectors/1");
    expect(decimal(vectors.floor)).toBe(DEFINITION_V3_FLOOR);
    expect(BigInt(PARAMETERS.MIN_CELL_ELECTORATE)).toBe(DEFINITION_V3_FLOOR);
    expect(vectors.folds).toHaveLength(10);
    expect(vectors.tiers).toHaveLength(8);
  });

  test.each(vectors.folds.map((f) => [f.id, f] as const))("fold %s", (_id, f) => {
    expect(foldRegions(f.members.map(decimal))).toEqual(f.cells);
  });

  test.each(vectors.tiers.map((t) => [t.id, t] as const))(
    "tier %s: leaves, region counts, cells and paths",
    (_id, v) => {
      const { tier, leavesOf } = tierOf(v);
      const derived = deriveTierCells(tier, leavesOf, new Map());
      if (v.leaves !== undefined) {
        const deduped = firstOccurrence(
          tier.groups.map((g) => leavesOf.get(g.group_id) ?? []),
          [],
        );
        expect(deduped).toEqual(v.leaves.map((row) => row.map(decimal)));
      }
      expect(derived.regions).toEqual(v.regions.map(decimal));
      expect(derived.cells).toHaveLength(v.cells.length);
      for (const [i, c] of v.cells.entries()) {
        const d = derived.cells[i];
        expect(d?.regions).toEqual(c.regions);
        expect(d?.groups).toEqual(c.groups.map(decimal));
        expect(d?.root).toBe(decimal(c.root));
        expect(d?.members).toBe(decimal(c.members));
        expect(d?.leaves).toHaveLength(c.leafCount);
        for (const p of c.paths) {
          const leaves = d?.leaves ?? [];
          expect(leaves[p.index]).toBe(decimal(p.leaf));
          expect(tierTreePath(leaves, p.index)).toEqual(p.siblings.map(decimal));
          expect(climb(decimal(p.leaf), p.index, p.siblings.map(decimal))).toBe(decimal(c.root));
        }
      }
    },
    // The split tier hashes about 3,200 leaves through Poseidon2 several times:
    // a few seconds alone, more beside every other package's tests.
    60_000,
  );

  test("a definition stating exactly the derived electorate matches, and each wrong field is found", () => {
    for (const v of vectors.tiers) {
      const { tier, leavesOf } = tierOf(v);
      const derived = deriveTierCells(tier, leavesOf, new Map());
      const stated: TierElectorate = {
        tier: 0,
        root_l2_block: 1n,
        groups: tier.groups,
        regions: v.regions.map(decimal),
        cells: v.cells.map((c) => ({ root: decimal(c.root), members: decimal(c.members) })),
      };
      expect(tierElectorateMismatch(stated, derived), v.id).toBeUndefined();
      const regions = stated.regions.map((n, i) => (i === 0 ? n + 1n : n));
      expect(tierElectorateMismatch({ ...stated, regions }, derived)).toEqual({
        field: "regions",
        region: 0,
      });
      const last = stated.cells.length - 1;
      const bump = (f: "root" | "members") =>
        stated.cells.map((c, i) => (i === last ? { ...c, [f]: c[f] + 1n } : c));
      expect(tierElectorateMismatch({ ...stated, cells: bump("root") }, derived)).toEqual({
        field: "cell-root",
        cell: last,
      });
      expect(tierElectorateMismatch({ ...stated, cells: bump("members") }, derived)).toEqual({
        field: "cell-members",
        cell: last,
      });
      expect(
        tierElectorateMismatch({ ...stated, cells: [...stated.cells, stated.cells[0]!] }, derived), // cells is non-empty: the fold gives at least one
      ).toEqual({ field: "cells", count: stated.cells.length });
    }
  });
});

describe("the fold's properties (docs/spec/election-definition.md, Regional cells)", () => {
  const counts = fc.array(
    fc.oneof(
      fc.bigInt({ min: 1n, max: 2n * DEFINITION_V3_FLOOR }),
      fc.constantFrom(DEFINITION_V3_FLOOR - 1n, DEFINITION_V3_FLOOR),
    ),
    { minLength: 1, maxLength: 40 },
  );

  test("partitions the regions, keeps region order, and puts the remainder last", () => {
    fc.assert(
      fc.property(counts, (members) => {
        const cells = foldRegions(members);
        const all = cells.flat();
        expect(all.toSorted((a, b) => a - b)).toEqual(members.map((_, i) => i));
        for (const c of cells) expect(c).toEqual(c.toSorted((a, b) => a - b));
        // Every cell but the last is one region on its own.
        for (const c of cells.slice(0, -1)) expect(c).toHaveLength(1);
      }),
      { numRuns },
    );
  });

  test("every cell of a split tier reaches the floor, and an unsplit tier is one cell", () => {
    fc.assert(
      fc.property(counts, (members) => {
        const cells = foldRegions(members);
        const size = (c: readonly number[]) => c.reduce((n, r) => n + (members[r] as bigint), 0n);
        if (cells.length > 1) for (const c of cells) expect(size(c)).toBeGreaterThanOrEqual(1000n);
        else expect(cells[0]).toHaveLength(members.length);
      }),
      { numRuns },
    );
  });

  test("a large region is never merged: when split, each is its own cell", () => {
    fc.assert(
      fc.property(counts, (members) => {
        const cells = foldRegions(members);
        if (cells.length === 1) return;
        for (const [i, n] of members.entries())
          if (n >= DEFINITION_V3_FLOOR) expect(cells).toContainEqual([i]);
      }),
      { numRuns },
    );
  });

  test("refuses no regions and negative counts", () => {
    expect(() => foldRegions([])).toThrow(RangeError);
    expect(() => foldRegions([5n, -1n])).toThrow(RangeError);
  });
});

describe("first occurrence and cell trees (docs/spec/membership.md, Cell tree)", () => {
  const value = fc.bigInt({ min: 2n, max: 40n });
  const groups = fc.array(fc.array(fc.oneof(value, fc.constant(0n)), { maxLength: 8 }), {
    minLength: 1,
    maxLength: 5,
  });

  test("each nonzero commitment survives exactly once, at its first position", () => {
    fc.assert(
      fc.property(groups, (gs) => {
        const out = firstOccurrence(gs, []);
        const flatIn = gs.flat();
        const flatOut = out.flat();
        expect(flatOut).toHaveLength(flatIn.length);
        const kept = flatOut.filter((x) => x !== 0n);
        expect(new Set(kept).size).toBe(kept.length);
        expect(new Set(kept)).toEqual(new Set(flatIn.filter((x) => x !== 0n)));
        for (const [i, x] of flatOut.entries()) if (x !== 0n) expect(flatIn.indexOf(x)).toBe(i);
      }),
      { numRuns },
    );
  });

  test("no commitment is counted in two cells, and the region counts sum to the distinct commitments", () => {
    fc.assert(
      fc.property(groups, fc.array(fc.nat(2), { minLength: 5, maxLength: 5 }), (gs, regionOf) => {
        const used = new Set(gs.map((_, i) => regionOf[i] as number));
        // Renumber so every region is named by a group, as `electorate` requires.
        const index = new Map([...used].toSorted((a, b) => a - b).map((r, i) => [r, i]));
        const tier = {
          groups: gs.map((_, i) => ({
            group_id: BigInt(10 + i),
            region: index.get(regionOf[i] as number) as number,
          })),
          regions: Array.from({ length: used.size }, () => 0n),
        };
        const derived = deriveTierCells(
          tier,
          new Map(gs.map((g, i) => [BigInt(10 + i), g])),
          new Map(),
        );
        const distinct = new Set(gs.flat().filter((x) => x !== 0n)).size;
        expect(derived.regions.reduce((a, b) => a + b, 0n)).toBe(BigInt(distinct));
        const seen = new Set<bigint>();
        for (const c of derived.cells)
          for (const leaf of c.leaves)
            if (leaf !== 0n) {
              expect(seen.has(leaf)).toBe(false);
              seen.add(leaf);
            }
        for (const c of derived.cells) expect(c.root).toBe(tierTreeRoot(c.leaves));
      }),
      { numRuns: Math.min(numRuns, 200) },
    );
  });

  test("refuses groups out of order, an unknown region and a group with no leaves", () => {
    const leaves = new Map([
      [1n, [5n]],
      [2n, [6n]],
    ]);
    const regions = [0n];
    expect(() =>
      deriveTierCells(
        {
          groups: [
            { group_id: 2n, region: 0 },
            { group_id: 1n, region: 0 },
          ],
          regions,
        },
        leaves,
        new Map(),
      ),
    ).toThrow(RangeError);
    expect(() =>
      deriveTierCells({ groups: [{ group_id: 1n, region: 1 }], regions }, leaves, new Map()),
    ).toThrow(RangeError);
    expect(() =>
      deriveTierCells({ groups: [{ group_id: 3n, region: 0 }], regions }, leaves, new Map()),
    ).toThrow(RangeError);
  });
});
