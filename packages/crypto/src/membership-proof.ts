// Semaphore v4's Groth16 membership proofs (docs/spec/membership.md,
// Verification key, Proof encoding and Verification; ADR 0009): the pinned
// depth-32 verification key and its hash, the strict proof codec, and
// Groth16's published verification equation (Groth, EUROCRYPT 2016) over
// @noble/curves' BN254 pairing. Composition of a published protocol: no
// curve, pairing or proof-system arithmetic is implemented here. Many proofs
// can be checked at once with the small-exponent batch test (Bellare, Garay
// and Rabin, EUROCRYPT 1998) as Zcash's `bellman` applies it to Groth16.

import { bn254 } from "@noble/curves/bn254.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { BN254_R, type Codec, DecodeError, decode, EncodeError, encode } from "./codec.ts";
import { ds } from "./domain-separation.ts";
import { H } from "./group.ts";
import { MEMBERSHIP_DEPTH } from "./membership.ts";

type G1 = InstanceType<typeof bn254.G1.Point>;
type G2 = InstanceType<typeof bn254.G2.Point>;
type Fp2 = { readonly c0: bigint; readonly c1: bigint };

const { Fp, Fp2, Fp12 } = bn254.fields;
/** The BN254 base field's order, `p`. */
const P = Fp.ORDER;

/**
 * Semaphore v4's depth-32 Groth16 verification key, from
 * `packages/proof/src/verification-keys.json` at v4.14.3 (index 31 of
 * `vk_delta_2` and `IC`; the other entries are shared by every depth). A test
 * checks it against the vendored file, and the vendored file's provenance is
 * re-fetched in CI (T-05, T-07).
 */
const VK = Object.freeze({
  alpha: [
    0x245229d9b076b3c0e8a4d70bde8c1cccffa08a9fae7557b165b3b0dbd653e2c7n,
    0x253ec85988dbb84e46e94b5efa3373b47a000b4ac6c86b2d4b798d274a182302n,
  ],
  beta: [
    [
      0x2424bcc1f60a5472685fd50705b2809626e170120acaf441e133a2bd5e61d244n,
      0x07090a82e8fabbd39299be24705b92cf208ee8b3487f6f2b39ff27978a29a1dbn,
    ],
    [
      0x2b86859fd3d55c9d150fb3f0aeba798826493dd73d357ab0f9fdaced9fc81829n,
      0x0ae1135cffdaf227c5dc266740607aa930bc3bd92ddc2b135086d9da2dfd3e2an,
    ],
  ],
  gamma: [
    [
      0x1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6edn,
      0x198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2n,
    ],
    [
      0x12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daan,
      0x090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975bn,
    ],
  ],
  delta: [
    [
      0x25ca08820ba2a38dcd2561640ae9935ef47b5da8a801641a7066f7dbc52ff365n,
      0x2aeea52c33986c164976c52dfb73b8524b9e12650cc2e6614eb1efd1d3134f58n,
    ],
    [
      0x16d389fa12477aa6c862499500c516228cd9ae7c652c3f61f641b6590b800671n,
      0x1d8489971cf0f77a525cae847acd5056502177b00ca5b72b3f0fb32e0bb85bb8n,
    ],
  ],
  ic: [
    [
      0x16569eaf77c8ec57e85b52ee30cd6212133a17ca3a4e87bcfd7507598616214dn,
      0x0e2b188f173ee86cce1a411c0d2ff80e1ead326474358dbf412f8e540c01aa91n,
    ],
    [
      0x173f752e069ecc268a7427e0935db3acd27fb7bc097e2b2c58d5a6acdd1fb4c1n,
      0x0ef703b9687c4c6f9deddc9c9d3ef5ba1d9a87529d0a7387bc569c6c642913c4n,
    ],
    [
      0x25fa7538cb83e2a689d5caeac55b325d3597547ef6c8dc122a2a6d000c344eecn,
      0x023e56786b482a73477d0fd36701f0eddd08298e43913144c3f7b879d0988761n,
    ],
    [
      0x2efec260abd0d45688e61558f0288cbddd8b5774e48466f164d5e522b5441314n,
      0x14d6f2fe1a75dc3f898674bca43b786b3eebb0e2ac53ea6336d2d0496f23399cn,
    ],
    [
      0x133eef87007a5128b3f86d3ff94bdd1a0143b28d4b72e7b02b2022147764b03an,
      0x20a11d5fb29aa2ab37f2917d0b42ef10170b5f8614bc6e4decda4186dfafba37n,
    ],
  ],
} as const);

/**
 * sha256 of Semaphore's depth-32 proving key, `semaphore-32.zkey` as
 * Semaphore 4.14.3's prover downloads it
 * (`https://snark-artifacts.pse.dev/semaphore/4.13.0/semaphore-32.zkey`).
 * Bound into the key hash so that a prover checks it holds exactly this
 * proving key, whose reference string P1-17b part 2 checks for
 * well-formedness (docs/spec/membership.md, Security notes; T-07, T-12).
 */
export const MEMBERSHIP_ZKEY_SHA256 =
  "2e5f7a9f880c337134ee4c7fc4e53573813b4c9c6ae46221c0b56e7992304650";

/** `membership_proof`: A ‖ B ‖ C, 256 bytes. */
export const MEMBERSHIP_PROOF_LENGTH = 256;

/** A decoded membership proof: three points, each checked in its group. */
export interface MembershipProof {
  readonly a: G1;
  readonly b: G2;
  readonly c: G1;
}

/** The public signals, in the circuit's order `[ρ, ν, m̂, ŝ]`. */
export interface MembershipSignals {
  readonly root: bigint;
  readonly nullifier: bigint;
  readonly message: bigint;
  readonly scope: bigint;
}

function word(v: bigint): Uint8Array {
  const b = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}

function readWord(bytes: Uint8Array, at: number): bigint {
  let v = 0n;
  for (let i = at; i < at + 32; i++) v = (v << 8n) | BigInt(bytes[i] as number);
  return v;
}

const g1Bytes = (x: bigint, y: bigint) => Uint8Array.from([...word(x), ...word(y)]);
// EIP-197's order, the imaginary part first, as Semaphore's Solidity verifier
// and its packed proofs have it.
const g2Bytes = (x: Fp2, y: Fp2) =>
  Uint8Array.from([...word(x.c1), ...word(x.c0), ...word(y.c1), ...word(y.c0)]);

/**
 * A G1 point from canonical coordinates, on the curve and not the identity
 * (BN254's G1 has cofactor 1). `null` if it isn't one.
 */
function g1Point(x: bigint, y: bigint): G1 | null {
  if (x >= P || y >= P || (x === 0n && y === 0n)) return null;
  try {
    const point = bn254.G1.Point.fromAffine({ x, y });
    point.assertValidity();
    return point;
  } catch {
    return null;
  }
}

/** A G2 point from canonical coordinates, on the twist, in the order-r subgroup, not the identity. */
function g2Point(x: Fp2, y: Fp2): G2 | null {
  if ([x.c0, x.c1, y.c0, y.c1].some((v) => v >= P)) return null;
  if (Fp2.is0(x) && Fp2.is0(y)) return null;
  try {
    const point = bn254.G2.Point.fromAffine({ x: Fp2.create(x), y: Fp2.create(y) });
    // On the twist and torsion-free: a point outside the subgroup would let
    // a forger move the pairing into a small subgroup (T-05).
    point.assertValidity();
    return point;
  } catch {
    return null;
  }
}

// Proofs `membershipProof` decoded: frozen, with every point checked in its
// group, so `verifyDecodedMembershipProof` can skip the decoder's checks.
const DECODED = new WeakSet<MembershipProof>();

/**
 * The `membership_proof` codec: A (G1), B (G2), C (G1), each coordinate a
 * 32-byte big-endian base-field element below `p`, G2 coordinates imaginary
 * part first. Every point must be canonical, on its curve, in the order-r
 * subgroup and not the identity, or decoding fails `non-canonical` at the
 * point's offset (T-05, T-31).
 */
export const membershipProof: Codec<MembershipProof> = {
  minLength: MEMBERSHIP_PROOF_LENGTH,
  write(w, value) {
    const { a, b, c } = value ?? ({} as Partial<MembershipProof>);
    if (
      !(a instanceof bn254.G1.Point) ||
      !(b instanceof bn254.G2.Point) ||
      !(c instanceof bn254.G1.Point)
    )
      throw new EncodeError("membership_proof: expected three points");
    for (const p of [a, b, c]) {
      try {
        p.assertValidity();
      } catch {
        throw new EncodeError("membership_proof: a point isn't in its group");
      }
      if (p.is0()) throw new EncodeError("membership_proof: a point is the identity");
    }
    const A = a.toAffine();
    const B = b.toAffine();
    const C = c.toAffine();
    w.bytes(g1Bytes(A.x, A.y));
    w.bytes(g2Bytes(B.x, B.y));
    w.bytes(g1Bytes(C.x, C.y));
  },
  read(r) {
    const at = r.offset;
    const bytes = r.take(MEMBERSHIP_PROOF_LENGTH);
    const a = g1Point(readWord(bytes, 0), readWord(bytes, 32));
    if (a === null) throw new DecodeError("non-canonical", at);
    const b = g2Point(
      { c1: readWord(bytes, 64), c0: readWord(bytes, 96) },
      { c1: readWord(bytes, 128), c0: readWord(bytes, 160) },
    );
    if (b === null) throw new DecodeError("non-canonical", at + 64);
    const c = g1Point(readWord(bytes, 192), readWord(bytes, 224));
    if (c === null) throw new DecodeError("non-canonical", at + 192);
    const proof = Object.freeze({ a, b, c });
    DECODED.add(proof);
    return proof;
  },
};

/** Decodes exactly one `membership_proof`; throws `DecodeError` otherwise. */
export function decodeMembershipProof(bytes: Uint8Array): MembershipProof {
  return decode(membershipProof, bytes);
}

/** Encodes a membership proof; every accepted encoding re-encodes to itself. */
export function encodeMembershipProof(proof: MembershipProof): Uint8Array {
  return encode(membershipProof, proof);
}

const pairs = (v: readonly (readonly [bigint, bigint])[]) => v;
const fp2 = ([c0, c1]: readonly [bigint, bigint]): Fp2 => ({ c0, c1 });

/**
 * The verification key's encoding, 768 bytes: `alpha` (G1), `beta`, `gamma`
 * and `delta` (G2), then `IC_0` to `IC_4` (G1), in the proof's point encoding.
 */
export function membershipVkEncoding(): Uint8Array {
  const out = new Uint8Array(768);
  let at = 0;
  const put = (b: Uint8Array) => {
    out.set(b, at);
    at += b.length;
  };
  put(g1Bytes(...VK.alpha));
  for (const [x, y] of [VK.beta, VK.gamma, VK.delta]) put(g2Bytes(fp2(x), fp2(y)));
  for (const [x, y] of pairs(VK.ic)) put(g1Bytes(x, y));
  return out;
}

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
}

/**
 * `membership_vk_hash = H(DS("abolish/v1/membership-vk", u8(32) ‖ vk ‖ zkey_sha256))`:
 * the depth, the verification key and the proving key's sha256. An election
 * definition carries it; a verifier compares it with this value and never
 * verifies under a key the definition names (docs/spec/verifier.md 1.3;
 * T-05, T-07).
 */
export function membershipVkHash(): Uint8Array {
  const input = new Uint8Array(1 + 768 + 32);
  input[0] = MEMBERSHIP_DEPTH;
  input.set(membershipVkEncoding(), 1);
  input.set(hexBytes(MEMBERSHIP_ZKEY_SHA256), 769);
  return H(ds("abolish/v1/membership-vk", input));
}

let key:
  | {
      readonly alpha: G1;
      readonly beta: G2;
      readonly gamma: G2;
      readonly delta: G2;
      readonly ic: readonly G1[];
    }
  | undefined;

function verificationKey(): NonNullable<typeof key> {
  if (key === undefined) {
    const g1 = ([x, y]: readonly [bigint, bigint]) => {
      const point = g1Point(x, y);
      if (point === null) throw new Error("membership verification key: bad G1 point");
      return point;
    };
    const g2 = ([x, y]: readonly (readonly [bigint, bigint])[]) => {
      const point = x !== undefined && y !== undefined ? g2Point(fp2(x), fp2(y)) : null;
      if (point === null) throw new Error("membership verification key: bad G2 point");
      return point;
    };
    key = {
      alpha: g1(VK.alpha),
      beta: g2(VK.beta),
      gamma: g2(VK.gamma),
      delta: g2(VK.delta),
      ic: pairs(VK.ic).map(g1),
    };
  }
  return key;
}

/**
 * Verifies a membership proof under the pinned depth-32 key, with public
 * signals `[ρ, ν, m̂, ŝ]` (docs/spec/membership.md, Checks, step 5). Returns
 * `false` for any failure: a proof that doesn't decode, a signal at or above
 * `r` (never reduced, so one proof can't stand for two signal values; T-31),
 * a root of 0 (provable by anyone with a proof length above the depth; T-04,
 * T-05), or a failed pairing check
 * `e(A, B) = e(alpha, beta) · e(L, gamma) · e(C, delta)` with
 * `L = IC_0 + ρ·IC_1 + ν·IC_2 + m̂·IC_3 + ŝ·IC_4`. The caller computes the
 * root, message and scope itself from the definition and the ballot, never
 * from the ballot's own claims (verifier 5.1 to 5.3). Proofs are malleable:
 * a valid proof has other valid encodings, so replay detection never
 * compares proof bytes (T-38).
 */
export function verifyMembershipProof(proof: Uint8Array, signals: MembershipSignals): boolean {
  const inputs = signalInputs(signals);
  if (inputs === null) return false;
  let decoded: MembershipProof;
  try {
    decoded = decodeMembershipProof(proof);
  } catch (e) {
    if (e instanceof DecodeError) return false;
    throw e;
  }
  return pairingCheck(decoded, inputs);
}

/**
 * Internal: `verifyMembershipProof` for a proof the caller already decoded
 * with `membershipProof` (a ballot record's field), so its points aren't
 * decoded and subgroup-checked twice. Points that didn't come from that
 * decoder are refused.
 */
export function verifyDecodedMembershipProof(
  proof: MembershipProof,
  signals: MembershipSignals,
): boolean {
  const inputs = signalInputs(signals);
  if (inputs === null) return false;
  if (!DECODED.has(proof)) throw new TypeError("proof: expected a decoded membership proof");
  return pairingCheck(proof, inputs);
}

/** The signals in the circuit's order, or `null` if one is at or above `r` or the root is 0. */
function signalInputs(signals: MembershipSignals): readonly bigint[] | null {
  if (signals === null || typeof signals !== "object")
    throw new TypeError("signals: expected an object");
  // Read once, so a getter can't show the checks one value and the pairing another.
  const { root, nullifier, message, scope } = signals;
  const inputs = [root, nullifier, message, scope];
  for (const v of inputs)
    if (typeof v !== "bigint") throw new TypeError("signals: expected bigints");
  if (inputs.some((v) => v < 0n || v >= BN254_R)) return null;
  if (root === 0n) return null;
  return inputs;
}

function pairingCheck(decoded: MembershipProof, inputs: readonly bigint[]): boolean {
  const vk = verificationKey();
  let l = vk.ic[0] as G1; // IC has exactly 5 points (nPublic + 1).
  for (const [i, v] of inputs.entries()) if (v !== 0n) l = l.add((vk.ic[i + 1] as G1).multiply(v));
  const terms = [
    { g1: decoded.a.negate(), g2: decoded.b },
    { g1: vk.alpha, g2: vk.beta },
    { g1: decoded.c, g2: vk.delta },
  ];
  // L is the identity only for inputs that solve a discrete log among the IC
  // points; noble refuses a zero pairing term, and e(0, gamma) is 1 anyway.
  if (!l.is0()) terms.push({ g1: l, g2: vk.gamma });
  return Fp12.eql(bn254.pairingBatch(terms), Fp12.ONE);
}

/** One proof of a batch: decoded by `membershipProof`, with its public signals. */
export interface MembershipProofCheck {
  readonly proof: MembershipProof;
  readonly signals: MembershipSignals;
}

interface Pending {
  readonly at: number;
  readonly proof: MembershipProof;
  readonly inputs: readonly bigint[];
}

// A batch this small, once it fails, is checked proof by proof: splitting it
// further costs more pairings than it saves.
const SPLIT_FLOOR = 4;

/**
 * `r_i`: uniform in `[1, 2^128)` from the CSPRNG, drawn after every proof of
 * the batch is fixed, so no submitter can choose proofs that cancel under it
 * (docs/spec/vouching.md, Batched verification; T-52).
 */
function coefficient(): bigint {
  for (;;) {
    let v = 0n;
    for (const x of randomBytes(16)) v = (v << 8n) | BigInt(x);
    if (v !== 0n) return v;
  }
}

/**
 * Whether every proof of `items` passes, by one product of `N + 3` pairings:
 * `∏ e(−r_i·A_i, B_i) · e(Σr_i·alpha, beta) · e(Σr_i·L_i, gamma) ·
 * e(Σr_i·C_i, delta) = 1`, each `L_i`'s inputs folded into one combination
 * of the five IC points. Sound only because every point passed the strict
 * decoder, so each lies in its prime-order group: a batch holding an invalid
 * proof then passes with probability at most `2^−128`.
 */
function batchPasses(items: readonly Pending[]): boolean {
  const vk = verificationKey();
  const terms: { g1: G1; g2: G2 }[] = [];
  let sum = 0n;
  const ic = vk.ic.map(() => 0n);
  let c = bn254.G1.Point.ZERO;
  for (const { proof, inputs } of items) {
    const r = coefficient();
    // −r·A is never the identity: A isn't, and 0 < r < the group's order.
    terms.push({ g1: proof.a.multiplyUnsafe(r).negate(), g2: proof.b });
    sum += r;
    ic[0] = (ic[0] as bigint) + r;
    for (const [j, v] of inputs.entries()) ic[j + 1] = (ic[j + 1] as bigint) + r * v;
    c = c.add(proof.c.multiplyUnsafe(r));
  }
  let l = bn254.G1.Point.ZERO;
  for (const [j, v] of ic.entries()) {
    const k = v % BN254_R;
    if (k !== 0n) l = l.add((vk.ic[j] as G1).multiplyUnsafe(k));
  }
  // Σr_i is below N·2^128, far below the order, so never 0 mod it.
  terms.push({ g1: vk.alpha.multiplyUnsafe(sum % BN254_R), g2: vk.beta });
  // noble refuses a zero pairing term, and e(0, Q) is 1 anyway.
  if (!l.is0()) terms.push({ g1: l, g2: vk.gamma });
  if (!c.is0()) terms.push({ g1: c, g2: vk.delta });
  return Fp12.eql(bn254.pairingBatch(terms), Fp12.ONE);
}

function individually(items: readonly Pending[], verdicts: boolean[]): void {
  for (const { at, proof, inputs } of items) verdicts[at] = pairingCheck(proof, inputs);
}

function resolve(items: readonly Pending[], verdicts: boolean[]): void {
  if (items.length <= SPLIT_FLOOR) individually(items, verdicts);
  else if (batchPasses(items)) for (const { at } of items) verdicts[at] = true;
  else split(items, verdicts);
}

// `items` failed as a batch. A half that passes is accepted; if only one half
// fails, it holds the invalid proofs and is split in turn. If both fail, the
// failures are dense (a flood of junk, T-52), and every proof of both is
// checked alone, so a batch of junk costs about 1.5 times checking it proof
// by proof rather than the twice that splitting it to the end would.
function split(items: readonly Pending[], verdicts: boolean[]): void {
  const half = Math.ceil(items.length / 2);
  const failed: (readonly Pending[])[] = [];
  for (const part of [items.slice(0, half), items.slice(half)])
    if (part.length > SPLIT_FLOOR && batchPasses(part))
      for (const { at } of part) verdicts[at] = true;
    else failed.push(part);
  const [only] = failed;
  if (failed.length === 1 && only !== undefined && only.length > SPLIT_FLOOR) split(only, verdicts);
  else for (const part of failed) individually(part, verdicts);
}

/**
 * Each proof's verdict under the pinned depth-32 key, exactly as
 * `verifyDecodedMembershipProof` gives it, but checked in batches
 * (docs/spec/vouching.md, Batched verification): a batch that passes accepts
 * every proof in it, and one that fails is split in halves until each proof's
 * own verdict is known, the smallest parts, and both halves of a batch whose
 * halves both fail, proof by proof. A proof whose
 * signals `verifyDecodedMembershipProof` refuses (one at or above `r`, a root
 * of 0) is `false` and never enters a batch. Only proofs decoded by
 * `membershipProof` are accepted: the batch test is sound only for points in
 * their prime-order groups (T-05). The coefficients are drawn here, from the
 * CSPRNG, after every proof is held; no caller supplies them. Batching lowers
 * the cost of honest proofs; a batch of junk fails and falls back to about
 * 1.5 times the pairings of checking it proof by proof (T-52).
 */
export function verifyDecodedMembershipProofs(checks: readonly MembershipProofCheck[]): boolean[] {
  if (!Array.isArray(checks)) throw new TypeError("checks: expected an array");
  const list = checks.slice();
  const verdicts = list.map(() => false);
  const pending: Pending[] = [];
  for (const [at, check] of list.entries()) {
    if (check === null || typeof check !== "object")
      throw new TypeError(`checks[${at}]: expected an object`);
    // Read once, so a getter can't show the batch one proof and the split another.
    const { proof, signals } = check;
    const inputs = signalInputs(signals);
    if (!DECODED.has(proof)) throw new TypeError("proof: expected a decoded membership proof");
    if (inputs !== null) pending.push({ at, proof, inputs });
  }
  resolve(pending, verdicts);
  return verdicts;
}
