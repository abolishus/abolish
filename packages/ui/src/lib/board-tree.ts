// The shape of the board's Merkle tree (docs/spec/board.md, Board tree): which
// entries each hash of an inclusion proof commits to. Shape only, no hashing:
// the kit draws proofs a verifier has already checked, and needs to know where
// each hash sits to draw it exactly.

/** A run of board entries, from `from` up to but not including `to`. */
export interface EntryRange {
  readonly from: number;
  readonly to: number;
}

/** One hash of an audit path, from the leaf towards the root. */
export interface AuditStep {
  /** Which side of the running hash the proof's hash goes on: `node(p, r)` is "left". */
  readonly side: "left" | "right";
  /** The entries the proof's hash commits to. */
  readonly sibling: EntryRange;
  /** The entries the node computed at this step commits to. */
  readonly parent: EntryRange;
}

/** RFC 9162's `k`: the largest power of two smaller than `n` (n > 1). */
function split(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/**
 * The audit path `PATH(index, D[size])` of RFC 9162 §2.1.3.1 as ranges, in
 * the order a verifier reads it: one step per hash, from the leaf's sibling
 * to the root's children. Each step's parent covers its sibling and the
 * running node, and the last step's parent is the whole tree.
 */
export function auditPath(index: number, size: number): AuditStep[] {
  if (!Number.isSafeInteger(size) || size < 1) throw new RangeError("a tree has at least one leaf");
  if (!Number.isSafeInteger(index) || index < 0 || index >= size)
    throw new RangeError("index must be a leaf of the tree");
  const steps: AuditStep[] = [];
  const walk = (m: number, from: number, to: number) => {
    const n = to - from;
    if (n === 1) return;
    const k = split(n);
    if (m < k) {
      walk(m, from, from + k);
      steps.push({ side: "right", sibling: { from: from + k, to }, parent: { from, to } });
    } else {
      walk(m - k, from + k, to);
      steps.push({ side: "left", sibling: { from, to: from + k }, parent: { from, to } });
    }
  };
  walk(index, 0, size);
  return steps;
}
