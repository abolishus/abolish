// The tier tree of docs/spec/membership.md, Tier tree: a complete depth-32
// Poseidon2 tree over a tier group's additions, which verifiers rebuild from
// the board (docs/spec/verifier.md 2.4) and never take from a group contract.
// A fixed depth with every path of length 32 means one registration is at
// most one identity (T-03, T-04, T-06).

import { isForbiddenCommitment } from "./group-registry.ts";
import { MEMBERSHIP_DEPTH } from "./membership.ts";
import { poseidon2 } from "./poseidon.ts";

/**
 * The most leaves a tier tree has; a group with more additions has none. A
 * JavaScript array holds at most 2^32 − 1 elements, so in practice memory
 * gives out first; the checks state the spec's bound.
 */
export const TIER_TREE_MAX_LEAVES = 2 ** MEMBERSHIP_DEPTH;

let zeroChain: readonly bigint[] | undefined;

/** `Z_0 = 0`, `Z_{h+1} = Poseidon2(Z_h, Z_h)`: the empty subtree at each height, 0 to 32. */
export function tierTreeZeros(): readonly bigint[] {
  if (zeroChain === undefined) {
    const z = [0n];
    for (let h = 0; h < MEMBERSHIP_DEPTH; h++) {
      const below = z[h] as bigint; // z has h + 1 entries here.
      z.push(poseidon2(below, below));
    }
    zeroChain = Object.freeze(z);
  }
  return zeroChain;
}

function checkedLeaves(leaves: readonly bigint[]): bigint[] {
  if (!Array.isArray(leaves)) throw new TypeError("leaves: expected an array");
  const copy = leaves.slice();
  if (copy.length > TIER_TREE_MAX_LEAVES)
    throw new RangeError("leaves: a group with more than 2^32 additions has no tier tree");
  // A leaf is 0 or a member's commitment; a forbidden value here (1, the
  // commitment of secret 0, anything not below r) is a replay bug.
  for (const leaf of copy)
    if (typeof leaf !== "bigint" || (leaf !== 0n && isForbiddenCommitment(leaf)))
      throw new RangeError("leaves: expected 0 or a commitment that isn't forbidden");
  return copy;
}

/** Every level of the tree, from the leaves (level 0) up; empty nodes are left out. */
function levels(leaves: readonly bigint[]): bigint[][] {
  const z = tierTreeZeros();
  const out: bigint[][] = [leaves.slice()];
  for (let h = 0; h < MEMBERSHIP_DEPTH; h++) {
    const below = out[h] as bigint[]; // out has h + 1 levels here.
    const empty = z[h] as bigint;
    const up: bigint[] = [];
    for (let j = 0; 2 * j < below.length; j++)
      up.push(poseidon2(below[2 * j] as bigint, below[2 * j + 1] ?? empty));
    out.push(up);
  }
  return out;
}

/**
 * The tier tree's root over `leaves` in order (0 where a member was removed
 * or a commitment was forbidden), with empty leaves beyond them. An empty
 * tier's root is `Z_32`, which no one can prove against, so a definition
 * listing it fails (docs/spec/membership.md, Checks).
 */
export function tierTreeRoot(leaves: readonly bigint[]): bigint {
  const all = levels(checkedLeaves(leaves));
  return all[MEMBERSHIP_DEPTH]?.[0] ?? (tierTreeZeros()[MEMBERSHIP_DEPTH] as bigint);
}

/**
 * The 32 siblings of leaf `index`, bottom up: an honest member's Semaphore
 * path, with `len = 32` and `index` as the path index. The ballot client
 * builds it from the whole tier, never by asking a server for its own path
 * (T-10, T-13; P2-8).
 */
export function tierTreePath(leaves: readonly bigint[], index: number): bigint[] {
  const copy = checkedLeaves(leaves);
  if (!Number.isSafeInteger(index) || index < 0 || index >= copy.length)
    throw new RangeError("tierTreePath: index must name a leaf");
  const all = levels(copy);
  const z = tierTreeZeros();
  const path: bigint[] = [];
  for (let h = 0; h < MEMBERSHIP_DEPTH; h++) {
    // Arithmetic, not `^ 1`: bitwise operators wrap above 2^31.
    const n = Math.floor(index / 2 ** h);
    path.push(all[h]?.[n % 2 === 0 ? n + 1 : n - 1] ?? (z[h] as bigint));
  }
  return path;
}

/** A member's place in a tier tree, found in one pass over its leaves. */
export interface TierTreeMemberPath {
  /** The first leaf holding the member's commitment. */
  readonly index: number;
  /** Its 32 siblings, bottom up, as `tierTreePath` gives them. */
  readonly siblings: readonly bigint[];
  /** The root over every leaf, as `tierTreeRoot` gives it. */
  readonly root: bigint;
}

/**
 * The path of the first leaf equal to `member` and the tree's root, in one
 * pass over `leaves` holding 32 nodes, never the leaves: the ballot client
 * builds its path from a whole tier (or cell) on a phone, so a large tier is
 * streamed rather than held again, with its levels, as `tierTreePath` holds
 * it (P2-21 part 3; T-10, T-13). Each leaf is read once, so an iterable
 * can't show the path one list and the root another. `undefined` if no leaf
 * is `member`. Leaves are checked as `tierTreeRoot` checks them.
 */
export function tierTreeMemberPath(
  leaves: Iterable<bigint>,
  member: bigint,
): TierTreeMemberPath | undefined {
  if (leaves === null || typeof leaves !== "object" || !(Symbol.iterator in leaves))
    throw new TypeError("leaves: expected an iterable");
  if (typeof member !== "bigint" || isForbiddenCommitment(member))
    throw new RangeError("member: expected a commitment that isn't forbidden");
  const z = tierTreeZeros();
  // frontier[h]: the newest complete node of even index at level h, waiting for its right sibling.
  const frontier: bigint[] = [];
  const siblings: (bigint | undefined)[] = Array.from(
    { length: MEMBERSHIP_DEPTH },
    () => undefined,
  );
  // Arithmetic, not `>>` or `^ 1`: bitwise operators wrap above 2^31.
  const siblingAt = (index: number, h: number) => {
    const n = Math.floor(index / 2 ** h);
    return n % 2 === 0 ? n + 1 : n - 1;
  };
  let count = 0;
  let index = -1;
  let full: bigint | undefined;
  for (const leaf of leaves) {
    if (typeof leaf !== "bigint" || (leaf !== 0n && isForbiddenCommitment(leaf)))
      throw new RangeError("leaves: expected 0 or a commitment that isn't forbidden");
    if (count >= TIER_TREE_MAX_LEAVES)
      throw new RangeError("leaves: a group with more than 2^32 additions has no tier tree");
    if (index < 0 && leaf === member) {
      index = count;
      // Its left siblings are complete already, each waiting in the frontier.
      for (let h = 0; h < MEMBERSHIP_DEPTH; h++)
        if (Math.floor(index / 2 ** h) % 2 === 1) siblings[h] = frontier[h];
    }
    let node = leaf;
    let at = count;
    let h = 0;
    for (; h < MEMBERSHIP_DEPTH; h++) {
      // A right sibling of the member's path is complete when it is formed.
      if (index >= 0 && at === siblingAt(index, h)) siblings[h] = node;
      if (at % 2 === 0) {
        frontier[h] = node;
        break;
      }
      node = poseidon2(frontier[h] as bigint, node); // `at` is odd, so its left sibling waits.
      at = Math.floor(at / 2);
    }
    if (h === MEMBERSHIP_DEPTH) full = node; // the 2^32nd leaf completes the root
    count++;
  }
  if (index < 0) return undefined;
  // Close the tree over empty leaves: at each level the node of index
  // floor(count / 2^h) is partial (`node`, or empty if undefined) and every
  // later one is empty.
  let node: bigint | undefined;
  for (let h = 0; h < MEMBERSHIP_DEPTH; h++) {
    const empty = z[h] as bigint;
    const partial = Math.floor(count / 2 ** h);
    const sibling = siblingAt(index, h);
    if (sibling === partial) siblings[h] = node ?? empty;
    else if (sibling > partial) siblings[h] = empty;
    if (partial % 2 === 1) node = poseidon2(frontier[h] as bigint, node ?? empty);
    else if (node !== undefined) node = poseidon2(node, empty);
  }
  return {
    index,
    siblings: siblings.map((s) => s as bigint), // every level is set above
    root: full ?? node ?? (z[MEMBERSHIP_DEPTH] as bigint),
  };
}

/** One logged event of a group contract that records no signed sequence. */
export type TierGroupEvent =
  | { readonly kind: "add"; readonly commitment: bigint }
  | { readonly kind: "remove"; readonly index: bigint };

export interface TierGroupReplay {
  /** The tier tree's leaves in order, `0n` for a removed or forbidden addition. */
  readonly leaves: readonly bigint[];
  /** The members counted: additions whose commitment isn't forbidden, not removed. */
  readonly groupSize: number;
}

/**
 * The lenient replay of docs/spec/membership.md, Commitments and removals, for
 * group contracts whose records carry no signed sequence. A forbidden
 * commitment keeps its index with leaf 0 and isn't counted; a removal names a
 * leaf index and sets it to 0, and one naming an index not yet added or a leaf
 * already 0 changes nothing. Nothing here fails the definition, so no
 * registrant or stray removal can break later elections (T-25, T-53), and two
 * verifiers always rebuild the same root. Groups in the group registry are
 * replayed strictly instead (`applyGroupRecords`). The caller passes only the
 * events counted toward the tier under its binding (verifier 2.4).
 */
export function replayTierGroup(events: readonly TierGroupEvent[]): TierGroupReplay {
  if (!Array.isArray(events)) throw new TypeError("events: expected an array");
  const leaves: bigint[] = [];
  for (const [at, event] of events.slice().entries()) {
    const { kind } = event;
    if (kind === "add") {
      const { commitment } = event;
      if (typeof commitment !== "bigint" || commitment < 0n || commitment >= 2n ** 256n)
        throw new RangeError(`events[${at}]: a commitment is a uint256`);
      if (leaves.length >= TIER_TREE_MAX_LEAVES)
        throw new RangeError("events: a group with more than 2^32 additions has no tier tree");
      leaves.push(isForbiddenCommitment(commitment) ? 0n : commitment);
    } else if (kind === "remove") {
      const { index } = event;
      if (typeof index !== "bigint" || index < 0n)
        throw new RangeError(`events[${at}]: an index is a non-negative integer`);
      if (index < BigInt(leaves.length)) leaves[Number(index)] = 0n;
    } else throw new TypeError(`events[${at}]: kind must be "add" or "remove"`);
  }
  return { leaves, groupSize: leaves.reduce((n, leaf) => (leaf === 0n ? n : n + 1), 0) };
}

/**
 * Internal: a tier tree kept across updates, so a group's roots at many blocks
 * cost one pass over its records rather than one rebuild per block (T-52).
 * Leaves are appended in order or set to 0 (a removal); `root()` rehashes only
 * the nodes above leaves changed since the last call. It gives `tierTreeRoot`
 * of the same leaves.
 */
export class TierTreeBuilder {
  readonly #levels: bigint[][] = Array.from({ length: MEMBERSHIP_DEPTH + 1 }, () => []);
  #dirty = new Set<number>();

  /** The number of leaves, removed ones included. */
  get size(): number {
    return (this.#levels[0] as bigint[]).length;
  }

  /** Appends a member's commitment as the next leaf. */
  append(leaf: bigint): void {
    if (typeof leaf !== "bigint" || isForbiddenCommitment(leaf))
      throw new RangeError("append: expected a commitment that isn't forbidden");
    if (this.size >= TIER_TREE_MAX_LEAVES)
      throw new RangeError("append: a group with more than 2^32 additions has no tier tree");
    this.#dirty.add(this.size);
    (this.#levels[0] as bigint[]).push(leaf);
  }

  /** Sets leaf `index`, already added, to 0. */
  remove(index: number): void {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.size)
      throw new RangeError("remove: index must name a leaf");
    (this.#levels[0] as bigint[])[index] = 0n;
    this.#dirty.add(index);
  }

  root(): bigint {
    const z = tierTreeZeros();
    let changed = this.#dirty;
    for (let h = 0; h < MEMBERSHIP_DEPTH; h++) {
      const below = this.#levels[h] as bigint[];
      const up = this.#levels[h + 1] as bigint[];
      const empty = z[h] as bigint;
      const parents = new Set<number>();
      // Arithmetic, not `>> 1`: bitwise operators wrap above 2^31.
      for (const i of changed) parents.add(Math.floor(i / 2));
      // Ascending, so a new parent is always the next one along its level.
      for (const j of [...parents].sort((a, b) => a - b))
        up[j] = poseidon2(below[2 * j] as bigint, below[2 * j + 1] ?? empty);
      changed = parents;
    }
    this.#dirty = new Set();
    return this.#levels[MEMBERSHIP_DEPTH]?.[0] ?? (z[MEMBERSHIP_DEPTH] as bigint);
  }
}
