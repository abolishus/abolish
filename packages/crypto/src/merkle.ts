// The Merkle tree of RFC 9162 (Certificate Transparency 2.0) §2.1, over a
// leaf hash and a node hash, with its inclusion and consistency proofs. The
// board instantiates it with tagged `H` (docs/spec/board.md); the tests also
// run it with RFC 6962's hashes against published vectors. Roots bind every
// leaf and its position, so recomputing one detects any change, drop or
// reorder (T-23), and consistency proofs show that an anchored tree extends
// one a voter was shown earlier (T-24).

import { ds } from "./domain-separation.ts";
import { H } from "./group.ts";

/** The two hash functions a tree is built from: `MTH({d})` and an interior node. */
export interface TreeHash {
  leaf(data: Uint8Array): Uint8Array;
  node(left: Uint8Array, right: Uint8Array): Uint8Array;
}

const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

/**
 * The board tree's hashes: `H(DS("abolish/v1/merkle/leaf", d))` and
 * `H(DS("abolish/v1/merkle/node", left ‖ right))`. The two tags play the role
 * of RFC 9162's `0x00` and `0x01` prefixes, so no leaf hash equals a node hash.
 */
export const BOARD_TREE: TreeHash = Object.freeze({
  leaf: (data: Uint8Array) => H(ds("abolish/v1/merkle/leaf", data)),
  node: (left: Uint8Array, right: Uint8Array) =>
    H(ds("abolish/v1/merkle/node", concat(left, right))),
});

const U64_MAX = (1n << 64n) - 1n;
const MAX_PATH = 65;

function checkLeaves(leaves: readonly Uint8Array[]): void {
  if (!Array.isArray(leaves) || leaves.length === 0)
    throw new RangeError("a tree has at least one leaf");
}

/** The largest power of two smaller than `n`, for `n > 1`. */
function split(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** `MTH(D[from:to])`, §2.1.1. */
function mth(h: TreeHash, d: readonly Uint8Array[], from: number, to: number): Uint8Array {
  const n = to - from;
  if (n === 1) return h.leaf(d[from] as Uint8Array);
  const k = split(n);
  return h.node(mth(h, d, from, from + k), mth(h, d, from + k, to));
}

/** `MTH(D[n])` of a non-empty list of leaves. The board never hashes an empty tree. */
export function merkleRoot(h: TreeHash, leaves: readonly Uint8Array[]): Uint8Array {
  checkLeaves(leaves);
  return mth(h, leaves, 0, leaves.length);
}

/**
 * The roots of every prefix of `leaves` whose size is in `sizes`, in one pass:
 * O(n) hashes for the leaves plus O(log n) per root, where computing each
 * root afresh would cost O(n) each.
 */
export function merkleRoots(
  h: TreeHash,
  leaves: readonly Uint8Array[],
  sizes: ReadonlySet<number>,
): Map<number, Uint8Array> {
  const out = new Map<number, Uint8Array>();
  // The perfect subtrees covering the leaves so far, largest first: the
  // binary decomposition of the size. MTH of the prefix folds them from the
  // right, which is §2.1.1's recursion unrolled.
  const stack: { size: number; hash: Uint8Array }[] = [];
  for (let i = 0; i < leaves.length; i++) {
    let top = { size: 1, hash: h.leaf(leaves[i] as Uint8Array) };
    for (
      let last = stack.at(-1);
      last !== undefined && last.size === top.size;
      last = stack.at(-1)
    ) {
      stack.pop();
      top = { size: last.size * 2, hash: h.node(last.hash, top.hash) };
    }
    stack.push(top);
    if (sizes.has(i + 1)) {
      let root = (stack.at(-1) as (typeof stack)[number]).hash;
      for (let j = stack.length - 2; j >= 0; j--)
        root = h.node((stack[j] as (typeof stack)[number]).hash, root);
      out.set(i + 1, root);
    }
  }
  return out;
}

/** `PATH(m, D[from:to])`, §2.1.3.1. */
function path(
  h: TreeHash,
  m: number,
  d: readonly Uint8Array[],
  from: number,
  to: number,
): Uint8Array[] {
  const n = to - from;
  if (n === 1) return [];
  const k = split(n);
  return m < k
    ? [...path(h, m, d, from, from + k), mth(h, d, from + k, to)]
    : [...path(h, m - k, d, from + k, to), mth(h, d, from, from + k)];
}

/** The audit path proving leaf `index` is in the tree of `leaves` (RFC 9162 §2.1.3.1). */
export function inclusionProof(
  h: TreeHash,
  leaves: readonly Uint8Array[],
  index: number,
): Uint8Array[] {
  checkLeaves(leaves);
  if (!Number.isSafeInteger(index) || index < 0 || index >= leaves.length)
    throw new RangeError("index must be a leaf of the tree");
  return path(h, index, leaves, 0, leaves.length);
}

/** `SUBPROOF(m, D[from:to], b)`, §2.1.4.1. */
function subproof(
  h: TreeHash,
  m: number,
  d: readonly Uint8Array[],
  from: number,
  to: number,
  b: boolean,
): Uint8Array[] {
  const n = to - from;
  if (m === n) return b ? [] : [mth(h, d, from, to)];
  const k = split(n);
  return m <= k
    ? [...subproof(h, m, d, from, from + k, b), mth(h, d, from + k, to)]
    : [...subproof(h, m - k, d, from + k, to, false), mth(h, d, from, from + k)];
}

/**
 * The proof that the tree of the first `size1` leaves is a prefix of the tree
 * of all of `leaves` (RFC 9162 §2.1.4.1); empty when the sizes are equal.
 */
export function consistencyProof(
  h: TreeHash,
  leaves: readonly Uint8Array[],
  size1: number,
): Uint8Array[] {
  checkLeaves(leaves);
  if (!Number.isSafeInteger(size1) || size1 < 1 || size1 > leaves.length)
    throw new RangeError("size1 must be from 1 to the tree's size");
  return size1 === leaves.length ? [] : subproof(h, size1, leaves, 0, leaves.length, true);
}

const isHash = (x: unknown): x is Uint8Array =>
  x instanceof Uint8Array && ArrayBuffer.isView(x) && x.length === 32;

const isU64 = (x: unknown): x is bigint => typeof x === "bigint" && x >= 0n && x <= U64_MAX;

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/** Copies a proof, or returns undefined if any part of it isn't a 32-byte hash. */
function readPath(proof: readonly Uint8Array[]): Uint8Array[] | undefined {
  // docs/spec/board.md: every verification step shifts `sn`, a u64, so a
  // longer path always fails; rejecting it first bounds the work (T-52).
  if (!Array.isArray(proof) || proof.length > MAX_PATH) return undefined;
  // Read once, by index, so a proxy or getter can't change it between checks.
  const out: Uint8Array[] = [];
  const n = proof.length;
  for (let i = 0; i < n; i++) {
    const p: unknown = proof[i];
    if (!isHash(p)) return undefined;
    out.push(new Uint8Array(p));
  }
  return out;
}

/**
 * Verifies an inclusion proof (RFC 9162 §2.1.3.2): that `leaf` (the leaf's
 * data, which this hashes with `h.leaf`) is leaf `index` of the tree of
 * `size` leaves with root `root`. Malformed arguments verify as false.
 */
export function verifyInclusion(
  h: TreeHash,
  index: bigint,
  size: bigint,
  leaf: Uint8Array,
  proof: readonly Uint8Array[],
  root: Uint8Array,
): boolean {
  const p = readPath(proof);
  if (p === undefined || !isU64(index) || !isU64(size) || !isHash(root)) return false;
  if (!(leaf instanceof Uint8Array) || !ArrayBuffer.isView(leaf)) return false;
  if (index >= size) return false;
  let fn = index;
  let sn = size - 1n;
  let r = h.leaf(new Uint8Array(leaf));
  for (const x of p) {
    if (sn === 0n) return false;
    if ((fn & 1n) === 1n || fn === sn) {
      r = h.node(x, r);
      while ((fn & 1n) === 0n && fn !== 0n) {
        fn >>= 1n;
        sn >>= 1n;
      }
    } else {
      r = h.node(r, x);
    }
    fn >>= 1n;
    sn >>= 1n;
  }
  return sn === 0n && equal(r, root);
}

/**
 * Verifies a consistency proof (RFC 9162 §2.1.4.2): that the tree of `size1`
 * leaves with root `root1` is a prefix of the tree of `size2` leaves with root
 * `root2`. Equal sizes need an empty proof and equal roots; `size1` is at
 * least 1, so two empty trees are never consistent. Malformed arguments verify as false.
 */
export function verifyConsistency(
  h: TreeHash,
  size1: bigint,
  size2: bigint,
  root1: Uint8Array,
  root2: Uint8Array,
  proof: readonly Uint8Array[],
): boolean {
  const p = readPath(proof);
  if (p === undefined || !isU64(size1) || !isU64(size2) || !isHash(root1) || !isHash(root2))
    return false;
  if (size1 === 0n) return false;
  if (size1 === size2) return p.length === 0 && equal(root1, root2);
  if (size1 > size2 || p.length === 0) return false;
  // When size1 is a power of two its root is a node of the larger tree, and
  // the proof leaves it out.
  if ((size1 & (size1 - 1n)) === 0n) p.unshift(new Uint8Array(root1));
  let fn = size1 - 1n;
  let sn = size2 - 1n;
  while ((fn & 1n) === 1n) {
    fn >>= 1n;
    sn >>= 1n;
  }
  let fr = p[0] as Uint8Array;
  let sr = fr;
  for (const c of p.slice(1)) {
    if (sn === 0n) return false;
    if ((fn & 1n) === 1n || fn === sn) {
      fr = h.node(c, fr);
      sr = h.node(c, sr);
      while ((fn & 1n) === 0n && fn !== 0n) {
        fn >>= 1n;
        sn >>= 1n;
      }
    } else {
      sr = h.node(sr, c);
    }
    fn >>= 1n;
    sn >>= 1n;
  }
  return equal(fr, root1) && equal(sr, root2) && sn === 0n;
}
