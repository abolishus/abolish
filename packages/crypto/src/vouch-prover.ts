// The voucher's side of a Tier 1 vouch (docs/spec/vouching.md, Scopes,
// Messages, The vouch and Prover rules; ADR 0014): both proofs' prover inputs
// from the voucher's own secret and the Tier 2 leaves its client rebuilt, the
// slot it spends, and the finished vouch. Every scope, message and nullifier
// is computed here from the binding, the vouchee's commitment and the
// voucher's choices, never taken from the vouchee, a relay or a server
// (T-06, T-32), and each proof is finished as a ballot's is
// (membership-prover.ts): verified under the pinned key against those
// signals, re-randomised with this realm's CSPRNG and verified again, so the
// vouch is self-checked before it leaves the device (T-05, T-07, T-12).

import { randomBytes } from "@noble/hashes/utils.js";
import { isForbiddenCommitment } from "./group-registry.ts";
import { semaphoreField } from "./membership.ts";
import {
  commitmentOf,
  finishMembershipProofWith,
  memberPath,
  MembershipProverError,
  type MembershipProverInput,
  proverInputAt,
  secretScalar,
} from "./membership-prover.ts";
import { MEMBERSHIP_PROOF_LENGTH, verifyMembershipProof } from "./membership-proof.ts";
import { poseidon2 } from "./poseidon.ts";
import {
  type Vouch,
  type VouchContext,
  VOUCH_SLOTS,
  vouchMessage,
  vouchScope,
  vouchSlotScope,
} from "./vouch.ts";
import { VOUCH_ROOT_INTERVAL } from "./vouch-count.ts";

/** Which check refused: each is a reason the voucher's client shows, never a retry. */
export type VouchProverErrorCode =
  /** The vouchee's commitment is forbidden: a vouch for it counts for nothing. */
  | "forbidden-commitment"
  /** The vouchee's commitment is a leaf of the Tier 2 group: it isn't fresh (the voucher's own among them). */
  | "not-fresh"
  /** The slot isn't an integer in `[0, L)`. */
  | "slot"
  /** Every slot is spent or held. */
  | "no-slot"
  /** The root block isn't on the root grid (a multiple of `VOUCH_ROOT_INTERVAL`). */
  | "root-grid";

export class VouchProverError extends Error {
  override readonly name = "VouchProverError";
  constructor(readonly code: VouchProverErrorCode) {
    super(code);
  }
}

/** What a vouch is for: the vouchee's group and commitment, and the voucher's choices. */
export interface VouchStatement {
  /** Where the addition will be logged. */
  readonly context: VouchContext;
  /** The Tier 1 group, whose `GroupCreated` the client saw in finalized L2 history. */
  readonly groupId: bigint;
  /** `C_V`, the vouchee's commitment, as the vouchee's device showed it. */
  readonly commitment: bigint;
  /** The Tier 2 group the voucher proves membership of. */
  readonly tier2GroupId: bigint;
  /** The grid block whose root the client rebuilt, derived from L1 data. */
  readonly rootBlock: bigint;
  /** That root, as the client rebuilt it from the group's additions. */
  readonly root: bigint;
  /** `j`, an unspent slot (`pickVouchSlot`). */
  readonly slot: number;
}

/** Both prover requests of one vouch: the vouchee proof's and the slot proof's. */
export interface VouchProverInput {
  readonly vouchee: MembershipProverInput;
  readonly slot: MembershipProverInput;
}

interface Built {
  readonly tier2GroupId: bigint;
  readonly rootBlock: bigint;
  readonly root: bigint;
  readonly slot: number;
}

// Inputs `vouchProverInput` built, with the fields their vouch carries: only
// these finish a vouch, so no caller pairs proofs with fields of its own.
const BUILT = new WeakMap<VouchProverInput, Built>();

// The leaves as given, refusing the vouchee's commitment among them in the
// same pass that builds the voucher's path.
function* fresh(leaves: Iterable<bigint>, commitment: bigint): Generator<bigint> {
  if (leaves === null || typeof leaves !== "object" || !(Symbol.iterator in leaves))
    throw new TypeError("leaves: expected an iterable");
  for (const leaf of leaves) {
    if (leaf === commitment) throw new VouchProverError("not-fresh");
    yield leaf;
  }
}

/**
 * Both prover requests of a vouch by the Tier 2 member whose identity secret
 * is `secret` (32 bytes, big-endian, docs/spec/identity-backup.md), in the
 * Tier 2 group whose leaves at `statement.rootBlock` are `leaves`, in
 * tier-tree order. One path, built here from every leaf in one pass, serves
 * both proofs; it must climb to `statement.root`. The scopes `S_V` and `S_j`,
 * both nullifiers and the cross-bound messages `M_V` (naming `ν_S`) and
 * `M_S` (naming `ν_V`) are computed here (docs/spec/vouching.md, Scopes and
 * Messages). Refuses a forbidden vouchee commitment, one among the Tier 2
 * leaves (the voucher's own included; Prover rules, The vouchee), a slot
 * outside `[0, L)` and a root block off the grid. Whether the root block is
 * the newest derived from L1 data and still inside the window, whether the
 * Tier 1 group is final and whether the vouchee is in any other group are
 * the caller's (Prover rules). Throws `VouchProverError`, and
 * `MembershipProverError` with `secret`, `not-a-member` or `root`.
 */
export function vouchProverInput(
  secret: Uint8Array,
  leaves: Iterable<bigint>,
  statement: VouchStatement,
): VouchProverInput {
  if (statement === null || typeof statement !== "object")
    throw new TypeError("statement: expected an object");
  // Read once, so a getter can't show the checks one value and the inputs another.
  const { context, groupId, commitment, tier2GroupId, rootBlock, root, slot } = statement;
  if (typeof commitment !== "bigint" || isForbiddenCommitment(commitment))
    throw new VouchProverError("forbidden-commitment");
  if (!Number.isInteger(slot) || slot < 0 || slot >= VOUCH_SLOTS)
    throw new VouchProverError("slot");
  for (const v of [tier2GroupId, rootBlock])
    if (typeof v !== "bigint" || v < 0n || v >= 2n ** 64n)
      throw new RangeError("statement: tier2GroupId and rootBlock must be u64s");
  if (rootBlock % VOUCH_ROOT_INTERVAL !== 0n) throw new VouchProverError("root-grid");
  if (context === null || typeof context !== "object")
    throw new TypeError("vouch context: expected an object");
  // The context too, so every scope and message binds one chain and registry.
  const ctx: VouchContext = {
    chainId: context.chainId,
    registry:
      context.registry instanceof Uint8Array ? new Uint8Array(context.registry) : context.registry,
  };
  const voucheeScope = semaphoreField(vouchScope(ctx, groupId, commitment));
  const slotScope = semaphoreField(vouchSlotScope(ctx, slot));
  const message = (role: 0 | 1, other: bigint) =>
    semaphoreField(vouchMessage(ctx, role, groupId, commitment, tier2GroupId, rootBlock, other));
  const s = secretScalar(secret);
  const path = memberPath(commitmentOf(s), fresh(leaves, commitment), root);
  // Each nullifier needs only the secret and its scope, so both exist before
  // either message (Messages, Cross-binding).
  const voucheeNullifier = poseidon2(voucheeScope, s);
  const slotNullifier = poseidon2(slotScope, s);
  const input: VouchProverInput = Object.freeze({
    vouchee: proverInputAt(s, path, voucheeScope, message(0, slotNullifier)),
    slot: proverInputAt(s, path, slotScope, message(1, voucheeNullifier)),
  });
  BUILT.set(input, { tier2GroupId, rootBlock, root, slot });
  return input;
}

/**
 * The test seam of `finishVouch`, with the randomness source passed in. Not
 * exported from the package: production code draws from the CSPRNG only.
 */
export function finishVouchWith(
  input: VouchProverInput,
  voucheeProof: Uint8Array,
  slotProof: Uint8Array,
  draw: (n: number) => Uint8Array,
): Vouch {
  const built = BUILT.get(input);
  if (built === undefined) throw new TypeError("input: expected a vouchProverInput result");
  // The slot proof is verified before the vouchee proof is re-randomised, so
  // a bad pair draws nothing; finishing verifies it again, one pairing check
  // more per vouch.
  if (!(slotProof instanceof Uint8Array) || !ArrayBuffer.isView(slotProof))
    throw new TypeError("proof: expected bytes");
  const slotCopy = new Uint8Array(slotProof);
  if (
    slotCopy.length !== MEMBERSHIP_PROOF_LENGTH ||
    !verifyMembershipProof(slotCopy, input.slot.signals)
  )
    throw new MembershipProverError("proof");
  const vouchee = finishMembershipProofWith(input.vouchee, voucheeProof, draw);
  const slot = finishMembershipProofWith(input.slot, slotCopy, draw);
  return Object.freeze({
    ...built,
    voucheeNullifier: input.vouchee.signals.nullifier,
    slotNullifier: input.slot.signals.nullifier,
    voucheeProof: vouchee,
    slotProof: slot,
  });
}

/**
 * The vouch (docs/spec/vouching.md, The vouch) from the prover's two proofs
 * for `input`: each decoded strictly and verified under the pinned key
 * against the signals `vouchProverInput` computed, never the prover's,
 * re-randomised with this realm's CSPRNG and verified again (Prover rules,
 * Self-check). Only the result may leave the device, handed to the vouchee in
 * person, never through us (T-10, T-22). Throws `MembershipProverError` with
 * `proof` or `rerandomised`.
 */
export function finishVouch(
  input: VouchProverInput,
  voucheeProof: Uint8Array,
  slotProof: Uint8Array,
): Vouch {
  return finishVouchWith(input, voucheeProof, slotProof, randomBytes);
}

/**
 * The test seam of `pickVouchSlot`, with the randomness source passed in.
 * Not exported from the package.
 */
export function pickVouchSlotWith(
  unavailable: Iterable<number>,
  draw: (n: number) => Uint8Array,
): number {
  if (unavailable === null || typeof unavailable !== "object" || !(Symbol.iterator in unavailable))
    throw new TypeError("unavailable: expected an iterable");
  const taken = new Set<number>();
  for (const j of unavailable) {
    if (!Number.isInteger(j) || j < 0 || j >= VOUCH_SLOTS)
      throw new RangeError("unavailable: expected slots in [0, L)");
    taken.add(j);
  }
  const free = Array.from({ length: VOUCH_SLOTS }, (_, j) => j).filter((j) => !taken.has(j));
  if (free.length === 0) throw new VouchProverError("no-slot");
  // Rejection over one byte, so every free slot is equally likely.
  const bound = 256 - (256 % free.length);
  for (;;) {
    const b = draw(1);
    if (!(b instanceof Uint8Array) || b.length !== 1) throw new TypeError("draw: expected 1 byte");
    const v = b[0] as number;
    if (v < bound) return free[v % free.length] as number;
  }
}

/**
 * A slot `j` drawn uniformly from `[0, L)` less `unavailable`, so `j` doesn't
 * reveal how many vouches the voucher has made (docs/spec/vouching.md, Prover
 * rules, The slot). `unavailable` is every slot held by a vouch handed out
 * and not yet released, and every slot whose slot nullifier appears in any
 * logged addition, counted or not, which is never reused (T-22). Throws
 * `VouchProverError` with `no-slot` when none is left.
 */
export function pickVouchSlot(unavailable: Iterable<number>): number {
  return pickVouchSlotWith(unavailable, randomBytes);
}
