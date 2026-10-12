import { sha256 } from "@noble/hashes/sha2.js";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  appendSubtrees,
  BOARD_TREE,
  consistencyProof,
  consistencyProofSubtrees,
  foldSubtrees,
  inclusionProof,
  inclusionProofSubtrees,
  merkleRoot,
  rootSubtrees,
  type SubtreeId,
  type TreeHash,
  verifyConsistency,
  verifyInclusion,
} from "../src/index.ts";

// Roots and proofs built from stored perfect subtrees must be exactly the ones
// the tree's own functions compute from every leaf, so a server that keeps
// subtrees (T-52) serves what a verifier recomputes (T-23, T-24).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const run = <T>(p: fc.IPropertyWithHooks<T> | fc.IProperty<T>) => fc.assert(p, { numRuns });

const hash32 = fc.uint8Array({ minLength: 32, maxLength: 32 });
const leavesArb = (max: number) => fc.array(hash32, { minLength: 1, maxLength: max });
const key = ({ level, index }: SubtreeId) => `${level}/${index}`;

/** Appends every leaf through `appendSubtrees`, as a store would. */
function buildStore(h: TreeHash, leaves: readonly Uint8Array[]): Map<string, Uint8Array> {
  const store = new Map<string, Uint8Array>();
  leaves.forEach((leaf, size) => {
    const frontier = size === 0 ? [] : rootSubtrees(size).map((s) => store.get(key(s)));
    expect(frontier.every((x) => x !== undefined)).toBe(true);
    for (const s of appendSubtrees(h, frontier as Uint8Array[], size, leaf)) {
      expect(store.has(key(s))).toBe(false);
      store.set(key(s), s.hash);
    }
  });
  return store;
}

const fold = (h: TreeHash, store: Map<string, Uint8Array>, ids: readonly SubtreeId[]) =>
  foldSubtrees(
    h,
    ids.map((s) => {
      const x = store.get(key(s));
      if (x === undefined) throw new Error(`missing subtree ${key(s)}`);
      return x;
    }),
  );

describe("board tree from stored subtrees", () => {
  test("every appended subtree is MTH of its leaves", () => {
    run(
      fc.property(leavesArb(70), (leaves) => {
        const store = buildStore(BOARD_TREE, leaves);
        for (const [k, hash] of store) {
          const [level, index] = k.split("/").map(Number) as [number, number];
          const from = index * 2 ** level;
          expect(from + 2 ** level).toBeLessThanOrEqual(leaves.length);
          expect(hash).toEqual(merkleRoot(BOARD_TREE, leaves.slice(from, from + 2 ** level)));
        }
        // One subtree per node of the perfect subtrees: 2n minus one per set bit.
        const ones = leaves.length.toString(2).replaceAll("0", "").length;
        expect(store.size).toBe(2 * leaves.length - ones);
      }),
    );
  });

  test("roots and proofs equal the ones computed from every leaf", () => {
    run(
      fc.property(leavesArb(70), fc.nat(), fc.nat(), (leaves, a, b) => {
        const store = buildStore(BOARD_TREE, leaves);
        const n = leaves.length;
        const i = a % n;
        const m = (b % n) + 1;
        expect(fold(BOARD_TREE, store, rootSubtrees(n))).toEqual(merkleRoot(BOARD_TREE, leaves));
        expect(inclusionProofSubtrees(i, n).map((r) => fold(BOARD_TREE, store, r))).toEqual(
          inclusionProof(BOARD_TREE, leaves, i),
        );
        expect(consistencyProofSubtrees(m, n).map((r) => fold(BOARD_TREE, store, r))).toEqual(
          consistencyProof(BOARD_TREE, leaves, m),
        );
      }),
    );
  });

  test("every prefix's root and proofs come from the subtrees stored by then", () => {
    const leaves = Array.from({ length: 40 }, (_, i) => sha256(Uint8Array.of(i)));
    const store = buildStore(BOARD_TREE, leaves);
    for (let n = 1; n <= leaves.length; n++) {
      const prefix = leaves.slice(0, n);
      // Only subtrees within the first n leaves: a server answering for an
      // earlier size never needs a later entry.
      const within = (ids: readonly SubtreeId[]) =>
        ids.every((s) => (s.index + 1) * 2 ** s.level <= n);
      expect(within(rootSubtrees(n))).toBe(true);
      expect(fold(BOARD_TREE, store, rootSubtrees(n))).toEqual(merkleRoot(BOARD_TREE, prefix));
      for (let i = 0; i < n; i++) {
        const plan = inclusionProofSubtrees(i, n);
        expect(plan.every(within)).toBe(true);
        expect(plan.map((r) => fold(BOARD_TREE, store, r))).toEqual(
          inclusionProof(BOARD_TREE, prefix, i),
        );
      }
      for (let m = 1; m <= n; m++) {
        const plan = consistencyProofSubtrees(m, n);
        expect(plan.every(within)).toBe(true);
        expect(plan.map((r) => fold(BOARD_TREE, store, r))).toEqual(
          consistencyProof(BOARD_TREE, prefix, m),
        );
      }
    }
  });

  // A symbolic tree: each "hash" records the leaf range it covers and a digest
  // of the tree's shape over it, so roots and proofs of trees far too large to
  // build can be checked against RFC 9162's own verification.
  const POISON = new Uint8Array(32).fill(0xff);
  const u64 = (x: number) => {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, BigInt(x));
    return out;
  };
  const sym = (from: number, to: number, shape: Uint8Array) =>
    Uint8Array.of(...u64(from), ...u64(to), ...shape.subarray(0, 16));
  const parse = (x: Uint8Array) => {
    const v = new DataView(x.buffer, x.byteOffset, 32);
    return { from: Number(v.getBigUint64(0)), to: Number(v.getBigUint64(8)), shape: x.slice(16) };
  };
  const LEAF_SHAPE = sha256(Uint8Array.of(0));
  const SYMBOLIC: TreeHash = {
    leaf: (d) => {
      const i = Number(new DataView(d.buffer, d.byteOffset, 8).getBigUint64(0));
      return sym(i, i + 1, LEAF_SHAPE);
    },
    node: (l, r) => {
      const a = parse(l);
      const b = parse(r);
      if (a.to !== b.from || l.every((x) => x === 0xff) || r.every((x) => x === 0xff))
        return POISON;
      return sym(a.from, b.to, sha256(Uint8Array.of(1, ...a.shape, ...b.shape)));
    },
  };
  const perfectShapes = [LEAF_SHAPE.subarray(0, 16)];
  for (let l = 1; l < 64; l++) {
    const p = perfectShapes[l - 1] as Uint8Array;
    perfectShapes.push(sha256(Uint8Array.of(1, ...p, ...p)).subarray(0, 16));
  }
  const perfect = ({ level, index }: SubtreeId) =>
    sym(index * 2 ** level, (index + 1) * 2 ** level, perfectShapes[level] as Uint8Array);
  /** §2.1.1's MTH over [from, to), symbolically; the left half is always perfect. */
  const mth = (from: number, to: number): Uint8Array => {
    const n = to - from;
    let k = 1;
    while (k * 2 <= n) k *= 2;
    if (k === n) return perfect({ level: Math.log2(k), index: from / k });
    let s = 1;
    while (s * 2 < n) s *= 2;
    return SYMBOLIC.node(mth(from, from + s), mth(from + s, to));
  };
  const symFold = (ids: readonly SubtreeId[]) => foldSubtrees(SYMBOLIC, ids.map(perfect));
  const bigSize = fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER });

  test("roots and proofs of trees up to 2^53 leaves verify under RFC 9162", () => {
    run(
      fc.property(bigSize, fc.double({ min: 0, max: 1, noNaN: true }), (n, t) => {
        const i = Math.min(n - 1, Math.floor(t * n));
        const m = i + 1;
        const root = mth(0, n);
        expect(symFold(rootSubtrees(n))).toEqual(root);
        const path = inclusionProofSubtrees(i, n).map(symFold);
        expect(path.length).toBeLessThanOrEqual(64);
        expect(verifyInclusion(SYMBOLIC, BigInt(i), BigInt(n), u64(i), path, root)).toBe(true);
        const proof = consistencyProofSubtrees(m, n).map(symFold);
        expect(verifyConsistency(SYMBOLIC, BigInt(m), BigInt(n), mth(0, m), root, proof)).toBe(
          true,
        );
      }),
    );
  });

  test("the symbolic tree catches a wrong shape", () => {
    // Folding a 3-leaf range as 0,(1,2) rather than (0,1),2 covers the same
    // leaves but isn't §2.1.1's tree.
    const wrong = SYMBOLIC.node(
      perfect({ level: 0, index: 0 }),
      SYMBOLIC.node(perfect({ level: 0, index: 1 }), perfect({ level: 0, index: 2 })),
    );
    expect(wrong).not.toEqual(mth(0, 3));
    expect(symFold(rootSubtrees(3))).toEqual(mth(0, 3));
  });

  test("appending checks the frontier against the tree's size", () => {
    const leaf = new Uint8Array(32);
    const h = new Uint8Array(32);
    expect(() => appendSubtrees(BOARD_TREE, [h], 0, leaf)).toThrow(RangeError);
    expect(() => appendSubtrees(BOARD_TREE, [], 1, leaf)).toThrow(RangeError);
    expect(() => appendSubtrees(BOARD_TREE, [h], 3, leaf)).toThrow(RangeError);
    expect(() => appendSubtrees(BOARD_TREE, [h.subarray(1), h], 3, leaf)).toThrow(RangeError);
    expect(() => appendSubtrees(BOARD_TREE, [h], -1, leaf)).toThrow(RangeError);
    expect(() => appendSubtrees(BOARD_TREE, [h], 1.5, leaf)).toThrow(RangeError);
    expect(() => appendSubtrees(BOARD_TREE, [], 0, "ab" as never)).toThrow(TypeError);
    expect(appendSubtrees(BOARD_TREE, [h, h], 3, leaf).map(key)).toEqual(["0/3", "1/1", "2/0"]);
  });

  test("plans refuse sizes and indices outside the tree", () => {
    expect(() => rootSubtrees(0)).toThrow(RangeError);
    expect(() => rootSubtrees(2 ** 53)).toThrow(RangeError);
    expect(() => inclusionProofSubtrees(1, 1)).toThrow(RangeError);
    expect(() => inclusionProofSubtrees(-1, 1)).toThrow(RangeError);
    expect(() => consistencyProofSubtrees(0, 1)).toThrow(RangeError);
    expect(() => consistencyProofSubtrees(2, 1)).toThrow(RangeError);
    expect(() => foldSubtrees(BOARD_TREE, [])).toThrow(RangeError);
  });
});
