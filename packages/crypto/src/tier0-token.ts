// Tier 0 tokens (docs/spec/tier0-token.md; ADR 0039, option C): the issuer's
// key identifiers and periods, the group `info`, the token input that binds a
// commitment, and RFC 9497's POPRF mode over ristretto255-SHA512 with batch
// size 1 (Blind, BlindEvaluate with its proof, Finalize and Evaluate). Each
// step is the RFC's own, composed from group.ts's wrappers over @noble/curves
// under the RFC's DSTs, as tests/vectors/rfc.test.ts composes them; nothing
// here is on the board, the chain or the archive (T-74, T-10, T-16).

import { sha512 } from "@noble/hashes/sha2.js";
import { concatBytes } from "@noble/hashes/utils.js";
import { randomScalar } from "./ballot-validity.ts";
import { bytesFixed, DecodeError, decode, encode, fieldBn254, u32, u64 } from "./codec.ts";
import { ds } from "./domain-separation.ts";
import {
  type Element,
  element,
  elementOrIdentity,
  G,
  GROUP_ORDER,
  H,
  hashToRistretto255,
  hashToScalarXmd,
  IDENTITY,
  scalar,
  scalarInverse,
} from "./group.ts";
import { isForbiddenCommitment } from "./group-registry.ts";

/** Seconds in a key period (30 days); period `q` is `[TOKEN_KEY_PERIOD · q, TOKEN_KEY_PERIOD · (q + 1))`. */
export const TOKEN_KEY_PERIOD = 2_592_000;
/** The token input's layout version (Token input). */
export const TOKEN_VERSION = 1;
/** Seconds over which the client spreads its redemption after `Finalize` (Timing). */
export const TOKEN_REDEEM_DELAY = 86_400;

/** The codes of docs/spec/tier0-token.md, Errors, that this module's checks raise. */
export type Tier0TokenErrorCode =
  | "non-canonical"
  | "forbidden-commitment"
  | "tweaked-key-identity"
  | "blinded-element"
  | "inverse"
  | "evaluation-element"
  | "proof";

export class Tier0TokenError extends Error {
  override readonly name = "Tier0TokenError";
  constructor(readonly code: Tier0TokenErrorCode) {
    super(code);
  }
}

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

// RFC 9497 §3.1: contextString = "OPRFV1-" ‖ I2OSP(modePOPRF, 1) ‖ "-" ‖ identifier.
const CONTEXT = concatBytes(ascii("OPRFV1-"), Uint8Array.of(0x02), ascii("-ristretto255-SHA512"));
const HASH_TO_GROUP_DST = concatBytes(ascii("HashToGroup-"), CONTEXT);
const HASH_TO_SCALAR_DST = concatBytes(ascii("HashToScalar-"), CONTEXT);
const SEED_DST = concatBytes(ascii("Seed-"), CONTEXT);

const MAX_FRAMED = 0xffff;
const SCALAR_LEN = 32;
const PROOF_LEN = 2 * SCALAR_LEN;
/** Bytes in a token, RFC 9497's `Nh` for SHA-512. */
export const TOKEN_LEN = 64;

function bytesOf(b: unknown, what: string, length?: number): Uint8Array {
  // A Proxy or another typed array would hash other bytes than the ones
  // checked; copied, so the caller can't change them midway.
  if (!(b instanceof Uint8Array) || !ArrayBuffer.isView(b))
    throw new TypeError(`${what} must be a Uint8Array`);
  const copy = new Uint8Array(b);
  if (length !== undefined && copy.length !== length)
    throw new RangeError(`${what} must be ${length} bytes`);
  return copy;
}

/** `I2OSP(len(b), 2) ‖ b`, RFC 9497's length-prefixed framing. */
function framed(b: Uint8Array): Uint8Array {
  if (b.length > MAX_FRAMED) throw new RangeError("RFC 9497 inputs are below 2¹⁶ bytes");
  return concatBytes(Uint8Array.of(b.length >> 8, b.length & 0xff), b);
}

const ser = (p: Element) => encode(element, p);
// A proof's transcript serialises whatever its scalars give, the identity
// included (a forged proof of zeros reaches it), so a bad proof fails the
// challenge rather than the encoder.
const serAny = (p: Element) => encode(elementOrIdentity, p);
const mod = (x: bigint) => ((x % GROUP_ORDER) + GROUP_ORDER) % GROUP_ORDER;
// @noble/curves multiplies only by 1 to ℓ − 1; a proof's public scalars can be 0.
const mul = (p: Element, k: bigint) => (k === 0n ? IDENTITY : p.multiply(k));

function decodeElement(b: unknown, what: string, code: Tier0TokenErrorCode): Element {
  const bytes = bytesOf(b, what);
  try {
    return decode(element, bytes);
  } catch (e) {
    if (e instanceof DecodeError) throw new Tier0TokenError(code);
    throw e;
  }
}

// `pkS` comes from the deployment record, so a bad one is a configuration
// fault, never one of the spec's codes (which a client would act on).
function decodePublicKey(b: unknown): Element {
  try {
    return decodeElement(b, "public key", "non-canonical");
  } catch (e) {
    if (e instanceof Tier0TokenError)
      throw new RangeError("public key must be a canonical element other than the identity");
    throw e;
  }
}

/** A scalar's 32-byte encoding, below ℓ and not 0: a key or a blind. */
function decodeSecretScalar(b: unknown, what: string): bigint {
  const bytes = bytesOf(b, what, SCALAR_LEN);
  let k: bigint;
  try {
    k = decode(scalar, bytes);
  } catch {
    throw new RangeError(`${what} must be a canonical scalar`);
  } finally {
    bytes.fill(0);
  }
  if (k === 0n) throw new RangeError(`${what} must not be 0`);
  return k;
}

function randomNonZeroScalar(): bigint {
  let k = randomScalar();
  while (k === 0n) k = randomScalar();
  return k;
}

// RFC 9497 §3.3.3: m = HashToScalar("Info" ‖ I2OSP(len(info), 2) ‖ info).
function tweak(info: Uint8Array): bigint {
  return hashToScalarXmd(concatBytes(ascii("Info"), framed(info)), HASH_TO_SCALAR_DST);
}

function inputElement(input: Uint8Array): Element {
  const p = hashToRistretto255(input, HASH_TO_GROUP_DST);
  // RFC 9497 InvalidInputError; hash_to_ristretto255 reaches the identity
  // only with negligible probability.
  if (p.is0()) throw new Error("the token input hashes to the identity");
  return p;
}

// RFC 9497 §3.3.3 Finalize and Evaluate's common output.
function output(input: Uint8Array, info: Uint8Array, unblinded: Element): Uint8Array {
  return sha512(
    concatBytes(framed(input), framed(info), framed(ser(unblinded)), ascii("Finalize")),
  );
}

// RFC 9497 §2.2.1 ComputeComposites with batch size 1: `d` for (C, D) under B.
function composite(Bm: Uint8Array, C: Element, D: Element): bigint {
  const seed = sha512(concatBytes(framed(Bm), framed(SEED_DST)));
  return hashToScalarXmd(
    concatBytes(
      framed(seed),
      Uint8Array.of(0, 0),
      framed(serAny(C)),
      framed(serAny(D)),
      ascii("Composite"),
    ),
    HASH_TO_SCALAR_DST,
  );
}

function proofChallenge(Bm: Uint8Array, M: Element, Z: Element, t2: Element, t3: Element): bigint {
  return hashToScalarXmd(
    concatBytes(
      framed(Bm),
      framed(serAny(M)),
      framed(serAny(Z)),
      framed(serAny(t2)),
      framed(serAny(t3)),
      ascii("Challenge"),
    ),
    HASH_TO_SCALAR_DST,
  );
}

/** The issuer's key pair: `skS` and `pkS = skS · g`, each 32 bytes. */
export interface Tier0TokenKeyPair {
  readonly secretKey: Uint8Array;
  readonly publicKey: Uint8Array;
}

/** RFC 9497 `GenerateKeyPair`: `skS` uniform on 1 to ℓ − 1 from the CSPRNG (Keys). */
export function generateTier0TokenKeyPair(): Tier0TokenKeyPair {
  const sk = randomNonZeroScalar();
  return { secretKey: encode(scalar, sk), publicKey: ser(G.multiply(sk)) };
}

/** `pkS` for a secret key's encoding. */
export function tier0TokenPublicKey(secretKey: Uint8Array): Uint8Array {
  return ser(G.multiply(decodeSecretScalar(secretKey, "secret key")));
}

/** The key period `floor(now / TOKEN_KEY_PERIOD)` of a UNIX time in seconds. */
export function tier0TokenKeyPeriod(now: number): number {
  if (!Number.isSafeInteger(now) || now < 0)
    throw new RangeError("now must be a non-negative integer of seconds");
  return Math.floor(now / TOKEN_KEY_PERIOD);
}

/** Whether period `q`'s key issues at `now`: only during `q` (Keys). */
export function tier0TokenKeyIssues(period: number, now: number): boolean {
  return tier0TokenKeyPeriod(now) === period;
}

/** Whether period `q`'s key redeems at `now`: during `q` and `q + 1` (Keys). */
export function tier0TokenKeyRedeems(period: number, now: number): boolean {
  const current = tier0TokenKeyPeriod(now);
  return current === period || current === period + 1;
}

/** `key_id = H(DS("abolish/v1/tier0-token/key", u32(q) ‖ pkS))`. */
export function tier0TokenKeyId(period: number, publicKey: Uint8Array): Uint8Array {
  // pkS is checked as an element, so no identifier names a key no one holds.
  const pk = ser(decodePublicKey(publicKey));
  return H(ds("abolish/v1/tier0-token/key", concatBytes(encode(u32, period), pk)));
}

/** The published group a token admits to (Group info), from the deployment record. */
export interface Tier0TokenGroup {
  readonly chainId: bigint;
  readonly groupRegistry: Uint8Array;
  readonly groupId: bigint;
}

/** `info = H(DS("abolish/v1/tier0-token/info", u64(chain_id) ‖ bytes[20](group_registry) ‖ u64(group_id)))`. */
export function tier0TokenInfo(group: Tier0TokenGroup): Uint8Array {
  return H(
    ds(
      "abolish/v1/tier0-token/info",
      concatBytes(
        encode(u64, group.chainId),
        encode(bytesFixed(20), group.groupRegistry),
        encode(u64, group.groupId),
      ),
    ),
  );
}

/**
 * `input = H(DS("abolish/v1/tier0-token/input", u8(TOKEN_VERSION) ‖ key_id ‖
 * field<bn254>(C)))` for a commitment's 32-byte encoding, which must be below
 * `r` (`non-canonical`) and not forbidden (`forbidden-commitment`), so a token
 * never binds a commitment no group admits (T-16).
 */
export function tier0TokenInput(keyId: Uint8Array, commitment: Uint8Array): Uint8Array {
  const kid = bytesOf(keyId, "key_id", 32);
  const c = bytesOf(commitment, "commitment", 32);
  let value: bigint;
  try {
    value = decode(fieldBn254, c);
  } catch (e) {
    if (e instanceof DecodeError) throw new Tier0TokenError("non-canonical");
    throw e;
  }
  if (isForbiddenCommitment(value)) throw new Tier0TokenError("forbidden-commitment");
  return H(ds("abolish/v1/tier0-token/input", concatBytes(Uint8Array.of(TOKEN_VERSION), kid, c)));
}

/** What `Blind` gives the client: `blind` to keep secret, `B` to send, `T` to check the answer against. */
export interface Tier0TokenBlinding {
  readonly blind: Uint8Array;
  readonly blindedElement: Uint8Array;
  readonly tweakedKey: Uint8Array;
}

// RFC 9497 §3.3.3: T = HashToScalar(framedInfo) · g + pkS, refused when it is
// the identity (InvalidInputError), since no evaluation under it exists.
function tweakedKey(publicKey: Uint8Array, info: Uint8Array): Element {
  const pk = decodePublicKey(publicKey);
  const t = mul(G, tweak(info)).add(pk);
  if (t.is0()) throw new Tier0TokenError("tweaked-key-identity");
  return t;
}

/**
 * RFC 9497 `Blind` under an explicit `blind`. Internal test seam: the entry
 * point exports only `tier0TokenBlind`, which draws it, so production code
 * can't reuse one.
 */
export function tier0TokenBlindWith(
  input: Uint8Array,
  publicKey: Uint8Array,
  info: Uint8Array,
  blind: Uint8Array,
): Tier0TokenBlinding {
  const T = tweakedKey(publicKey, bytesOf(info, "info"));
  const r = decodeSecretScalar(blind, "blind");
  const B = inputElement(bytesOf(input, "input")).multiply(r);
  return { blind: encode(scalar, r), blindedElement: ser(B), tweakedKey: ser(T) };
}

/**
 * RFC 9497 `Blind`, with `blind` fresh from the CSPRNG: the client stores
 * `blind` and `B` durably before sending `B` (Issuance, step 1).
 */
export function tier0TokenBlind(
  input: Uint8Array,
  publicKey: Uint8Array,
  info: Uint8Array,
): Tier0TokenBlinding {
  return tier0TokenBlindWith(input, publicKey, info, encode(scalar, randomNonZeroScalar()));
}

/** The issuer's answer: `Z` and `proof = c ‖ s`. */
export interface Tier0TokenEvaluation {
  readonly evaluationElement: Uint8Array;
  readonly proof: Uint8Array;
}

/**
 * `B` as the issuer decodes it (Issuance, step 2.4): 32 bytes encoding an
 * element other than the identity, else `blinded-element`.
 */
export function decodeTier0TokenBlindedElement(blindedElement: Uint8Array): Uint8Array {
  return ser(decodeElement(blindedElement, "blinded element", "blinded-element"));
}

// t = skS + m, refused at 0 (RFC 9497 InverseError).
function issuerKey(secretKey: Uint8Array, info: Uint8Array): bigint {
  const t = mod(decodeSecretScalar(secretKey, "secret key") + tweak(info));
  if (t === 0n) throw new Tier0TokenError("inverse");
  return t;
}

/**
 * RFC 9497 `BlindEvaluate` with the proof's randomness `r` given. Internal
 * test seam: the entry point exports only `tier0TokenBlindEvaluate`.
 */
export function tier0TokenBlindEvaluateWith(
  secretKey: Uint8Array,
  blindedElement: Uint8Array,
  info: Uint8Array,
  r: bigint,
): Tier0TokenEvaluation {
  const B = decodeElement(blindedElement, "blinded element", "blinded-element");
  const t = issuerKey(secretKey, bytesOf(info, "info"));
  if (typeof r !== "bigint" || r <= 0n || r >= GROUP_ORDER)
    throw new RangeError("r must be a scalar from 1 to ℓ - 1");
  const Z = B.multiply(scalarInverse(t));
  // GenerateProof(t, g, T, C = Z, D = B): the evaluation is t⁻¹ · B, so the
  // DLEQ relation runs from Z to B under t (§3.3.3).
  const Bm = ser(G.multiply(t));
  const M = Z.multiply(composite(Bm, Z, B));
  const c = proofChallenge(Bm, M, M.multiply(t), G.multiply(r), M.multiply(r));
  const s = mod(r - c * t);
  return {
    evaluationElement: ser(Z),
    proof: concatBytes(encode(scalar, c), encode(scalar, s)),
  };
}

/**
 * RFC 9497 `BlindEvaluate`, with fresh proof randomness (Issuance, step 4).
 * Throws `blinded-element` for a `B` the issuer refuses and `inverse` when
 * `skS + m = 0` for this `info`.
 */
export function tier0TokenBlindEvaluate(
  secretKey: Uint8Array,
  blindedElement: Uint8Array,
  info: Uint8Array,
): Tier0TokenEvaluation {
  return tier0TokenBlindEvaluateWith(secretKey, blindedElement, info, randomNonZeroScalar());
}

/** The client's stored request, the issuer's answer and the published key, for `Finalize`. */
export interface Tier0TokenFinalization {
  readonly input: Uint8Array;
  readonly info: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly blind: Uint8Array;
  readonly blindedElement: Uint8Array;
  readonly evaluationElement: Uint8Array;
  readonly proof: Uint8Array;
}

/**
 * RFC 9497 `Finalize` (Issuance, step 5): checks `proof` against `T`, which
 * it computes from the published `pkS` and `info` rather than taking it, so
 * no other key or group can pass, and gives the 64-byte token. Throws
 * `evaluation-element` for a `Z` that isn't a canonical element other than
 * the identity, and `proof` for scalars at or above `ℓ`, a proof of another
 * length or one that doesn't check. The caller derives `input`'s `key_id`
 * and `publicKey` from the same published (`q`, `pkS`): nothing here can
 * check that pairing, and a mismatched pair finalizes a token the signing
 * service never accepts.
 */
export function tier0TokenFinalize(f: Tier0TokenFinalization): Uint8Array {
  const input = bytesOf(f.input, "input");
  const info = bytesOf(f.info, "info");
  const T = tweakedKey(f.publicKey, info);
  const Z = decodeElement(f.evaluationElement, "evaluation element", "evaluation-element");
  const B = decodeElement(f.blindedElement, "blinded element", "blinded-element");
  const proof = bytesOf(f.proof, "proof");
  if (proof.length !== PROOF_LEN) throw new Tier0TokenError("proof");
  let c: bigint;
  let s: bigint;
  try {
    c = decode(scalar, proof.subarray(0, SCALAR_LEN));
    s = decode(scalar, proof.subarray(SCALAR_LEN));
  } catch (e) {
    if (e instanceof DecodeError) throw new Tier0TokenError("proof");
    throw e;
  }
  // VerifyProof(g, T, C = Z, D = B, proof): M = d·Z, its image d·B.
  const Bm = ser(T);
  const d = composite(Bm, Z, B);
  const M = mul(Z, d);
  const W = mul(B, d);
  const t2 = mul(G, s).add(mul(T, c));
  const t3 = mul(M, s).add(mul(W, c));
  if (proofChallenge(Bm, M, W, t2, t3) !== c) throw new Tier0TokenError("proof");
  const r = decodeSecretScalar(f.blind, "blind");
  return output(input, info, Z.multiply(scalarInverse(r)));
}

/**
 * RFC 9497 `Evaluate`: the token for `input` under `skS` and `info`, computed
 * by the signing service at redemption (Redemption, step 3).
 */
export function tier0TokenEvaluate(
  secretKey: Uint8Array,
  input: Uint8Array,
  info: Uint8Array,
): Uint8Array {
  const i = bytesOf(input, "input");
  const inf = bytesOf(info, "info");
  const t = issuerKey(secretKey, inf);
  return output(i, inf, inputElement(i).multiply(scalarInverse(t)));
}

/**
 * Redemption, step 3: whether `token` is 64 bytes equal to `Evaluate(skS,
 * input, info)`, compared in constant time, since the expected token is what
 * a forger is after (T-74).
 */
export function tier0TokenMatches(
  secretKey: Uint8Array,
  input: Uint8Array,
  info: Uint8Array,
  token: Uint8Array,
): boolean {
  const presented = bytesOf(token, "token");
  const expected = tier0TokenEvaluate(secretKey, input, info);
  if (presented.length !== TOKEN_LEN) return false;
  let diff = 0;
  for (let i = 0; i < TOKEN_LEN; i++) diff |= (presented[i] ?? 0) ^ (expected[i] ?? 0);
  expected.fill(0);
  return diff === 0;
}

/**
 * Re-issuance, item 3 (Keys): whether `blind` and the commitment shown with a
 * dead token give the `B` the issuer's record holds, `blind · HashToGroup(input)`
 * with `input` from `keyId` and the commitment. An encoding the spec refuses
 * (a `blind` of 0 or at or above `ℓ`, a commitment not below `r` or
 * forbidden, a `B` that isn't an element) gives false, which the issuer
 * answers with `reissue-refused`.
 */
export function tier0TokenBlindedFrom(
  keyId: Uint8Array,
  commitment: Uint8Array,
  blind: Uint8Array,
  blindedElement: Uint8Array,
): boolean {
  let input: Uint8Array;
  let r: bigint;
  let B: Element;
  try {
    input = tier0TokenInput(keyId, commitment);
    r = decodeSecretScalar(blind, "blind");
    B = decodeElement(blindedElement, "blinded element", "blinded-element");
  } catch (e) {
    if (e instanceof Tier0TokenError || e instanceof RangeError) return false;
    throw e;
  }
  return inputElement(input).multiply(r).equals(B);
}
