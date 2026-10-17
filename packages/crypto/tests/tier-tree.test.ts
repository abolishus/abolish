import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  BN254_R,
  isForbiddenCommitment,
  MEMBERSHIP_DEPTH,
  POSEIDON2_ZERO_ONE,
  poseidon2,
  replayTierGroup,
  type TierGroupEvent,
  tierTreeMemberPath,
  tierTreePath,
  tierTreeRoot,
  tierTreeZeros,
} from "../src/index.ts";
import { TierTreeBuilder } from "../src/tier-tree.ts";
import { SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/tier-tree.json comes from an independent Python
// implementation of circomlib's Poseidon and the tier tree
// (scripts/tier-tree-vectors.py), so no expected value here comes from the
// code under test (docs/spec/membership.md, Tier tree; T-03, T-04, T-06).

interface TierTreeVectors {
  readonly format: string;
  readonly depth: number;
  readonly poseidon2: readonly {
    readonly id: string;
    readonly inputs: readonly string[];
    readonly output: string;
  }[];
  readonly zeros: readonly string[];
  readonly trees: readonly {
    readonly id: string;
    readonly events: readonly ({ readonly add: string } | { readonly remove: string })[];
    readonly leaves: readonly string[];
    readonly groupSize: number;
    readonly root: string;
    readonly emptyRoot: boolean;
    readonly paths: readonly { readonly index: number; readonly siblings: readonly string[] }[];
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("tier-tree.json", SPEC_VECTORS), "utf8"),
) as TierTreeVectors;

const decimal = (s: string | undefined) => {
  if (s === undefined || !/^(?:0|[1-9][0-9]*)$/.test(s)) throw new Error(`not a decimal: ${s}`);
  return BigInt(s);
};
const events = (raw: TierTreeVectors["trees"][number]["events"]): TierGroupEvent[] =>
  raw.map((e) =>
    "add" in e
      ? { kind: "add", commitment: decimal(e.add) }
      : { kind: "remove", index: decimal(e.remove) },
  );
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const member = fc.bigInt({ min: 2n, max: BN254_R - 1n }).filter((v) => !isForbiddenCommitment(v));

/** The root a path climbs to, as Semaphore's circuit computes it with len = 32. */
function climb(leaf: bigint, index: number, siblings: readonly bigint[]): bigint {
  let node = leaf;
  for (const [h, sibling] of siblings.entries())
    node =
      Math.floor(index / 2 ** h) % 2 === 0 ? poseidon2(node, sibling) : poseidon2(sibling, node);
  return node;
}

describe("tier-tree vectors (docs/spec/vectors/tier-tree.json)", () => {
  test("uses the format this reader knows, at the protocol-wide depth", () => {
    expect(vectors.format).toBe("abolish-tier-tree-vectors/1");
    expect(vectors.depth).toBe(MEMBERSHIP_DEPTH);
  });

  test("Poseidon2 matches the independent implementation", () => {
    expect(vectors.poseidon2).toHaveLength(5);
    for (const v of vectors.poseidon2)
      expect(poseidon2(decimal(v.inputs[0]), decimal(v.inputs[1])), v.id).toBe(decimal(v.output));
  });

  test("the empty-subtree chain is Z_0 = 0, Z_{h+1} = Poseidon2(Z_h, Z_h)", () => {
    expect(vectors.zeros).toHaveLength(MEMBERSHIP_DEPTH + 1);
    expect(tierTreeZeros()).toEqual(vectors.zeros.map(decimal));
  });

  test("replays each group's events to its leaves, group size and root", () => {
    expect(vectors.trees).toHaveLength(11);
    for (const t of vectors.trees) {
      const replay = replayTierGroup(events(t.events));
      expect(replay.leaves, t.id).toEqual(t.leaves.map(decimal));
      expect(replay.groupSize, t.id).toBe(t.groupSize);
      const root = tierTreeRoot(replay.leaves);
      expect(root, t.id).toBe(decimal(t.root));
      expect(root === tierTreeZeros()[MEMBERSHIP_DEPTH], t.id).toBe(t.emptyRoot);
    }
  });

  test("gives each member the independent implementation's 32 siblings", () => {
    let checked = 0;
    for (const t of vectors.trees) {
      const leaves = t.leaves.map(decimal);
      for (const p of t.paths) {
        const siblings = tierTreePath(leaves, p.index);
        expect(siblings, `${t.id}[${p.index}]`).toEqual(p.siblings.map(decimal));
        expect(climb(leaves[p.index] as bigint, p.index, siblings)).toBe(decimal(t.root));
        checked++;
      }
    }
    expect(checked).toBe(17);
  });
});

describe("tier tree", () => {
  test("Poseidon2(0, 1) is the forbidden commitment of secret 0", () => {
    expect(poseidon2(0n, 1n)).toBe(POSEIDON2_ZERO_ONE);
  });

  test("Poseidon2 rejects inputs outside the field instead of reducing them", () => {
    for (const bad of [-1n, BN254_R, BN254_R + 1n])
      expect(() => poseidon2(bad, 0n)).toThrow(RangeError);
    expect(() => poseidon2(0n, 1 as never)).toThrow(RangeError);
  });

  test("every member's path climbs to the root, and no other leaf's does", () => {
    fc.assert(
      fc.property(fc.array(member, { minLength: 1, maxLength: 9 }), fc.nat(), (leaves, pick) => {
        const root = tierTreeRoot(leaves);
        const i = pick % leaves.length;
        const path = tierTreePath(leaves, i);
        expect(path).toHaveLength(MEMBERSHIP_DEPTH);
        expect(climb(leaves[i] as bigint, i, path)).toBe(root);
        const j = (i + 1) % leaves.length;
        if (leaves[j] !== leaves[i]) expect(climb(leaves[j] as bigint, i, path)).not.toBe(root);
      }),
      { numRuns: Math.min(numRuns, 50) },
    );
  });

  test("the root changes with any leaf, and trailing empty leaves don't change it", () => {
    fc.assert(
      fc.property(
        fc.array(member, { minLength: 1, maxLength: 6 }),
        fc.nat(),
        member,
        (leaves, pick, other) => {
          const i = pick % leaves.length;
          const changed = leaves.slice();
          changed[i] = other;
          if (other !== leaves[i]) expect(tierTreeRoot(changed)).not.toBe(tierTreeRoot(leaves));
          expect(tierTreeRoot([...leaves, 0n, 0n])).toBe(tierTreeRoot(leaves));
        },
      ),
      { numRuns: Math.min(numRuns, 50) },
    );
  });

  test("removing a member zeroes its leaf and keeps every other index", () => {
    fc.assert(
      fc.property(
        fc.array(member, { minLength: 1, maxLength: 8 }),
        fc.nat(),
        (commitments, pick) => {
          const i = pick % commitments.length;
          const adds = commitments.map((commitment): TierGroupEvent => ({
            kind: "add",
            commitment,
          }));
          const replay = replayTierGroup([...adds, { kind: "remove", index: BigInt(i) }]);
          const expected = commitments.slice();
          expected[i] = 0n;
          expect(replay.leaves).toEqual(expected);
          expect(replay.groupSize).toBe(commitments.length - 1);
        },
      ),
      { numRuns },
    );
  });

  test("a stray removal, of an index not yet added or a leaf already removed, changes nothing", () => {
    fc.assert(
      fc.property(
        fc.array(member, { minLength: 1, maxLength: 6 }),
        fc.bigInt({ min: 0n, max: 2n ** 64n }),
        (commitments, extra) => {
          const adds = commitments.map((commitment): TierGroupEvent => ({
            kind: "add",
            commitment,
          }));
          const index = BigInt(commitments.length) + extra;
          expect(replayTierGroup([...adds, { kind: "remove", index }])).toEqual(
            replayTierGroup(adds),
          );
          const once = replayTierGroup([...adds, { kind: "remove", index: 0n }]);
          expect(
            replayTierGroup([
              ...adds,
              { kind: "remove", index: 0n },
              { kind: "remove", index: 0n },
            ]),
          ).toEqual(once);
        },
      ),
      { numRuns },
    );
  });

  test("forbidden commitments keep their index with leaf 0 and aren't counted", () => {
    for (const bad of [0n, 1n, POSEIDON2_ZERO_ONE, BN254_R, 2n ** 256n - 1n]) {
      const replay = replayTierGroup([
        { kind: "add", commitment: 5n },
        { kind: "add", commitment: bad },
        { kind: "add", commitment: 7n },
      ]);
      expect(replay.leaves).toEqual([5n, 0n, 7n]);
      expect(replay.groupSize).toBe(2);
    }
  });

  test("rejects malformed events and leaves rather than guessing", () => {
    expect(() => replayTierGroup([{ kind: "add", commitment: 2n ** 256n }])).toThrow(RangeError);
    expect(() => replayTierGroup([{ kind: "add", commitment: -1n }])).toThrow(RangeError);
    expect(() => replayTierGroup([{ kind: "remove", index: -1n }])).toThrow(RangeError);
    expect(() => replayTierGroup([{ kind: "move" } as never])).toThrow(TypeError);
    for (const bad of [1n, POSEIDON2_ZERO_ONE, BN254_R, -1n])
      expect(() => tierTreeRoot([5n, bad])).toThrow(RangeError);
    expect(() => tierTreePath([5n], 1)).toThrow(RangeError);
    expect(() => tierTreePath([5n], -1)).toThrow(RangeError);
  });
});

describe("TierTreeBuilder", () => {
  const commitment = fc.bigInt({ min: 2n, max: 2n ** 200n });

  test("gives tierTreeRoot's root after any appends and removals, wherever roots are taken", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            commitment.map((c) => ({ op: "append" as const, c })),
            fc.nat().map((i) => ({ op: "remove" as const, i })),
            fc.constant({ op: "root" as const }),
          ),
          { maxLength: 40 },
        ),
        (ops) => {
          const tree = new TierTreeBuilder();
          const leaves: bigint[] = [];
          for (const o of ops) {
            if (o.op === "append") {
              tree.append(o.c);
              leaves.push(o.c);
            } else if (o.op === "remove" && leaves.length > 0) {
              tree.remove(o.i % leaves.length);
              leaves[o.i % leaves.length] = 0n;
            } else expect(tree.root()).toBe(tierTreeRoot(leaves));
          }
          expect(tree.root()).toBe(tierTreeRoot(leaves));
          expect(tree.size).toBe(leaves.length);
        },
      ),
      { numRuns: Math.min(numRuns, 50) },
    );
  });

  test("refuses forbidden commitments and indices that name no leaf", () => {
    const tree = new TierTreeBuilder();
    expect(tree.root()).toBe(tierTreeRoot([]));
    expect(() => tree.append(1n)).toThrow(RangeError);
    expect(() => tree.remove(0)).toThrow(RangeError);
    tree.append(5n);
    expect(() => tree.remove(1)).toThrow(RangeError);
    tree.remove(0);
    expect(tree.root()).toBe(tierTreeRoot([0n]));
  });
});

describe("tierTreeMemberPath", () => {
  /** An iterable that can be read once only, as a stream of leaves is. */
  const once = (leaves: readonly bigint[]): Iterable<bigint> => {
    let read = false;
    return {
      *[Symbol.iterator]() {
        if (read) throw new Error("read twice");
        read = true;
        yield* leaves;
      },
    };
  };

  test("gives the independent implementation's siblings and root, from a stream", () => {
    let checked = 0;
    for (const t of vectors.trees) {
      const leaves = t.leaves.map(decimal);
      for (const p of t.paths) {
        const leaf = leaves[p.index] as bigint;
        // The stream finds a commitment's first leaf; other paths are tierTreePath's.
        if (leaf === 0n || leaves.indexOf(leaf) !== p.index) continue;
        expect(tierTreeMemberPath(once(leaves), leaf), `${t.id}[${p.index}]`).toEqual({
          index: p.index,
          siblings: p.siblings.map(decimal),
          root: decimal(t.root),
        });
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(10);
  });

  test(
    "equals tierTreePath and tierTreeRoot for any leaves and member, at every size around a power of two",
    { timeout: 120_000 },
    () => {
      const sizes = [1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 31, 32, 33, 64, 65];
      fc.assert(
        fc.property(
          fc.constantFrom(...sizes),
          fc.array(fc.oneof(member, fc.constant(0n)), { minLength: 65, maxLength: 65 }),
          fc.nat(),
          (size, pool, pick) => {
            const leaves = pool.slice(0, size);
            const i = pick % size;
            const target = leaves[i] === 0n ? 2n : (leaves[i] as bigint);
            leaves[i] = target;
            const first = leaves.indexOf(target);
            expect(tierTreeMemberPath(once(leaves), target)).toEqual({
              index: first,
              siblings: tierTreePath(leaves, first),
              root: tierTreeRoot(leaves),
            });
          },
        ),
        { numRuns: Math.min(numRuns, 100) },
      );
    },
  );

  test("finds the first of repeated leaves, and nothing for a commitment that isn't a leaf", () => {
    const leaves = [5n, 7n, 0n, 7n, 9n];
    expect(tierTreeMemberPath(leaves, 7n)?.index).toBe(1);
    expect(tierTreeMemberPath(leaves, 11n)).toBeUndefined();
    expect(tierTreeMemberPath([], 7n)).toBeUndefined();
  });

  test("rejects leaves tierTreeRoot rejects, and members that can't be leaves", () => {
    for (const bad of [1n, POSEIDON2_ZERO_ONE, BN254_R, -1n])
      expect(() => tierTreeMemberPath([5n, bad], 5n), String(bad)).toThrow(RangeError);
    expect(() => tierTreeMemberPath([5n, 1 as never], 5n)).toThrow(RangeError);
    for (const bad of [0n, 1n, POSEIDON2_ZERO_ONE, BN254_R])
      expect(() => tierTreeMemberPath([5n], bad), String(bad)).toThrow(RangeError);
    expect(() => tierTreeMemberPath(5n as never, 5n)).toThrow(TypeError);
    expect(() => tierTreeMemberPath(null as never, 5n)).toThrow(TypeError);
  });
});
