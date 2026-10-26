// The re-vote rule of docs/spec/revoting.md (ADR 0011): the membership
// proof's message, which binds the L1 block a ballot is ranked by, and the
// admission check on that block (verifier 5.8), and the selection of each tier
// and nullifier's counted ballot (verifier 5.7, 6.1). Reading finalized L1
// blocks is the verifier's (P1-19); the check here takes them as input.

import { BN254_R, encode, u64, u8 } from "./codec.ts";
import { ds } from "./domain-separation.ts";
import { H } from "./group.ts";
import { semaphoreField } from "./membership.ts";
import { rootStepWindow } from "./rolling-tier-tree.ts";

const U64_MAX = (1n << 64n) - 1n;

// Copies before checking the length: a Uint8Array subclass could report a
// false `length` while holding another number of bytes (codec.ts, copyBytes).
function bytes32(x: unknown, what: string): Uint8Array {
  if (!(x instanceof Uint8Array) || !ArrayBuffer.isView(x))
    throw new TypeError(`${what}: expected 32 bytes`);
  const copy = new Uint8Array(x);
  if (copy.length !== 32) throw new TypeError(`${what}: expected 32 bytes`);
  return copy;
}

function checkTier(tier: unknown, what: string): asserts tier is 0 | 1 | 2 {
  if (tier !== 0 && tier !== 1 && tier !== 2)
    throw new RangeError(`${what}: tier must be 0, 1 or 2`);
}

function checkU64(x: unknown, what: string): asserts x is bigint {
  if (typeof x !== "bigint" || x < 0n || x > U64_MAX) throw new RangeError(`${what}: not a u64`);
}

export interface MembershipMessageInput {
  readonly definitionHash: Uint8Array;
  readonly tier: number;
  /** The ballot's hash under `abolish/v1/ballot` (P1-12), without its membership proof. */
  readonly ballotHash: Uint8Array;
  readonly l1RefNumber: bigint;
  readonly l1RefHash: Uint8Array;
}

/**
 * `M = H(DS("abolish/v1/membership-message", definition_hash ‖ u8(tier) ‖
 * ballot_hash ‖ u64(l1_ref_number) ‖ l1_ref_hash))`. The block hash is what
 * makes a ballot no older than the block it names: a number alone could be
 * chosen ahead, letting a coercer have ballots made for future blocks (T-45).
 */
export function membershipMessage(input: MembershipMessageInput): Uint8Array {
  checkTier(input.tier, "membershipMessage");
  checkU64(input.l1RefNumber, "membershipMessage: l1RefNumber");
  const m = new Uint8Array(105);
  m.set(bytes32(input.definitionHash, "membershipMessage: definitionHash"));
  m.set(encode(u8, input.tier), 32);
  m.set(bytes32(input.ballotHash, "membershipMessage: ballotHash"), 33);
  m.set(encode(u64, input.l1RefNumber), 65);
  m.set(bytes32(input.l1RefHash, "membershipMessage: l1RefHash"), 73);
  return H(ds("abolish/v1/membership-message", m));
}

/** `m̂ = F(M)`: the message as the circuit's public input. */
export function membershipMessageField(input: MembershipMessageInput): bigint {
  return semaphoreField(membershipMessage(input));
}

/** A finalized L1 block, as the verifier read it from the definition's `l1_chain_id`. */
export interface FinalizedL1Block {
  readonly hash: Uint8Array;
  /** Unix seconds; strictly increasing with the block number on Ethereum. */
  readonly timestamp: bigint;
}

/** The finalized L1 chain up to `head`; `block(n)` is only asked for `n ≤ head`. */
export interface FinalizedL1 {
  readonly head: bigint;
  block(n: bigint): FinalizedL1Block;
}

export type L1ReferenceVerdict =
  | "admitted"
  | "pending"
  | "l1-ref-before-open"
  | "l1-ref-after-close"
  | "l1-ref-unknown";

/**
 * Seconds before `opens_at` from which a ballot may name a block: `l1_ref_min`
 * is the first finalized L1 block whose timestamp is at or after
 * `opens_at − L1_REF_MARGIN`. The caller finds it in the L1 range it reads for
 * anchors (docs/spec/revoting.md, Admission).
 */
export const L1_REF_MARGIN = 3600n;

/**
 * `l1_ref_min`: the first finalized block whose timestamp is at or after
 * `opensAt − L1_REF_MARGIN` (0 if that is negative), searched between `low` and
 * `l1.head`. `low` is any finalized block the caller knows is earlier (the
 * anchoring epoch's, say); it must be block 0 or have an earlier timestamp,
 * or the answer could lie below it. Returns `undefined` while the head hasn't
 * reached the window. Binary search relies on Ethereum's timestamps strictly
 * increasing with the block number.
 */
export function l1RefMin(l1: FinalizedL1, low: bigint, opensAt: bigint): bigint | undefined {
  checkU64(l1.head, "l1RefMin: head");
  checkU64(low, "l1RefMin: low");
  checkU64(opensAt, "l1RefMin: opensAt");
  if (low > l1.head) throw new RangeError("l1RefMin: low is above the finalized head");
  const threshold = opensAt > L1_REF_MARGIN ? opensAt - L1_REF_MARGIN : 0n;
  const at = (n: bigint) => {
    const t = l1.block(n).timestamp;
    checkU64(t, "l1RefMin: block timestamp");
    return t;
  };
  if (at(low) >= threshold) {
    if (low === 0n) return 0n;
    throw new RangeError("l1RefMin: low isn't before the window");
  }
  if (at(l1.head) < threshold) return undefined;
  // Invariant: at(lo) < threshold ≤ at(hi).
  let lo = low;
  let hi = l1.head;
  while (hi - lo > 1n) {
    const mid = lo + (hi - lo) / 2n;
    if (at(mid) < threshold) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * Verifier 5.8 (docs/spec/revoting.md, Admission), steps in the spec's order.
 * The lower bound keeps every lookup inside the L1 range around the poll, so
 * a ballot naming an ancient block can't demand evidence nobody archives
 * (T-53, T-36). A reference beyond `head` is pending only while `head` is at
 * or before `closesAt`: once L1 has finalized a block after close, every later
 * number is after close too, so a block that never comes (2^64 − 1, say) can't
 * keep the election unverifiable. Checking the time before the hash makes the
 * verdict the same for every head past close, so a verifier may pass the
 * first block after close as `head` and read no further L1.
 */
export function checkL1Reference(
  ref: { readonly l1RefNumber: bigint; readonly l1RefHash: Uint8Array },
  l1: FinalizedL1,
  window: { readonly l1RefMin: bigint; readonly closesAt: bigint },
): L1ReferenceVerdict {
  return referenceOf(ref, l1, window).verdict;
}

/** 5.8's verdict under ballot version 5: version 1's, then the step's window (step 5). */
export type L1ReferenceVerdictV5 = L1ReferenceVerdict | "root-step-stale" | "root-step-future";

/**
 * Verifier 5.8 under ballot version 5 (docs/spec/revoting.md, Admission,
 * step 5): `checkL1Reference`'s steps, then, for a reference it admits, the
 * window `t − ROOT_WINDOW < τ_n ≤ t` between the ballot's step `n` and `t`,
 * the timestamp of the block step 4 found (`root-step-stale`,
 * `root-step-future`). It reads no other block, so the verdict stays the same
 * for every head past close (T-36), and a ballot's step says at most when,
 * within the window, its proof's tree was taken (T-13).
 */
export function checkL1ReferenceV5(
  ref: { readonly l1RefNumber: bigint; readonly l1RefHash: Uint8Array; readonly step: number },
  l1: FinalizedL1,
  window: { readonly l1RefMin: bigint; readonly closesAt: bigint },
): L1ReferenceVerdictV5 {
  const { step } = ref;
  if (!Number.isSafeInteger(step) || step < 0 || step > 0xffff_ffff)
    throw new RangeError("checkL1ReferenceV5: step must be a u32");
  const { verdict, timestamp } = referenceOf(ref, l1, window);
  if (verdict !== "admitted") return verdict;
  const at = rootStepWindow(BigInt(step), timestamp);
  return at === "in" ? "admitted" : at === "stale" ? "root-step-stale" : "root-step-future";
}

// Steps 1 to 4, with the timestamp of the block step 2 read.
function referenceOf(
  ref: { readonly l1RefNumber: bigint; readonly l1RefHash: Uint8Array },
  l1: FinalizedL1,
  window: { readonly l1RefMin: bigint; readonly closesAt: bigint },
): { readonly verdict: L1ReferenceVerdict; readonly timestamp: bigint } {
  checkU64(ref.l1RefNumber, "checkL1Reference: l1RefNumber");
  const refHash = bytes32(ref.l1RefHash, "checkL1Reference: l1RefHash");
  checkU64(l1.head, "checkL1Reference: head");
  checkU64(window.l1RefMin, "checkL1Reference: l1RefMin");
  checkU64(window.closesAt, "checkL1Reference: closesAt");
  if (ref.l1RefNumber < window.l1RefMin) return { verdict: "l1-ref-before-open", timestamp: 0n };
  const atOrBelowHead = ref.l1RefNumber <= l1.head;
  const block = l1.block(atOrBelowHead ? ref.l1RefNumber : l1.head);
  const hash = bytes32(block.hash, "checkL1Reference: block hash");
  const { timestamp } = block;
  checkU64(timestamp, "checkL1Reference: block timestamp");
  const decide = (verdict: L1ReferenceVerdict) => ({ verdict, timestamp });
  if (timestamp > window.closesAt) return decide("l1-ref-after-close");
  if (!atOrBelowHead) return decide("pending");
  return decide(equalBytes(hash, refHash) ? "admitted" : "l1-ref-unknown");
}

// Public data, so a constant-time comparison isn't needed.
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** One ballot that passed every admission check except 5.7 (docs/spec/revoting.md, Selection). */
export interface AdmittedBallot {
  readonly tier: number;
  /** The nullifier `ν`, a canonical `field<bn254>` value. */
  readonly nullifier: bigint;
  /**
   * `M` as the verifier recomputed it from the ballot record and the
   * definition (never a decoded field), which the membership proof verified
   * against. Then equal messages always name the same block, and the
   * inconsistency `selectBallots` throws on is unreachable from board data.
   */
  readonly message: Uint8Array;
  readonly l1RefNumber: bigint;
  /** The ballot's board position; unique among the input. */
  readonly index: bigint;
}

export interface BallotSelection {
  /** At most one per (tier, nullifier): the input to the tally. */
  readonly selected: readonly AdmittedBallot[];
  /** Rejected with `repeat` (verifier 5.7): same tier, nullifier and message as a ballot at a smaller index. */
  readonly repeats: readonly AdmittedBallot[];
  /** Listed with `revote-tie`: distinct ballots sharing their group's highest block, so the group counts nothing. */
  readonly ties: readonly AdmittedBallot[];
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const byIndex = (a: AdmittedBallot, b: AdmittedBallot) =>
  a.index < b.index ? -1 : a.index > b.index ? 1 : 0;

/**
 * Selects each tier and nullifier's counted ballot (docs/spec/revoting.md,
 * Selection). The result depends on the set of ballots alone, never on their
 * order or board positions (R3): positions only decide which copy of a
 * repeat is listed as the one that stands, and copies share their message, so
 * what is counted is the same. Outputs are sorted by index.
 */
export function selectBallots(ballots: Iterable<AdmittedBallot>): BallotSelection {
  const indices = new Set<bigint>();
  // Copies each ballot, so a caller mutating its input afterwards can't change
  // what was checked.
  const input: AdmittedBallot[] = [];
  for (const b of ballots) {
    checkTier(b.tier, "selectBallots");
    if (typeof b.nullifier !== "bigint" || b.nullifier < 0n || b.nullifier >= BN254_R)
      throw new RangeError("selectBallots: nullifier is not a canonical field<bn254> value");
    checkU64(b.l1RefNumber, "selectBallots: l1RefNumber");
    checkU64(b.index, "selectBallots: index");
    if (indices.has(b.index)) throw new RangeError("selectBallots: duplicate index");
    indices.add(b.index);
    input.push({
      tier: b.tier,
      nullifier: b.nullifier,
      message: bytes32(b.message, "selectBallots: message"),
      l1RefNumber: b.l1RefNumber,
      index: b.index,
    });
  }
  input.sort(byIndex);

  // Step 1: repeats. In index order, the first of equal (tier, ν, M) stands.
  const standing = new Map<string, AdmittedBallot>();
  const repeats: AdmittedBallot[] = [];
  for (const b of input) {
    const key = `${b.tier}:${b.nullifier}:${toHex(b.message)}`;
    const first = standing.get(key);
    if (first === undefined) standing.set(key, b);
    else {
      // M binds the block number, so equal messages with different numbers
      // can't both have passed the membership check: the caller decoded or
      // recomputed one of them wrongly.
      if (first.l1RefNumber !== b.l1RefNumber)
        throw new RangeError("selectBallots: equal messages name different L1 blocks");
      repeats.push(b);
    }
  }

  // Steps 2 and 3: group by (tier, ν); the single highest block counts, and a
  // shared highest block is a tie.
  const groups = new Map<string, AdmittedBallot[]>();
  for (const b of standing.values()) {
    const key = `${b.tier}:${b.nullifier}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [b]);
    else group.push(b);
  }
  const selected: AdmittedBallot[] = [];
  const ties: AdmittedBallot[] = [];
  for (const group of groups.values()) {
    let top = -1n;
    for (const b of group) if (b.l1RefNumber > top) top = b.l1RefNumber;
    const best = group.filter((b) => b.l1RefNumber === top);
    (best.length === 1 ? selected : ties).push(...best);
  }
  return { selected: selected.sort(byIndex), repeats, ties: ties.sort(byIndex) };
}
