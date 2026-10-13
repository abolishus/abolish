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
  type CommittedVoteV4,
  isRegisteredSharing,
  isRegisteredSharingV4,
  randomScalar,
  type Share,
  SHARES,
  VSS,
  type VoteHalvesV4,
  type VoteSharing,
  type VoteSharingV4,
} from "./ballot-validity.ts";
import type { SeatPanel } from "./ballot.ts";
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
export const MAX_SEALED = 4 + 64 * MAX_OPTIONS + AEAD_TAG_LEN;

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

/**
 * What one seat's ciphertext is bound to. `head` is what `aad` and `t_e`
 * start with (the election, the ballot record's type and the version whose
 * share-ciphertext rules apply, under version 4 the seat's panel, then the
 * seat), `commitments` the VSS commitments both bind, and `vss` the seat's
 * own panel's commitments, which its shares are checked against
 * (docs/spec/share-encryption.md, Ciphertext; Ballot version 4). A complaint's
 * challenge input starts with `complaintHead` under `complaintTag`.
 */
interface SeatBinding {
  readonly definitionHash: Uint8Array;
  readonly seat: number;
  readonly head: Uint8Array;
  readonly commitments: Uint8Array;
  readonly vss: CommittedVote["vss"];
  readonly complaintTag: "abolish/v1/fs/share-complaint" | "abolish/v1/fs/share-complaint-2";
  readonly complaintHead: Uint8Array;
}

// Ballot versions 1 to 3: ballot version 1's rules, `u8(1)`, then the seat.
function bindingV1(ctx: ShareContext, seat: number, vss: CommittedVote["vss"]): SeatBinding {
  const head = new Writer();
  head.bytes(ctx.definitionHash);
  u16.write(head, BALLOT_RECORD_TYPE);
  u8.write(head, BALLOT_VERSION);
  u8.write(head, seat);
  const commitments = new Writer();
  VSS.write(commitments, vss);
  const complaintHead = new Writer();
  complaintHead.bytes(ctx.definitionHash);
  u8.write(complaintHead, seat);
  return {
    definitionHash: ctx.definitionHash,
    seat,
    head: head.finish(),
    commitments: commitments.finish(),
    vss,
    complaintTag: "abolish/v1/fs/share-complaint",
    complaintHead: complaintHead.finish(),
  };
}

/** The halves a version-4 seat's ciphertext is bound to: both, whichever panel the seat is in. */
export type ShareHalvesV4 = Pick<CommittedVoteV4, "vss" | "author_vss">;

const BALLOT_VERSION_4 = 4;

// Ballot version 4: its own rules, `u8(4)`, then the seat's panel and the
// seat, and both halves' commitments, so a ciphertext for one panel's seat
// `i` never opens or proves for the other's, nor next to another half
// (docs/spec/share-encryption.md, Ciphertext (ballot version 4); T-30, T-31,
// T-37).
function bindingV4(
  ctx: ShareContext,
  panel: SeatPanel,
  seat: number,
  halves: ShareHalvesV4,
): SeatBinding {
  const head = new Writer();
  head.bytes(ctx.definitionHash);
  u16.write(head, BALLOT_RECORD_TYPE);
  u8.write(head, BALLOT_VERSION_4);
  u8.write(head, panel);
  u8.write(head, seat);
  const commitments = new Writer();
  VSS.write(commitments, halves.vss);
  VSS.write(commitments, halves.author_vss);
  const complaintHead = new Writer();
  complaintHead.bytes(ctx.definitionHash);
  u8.write(complaintHead, panel);
  u8.write(complaintHead, seat);
  return {
    definitionHash: ctx.definitionHash,
    seat,
    head: head.finish(),
    commitments: commitments.finish(),
    vss: panel === 2 ? halves.author_vss : halves.vss,
    complaintTag: "abolish/v1/fs/share-complaint-2",
    complaintHead: complaintHead.finish(),
  };
}

function checkPanel(panel: SeatPanel, halves: ShareHalvesV4): void {
  if (panel !== 1 && panel !== 2) throw new RangeError("panel must be 1 (default) or 2 (author)");
  if (panel === 2 && halves.author_vss.length === 0)
    throw new RangeError("the ballot has no author half, so no author seat");
}

/** The AEAD's associated data: the election, the ballot version, the seat (and its panel) and the VSS commitments. */
function associatedData(b: SeatBinding): Uint8Array {
  const w = new Writer();
  w.bytes(b.head);
  w.bytes(b.commitments);
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
  b: SeatBinding,
  dh: Element,
  ctM: Uint8Array,
  ctDh: Element,
  sealed: Uint8Array,
  a: Element,
): bigint {
  const w = new Writer();
  w.bytes(b.head);
  element.write(w, dh);
  w.bytes(b.commitments);
  w.bytes(ctM);
  element.write(w, ctDh);
  bytesVar(MAX_SEALED).write(w, sealed);
  elementOrIdentity.write(w, a);
  return challenge("abolish/v1/fs/share-ephemeral", w.finish());
}

function ephemeralProofOk(b: SeatBinding, dh: Element, ct: ShareCiphertext): boolean {
  const a = mul(G, ct.pok_z).subtract(mul(ct.ct_dh, ct.pok_c));
  return ephemeralChallenge(b, dh, ct.ct_mlkem, ct.ct_dh, ct.sealed, a) === ct.pok_c;
}

// Each AEAD key seals exactly one message: it hashes a fresh 32-byte ML-KEM
// message and a fresh ephemeral, so a fixed nonce never repeats under a key.
const NONCE = new Uint8Array(12);

// Decryption steps 4 and 5 with a known AEAD key: the seat's shares, or the
// code of the first step that fails.
function openWith(
  key: Uint8Array,
  b: SeatBinding,
  sealed: Uint8Array,
):
  | { readonly ok: true; readonly shares: readonly Share[] }
  | { readonly ok: false; readonly code: "share-decrypt" | "share-check" } {
  let plain: Uint8Array;
  try {
    plain = chacha20poly1305(key, NONCE, associatedData(b)).decrypt(sealed);
  } catch {
    return { ok: false, code: "share-decrypt" };
  }
  let shares: readonly Share[];
  try {
    shares = decode(SHARES, plain);
  } catch {
    return { ok: false, code: "share-decrypt" };
  }
  if (shares.length !== b.vss.length) return { ok: false, code: "share-decrypt" };
  if (!checkShares(b.vss, b.seat, shares)) return { ok: false, code: "share-check" };
  return { ok: true, shares };
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
 * cast erases them (ADR 0002, Private part; T-18, T-45). This package keeps a
 * private copy for `openChallenge` while the object lives, so after a cast
 * the client copies out what it still needs and drops the whole object.
 */
export interface EncryptedShares {
  readonly ciphertexts: readonly Uint8Array[];
  readonly hashes: readonly Uint8Array[];
  readonly randomness: readonly ShareEncapsulation[];
}

// One seat's ciphertext of `shares` under `key`, deterministic in its
// randomness, bound as `b` says (docs/spec/share-encryption.md, Ciphertext).
function sealSeat(
  b: SeatBinding,
  key: KemPublicKey,
  shares: readonly Share[],
  randomness: ShareEncapsulation,
): Uint8Array {
  checkSeat(b.seat, MAX_TRUSTEES);
  // Round-trips the key through its codec: the modulus check and a
  // non-identity DH key, whatever the caller passed (T-39).
  const k = decode(KEM_PUBLIC_KEY, encode(KEM_PUBLIC_KEY, key));
  const { m, e, w } = randomness;
  if (!(m instanceof Uint8Array) || m.length !== MLKEM_MSG_LEN)
    throw new RangeError("encrypt: m must be 32 bytes");
  if (typeof e !== "bigint" || e <= 0n || e >= GROUP_ORDER)
    throw new RangeError("encrypt: e must be a scalar from 1 to ℓ − 1");
  if (typeof w !== "bigint" || w <= 0n || w >= GROUP_ORDER)
    throw new RangeError("encrypt: w must be a scalar from 1 to ℓ − 1");
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(k.ek, m);
  const ctDh = G.multiply(e);
  const aeadKey = combine(sharedSecret, k.dh.multiply(e), ctDh, k.dh);
  sharedSecret.fill(0);
  const sealed = chacha20poly1305(aeadKey, NONCE, associatedData(b)).encrypt(
    encode(SHARES, shares),
  );
  aeadKey.fill(0);
  const pokC = ephemeralChallenge(b, k.dh, cipherText, ctDh, sealed, G.multiply(w));
  const pokZ = (w + pokC * e) % GROUP_ORDER;
  return encode(SHARE_CIPHERTEXT, {
    ct_mlkem: cipherText,
    ct_dh: ctDh,
    pok_c: pokC,
    pok_z: pokZ,
    sealed,
  });
}

/**
 * Internal: one seat's ciphertext of `shares` under `key`, deterministic in
 * its randomness (docs/spec/share-encryption.md, Ciphertext). Encryption and
 * a challenge's check both make ciphertexts here, so an opening rebuilds
 * exactly the bytes a client sent (docs/spec/challenge.md, Checks). The
 * package entry point doesn't export it: a caller choosing `m` or `e` could
 * reuse an AEAD key (T-15).
 */
export function encryptSeat(
  ctx: ShareContext,
  seat: number,
  key: KemPublicKey,
  vss: CommittedVote["vss"],
  shares: readonly Share[],
  randomness: ShareEncapsulation,
): Uint8Array {
  return sealSeat(bindingV1(ctx, seat, vss), key, shares, randomness);
}

/**
 * Internal: `encryptSeat` for a seat of either panel under ballot version 4
 * (docs/spec/share-encryption.md, Ciphertext (ballot version 4)), for opening
 * version 3's rebuild of a challenged ballot's ciphertexts (P2-16 part 2b-4).
 * The package entry point doesn't export it, for the same reason.
 */
export function encryptSeatV4(
  ctx: ShareContext,
  panel: SeatPanel,
  seat: number,
  key: KemPublicKey,
  halves: ShareHalvesV4,
  shares: readonly Share[],
  randomness: ShareEncapsulation,
): Uint8Array {
  checkPanel(panel, halves);
  return sealSeat(bindingV4(ctx, panel, seat, halves), key, shares, randomness);
}

/** What `encryptSharesWith` made an `EncryptedShares` from, copied so the caller can't change it. */
export interface Encryption {
  readonly sharing: VoteSharing;
  readonly definitionHash: Uint8Array;
  /** Each seat's KEM key, encoded. */
  readonly keys: readonly Uint8Array[];
  readonly hashes: readonly Uint8Array[];
  readonly randomness: readonly ShareEncapsulation[];
}

// Every encryption `encryptSharesWith` made, with private copies of what made
// it: a challenge reveals only the randomness of ciphertexts made here, for
// the sharing they encrypt (docs/spec/challenge.md, Client rules).
const ENCRYPTIONS = new WeakMap<EncryptedShares, Encryption>();

const copyRandomness = (randomness: readonly ShareEncapsulation[]) =>
  randomness.map(({ m, e, w }) => ({ m: Uint8Array.from(m), e, w }));

/** Internal: what made `encrypted`, or `undefined` if `encryptShares` didn't. */
export function encryptionOf(encrypted: EncryptedShares): Encryption | undefined {
  const made = ENCRYPTIONS.get(encrypted);
  if (made === undefined) return undefined;
  return {
    sharing: made.sharing,
    definitionHash: Uint8Array.from(made.definitionHash),
    keys: made.keys.map((k) => Uint8Array.from(k)),
    hashes: made.hashes.map((h) => Uint8Array.from(h)),
    randomness: copyRandomness(made.randomness),
  };
}

// The caller's randomness, copied before use so a caller mutating its arrays
// later changes neither the ciphertexts nor the record of what made them.
function takeRandomness(randomness: readonly ShareEncapsulation[]): ShareEncapsulation[] {
  return randomness.map(({ m, e, w }) => ({
    m: m instanceof Uint8Array ? Uint8Array.from(m) : m,
    e,
    w,
  }));
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
  const copies = takeRandomness(randomness);
  const ciphertexts = keys.map((key, i) =>
    encryptSeat(
      ctx,
      i + 1,
      key,
      sharing.vss,
      sharing.shares[i] as readonly Share[],
      copies[i] as ShareEncapsulation,
    ),
  );
  const encrypted: EncryptedShares = {
    ciphertexts,
    hashes: ciphertexts.map(shareCiphertextHash),
    randomness: copyRandomness(copies),
  };
  ENCRYPTIONS.set(encrypted, {
    sharing,
    definitionHash: Uint8Array.from(ctx.definitionHash),
    keys: keys.map((k) => encode(KEM_PUBLIC_KEY, k)),
    hashes: encrypted.hashes.map((h) => Uint8Array.from(h)),
    randomness: copies,
  });
  return encrypted;
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
  return encryptSharesWith(ctx, sharing, keys, keys.map(randomEncapsulation));
}

function randomEncapsulation(): ShareEncapsulation {
  return { m: randomBytes(MLKEM_MSG_LEN), e: nonZeroRandom(), w: nonZeroRandom() };
}

/**
 * A version-4 ballot's share ciphertexts: the default panel's, one per
 * default seat in order, and the author panel's, one per author seat (none
 * without an author panel), each with its hash for its own panel's list of
 * the committed vote and its randomness, kept and erased as `EncryptedShares`
 * says (T-18, T-45).
 */
export interface EncryptedSharesV4 extends EncryptedShares {
  readonly authorCiphertexts: readonly Uint8Array[];
  readonly authorHashes: readonly Uint8Array[];
  readonly authorRandomness: readonly ShareEncapsulation[];
}

/** What `encryptSharesV4With` made an `EncryptedSharesV4` from, copied so the caller can't change it. */
export interface EncryptionV4 {
  readonly sharing: VoteSharingV4;
  readonly definitionHash: Uint8Array;
  /** Each default seat's KEM key, encoded. */
  readonly keys: readonly Uint8Array[];
  readonly hashes: readonly Uint8Array[];
  readonly randomness: readonly ShareEncapsulation[];
  /** Each author seat's KEM key, encoded. */
  readonly authorKeys: readonly Uint8Array[];
  readonly authorHashes: readonly Uint8Array[];
  readonly authorRandomness: readonly ShareEncapsulation[];
}

// Every version-4 encryption `encryptSharesV4With` made, as ENCRYPTIONS
// holds version 1's: opening version 3 reveals only these (P2-16 part 2b-4).
const ENCRYPTIONS_V4 = new WeakMap<EncryptedSharesV4, EncryptionV4>();

/** Internal: what made `encrypted`, or `undefined` if `encryptSharesV4` didn't. */
export function encryptionOfV4(encrypted: EncryptedSharesV4): EncryptionV4 | undefined {
  const made = ENCRYPTIONS_V4.get(encrypted);
  if (made === undefined) return undefined;
  const copies = (list: readonly Uint8Array[]) => list.map((b) => Uint8Array.from(b));
  return {
    sharing: made.sharing,
    definitionHash: Uint8Array.from(made.definitionHash),
    keys: copies(made.keys),
    hashes: copies(made.hashes),
    randomness: copyRandomness(made.randomness),
    authorKeys: copies(made.authorKeys),
    authorHashes: copies(made.authorHashes),
    authorRandomness: copyRandomness(made.authorRandomness),
  };
}

/**
 * Internal: encrypts a version-4 sharing's shares with the given randomness.
 * Production code calls `encryptSharesV4`; the package entry point doesn't
 * export this.
 */
export function encryptSharesV4With(
  ctx: ShareContext,
  sharing: VoteSharingV4,
  keys: readonly KemPublicKey[],
  authorKeys: readonly KemPublicKey[],
  randomness: readonly ShareEncapsulation[],
  authorRandomness: readonly ShareEncapsulation[],
): EncryptedSharesV4 {
  checkContext(ctx);
  // Only a sharing `shareVoteV4` made: its halves add to the vote and each
  // is committed as its panel's (T-14, T-41).
  if (!isRegisteredSharingV4(sharing))
    throw new TypeError("encrypt: the sharing must come from shareVoteV4, unchanged");
  const n = sharing.shares.length;
  const nA = sharing.authorShares.length;
  if (keys.length !== n) throw new RangeError("encrypt: one trustee key per default seat");
  if (authorKeys.length !== nA) throw new RangeError("encrypt: one trustee key per author seat");
  if (randomness.length !== n) throw new RangeError("encrypt: one encapsulation per default seat");
  if (authorRandomness.length !== nA)
    throw new RangeError("encrypt: one encapsulation per author seat");
  const halves = { vss: sharing.vss, author_vss: sharing.authorVss };
  const panel = (
    p: SeatPanel,
    ks: readonly KemPublicKey[],
    shares: VoteSharingV4["shares"],
    copies: readonly ShareEncapsulation[],
  ) =>
    ks.map((key, i) =>
      encryptSeatV4(
        ctx,
        p,
        i + 1,
        key,
        halves,
        shares[i] as readonly Share[],
        copies[i] as ShareEncapsulation,
      ),
    );
  const copies = takeRandomness(randomness);
  const authorCopies = takeRandomness(authorRandomness);
  const ciphertexts = panel(1, keys, sharing.shares, copies);
  const authorCiphertexts = panel(2, authorKeys, sharing.authorShares, authorCopies);
  const encrypted: EncryptedSharesV4 = {
    ciphertexts,
    hashes: ciphertexts.map(shareCiphertextHash),
    randomness: copyRandomness(copies),
    authorCiphertexts,
    authorHashes: authorCiphertexts.map(shareCiphertextHash),
    authorRandomness: copyRandomness(authorCopies),
  };
  ENCRYPTIONS_V4.set(encrypted, {
    sharing,
    definitionHash: Uint8Array.from(ctx.definitionHash),
    keys: keys.map((k) => encode(KEM_PUBLIC_KEY, k)),
    hashes: encrypted.hashes.map((h) => Uint8Array.from(h)),
    randomness: copies,
    authorKeys: authorKeys.map((k) => encode(KEM_PUBLIC_KEY, k)),
    authorHashes: encrypted.authorHashes.map((h) => Uint8Array.from(h)),
    authorRandomness: authorCopies,
  });
  return encrypted;
}

/**
 * Encrypts a version-4 sharing's shares (docs/spec/share-encryption.md,
 * Ballot version 4): each default seat's to its key in the default panel's
 * registered key set and each author seat's to its key in the author panel's,
 * in seat order, every value from the CSPRNG. A seat's ciphertext names its
 * panel and binds both halves' commitments, so it opens only for that seat
 * of that panel next to this exact core (T-30, T-31, T-37). Shares sent to a
 * substituted key can't be taken back (T-37).
 */
export function encryptSharesV4(
  ctx: ShareContext,
  sharing: VoteSharingV4,
  keys: readonly KemPublicKey[],
  authorKeys: readonly KemPublicKey[],
): EncryptedSharesV4 {
  return encryptSharesV4With(
    ctx,
    sharing,
    keys,
    authorKeys,
    keys.map(randomEncapsulation),
    authorKeys.map(randomEncapsulation),
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

// Decryption steps 1 to 5 (docs/spec/share-encryption.md, Decryption).
function openSeat(b: SeatBinding, secretKey: KemSecretKey, ciphertext: Uint8Array): OpenResult {
  checkSecretKey(secretKey);
  let ct: ShareCiphertext;
  try {
    ct = decode(SHARE_CIPHERTEXT, ciphertext);
  } catch {
    return { ok: false, code: "share-malformed" };
  }
  const dh = G.multiply(secretKey.x);
  if (!ephemeralProofOk(b, dh, ct)) return { ok: false, code: "share-proof" };
  const { secretKey: dk } = ml_kem768.keygen(secretKey.seed);
  // FIPS 203 Decaps: implicit rejection returns a pseudorandom secret for a
  // ciphertext that fails re-encryption, so the AEAD then fails.
  const ssM = ml_kem768.decapsulate(ct.ct_mlkem, dk);
  dk.fill(0);
  const key = combine(ssM, ct.ct_dh.multiply(secretKey.x), ct.ct_dh, dh);
  ssM.fill(0);
  const opened = openWith(key, b, ct.sealed);
  key.fill(0);
  return opened;
}

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
  return openSeat(bindingV1(ctx, seat, vss), secretKey, ciphertext);
}

/**
 * `openShares` for seat `seat` of panel `panel` under ballot version 4
 * (docs/spec/share-encryption.md, Decryption and intake (ballot version 4)):
 * the associated data and the proof of knowledge name the panel and bind
 * both halves, and the shares are checked against the seat's own panel's
 * commitments. `secretKey` is the seat's key in its own panel's key set.
 */
export function openSharesV4(
  ctx: ShareContext,
  panel: SeatPanel,
  seat: number,
  secretKey: KemSecretKey,
  halves: ShareHalvesV4,
  ciphertext: Uint8Array,
): OpenResult {
  checkContext(ctx);
  checkPanel(panel, halves);
  checkSeat(seat, MAX_TRUSTEES);
  return openSeat(bindingV4(ctx, panel, seat, halves), secretKey, ciphertext);
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

type PostingCheck =
  | {
      readonly ok: true;
      readonly key: KemPublicKey;
      readonly ct: ShareCiphertext;
      readonly ssM: Uint8Array;
    }
  | { readonly ok: false; readonly code: PostingCode };

// The public check of a posting for the seat `b` binds, against `expected`,
// the ballot's share hash for that seat in its own panel's list.
function postingCheck(
  b: SeatBinding,
  key: KemPublicKey,
  expected: Uint8Array,
  posting: Posting,
): PostingCheck {
  const k = decode(KEM_PUBLIC_KEY, encode(KEM_PUBLIC_KEY, key));
  let ct: ShareCiphertext;
  if (!(posting.m instanceof Uint8Array) || posting.m.length !== MLKEM_MSG_LEN)
    return { ok: false, code: "posting-malformed" };
  try {
    ct = decode(SHARE_CIPHERTEXT, posting.ciphertext);
  } catch {
    return { ok: false, code: "posting-malformed" };
  }
  if (!bytesEqual(shareCiphertextHash(posting.ciphertext), expected))
    return { ok: false, code: "posting-hash" };
  if (!ephemeralProofOk(b, k.dh, ct)) return { ok: false, code: "posting-proof" };
  // FIPS 203 Encaps_internal, used only to verify: m determines the ML-KEM
  // ciphertext, so only the client that made it can supply a passing m.
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(k.ek, posting.m);
  if (!bytesEqual(cipherText, ct.ct_mlkem)) return { ok: false, code: "posting-encapsulation" };
  return { ok: true, key: k, ct, ssM: sharedSecret };
}

// A version-1 seat: its binding and its share hash.
function seatV1(
  ctx: ShareContext,
  seat: number,
  vss: CommittedVote["vss"],
  shareHashes: CommittedVote["share_hashes"],
) {
  checkContext(ctx);
  checkSeat(seat, shareHashes.length);
  return { b: bindingV1(ctx, seat, vss), expected: shareHashes[seat - 1] as Uint8Array };
}

// A version-4 seat of either panel: its binding and its share hash, from its
// own panel's list, never the other's (T-37).
function seatV4(ctx: ShareContext, panel: SeatPanel, seat: number, vote: VoteHalvesV4) {
  checkContext(ctx);
  checkPanel(panel, vote);
  const hashes = panel === 2 ? vote.author_share_hashes : vote.share_hashes;
  checkSeat(seat, hashes.length);
  return { b: bindingV4(ctx, panel, seat, vote), expected: hashes[seat - 1] as Uint8Array };
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
  const { b, expected } = seatV1(ctx, seat, vss, shareHashes);
  const r = postingCheck(b, key, expected, posting);
  return r.ok ? { ok: true } : r;
}

/**
 * `checkPosting` for seat `seat` of panel `panel` under ballot version 4
 * (docs/spec/share-encryption.md, Public posting (ballot version 4)): the
 * hash against its own panel's list, the proof of knowledge under version
 * 4's `t_e`, and `key`, the seat's key in its own panel's registered key set.
 */
export function checkPostingV4(
  ctx: ShareContext,
  panel: SeatPanel,
  seat: number,
  key: KemPublicKey,
  vote: VoteHalvesV4,
  posting: Posting,
): PostingResult {
  const { b, expected } = seatV4(ctx, panel, seat, vote);
  const r = postingCheck(b, key, expected, posting);
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
  b: SeatBinding,
  key: Element,
  shareHash: Uint8Array,
  ctDh: Element,
  d: Element,
  a1: Element,
  a2: Element,
): bigint {
  const w = new Writer();
  w.bytes(b.complaintHead);
  element.write(w, key);
  w.bytes(shareHash);
  element.write(w, ctDh);
  element.write(w, d);
  elementOrIdentity.write(w, a1);
  elementOrIdentity.write(w, a2);
  return challenge(b.complaintTag, w.finish());
}

function proveComplaintFor(
  b: SeatBinding,
  expected: Uint8Array,
  keyPair: KemKeyPair,
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
  const p = postingCheck(b, keyPair.publicKey, expected, posting);
  if (!p.ok) throw new RangeError(`complaint: the posting fails (${p.code})`);
  const intake = openSeat(b, keyPair.secretKey, posting.ciphertext);
  if (intake.ok || (intake.code !== "share-decrypt" && intake.code !== "share-check"))
    throw new RangeError("complaint: the posted shares don't fail decryption or the share check");
  const ct = p.ct;
  const d = ct.ct_dh.multiply(x);
  const c = complaintChallenge(
    b,
    keyPair.publicKey.dh,
    expected,
    ct.ct_dh,
    d,
    G.multiply(w),
    ct.ct_dh.multiply(w),
  );
  return { dh: d, c, z: (w + c * x) % GROUP_ORDER };
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
  const { b, expected } = seatV1(ctx, seat, vss, shareHashes);
  return proveComplaintFor(b, expected, keyPair, posting, w);
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

/**
 * Internal: proves a version-4 complaint with the given nonce. Production
 * code calls `proveComplaintV4`; the package entry point doesn't export this.
 */
export function proveComplaintV4With(
  ctx: ShareContext,
  panel: SeatPanel,
  seat: number,
  keyPair: KemKeyPair,
  vote: VoteHalvesV4,
  posting: Posting,
  w: bigint,
): ComplaintProof {
  const { b, expected } = seatV4(ctx, panel, seat, vote);
  return proveComplaintFor(b, expected, keyPair, posting, w);
}

/**
 * `proveComplaint` for seat `seat` of panel `panel` under ballot version 4
 * (docs/spec/share-encryption.md, Complaints (ballot version 4)): the proof's
 * challenge names the panel under its own tag, so a complaint for one
 * panel's seat is never one for the other's (T-29). `keyPair` is the seat's
 * key in its own panel's key set.
 */
export function proveComplaintV4(
  ctx: ShareContext,
  panel: SeatPanel,
  seat: number,
  keyPair: KemKeyPair,
  vote: VoteHalvesV4,
  posting: Posting,
): ComplaintProof {
  return proveComplaintV4With(ctx, panel, seat, keyPair, vote, posting, nonZeroRandom());
}

export type ComplaintCode = PostingCode | "complaint-proof" | "complaint-unfounded";

/** `ok: true` means the complaint is proven and the ballot is excluded. */
export type ComplaintResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ComplaintCode };

function checkComplaintFor(
  b: SeatBinding,
  expected: Uint8Array,
  key: KemPublicKey,
  posting: Posting,
  complaint: ComplaintProof,
): ComplaintResult {
  const p = postingCheck(b, key, expected, posting);
  if (!p.ok) return p;
  const { dh: d, c, z } = decode(COMPLAINT_PROOF, encode(COMPLAINT_PROOF, complaint));
  const ctDh = p.ct.ct_dh;
  const dh = p.key.dh;
  const a1 = mul(G, z).subtract(mul(dh, c));
  const a2 = mul(ctDh, z).subtract(mul(d, c));
  if (complaintChallenge(b, dh, expected, ctDh, d, a1, a2) !== c)
    return { ok: false, code: "complaint-proof" };
  if (openWith(combine(p.ssM, d, ctDh, dh), b, p.ct.sealed).ok)
    return { ok: false, code: "complaint-unfounded" };
  return { ok: true };
}

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
  const { b, expected } = seatV1(ctx, seat, vss, shareHashes);
  return checkComplaintFor(b, expected, key, posting, complaint);
}

/**
 * `checkComplaint` for seat `seat` of panel `panel` under ballot version 4
 * (docs/spec/share-encryption.md, Complaints (ballot version 4)): the posting
 * checked as `checkPostingV4` does, the proof under version 4's challenge
 * with the panel, and `complaint-unfounded` decrypting with version 4's
 * associated data against the seat's own panel's commitments.
 */
export function checkComplaintV4(
  ctx: ShareContext,
  panel: SeatPanel,
  seat: number,
  key: KemPublicKey,
  vote: VoteHalvesV4,
  posting: Posting,
  complaint: ComplaintProof,
): ComplaintResult {
  const { b, expected } = seatV4(ctx, panel, seat, vote);
  return checkComplaintFor(b, expected, key, posting, complaint);
}
