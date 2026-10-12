// Share encryption (docs/spec/share-encryption.md; ADR 0002 option B, ADR
// 0016 option A): each trustee's shares of a ballot travel under a hybrid KEM
// that combines ML-KEM-768 (FIPS 203) with Diffie–Hellman in ristretto255,
// X-Wing style, and ChaCha20-Poly1305 (RFC 8439). It also holds the public
// check of a posted ciphertext and the trustee's complaint, a Chaum–Pedersen
// proof of the DH value (T-15, T-39, T-41). ML-KEM, the AEAD, the group and
// the hashes are @noble's; this module only composes them.

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import {
  BALLOT_RECORD_TYPE,
  BALLOT_VERSION,
  checkShares,
  type CommittedVote,
  isRegisteredSharing,
  randomScalar,
  type Share,
  SHARES,
  VSS,
  type VoteSharing,
} from "./ballot-validity.ts";
import {
  bytesFixed,
  bytesVar,
  type Codec,
  type CodecValue,
  decode,
  DecodeError,
  encode,
  EncodeError,
  struct,
  u16,
  u8,
  Writer,
} from "./codec.ts";
import { ds } from "./domain-separation.ts";
import {
  challenge,
  type Element,
  element,
  elementOrIdentity,
  G,
  GROUP_ORDER,
  H,
  IDENTITY,
  scalar,
} from "./group.ts";
import { PARAMETERS } from "./parameters.ts";

const { MAX_OPTIONS, MAX_TRUSTEES } = PARAMETERS;

/** FIPS 203 Table 3, ML-KEM-768: encapsulation key, ciphertext and shared-secret sizes. */
const MLKEM_EK_LEN = 1184;
export const MLKEM_CT_LEN = 1088;
const MLKEM_SEED_LEN = 64;
export const MLKEM_MSG_LEN = 32;
const MLKEM_Q = 3329;
export const AEAD_TAG_LEN = 16;

/** The longest sealed shares: `SHARES` at `MAX_OPTIONS` (a 4-byte count, 64 bytes per option) and the tag. */
const MAX_SEALED = 4 + 64 * MAX_OPTIONS + AEAD_TAG_LEN;

/**
 * An ML-KEM-768 encapsulation key that passes FIPS 203 §7.2's modulus check:
 * every 12-bit coefficient of its first 1152 bytes is below `q`, so
 * `ByteEncode12(ByteDecode12(ek)) = ek` and the key has one encoding (T-31,
 * T-39). The last 32 bytes are the seed `ρ`, any value.
 */
const mlkemEk: Codec<Uint8Array> = {
  minLength: MLKEM_EK_LEN,
  write(w, value) {
    if (!(value instanceof Uint8Array) || value.length !== MLKEM_EK_LEN)
      throw new EncodeError(`kem key: ek must be ${MLKEM_EK_LEN} bytes`);
    if (!modulusOk(value)) throw new EncodeError("kem key: ek fails the modulus check");
    w.bytes(Uint8Array.from(value));
  },
  read(r) {
    const at = r.offset;
    const bytes = r.take(MLKEM_EK_LEN).slice();
    if (!modulusOk(bytes)) throw new DecodeError("non-canonical", at);
    return bytes;
  },
};

function modulusOk(ek: Uint8Array): boolean {
  for (let i = 0; i < MLKEM_EK_LEN - 32; i += 3) {
    const b0 = ek[i] as number;
    const b1 = ek[i + 1] as number;
    const b2 = ek[i + 2] as number;
    if ((b0 | ((b1 & 0x0f) << 8)) >= MLKEM_Q || ((b1 >> 4) | (b2 << 4)) >= MLKEM_Q) return false;
  }
  return true;
}

/** A trustee's per-election KEM key (docs/spec/share-encryption.md, Trustee KEM key). */
export const KEM_PUBLIC_KEY = struct([
  ["ek", mlkemEk],
  ["dh", element],
]);

export type KemPublicKey = CodecValue<typeof KEM_PUBLIC_KEY>;

/** A `scalar` other than 0: the DH secret key and every ephemeral. */
const nonZeroScalar: Codec<bigint> = {
  minLength: 32,
  write(w, value) {
    if (value === 0n) throw new EncodeError("scalar: must not be 0");
    scalar.write(w, value);
  },
  read(r) {
    const at = r.offset;
    const v = scalar.read(r);
    if (v === 0n) throw new DecodeError("non-canonical", at);
    return v;
  },
};

/**
 * A trustee's KEM secret key, as its node stores it: the ML-KEM seed `d ‖ z`
 * and the DH key `x`. It is never posted or sent, and is destroyed after the
 * tally (ADR 0002, Consequences; T-14).
 */
export const KEM_SECRET_KEY = struct([
  ["seed", bytesFixed(MLKEM_SEED_LEN)],
  ["x", nonZeroScalar],
]);

export type KemSecretKey = CodecValue<typeof KEM_SECRET_KEY>;

export interface KemKeyPair {
  readonly publicKey: KemPublicKey;
  readonly secretKey: KemSecretKey;
}

// @noble rejects a multiplier of 0, which proofs legitimately use.
function mul(p: Element, s: bigint): Element {
  const e = ((s % GROUP_ORDER) + GROUP_ORDER) % GROUP_ORDER;
  return e === 0n ? IDENTITY : p.multiply(e);
}

function checkSecretKey(secretKey: KemSecretKey): void {
  // Round-trips through the codec: a 64-byte seed and x in 1 to ℓ − 1.
  encode(KEM_SECRET_KEY, secretKey);
}

/** Internal: the key pair for a given seed and DH key. Production code calls `kemKeygen`. */
export function kemKeyPairWith(seed: Uint8Array, x: bigint): KemKeyPair {
  const secretKey = { seed: Uint8Array.from(seed), x };
  checkSecretKey(secretKey);
  const { publicKey: ek } = ml_kem768.keygen(secretKey.seed);
  return { publicKey: { ek, dh: G.multiply(x) }, secretKey };
}

/** A fresh per-election KEM key pair, every secret from the CSPRNG (docs/spec/share-encryption.md, Trustee KEM key). */
export function kemKeygen(): KemKeyPair {
  return kemKeyPairWith(randomBytes(MLKEM_SEED_LEN), nonZeroRandom());
}

/** The ciphertext carrying one trustee's shares (docs/spec/share-encryption.md, Ciphertext). */
export const SHARE_CIPHERTEXT = struct([
  ["ct_mlkem", bytesFixed(MLKEM_CT_LEN)],
  ["ct_dh", element],
  ["pok_c", scalar],
  ["pok_z", scalar],
  ["sealed", bytesVar(MAX_SEALED)],
]);

export type ShareCiphertext = CodecValue<typeof SHARE_CIPHERTEXT>;

/** `H(ct_i)`: the share hash a ballot's committed vote carries for seat `i`, over the ciphertext's encoding. */
export function shareCiphertextHash(ciphertext: Uint8Array): Uint8Array {
  return H(ds("abolish/v1/share-ciphertext", ciphertext));
}

/** What the ciphertexts of one ballot are bound to, from the registered definition. */
export interface ShareContext {
  readonly definitionHash: Uint8Array;
}

function checkContext(ctx: ShareContext): void {
  if (!(ctx.definitionHash instanceof Uint8Array) || ctx.definitionHash.length !== 32)
    throw new RangeError("share context: definitionHash must be 32 bytes");
}

function checkSeat(seat: number, n: number): void {
  if (!Number.isSafeInteger(seat) || seat < 1 || seat > Math.min(n, MAX_TRUSTEES))
    throw new RangeError("seat must be a trustee seat from 1 to n");
}

/** The AEAD key: the X-Wing combiner over both shared secrets, the DH ciphertext and the trustee's DH key. */
function combine(ssM: Uint8Array, ssDh: Element, ctDh: Element, dh: Element): Uint8Array {
  const w = new Writer();
  w.bytes(ssM);
  element.write(w, ssDh);
  element.write(w, ctDh);
  element.write(w, dh);
  return H(ds("abolish/v1/kem/share", w.finish()));
}

/** The AEAD's associated data: the election, the ballot version, the seat and the VSS commitments. */
function associatedData(ctx: ShareContext, seat: number, vss: CommittedVote["vss"]): Uint8Array {
  const w = new Writer();
  w.bytes(ctx.definitionHash);
  u16.write(w, BALLOT_RECORD_TYPE);
  u8.write(w, BALLOT_VERSION);
  u8.write(w, seat);
  VSS.write(w, vss);
  return ds("abolish/v1/kem/share-aad", w.finish());
}

/**
 * The challenge of the ciphertext's proof of knowledge of `e = log_g ct_DH`.
 * It binds everything the ciphertext is for, so no one but its maker can put
 * its `ct_DH` in another ciphertext: otherwise a copy, posted with garbage,
 * would make an honest trustee's complaint reveal `ct_DH^x` and so open the
 * original (docs/spec/share-encryption.md, Ciphertext; T-15, T-41).
 */
function ephemeralChallenge(
  ctx: ShareContext,
  seat: number,
  dh: Element,
  vss: CommittedVote["vss"],
  ctM: Uint8Array,
  ctDh: Element,
  sealed: Uint8Array,
  a: Element,
): bigint {
  const w = new Writer();
  w.bytes(ctx.definitionHash);
  u16.write(w, BALLOT_RECORD_TYPE);
  u8.write(w, BALLOT_VERSION);
  u8.write(w, seat);
  element.write(w, dh);
  VSS.write(w, vss);
  w.bytes(ctM);
  element.write(w, ctDh);
  bytesVar(MAX_SEALED).write(w, sealed);
  elementOrIdentity.write(w, a);
  return challenge("abolish/v1/fs/share-ephemeral", w.finish());
}

function ephemeralProofOk(
  ctx: ShareContext,
  seat: number,
  dh: Element,
  vss: CommittedVote["vss"],
  ct: ShareCiphertext,
): boolean {
  const a = mul(G, ct.pok_z).subtract(mul(ct.ct_dh, ct.pok_c));
  return ephemeralChallenge(ctx, seat, dh, vss, ct.ct_mlkem, ct.ct_dh, ct.sealed, a) === ct.pok_c;
}

// Each AEAD key seals exactly one message: it hashes a fresh 32-byte ML-KEM
// message and a fresh ephemeral, so a fixed nonce never repeats under a key.
const NONCE = new Uint8Array(12);

function open(
  key: Uint8Array,
  aad: Uint8Array,
  sealed: Uint8Array,
  m: number,
): readonly Share[] | null {
  let plain: Uint8Array;
  try {
    plain = chacha20poly1305(key, NONCE, aad).decrypt(sealed);
  } catch {
    return null;
  }
  try {
    const shares = decode(SHARES, plain);
    return shares.length === m ? shares : null;
  } catch {
    return null;
  }
}

/**
 * The encapsulation randomness for one seat: the ML-KEM message `m`, the DH
 * ephemeral `e` and the nonce `w` of the proof of knowledge of `e`.
 */
export interface ShareEncapsulation {
  readonly m: Uint8Array;
  readonly e: bigint;
  readonly w: bigint;
}

/**
 * A ballot's share ciphertexts, one per seat in order, with their hashes for
 * the committed vote. `randomness` stays on the client only until the voter
 * casts or spoils: a posting needs `m`, a spoiled ballot reveals both, and a
 * cast erases them (ADR 0002, Private part; T-18, T-45).
 */
export interface EncryptedShares {
  readonly ciphertexts: readonly Uint8Array[];
  readonly hashes: readonly Uint8Array[];
  readonly randomness: readonly ShareEncapsulation[];
}

/**
 * Internal: encrypts a sharing's shares with the given randomness. Production
 * code calls `encryptShares`; the package entry point doesn't export this.
 */
export function encryptSharesWith(
  ctx: ShareContext,
  sharing: VoteSharing,
  keys: readonly KemPublicKey[],
  randomness: readonly ShareEncapsulation[],
): EncryptedShares {
  checkContext(ctx);
  if (!isRegisteredSharing(sharing))
    throw new TypeError("encrypt: the sharing must come from shareVote, unchanged");
  const n = sharing.shares.length;
  if (keys.length !== n) throw new RangeError("encrypt: one trustee key per seat");
  if (randomness.length !== n) throw new RangeError("encrypt: one encapsulation per seat");
  const ciphertexts = keys.map((key, i) => {
    // Round-trips the key through its codec: the modulus check and a
    // non-identity DH key, whatever the caller passed (T-39).
    const k = decode(KEM_PUBLIC_KEY, encode(KEM_PUBLIC_KEY, key));
    const { m, e, w } = randomness[i] as ShareEncapsulation;
    if (!(m instanceof Uint8Array) || m.length !== MLKEM_MSG_LEN)
      throw new RangeError("encrypt: m must be 32 bytes");
    if (typeof e !== "bigint" || e <= 0n || e >= GROUP_ORDER)
      throw new RangeError("encrypt: e must be a scalar from 1 to ℓ − 1");
    if (typeof w !== "bigint" || w <= 0n || w >= GROUP_ORDER)
      throw new RangeError("encrypt: w must be a scalar from 1 to ℓ − 1");
    const { cipherText, sharedSecret } = ml_kem768.encapsulate(k.ek, m);
    const ctDh = G.multiply(e);
    const key2 = combine(sharedSecret, k.dh.multiply(e), ctDh, k.dh);
    const aad = associatedData(ctx, i + 1, sharing.vss);
    const plain = encode(SHARES, sharing.shares[i] as readonly Share[]);
    const sealed = chacha20poly1305(key2, NONCE, aad).encrypt(plain);
    const pokC = ephemeralChallenge(
      ctx,
      i + 1,
      k.dh,
      sharing.vss,
      cipherText,
      ctDh,
      sealed,
      G.multiply(w),
    );
    const pokZ = (w + pokC * e) % GROUP_ORDER;
    return encode(SHARE_CIPHERTEXT, {
      ct_mlkem: cipherText,
      ct_dh: ctDh,
      pok_c: pokC,
      pok_z: pokZ,
      sealed,
    });
  });
  return {
    ciphertexts,
    hashes: ciphertexts.map(shareCiphertextHash),
    randomness: randomness.map(({ m, e, w }) => ({ m: Uint8Array.from(m), e, w })),
  };
}

/**
 * Encrypts each trustee's shares of a sharing to that trustee's registered
 * KEM key, in seat order, with all randomness from the CSPRNG
 * (docs/spec/share-encryption.md, Encryption). The keys must be the panel's,
 * as verifier 2.5 recomputes them; shares sent to a substituted key can't be
 * taken back (T-37).
 */
export function encryptShares(
  ctx: ShareContext,
  sharing: VoteSharing,
  keys: readonly KemPublicKey[],
): EncryptedShares {
  return encryptSharesWith(
    ctx,
    sharing,
    keys,
    keys.map(() => ({ m: randomBytes(MLKEM_MSG_LEN), e: nonZeroRandom(), w: nonZeroRandom() })),
  );
}

/** A scalar uniform on 1 to ℓ − 1 from the CSPRNG. Internal: the package entry point doesn't export it. */
export function nonZeroRandom(): bigint {
  let v = randomScalar();
  // 0 has probability about 2⁻²⁵²; drawing again keeps v uniform on 1 to ℓ − 1.
  while (v === 0n) v = randomScalar();
  return v;
}

export type OpenCode = "share-malformed" | "share-proof" | "share-decrypt" | "share-check";

export type OpenResult =
  | { readonly ok: true; readonly shares: readonly Share[] }
  | { readonly ok: false; readonly code: OpenCode };

/**
 * Trustee `seat`'s intake: decrypts its ciphertext and checks the shares
 * against the ballot's VSS commitments (docs/spec/share-encryption.md,
 * Decryption). A failure is refused at once and nothing is published: the DH
 * value and the ML-KEM output never leave the trustee (ADR 0002, Delivery).
 * The trustee also checks the ballot's validity proofs before it receipts.
 */
export function openShares(
  ctx: ShareContext,
  seat: number,
  secretKey: KemSecretKey,
  vss: CommittedVote["vss"],
  ciphertext: Uint8Array,
): OpenResult {
  checkContext(ctx);
  checkSeat(seat, MAX_TRUSTEES);
  checkSecretKey(secretKey);
  let ct: ShareCiphertext;
  try {
    ct = decode(SHARE_CIPHERTEXT, ciphertext);
  } catch {
    return { ok: false, code: "share-malformed" };
  }
  const dh = G.multiply(secretKey.x);
  if (!ephemeralProofOk(ctx, seat, dh, vss, ct)) return { ok: false, code: "share-proof" };
  const { secretKey: dk } = ml_kem768.keygen(secretKey.seed);
  // FIPS 203 Decaps: implicit rejection returns a pseudorandom secret for a
  // ciphertext that fails re-encryption, so the AEAD then fails.
  const ssM = ml_kem768.decapsulate(ct.ct_mlkem, dk);
  dk.fill(0);
  const key = combine(ssM, ct.ct_dh.multiply(secretKey.x), ct.ct_dh, dh);
  ssM.fill(0);
  const shares = open(key, associatedData(ctx, seat, vss), ct.sealed, vss.length);
  key.fill(0);
  if (shares === null) return { ok: false, code: "share-decrypt" };
  if (!checkShares(vss, seat, shares)) return { ok: false, code: "share-check" };
  return { ok: true, shares };
}

/** A ciphertext a client posted for one seat, with its ML-KEM message (ADR 0002, Public posting). */
export interface Posting {
  readonly ciphertext: Uint8Array;
  readonly m: Uint8Array;
}

export type PostingCode =
  | "posting-malformed"
  | "posting-hash"
  | "posting-proof"
  | "posting-encapsulation";

export type PostingResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: PostingCode };

function postingCheck(
  ctx: ShareContext,
  seat: number,
  key: KemPublicKey,
  vss: CommittedVote["vss"],
  shareHashes: CommittedVote["share_hashes"],
  posting: Posting,
):
  | {
      readonly ok: true;
      readonly key: KemPublicKey;
      readonly ct: ShareCiphertext;
      readonly ssM: Uint8Array;
    }
  | { readonly ok: false; readonly code: PostingCode } {
  checkContext(ctx);
  checkSeat(seat, shareHashes.length);
  const k = decode(KEM_PUBLIC_KEY, encode(KEM_PUBLIC_KEY, key));
  let ct: ShareCiphertext;
  if (!(posting.m instanceof Uint8Array) || posting.m.length !== MLKEM_MSG_LEN)
    return { ok: false, code: "posting-malformed" };
  try {
    ct = decode(SHARE_CIPHERTEXT, posting.ciphertext);
  } catch {
    return { ok: false, code: "posting-malformed" };
  }
  const expected = shareHashes[seat - 1] as Uint8Array;
  if (!bytesEqual(shareCiphertextHash(posting.ciphertext), expected))
    return { ok: false, code: "posting-hash" };
  if (!ephemeralProofOk(ctx, seat, k.dh, vss, ct)) return { ok: false, code: "posting-proof" };
  // FIPS 203 Encaps_internal, used only to verify: m determines the ML-KEM
  // ciphertext, so only the client that made it can supply a passing m.
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(k.ek, posting.m);
  if (!bytesEqual(cipherText, ct.ct_mlkem)) return { ok: false, code: "posting-encapsulation" };
  return { ok: true, key: k, ct, ssM: sharedSecret };
}

/**
 * The public check of a posted ciphertext (docs/spec/share-encryption.md,
 * Public posting): it decodes, hashes to the ballot's share hash for its seat,
 * its proof of knowledge of the ephemeral verifies, and its ML-KEM message
 * re-encapsulates to its ML-KEM ciphertext under the seat's registered key. A
 * posting that fails is ignored; it never excludes a ballot.
 */
export function checkPosting(
  ctx: ShareContext,
  seat: number,
  key: KemPublicKey,
  vss: CommittedVote["vss"],
  shareHashes: CommittedVote["share_hashes"],
  posting: Posting,
): PostingResult {
  const r = postingCheck(ctx, seat, key, vss, shareHashes, posting);
  return r.ok ? { ok: true } : r;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  // Public values only: hashes and ciphertexts.
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** A trustee's complaint about a posting: the DH value and a Chaum–Pedersen proof of it. */
export const COMPLAINT_PROOF = struct([
  ["dh", element],
  ["c", scalar],
  ["z", scalar],
]);

export type ComplaintProof = CodecValue<typeof COMPLAINT_PROOF>;

function complaintChallenge(
  ctx: ShareContext,
  seat: number,
  key: Element,
  shareHash: Uint8Array,
  ctDh: Element,
  d: Element,
  a1: Element,
  a2: Element,
): bigint {
  const w = new Writer();
  w.bytes(ctx.definitionHash);
  u8.write(w, seat);
  element.write(w, key);
  w.bytes(shareHash);
  element.write(w, ctDh);
  element.write(w, d);
  elementOrIdentity.write(w, a1);
  elementOrIdentity.write(w, a2);
  return challenge("abolish/v1/fs/share-complaint", w.finish());
}

/**
 * Internal: proves a complaint with the given nonce. Production code calls
 * `proveComplaint`; the package entry point doesn't export this.
 */
export function proveComplaintWith(
  ctx: ShareContext,
  seat: number,
  keyPair: KemKeyPair,
  vss: CommittedVote["vss"],
  shareHashes: CommittedVote["share_hashes"],
  posting: Posting,
  w: bigint,
): ComplaintProof {
  checkSecretKey(keyPair.secretKey);
  if (typeof w !== "bigint" || w <= 0n || w >= GROUP_ORDER)
    throw new RangeError("complaint: w must be a scalar from 1 to ℓ − 1");
  const { x } = keyPair.secretKey;
  if (
    !G.multiply(x).equals(keyPair.publicKey.dh) ||
    !bytesEqual(ml_kem768.keygen(keyPair.secretKey.seed).publicKey, keyPair.publicKey.ek)
  )
    throw new RangeError("complaint: the key pair doesn't match");
  // Only a posting that passes the public check, and whose shares fail this
  // trustee's own intake at decryption or the share check: the DH value is
  // revealed for nothing else (ADR 0002, Complaints).
  const p = postingCheck(ctx, seat, keyPair.publicKey, vss, shareHashes, posting);
  if (!p.ok) throw new RangeError(`complaint: the posting fails (${p.code})`);
  const intake = openShares(ctx, seat, keyPair.secretKey, vss, posting.ciphertext);
  if (intake.ok || (intake.code !== "share-decrypt" && intake.code !== "share-check"))
    throw new RangeError("complaint: the posted shares don't fail decryption or the share check");
  const ct = p.ct;
  const d = ct.ct_dh.multiply(x);
  const c = complaintChallenge(
    ctx,
    seat,
    keyPair.publicKey.dh,
    shareHashes[seat - 1] as Uint8Array,
    ct.ct_dh,
    d,
    G.multiply(w),
    ct.ct_dh.multiply(w),
  );
  return { dh: d, c, z: (w + c * x) % GROUP_ORDER };
}

/**
 * A trustee's complaint about a posted ciphertext whose share is invalid
 * (docs/spec/share-encryption.md, Complaints): it reveals only the DH value
 * `ct_DH^x`, which the poster, having proved it knows `e`, can already
 * compute; never any ML-KEM output (ADR 0002, Complaints). It refuses unless
 * the posting passes the public check and the shares fail this trustee's
 * intake at decryption or the share check.
 */
export function proveComplaint(
  ctx: ShareContext,
  seat: number,
  keyPair: KemKeyPair,
  vss: CommittedVote["vss"],
  shareHashes: CommittedVote["share_hashes"],
  posting: Posting,
): ComplaintProof {
  return proveComplaintWith(ctx, seat, keyPair, vss, shareHashes, posting, nonZeroRandom());
}

export type ComplaintCode = PostingCode | "complaint-proof" | "complaint-unfounded";

/** `ok: true` means the complaint is proven and the ballot is excluded. */
export type ComplaintResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ComplaintCode };

/**
 * Anyone's check of a complaint (docs/spec/share-encryption.md, Complaints):
 * the posting passes the public check, the proof shows the DH value is the
 * seat's, and with it and the posted `m` the ciphertext doesn't open to valid
 * shares. A complaint against shares that pass is unfounded, and stays
 * attributed to the trustee that signed it (T-29).
 */
export function checkComplaint(
  ctx: ShareContext,
  seat: number,
  key: KemPublicKey,
  vss: CommittedVote["vss"],
  shareHashes: CommittedVote["share_hashes"],
  posting: Posting,
  complaint: ComplaintProof,
): ComplaintResult {
  const p = postingCheck(ctx, seat, key, vss, shareHashes, posting);
  if (!p.ok) return p;
  const { dh: d, c, z } = decode(COMPLAINT_PROOF, encode(COMPLAINT_PROOF, complaint));
  const ctDh = p.ct.ct_dh;
  const dh = p.key.dh;
  const a1 = mul(G, z).subtract(mul(dh, c));
  const a2 = mul(ctDh, z).subtract(mul(d, c));
  const expected = complaintChallenge(
    ctx,
    seat,
    dh,
    shareHashes[seat - 1] as Uint8Array,
    ctDh,
    d,
    a1,
    a2,
  );
  if (expected !== c) return { ok: false, code: "complaint-proof" };
  const aeadKey = combine(p.ssM, d, ctDh, dh);
  const shares = open(aeadKey, associatedData(ctx, seat, vss), p.ct.sealed, vss.length);
  if (shares !== null && checkShares(vss, seat, shares))
    return { ok: false, code: "complaint-unfounded" };
  return { ok: true };
}
