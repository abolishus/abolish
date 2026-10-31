// The ballot client's side of a membership proof (docs/spec/membership.md,
// Statement, Tier tree and Security notes; ADR 0009, Amendment of
// 2026-10-17): everything around the Groth16 prover except the prover itself.
// The client builds the circuit's inputs here from its own secret, the tier's
// leaves and a definition it verified; hands them to snarkjs in a realm of its
// own (packages/membership-prover, P2-21 part 4); and finishes the returned
// proof here: verified under the pinned key against the public inputs computed
// here, never the prover's, then re-randomised with this realm's CSPRNG and
// verified again. Zero knowledge then rests on @noble/* and the platform
// CSPRNG, whatever randomness or code made the prover's proof (T-05, T-07,
// T-12, T-55).

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { BN254_R, EncodeError } from "./codec.ts";
import { isIdentitySecret } from "./identity-backup.ts";
import { isForbiddenCommitment } from "./group-registry.ts";
import { BJJ_G } from "./keyed-nullifier.ts";
import {
  MEMBERSHIP_DEPTH,
  membershipScope,
  rollingMembershipScope,
  semaphoreField,
} from "./membership.ts";
import {
  MEMBERSHIP_PROOF_LENGTH,
  MEMBERSHIP_WASM_SHA256,
  MEMBERSHIP_ZKEY_SHA256,
  type MembershipSignals,
  rerandomiseMembershipProof,
  verifyMembershipProof,
} from "./membership-proof.ts";
import { poseidon2 } from "./poseidon.ts";
import { tierTreeMemberPath } from "./tier-tree.ts";

/** Which check refused: each is a reason the client shows, never a retry. */
export type MembershipProverErrorCode =
  /** Not an identity secret's encoding: 32 bytes, `1 ≤ s < l`. */
  | "secret"
  /** The leaves don't climb to the definition's root for this tier. */
  | "root"
  /**
   * The secret's commitment isn't a leaf of the tier. A forbidden commitment
   * (docs/spec/membership.md, Commitments and removals) never is: the tier
   * tree refuses one as a leaf, so it is refused here too.
   */
  | "not-a-member"
  /** The proving key isn't `semaphore-32.zkey` by its sha256. */
  | "zkey"
  /** The witness calculator isn't `semaphore-32.wasm` by its sha256. */
  | "wasm"
  /** The prover's proof doesn't verify under the pinned key for the inputs computed here. */
  | "proof"
  /** The re-randomised proof doesn't verify: a fault here, never sent. */
  | "rerandomised";

export class MembershipProverError extends Error {
  override readonly name = "MembershipProverError";
  constructor(readonly code: MembershipProverErrorCode) {
    super(code);
  }
}

/** What the proof is for, each value from a definition and ballot the client verified. */
export interface MembershipStatement {
  /** The election definition's hash. */
  readonly definitionHash: Uint8Array;
  /** The tier (0, 1 or 2) of the tier group, or of the cell, the voter proves membership of. */
  readonly tier: number;
  /** That tier's root (or cell-tree root) as the definition gives it. */
  readonly root: bigint;
  /** `M`, the 32-byte membership message of docs/spec/revoting.md. */
  readonly message: Uint8Array;
}

/**
 * Semaphore's circuit inputs, as snarkjs's `groth16.fullProve` takes them,
 * every value a decimal string: the secret, a path of exactly 32 siblings
 * (`merkleProofLength` is always 32, never a depth computed or supplied;
 * docs/spec/membership.md, Tree depth) and the mapped scope and message.
 */
export interface MembershipWitness {
  readonly secret: string;
  readonly merkleProofLength: string;
  readonly merkleProofIndex: string;
  readonly merkleProofSiblings: readonly string[];
  readonly scope: string;
  readonly message: string;
}

/** A prover request: the witness for the prover's realm and the signals that stay here. */
export interface MembershipProverInput {
  readonly witness: MembershipWitness;
  readonly signals: MembershipSignals;
}

// Inputs `membershipProverInput` built: only their signals finish a proof, so
// no caller can check a proof against signals the prover returned.
const BUILT = new WeakSet<MembershipProverInput>();

/**
 * Internal: the scalar `s` of an identity secret's encoding, or
 * `MembershipProverError` with `secret`. The package entry point doesn't
 * export it; `castSealV3` derives the nullifier with it.
 */
export function secretScalar(secret: Uint8Array): bigint {
  // Copied first, so the bytes checked are the bytes read.
  const copy =
    secret instanceof Uint8Array && ArrayBuffer.isView(secret) ? new Uint8Array(secret) : null;
  if (copy === null || !isIdentitySecret(copy)) throw new MembershipProverError("secret");
  let s = 0n;
  for (const b of copy) s = (s << 8n) | BigInt(b);
  copy.fill(0);
  return s;
}

/**
 * Internal: `Poseidon2(Ax, Ay)` for `(Ax, Ay) = s · B8`, the identity
 * commitment of secret scalar `s`.
 */
export function commitmentOf(s: bigint): bigint {
  const { x, y } = BJJ_G.multiply(s).toAffine();
  return poseidon2(x, y);
}

/**
 * The identity commitment of `secret` (32 bytes, big-endian,
 * docs/spec/identity-backup.md): the leaf the client looks for in its tier
 * (`tierMembership`). Throws `MembershipProverError` with `secret`.
 */
export function identityCommitment(secret: Uint8Array): bigint {
  return commitmentOf(secretScalar(secret));
}

/**
 * The nullifier `ν = Poseidon2(ŝ, s)` (docs/spec/membership.md, Statement)
 * of the voter whose identity secret is `secret`, under the scope of
 * `statement`'s definition hash, tier and root: what the validity proofs
 * bind (docs/spec/ballot-validity.md, Casting step 2) before `M`, and so the
 * prover's input, can exist. It is the `nullifier` signal
 * `membershipProverInput` gives for the same secret, definition, tier and
 * root under any message. It reads no leaves, so it says nothing of
 * membership: only a member's proof can carry it (T-07). Throws
 * `MembershipProverError` with `secret`, and as `membershipScope` does.
 */
export function membershipNullifier(
  secret: Uint8Array,
  statement: Omit<MembershipStatement, "message">,
): bigint {
  if (statement === null || typeof statement !== "object")
    throw new TypeError("statement: expected an object");
  // Read once, as membershipProverInput reads its statement.
  const { definitionHash, tier, root } = statement;
  return poseidon2(membershipScope(definitionHash, tier, root), secretScalar(secret));
}

/** The root a path of 32 siblings climbs to from `leaf` at `index`, as the circuit computes it. */
function climb(leaf: bigint, index: number, siblings: readonly bigint[]): bigint {
  let node = leaf;
  for (const [h, sibling] of siblings.entries())
    // Arithmetic, not `>>`: bitwise operators wrap above 2^31.
    node =
      Math.floor(index / 2 ** h) % 2 === 0 ? poseidon2(node, sibling) : poseidon2(sibling, node);
  return node;
}

/**
 * The prover's request for a voter with identity secret `secret` (32 bytes,
 * big-endian, docs/spec/identity-backup.md) in the tier whose leaves are
 * `leaves`, in tier-tree order (a cell's: its cell tree's, as
 * `tierMembership` gives them), for `statement`. The path is built here from
 * every leaf, never fetched (T-10, T-13), at the first leaf holding the
 * voter's commitment, in one pass that holds no copy of the leaves; it must climb to the
 * definition's root, so leaves that aren't the tier's are refused before any
 * proving. The scope is derived from the definition hash, the tier and the
 * root (`membershipScope`), the message mapped by `F`, and the nullifier
 * computed as `Poseidon2(ŝ, s)`: none is taken from a server or the prover.
 * The secret is for Abolish proofs only (Security notes, Chosen-scope
 * linkage). Throws `MembershipProverError`; a definition value out of range
 * throws as `membershipScope` does.
 */
export function membershipProverInput(
  secret: Uint8Array,
  leaves: Iterable<bigint>,
  statement: MembershipStatement,
): MembershipProverInput {
  if (statement === null || typeof statement !== "object")
    throw new TypeError("statement: expected an object");
  // Read once, so a getter can't show the checks one value and the inputs another.
  const { definitionHash, tier, root, message } = statement;
  const scope = membershipScope(definitionHash, tier, root);
  const messageField = semaphoreField(message);
  const s = secretScalar(secret);
  return proverInputAt(s, memberPath(commitmentOf(s), leaves, root), scope, messageField);
}

/**
 * What a rolling ballot's proof is for (docs/spec/membership.md, Rolling
 * scope and Checks for rolling ballots): `MembershipStatement`, with `root`
 * the root of the step the ballot names, which the client computed itself
 * from the listed groups' events (`rollingTierSteps`), never one a server,
 * relay or submitter gave it.
 */
export type RollingMembershipStatement = MembershipStatement;

/**
 * `membershipNullifier` under a rolling electorate: `ν = Poseidon2(ŝ_t, s)`
 * with the rolling scope of `statement`'s definition hash and tier, which
 * has no root in it, so the voter's nullifier is the same at every step, in
 * every listed group and after a removal and re-addition (T-01, T-02,
 * T-03). It is the `nullifier` signal `rollingMembershipProverInput` gives
 * for the same secret, definition and tier under any root and message.
 * Throws `MembershipProverError` with `secret`, and as
 * `rollingMembershipScope` does.
 */
export function rollingMembershipNullifier(
  secret: Uint8Array,
  statement: Pick<RollingMembershipStatement, "definitionHash" | "tier">,
): bigint {
  if (statement === null || typeof statement !== "object")
    throw new TypeError("statement: expected an object");
  const { definitionHash, tier } = statement;
  return poseidon2(rollingMembershipScope(definitionHash, tier), secretScalar(secret));
}

/**
 * `membershipProverInput` for a ballot of a rolling tier (ballot version 5):
 * the path built here from `leaves`, the step tree's leaves in chain order
 * with `0n` where a member was removed (`RollingStep`'s tree), at the first
 * leaf holding the voter's commitment, which after a removal and
 * re-addition is the live one, and checked to climb to `statement.root`, the
 * step's root; the scope is the tier's rolling scope `ŝ_t`
 * (`rollingMembershipScope`), never a fixed one, so the proof verifies only
 * as a rolling ballot of this definition and tier (T-08, T-13, T-31). The
 * client still proves only under a definition it verified, with the tier and
 * root computed from it and the chain (Security notes, Chosen-scope linkage;
 * T-12). Finish it with `finishMembershipProof`. Throws
 * `MembershipProverError`; a definition value out of range throws as
 * `rollingMembershipScope` does.
 */
export function rollingMembershipProverInput(
  secret: Uint8Array,
  leaves: Iterable<bigint>,
  statement: RollingMembershipStatement,
): MembershipProverInput {
  if (statement === null || typeof statement !== "object")
    throw new TypeError("statement: expected an object");
  // Read once, so a getter can't show the checks one value and the inputs another.
  const { definitionHash, tier, root, message } = statement;
  const scope = rollingMembershipScope(definitionHash, tier);
  const messageField = semaphoreField(message);
  const s = secretScalar(secret);
  return proverInputAt(s, memberPath(commitmentOf(s), leaves, root), scope, messageField);
}

/** A member's leaf index and its 32 siblings, climbing to the tier's root. */
export interface MemberPath {
  readonly root: bigint;
  readonly index: number;
  readonly siblings: readonly bigint[];
}

/**
 * Internal: the path of `commitment` at its first leaf of `leaves`, in one
 * pass that holds no copy of the leaves, which must climb to `root`; or
 * `MembershipProverError` with `not-a-member` or `root`. The package entry
 * point doesn't export it; the vouch prover builds both of a vouch's proofs
 * on one path.
 */
export function memberPath(commitment: bigint, leaves: Iterable<bigint>, root: bigint): MemberPath {
  // A forbidden commitment is never a leaf (part 2's contract), and the path
  // builder refuses to look for one.
  if (isForbiddenCommitment(commitment)) throw new MembershipProverError("not-a-member");
  const found = tierTreeMemberPath(leaves, commitment);
  if (found === undefined) throw new MembershipProverError("not-a-member");
  const { index, siblings } = found;
  // The circuit's own climb as well as the tree's root: a fault in either
  // refuses here rather than in a proof that fails verification later.
  if (found.root !== root || climb(commitment, index, siblings) !== root)
    throw new MembershipProverError("root");
  return { root, index, siblings };
}

/**
 * Internal: the prover's request for secret scalar `s` on `path`, under the
 * mapped `scope` and `messageField`, with the nullifier computed here. The
 * package entry point doesn't export it.
 */
export function proverInputAt(
  s: bigint,
  path: MemberPath,
  scope: bigint,
  messageField: bigint,
): MembershipProverInput {
  const { root, index, siblings } = path;
  const input: MembershipProverInput = Object.freeze({
    witness: Object.freeze({
      secret: s.toString(),
      merkleProofLength: String(MEMBERSHIP_DEPTH),
      merkleProofIndex: String(index),
      merkleProofSiblings: Object.freeze(siblings.map(String)),
      scope: scope.toString(),
      message: messageField.toString(),
    }),
    signals: Object.freeze({
      root,
      nullifier: poseidon2(scope, s),
      message: messageField,
      scope,
    }),
  });
  BUILT.add(input);
  return input;
}

/**
 * Refuses a proving key that isn't Semaphore's `semaphore-32.zkey` by its
 * sha256 (`MEMBERSHIP_ZKEY_SHA256`), the key whose reference string was
 * checked and which `membership_vk_hash` binds, whatever its source; checked
 * on every use, before the key reaches the prover (T-07, T-12).
 */
export function checkMembershipZkey(zkey: Uint8Array): void {
  if (!(zkey instanceof Uint8Array) || !ArrayBuffer.isView(zkey))
    throw new TypeError("zkey: expected bytes");
  if (bytesToHex(sha256(new Uint8Array(zkey))) !== MEMBERSHIP_ZKEY_SHA256)
    throw new MembershipProverError("zkey");
}

/**
 * Refuses a witness calculator that isn't Semaphore's `semaphore-32.wasm` by
 * its sha256 (`MEMBERSHIP_WASM_SHA256`), whatever its source; checked on
 * every use, before the secret reaches it (T-12, T-55).
 */
export function checkMembershipWasm(wasm: Uint8Array): void {
  if (!(wasm instanceof Uint8Array) || !ArrayBuffer.isView(wasm))
    throw new TypeError("wasm: expected bytes");
  if (bytesToHex(sha256(new Uint8Array(wasm))) !== MEMBERSHIP_WASM_SHA256)
    throw new MembershipProverError("wasm");
}

/** A scalar uniform in `[min, r)`, by rejection over 254-bit draws (kept about 76% of the time). */
function scalar(draw: (n: number) => Uint8Array, min: bigint): bigint {
  for (;;) {
    const b = draw(32);
    if (!(b instanceof Uint8Array) || b.length !== 32)
      throw new TypeError("draw: expected 32 bytes");
    let v = BigInt(b[0] as number) & 0x3fn; // r < 2^254
    for (let i = 1; i < 32; i++) v = (v << 8n) | BigInt(b[i] as number);
    if (v >= min && v < BN254_R) return v;
  }
}

/**
 * The test seam of `finishMembershipProof`, with the randomness source
 * passed in. Not exported from the package: production code draws from the
 * CSPRNG only.
 */
export function finishMembershipProofWith(
  input: MembershipProverInput,
  proof: Uint8Array,
  draw: (n: number) => Uint8Array,
): Uint8Array {
  if (!BUILT.has(input)) throw new TypeError("input: expected a membershipProverInput result");
  if (!(proof instanceof Uint8Array) || !ArrayBuffer.isView(proof))
    throw new TypeError("proof: expected bytes");
  const bytes = new Uint8Array(proof);
  // Before any randomness is drawn: a proof that fails here never leaves.
  if (bytes.length !== MEMBERSHIP_PROOF_LENGTH || !verifyMembershipProof(bytes, input.signals))
    throw new MembershipProverError("proof");
  const t = scalar(draw, 1n);
  const u = scalar(draw, 0n);
  let out: Uint8Array;
  try {
    out = rerandomiseMembershipProof(bytes, t, u);
  } catch (e) {
    // B' or C' the identity, with probability about 2^-254.
    if (e instanceof EncodeError) throw new MembershipProverError("rerandomised");
    throw e;
  }
  if (!verifyMembershipProof(out, input.signals)) throw new MembershipProverError("rerandomised");
  return out;
}

/**
 * The 256-byte `membership_proof` a ballot carries, from the prover's
 * `proof` for `input`: decoded strictly and verified under the pinned key
 * against `input`'s signals (computed by `membershipProverInput`, never the
 * prover's `publicSignals`), re-randomised with `t` uniform in `[1, r)` and
 * `u` uniform in `[0, r)` from this realm's CSPRNG, and verified again. The
 * prover's bytes are discarded; only the result may leave the device. Run it
 * in a realm the prover's code can't reach (docs/spec/membership.md, Security
 * notes). Throws `MembershipProverError` with `proof` or `rerandomised`.
 */
export function finishMembershipProof(input: MembershipProverInput, proof: Uint8Array): Uint8Array {
  return finishMembershipProofWith(input, proof, randomBytes);
}
