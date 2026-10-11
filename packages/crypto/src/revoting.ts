// The re-vote rule of docs/spec/revoting.md (ADR 0011): the membership
// proof's message, which binds the L1 block a ballot is ranked by, and the
// selection of each tier and nullifier's counted ballot (verifier 5.7, 6.1).
// The admission checks on the L1 block itself (verifier 5.8) need finalized
// L1 data, so they belong to the verifier (P1-19).

import { BN254_R, encode, u64, u8 } from "./codec.ts";
import { ds } from "./domain-separation.ts";
import { H } from "./group.ts";
import { semaphoreField } from "./membership.ts";

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

/** One ballot that passed every admission check except 5.7 (docs/spec/revoting.md, Selection). */
export interface AdmittedBallot {
  readonly tier: number;
  /** The nullifier `ν`, a canonical `field<bn254>` value. */
  readonly nullifier: bigint;
  /** `M`, which the membership proof verified against. */
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
