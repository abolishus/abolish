// The tier tree of docs/spec/membership.md, Tier tree: a complete depth-32
// Poseidon2 tree over a tier group's additions, which verifiers rebuild from
// the board (docs/spec/verifier.md 2.4) and never take from a group contract.
// A fixed depth with every path of length 32 means one registration is at
// most one identity (T-03, T-04, T-06).

import { isForbiddenCommitment } from "./group-registry.ts";
import { MEMBERSHIP_DEPTH } from "./membership.ts";
import { poseidon2 } from "./poseidon.ts";

/** The most leaves a tier tree has; a group with more additions has none. */
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
  for (let h = 0; h < MEMBERSHIP_DEPTH; h++)
    path.push(all[h]?.[Math.floor(index / 2 ** h) ^ 1] ?? (z[h] as bigint));
  return path;
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
