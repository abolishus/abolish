// The Tier 2 keyed nullifier's key (docs/spec/nullifier-key.md; ADR 0022,
// option A; record types 0x0011 and 0x0012): each seat registers a KEM key and
// a signing key, deals a Pedersen VSS sharing in Baby Jubjub with its shares
// sealed under the hybrid KEM, complains about a dealt share that fails, and
// answers complaints with the share itself (GJKR's first phase, no public
// key). The transcript check recomputes the qualified seats, their share
// commitments and `key_id` from the transcript alone (T-40, T-15, T-14, T-37).
// ML-KEM, ECDSA, the AEAD and both groups are @noble's; this module only
// composes them.

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { p256 } from "@noble/curves/nist.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import {
  bytesFixed,
  type CodecValue,
  DecodeError,
  type DecodeErrorCode,
  decode,
  encode,
  list,
  struct,
  u16,
  u64,
  u8,
  Writer,
} from "./codec.ts";
import { ds, type SpecifiedTagOf } from "./domain-separation.ts";
import { type Element, element, G, GROUP_ORDER, H } from "./group.ts";
import {
  BJJ_G,
  BJJ_ORDER,
  type BjjPoint,
  bjjPoint,
  bjjScalar,
  GENERATOR_J,
  type NullifierKey,
  type SeatShare,
} from "./keyed-nullifier.ts";
import { nullifierKeyApprovalStatement, STATEMENT_TAGS } from "./nullifier-key-statements.ts";
import { PARAMETERS } from "./parameters.ts";
import { RECORD_TYPES, RecordSchema, recordType } from "./record.ts";
import {
  AEAD_TAG_LEN,
  KEM_PUBLIC_KEY,
  KEM_SECRET_KEY,
  type KemKeyPair,
  kemKeygen,
  type KemPublicKey,
  type KemSecretKey,
  MLKEM_CT_LEN,
  MLKEM_MSG_LEN,
  nonZeroRandom,
} from "./share-encryption.ts";
import {
  identityKey,
  type Panel,
  panelId,
  type SignatureTag,
  p256Key,
  p256Sig,
  signStatement,
  verifyStatement,
} from "./trustee.ts";

const { MAX_TRUSTEES, RECORD_MARGIN } = PARAMETERS;

const MESSAGE_TAG = "abolish/v1/sig/nullifier-key-message";
const SIGNING_KEY_TAG = "abolish/v1/sig/nullifier-key-signing-key";

/**
 * The longest a version-2 run's deadline may lie ahead, in L2 blocks: 7 days
 * of 2-second blocks, as for a reshare. Without a bound a coordinator could
 * set a deadline that never passes, and a stalled run would hold its
 * approving seats for good (docs/spec/nullifier-key.md, Key context).
 */
export const MAX_KEY_WINDOW = 302_400n;

/**
 * @internal Throws unless `deadline` is still ahead of `currentL2Block` and at
 * most `window` blocks ahead: an honest seat takes part in, and approves,
 * only such a run. Resharing's runs too.
 */
export function checkRunDeadline(
  deadline: bigint,
  currentL2Block: bigint | undefined,
  window: bigint,
  name: string,
): void {
  if (typeof deadline !== "bigint" || typeof currentL2Block !== "bigint")
    throw new TypeError(`${name}: the deadline and the L2 block must be bigints`);
  if (deadline <= currentL2Block) throw new RangeError(`${name}: the run's deadline has passed`);
  if (deadline - currentL2Block > window)
    throw new RangeError(`${name}: the run's deadline is too far ahead`);
}

/** @internal Round 1's layout, which resharing's round 1 shares. */
export const ROUND_1 = struct([
  ["index", u8],
  ["kem_key", KEM_PUBLIC_KEY],
  ["signing_key", p256Key],
  ["signing_pop", p256Sig],
  ["signature", p256Sig],
] as const);

const ROUND_2 = struct([
  ["index", u8],
  ["commitments", list(bjjPoint, MAX_TRUSTEES)],
  ["share_hashes", list(bytesFixed(32), MAX_TRUSTEES - 1)],
  ["signature", p256Sig],
] as const);

const ROUND_3 = struct([
  ["index", u8],
  ["complaints", list(u8, MAX_TRUSTEES - 1)],
  ["signature", p256Sig],
] as const);

/** @internal A reveal's layout, which resharing's round 4 shares. */
export const REVEALED_SHARE = struct([
  ["complainer", u8],
  ["share", bjjScalar],
  ["blind", bjjScalar],
] as const);

const ROUND_4 = struct([
  ["index", u8],
  ["reveals", list(REVEALED_SHARE, MAX_TRUSTEES - 1)],
  ["signature", p256Sig],
] as const);

const KEYS = list(ROUND_1, MAX_TRUSTEES);
const DEALINGS = list(ROUND_2, MAX_TRUSTEES);
const COMPLAINTS = list(ROUND_3, MAX_TRUSTEES);
const RESPONSES = list(ROUND_4, MAX_TRUSTEES);

const transcriptV1 = struct([
  ["run_id", bytesFixed(32)],
  ["keys", KEYS],
  ["dealings", DEALINGS],
  ["complaints", COMPLAINTS],
  ["responses", RESPONSES],
] as const);

const transcriptV2 = struct([
  ["run_id", bytesFixed(32)],
  ["deadline", u64],
  ["keys", KEYS],
  ["dealings", DEALINGS],
  ["complaints", COMPLAINTS],
  ["responses", RESPONSES],
] as const);

export type RegistrationKeysMessage = CodecValue<typeof ROUND_1>;
export type DealingMessage = CodecValue<typeof ROUND_2>;
export type ComplaintsMessage = CodecValue<typeof ROUND_3>;
export type RevealedShare = CodecValue<typeof REVEALED_SHARE>;
export type ResponsesMessage = CodecValue<typeof ROUND_4>;

/**
 * Key transcript, version 1 (docs/spec/nullifier-key.md, Transcript): retired
 * before any registry is deployed, kept for its frozen vectors. Its key never
 * counts, since its runs have no deadline (Approval).
 */
export type NullifierKeyTranscript = CodecValue<typeof transcriptV1>;

/** Key transcript, version 2: version 1 with the run's deadline. */
export type NullifierKeyTranscriptV2 = CodecValue<typeof transcriptV2>;

/** Record type `0x0011`: the Tier 2 key's public transcript. */
export const NULLIFIER_KEY_TRANSCRIPT = recordType(RECORD_TYPES.nullifierKeyTranscript, {
  1: transcriptV1,
  2: transcriptV2,
});

/** `bjj-scalar(f_d(i)) ‖ bjj-scalar(f'_d(i))` and the AEAD tag. */
const SEALED_LEN = 64 + AEAD_TAG_LEN;

const dealtShareV1 = struct([
  ["key_context", bytesFixed(32)],
  ["dealer", u8],
  ["recipient", u8],
  ["ct_mlkem", bytesFixed(MLKEM_CT_LEN)],
  ["ct_dh", element],
  ["sealed", bytesFixed(SEALED_LEN)],
] as const);

/** Dealt share, version 1 (docs/spec/nullifier-key.md, Dealt share). */
export type DealtShare = CodecValue<typeof dealtShareV1>;

/**
 * Record type `0x0012`: one seat's share, sealed by its dealer. Private, and
 * never pinned by a profile: versions 1 and 2 of the transcript fix version 1.
 */
export const NULLIFIER_KEY_SHARE = recordType(RECORD_TYPES.nullifierKeyShare, { 1: dealtShareV1 });

const SCHEMA = new RecordSchema([NULLIFIER_KEY_TRANSCRIPT, NULLIFIER_KEY_SHARE]);

export function encodeNullifierKeyTranscript(transcript: NullifierKeyTranscript): Uint8Array {
  return SCHEMA.encode(NULLIFIER_KEY_TRANSCRIPT, 1, transcript);
}

/** Strictly decodes a key transcript under version 1. */
export function decodeNullifierKeyTranscript(bytes: Uint8Array, pinned: 1): NullifierKeyTranscript {
  const r = SCHEMA.decode(NULLIFIER_KEY_TRANSCRIPT, bytes, pinned);
  if (r.version !== 1) throw new RangeError("nullifier key: expected version 1");
  return r.value;
}

export function encodeNullifierKeyTranscriptV2(transcript: NullifierKeyTranscriptV2): Uint8Array {
  return SCHEMA.encode(NULLIFIER_KEY_TRANSCRIPT, 2, transcript);
}

/** Strictly decodes a key transcript under version 2. */
export function decodeNullifierKeyTranscriptV2(
  bytes: Uint8Array,
  pinned: 2,
): NullifierKeyTranscriptV2 {
  const r = SCHEMA.decode(NULLIFIER_KEY_TRANSCRIPT, bytes, pinned);
  if (r.version !== 2) throw new RangeError("nullifier key: expected version 2");
  return r.value;
}

export function encodeDealtShare(share: DealtShare): Uint8Array {
  return SCHEMA.encode(NULLIFIER_KEY_SHARE, 1, share);
}

/** Strictly decodes a dealt share under version 1, the version transcript 1 fixes. */
export function decodeDealtShare(bytes: Uint8Array, pinned: 1): DealtShare {
  return SCHEMA.decode(NULLIFIER_KEY_SHARE, bytes, pinned).value;
}

/** `key_id = H(DS("abolish/v1/keyed-nullifier/key", encode(transcript)))`, over the full record. */
export function nullifierKeyId(encoded: Uint8Array): Uint8Array {
  return H(ds("abolish/v1/keyed-nullifier/key", encoded));
}

/** `share_hash`: the dealt-share message's hash, over its full record encoding. */
export function dealtShareHash(encoded: Uint8Array): Uint8Array {
  return H(ds("abolish/v1/keyed-nullifier/key-share", encoded));
}

/** The Tier 2 scope and panel a run is for; every field comes from the release's pins. */
export interface NullifierKeyScope {
  readonly l2ChainId: bigint;
  readonly groupRegistry: Uint8Array;
  readonly panel: Panel;
}

/**
 * A scope and one run: its identifier and, for a version-2 run, its deadline,
 * the L2 block by which the key's approvals must be recorded to count.
 * `null` asks for a version-1 run, retired and kept for its frozen vectors:
 * its key never counts. Required, so no caller gets version 1 by omission.
 */
export interface NullifierKeyParams extends NullifierKeyScope {
  readonly runId: Uint8Array;
  readonly deadline: bigint | null;
}

const CONTEXT = struct([
  ["l2_chain_id", u64],
  ["group_registry", bytesFixed(20)],
  ["panel_id", bytesFixed(32)],
  ["run_id", bytesFixed(32)],
] as const);

interface Scope {
  readonly l2ChainId: bigint;
  readonly groupRegistry: Uint8Array;
  readonly panelId: Uint8Array;
  readonly threshold: number;
  readonly keys: readonly Uint8Array[];
}

interface Run extends Scope {
  readonly context: Uint8Array;
  readonly deadline: bigint | null;
}

// Each field read once, and the panel's identifier computed here, never taken
// from data (T-37).
function scopeOf(params: NullifierKeyScope): Scope {
  if (params === null || typeof params !== "object")
    throw new TypeError("nullifier key: expected parameters");
  const { l2ChainId, groupRegistry, panel } = params;
  if (panel === null || typeof panel !== "object")
    throw new TypeError("nullifier key: expected a panel");
  const keys = Array.isArray(panel.keys) ? panel.keys.map((k) => Uint8Array.from(k)) : [];
  const threshold = panel.threshold;
  const id = panelId({ threshold, keys });
  if (!(groupRegistry instanceof Uint8Array) || groupRegistry.length !== 20)
    throw new RangeError("nullifier key: groupRegistry must be 20 bytes");
  return {
    l2ChainId,
    groupRegistry: Uint8Array.from(groupRegistry),
    panelId: id,
    threshold,
    keys,
  };
}

const CONTEXT_V2 = struct([
  ["l2_chain_id", u64],
  ["group_registry", bytesFixed(20)],
  ["panel_id", bytesFixed(32)],
  ["run_id", bytesFixed(32)],
  ["deadline", u64],
] as const);

// Version 2's context has its own tag, so no message of a version-1 run
// checks in a version-2 run, or the reverse (docs/spec/domain-separation.md).
function runOf(params: NullifierKeyParams): Run {
  const scope = scopeOf(params);
  const { runId, deadline } = params;
  const fields = {
    l2_chain_id: scope.l2ChainId,
    group_registry: scope.groupRegistry,
    panel_id: scope.panelId,
    run_id: runId,
  };
  if (deadline === null) {
    const context = H(ds("abolish/v1/keyed-nullifier/key-context", encode(CONTEXT, fields)));
    return { ...scope, context, deadline: null };
  }
  const context = H(
    ds("abolish/v1/keyed-nullifier/key-context-2", encode(CONTEXT_V2, { ...fields, deadline })),
  );
  return { ...scope, context, deadline };
}

/** `key_context` (docs/spec/nullifier-key.md, Key context): version 2's with a deadline, version 1's without. */
export function nullifierKeyContext(params: NullifierKeyParams): Uint8Array {
  return runOf(params).context;
}

type Rounds = Pick<NullifierKeyTranscript, "keys" | "dealings" | "complaints" | "responses">;

/** `h_r = H(DS("abolish/v1/keyed-nullifier/key-round", h_{r−1} ‖ u8(r) ‖ encode(R_r)))`. */
function roundHash(prev: Uint8Array, round: number, encodedRound: Uint8Array): Uint8Array {
  const w = new Writer();
  w.bytes(prev);
  u8.write(w, round);
  w.bytes(encodedRound);
  return H(ds("abolish/v1/keyed-nullifier/key-round", w.finish()));
}

/** The chain `h_0 … h_3` over the rounds given so far. */
function chain(context: Uint8Array, t: Partial<Rounds>): Uint8Array[] {
  const h = [context];
  if (t.keys === undefined) return h;
  h.push(roundHash(h[0] as Uint8Array, 1, encode(KEYS, t.keys)));
  if (t.dealings === undefined) return h;
  h.push(roundHash(h[1] as Uint8Array, 2, encode(DEALINGS, t.dealings)));
  if (t.complaints === undefined) return h;
  h.push(roundHash(h[2] as Uint8Array, 3, encode(COMPLAINTS, t.complaints)));
  return h;
}

const ROUND_CODECS = [ROUND_1, ROUND_2, ROUND_3, ROUND_4] as const;

// The message's encoding without its 64-byte signature is `u8(i) ‖ body`,
// which follows `u8(r) ‖ h_{r−1}` in what the seat signs.
function signedMessage(round: number, prev: Uint8Array, encoded: Uint8Array): Uint8Array {
  const w = new Writer();
  u8.write(w, round);
  w.bytes(prev);
  w.bytes(encoded.subarray(0, encoded.length - 64));
  return w.finish();
}

/**
 * @internal Whether `msg`, a round-`round` message in `codec`, carries `key`'s
 * signature under `tag` over `u8(round) ‖ prev ‖ u8(i) ‖ body`.
 */
export function roundMessageOk(
  codec: unknown,
  tag: SignatureTag,
  key: Uint8Array | undefined,
  round: number,
  prev: Uint8Array,
  msg: { index: number; signature: Uint8Array },
): boolean {
  if (key === undefined) return false;
  const encoded = encode(codec as never, msg as never);
  return verifyStatement(key, tag, signedMessage(round, prev, encoded), msg.signature);
}

function messageOk(
  run: Run,
  round: number,
  prev: Uint8Array,
  msg: { index: number; signature: Uint8Array },
): boolean {
  const codec = ROUND_CODECS[round - 1] as (typeof ROUND_CODECS)[number];
  return roundMessageOk(codec, MESSAGE_TAG, run.keys[msg.index - 1], round, prev, msg);
}

// r = s = 1: a canonical encoding no real signature takes the place of.
const PLACEHOLDER_SIG = (() => {
  const b = new Uint8Array(64);
  b[31] = 1;
  b[63] = 1;
  return b;
})();

function sign<T extends { signature: Uint8Array }>(
  identitySecret: Uint8Array,
  round: number,
  prev: Uint8Array,
  unsigned: Omit<T, "signature">,
): T {
  const codec = ROUND_CODECS[round - 1] as (typeof ROUND_CODECS)[number];
  return signRoundMessage<T>(codec, MESSAGE_TAG, identitySecret, round, prev, unsigned);
}

/** @internal A round-`round` message in `codec`, signed under `tag` over `u8(round) ‖ prev ‖ u8(i) ‖ body`. */
export function signRoundMessage<T extends { signature: Uint8Array }>(
  codec: unknown,
  tag: SignatureTag,
  identitySecret: Uint8Array,
  round: number,
  prev: Uint8Array,
  unsigned: Omit<T, "signature">,
): T {
  // Encoded with a placeholder signature: the body is everything before it.
  const placeholder = { ...unsigned, signature: PLACEHOLDER_SIG } as unknown as T;
  const encoded = encode(codec as never, placeholder as never);
  const signature = signStatement(identitySecret, tag, signedMessage(round, prev, encoded));
  const signed = { ...unsigned, signature } as unknown as T;
  // Round-tripped, so only an encodable message with its own copies leaves here.
  return decode(codec as never, encode(codec as never, signed as never)) as T;
}

/** @internal `context ‖ u8(i) ‖ encode(kem_key) ‖ signing_key`, what a signing key's proof signs. */
export function signingPopMessage(
  context: Uint8Array,
  index: number,
  kemKey: KemPublicKey,
  signingKey: Uint8Array,
): Uint8Array {
  const w = new Writer();
  w.bytes(context);
  u8.write(w, index);
  KEM_PUBLIC_KEY.write(w, kemKey);
  p256Key.write(w, signingKey);
  return w.finish();
}

function possessionOk(context: Uint8Array, m: RegistrationKeysMessage): boolean {
  return verifyStatement(
    m.signing_key,
    SIGNING_KEY_TAG,
    signingPopMessage(context, m.index, m.kem_key, m.signing_key),
    m.signing_pop,
  );
}

/** A seat's secrets for one run: its identity key and the registration keys it registers. */
export interface RegistrationSecrets {
  readonly index: number;
  readonly identitySecret: Uint8Array;
  /** The registration KEM key: dealt shares now, clients' queries later (part 2b-4). */
  readonly kem: KemKeyPair;
  /** The registration P-256 signing key, 32 bytes big-endian: it signs answers. */
  readonly signingSecret: Uint8Array;
}

/** Fresh registration keys for a seat, every secret from the CSPRNG. */
export function registrationKeygen(index: number, identitySecret: Uint8Array): RegistrationSecrets {
  return { index, identitySecret, kem: kemKeygen(), signingSecret: p256.utils.randomSecretKey() };
}

/** @internal Throws unless `seat`'s identity secret is the pinned key of its seat. */
export function seatKey(
  run: { readonly keys: readonly Uint8Array[] },
  seat: { readonly index: number; readonly identitySecret: Uint8Array },
): void {
  const key = Number.isSafeInteger(seat.index) ? run.keys[seat.index - 1] : undefined;
  if (key === undefined || seat.index < 1)
    throw new RangeError("nullifier key: index must be a seat of the panel");
  // A key outside its seat would sign messages no checker attributes to it.
  if (!equalBytes(identityKey(seat.identitySecret), key))
    throw new RangeError("nullifier key: identitySecret is not the key of seat index");
}

/**
 * The seat's round-1 message must carry the keys it holds: a node that
 * regenerated them after signing round 1 would fail to open every honest
 * dealer's share, and its complaints would make honest dealers publish its
 * shares, `k` points of their polynomials with the corrupt seats' `k − 1`
 * (docs/spec/nullifier-key.md, Round 1). @internal: resharing's round 1 too.
 */
export function ownKeys(
  keys: readonly RegistrationKeysMessage[],
  index: number,
  kem: KemPublicKey,
  signingKey?: Uint8Array,
): void {
  const own = keys.find((m) => m.index === index);
  if (own === undefined) throw new RangeError("nullifier key: the seat has no round-1 message");
  if (
    !equalBytes(encode(KEM_PUBLIC_KEY, own.kem_key), encode(KEM_PUBLIC_KEY, kem)) ||
    (signingKey !== undefined && !equalBytes(own.signing_key, signingKey))
  )
    throw new RangeError("nullifier key: the seat's round-1 message doesn't carry its keys");
}

/**
 * Round 1: the seat's registration KEM key and signing key, with the signing
 * key's signature. In a version-2 run `currentL2Block` is the latest L2 block
 * the seat's node has seen: it takes part only in a run whose deadline is
 * ahead of it by at most `MAX_KEY_WINDOW`.
 */
export function registrationKeysMessage(
  params: NullifierKeyParams,
  seat: RegistrationSecrets,
  currentL2Block?: bigint,
): RegistrationKeysMessage {
  const run = runOf(params);
  seatKey(run, seat);
  if (run.deadline !== null)
    checkRunDeadline(run.deadline, currentL2Block, MAX_KEY_WINDOW, "nullifier key");
  const kemKey = seat.kem.publicKey;
  const signingKey = identityKey(seat.signingSecret);
  const pop = signStatement(
    seat.signingSecret,
    SIGNING_KEY_TAG,
    signingPopMessage(run.context, seat.index, kemKey, signingKey),
  );
  return sign<RegistrationKeysMessage>(seat.identitySecret, 1, run.context, {
    index: seat.index,
    kem_key: kemKey,
    signing_key: signingKey,
    signing_pop: pop,
  });
}

/** @internal */
export const modL = (a: bigint) => ((a % BJJ_ORDER) + BJJ_ORDER) % BJJ_ORDER;

/** @internal `f(z) mod l` by Horner's rule; `coefficients[j]` is the coefficient of `z^j`. */
export function evaluatePolynomial(coefficients: readonly bigint[], z: number): bigint {
  let v = 0n;
  for (let j = coefficients.length - 1; j >= 0; j--)
    v = modL(v * BigInt(z) + (coefficients[j] as bigint));
  return v;
}

/** @internal `Σ_j (i^j mod l) · A_j`: a dealer's commitment to its share for seat `i`. Public values only. */
export function commitmentAt(commitments: readonly BjjPoint[], i: number): BjjPoint {
  let c = BJJ_G.subtract(BJJ_G);
  let power = 1n;
  for (const a of commitments) {
    c = c.add(a.multiplyUnsafe(power));
    power = modL(power * BigInt(i));
  }
  return c;
}

// @noble rejects a multiplier of 0, which a share legitimately can be.
function bjjMul(p: BjjPoint, s: bigint): BjjPoint {
  return s === 0n ? p.subtract(p) : p.multiply(s);
}

/** @internal `σ · G + σ' · J`, constant time in the secrets. */
export function opening(share: bigint, blind: bigint): BjjPoint {
  return bjjMul(BJJ_G, share).add(bjjMul(GENERATOR_J, blind));
}

/** A dealer's two polynomials of degree `k − 1`: `f` (the key's) and `f'` (the blinding). */
export interface Polynomials {
  readonly f: readonly bigint[];
  readonly g: readonly bigint[];
}

/** The ML-KEM message and DH ephemeral that seal one dealt share. */
export interface ShareRandomness {
  readonly mu: Uint8Array;
  readonly e: bigint;
}

/**
 * A round-2 message, the dealt-share messages it carries the hashes of (one
 * per other seat of round 1, in order), and the polynomials the dealer keeps
 * until round 4 closes.
 */
export interface Dealing {
  readonly message: DealingMessage;
  readonly shares: readonly { readonly recipient: number; readonly bytes: Uint8Array }[];
  readonly polynomials: Polynomials;
}

/**
 * @internal The record type and tags of one sealed-share message: the dealt
 * share here, the reshared share in resharing. Each has its own, so a message
 * of one never opens as the other.
 */
export interface ShareChannel {
  readonly recordType: number;
  readonly kemTag: SpecifiedTagOf<"kdf-aead">;
  readonly aadTag: SpecifiedTagOf<"kdf-aead">;
}

const DEALT_SHARE_CHANNEL: ShareChannel = {
  recordType: RECORD_TYPES.nullifierKeyShare,
  kemTag: "abolish/v1/kem/nullifier-key-share",
  aadTag: "abolish/v1/kem/nullifier-key-share-aad",
};

/** `K`: share-encryption's X-Wing-style combiner, under the message's own tag. */
function combine(
  channel: ShareChannel,
  ssM: Uint8Array,
  ssDh: Element,
  ctDh: Element,
  dh: Element,
): Uint8Array {
  const w = new Writer();
  w.bytes(ssM);
  element.write(w, ssDh);
  element.write(w, ctDh);
  element.write(w, dh);
  return H(ds(channel.kemTag, w.finish()));
}

const COMMITMENTS = list(bjjPoint, MAX_TRUSTEES);

function associatedData(
  channel: ShareChannel,
  context: Uint8Array,
  dealer: number,
  recipient: number,
  commitments: readonly BjjPoint[],
): Uint8Array {
  const w = new Writer();
  u16.write(w, channel.recordType);
  u8.write(w, 1);
  w.bytes(context);
  u8.write(w, dealer);
  u8.write(w, recipient);
  COMMITMENTS.write(w, commitments);
  return ds(channel.aadTag, w.finish());
}

// Each AEAD key seals exactly one message: it hashes a fresh 32-byte ML-KEM
// message and a fresh ephemeral, so a fixed nonce never repeats under a key.
const NONCE = new Uint8Array(12);

/** @internal The sealed fields of a share message: `ct_mlkem`, `ct_dh` and `sealed`. */
export function sealShareWith(
  channel: ShareChannel,
  context: Uint8Array,
  dealer: number,
  recipient: RegistrationKeysMessage,
  commitments: readonly BjjPoint[],
  share: bigint,
  blind: bigint,
  randomness: ShareRandomness,
): { readonly ct_mlkem: Uint8Array; readonly ct_dh: Element; readonly sealed: Uint8Array } {
  const { mu, e } = randomness;
  if (!(mu instanceof Uint8Array) || mu.length !== MLKEM_MSG_LEN)
    throw new RangeError("nullifier key: mu must be 32 bytes");
  if (typeof e !== "bigint" || e <= 0n || e >= GROUP_ORDER)
    throw new RangeError("nullifier key: e must be a scalar from 1 to ℓ − 1");
  // Round-trips the key through its codec: the modulus check and a
  // non-identity DH key, whatever the caller passed (T-39).
  const key = decode(KEM_PUBLIC_KEY, encode(KEM_PUBLIC_KEY, recipient.kem_key));
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(key.ek, mu);
  const ctDh = G.multiply(e);
  const k = combine(channel, sharedSecret, key.dh.multiply(e), ctDh, key.dh);
  sharedSecret.fill(0);
  const w = new Writer();
  bjjScalar.write(w, share);
  bjjScalar.write(w, blind);
  const plain = w.finish();
  const sealed = chacha20poly1305(
    k,
    NONCE,
    associatedData(channel, context, dealer, recipient.index, commitments),
  ).encrypt(plain);
  k.fill(0);
  plain.fill(0);
  return { ct_mlkem: cipherText, ct_dh: ctDh, sealed };
}

function sealShare(
  context: Uint8Array,
  dealer: number,
  recipient: RegistrationKeysMessage,
  commitments: readonly BjjPoint[],
  share: bigint,
  blind: bigint,
  randomness: ShareRandomness,
): Uint8Array {
  return encodeDealtShare({
    key_context: Uint8Array.from(context),
    dealer,
    recipient: recipient.index,
    ...sealShareWith(
      DEALT_SHARE_CHANNEL,
      context,
      dealer,
      recipient,
      commitments,
      share,
      blind,
      randomness,
    ),
  });
}

/** @internal Throws unless both polynomials have `k` coefficients below `l`. */
export function checkPolynomials(p: Polynomials, k: number): void {
  for (const c of [p.f, p.g])
    if (
      !Array.isArray(c) ||
      c.length !== k ||
      c.some((x) => typeof x !== "bigint" || x < 0n || x >= BJJ_ORDER)
    )
      throw new RangeError("nullifier key: each polynomial needs k coefficients below l");
}

/**
 * Internal: seat `seat.index`'s round-2 message from the given polynomials
 * and sealing randomness, one per other seat of round 1 in order. Production
 * code calls `dealingMessage`; the package entry point doesn't export this.
 */
export function dealingMessageWith(
  params: NullifierKeyParams,
  seat: RegistrationSecrets,
  keys: readonly RegistrationKeysMessage[],
  polynomials: Polynomials,
  randomness: readonly ShareRandomness[],
): Dealing {
  const run = runOf(params);
  seatKey(run, seat);
  const h = checkedPrefix(run, { keys });
  ownKeys(keys, seat.index, seat.kem.publicKey, identityKey(seat.signingSecret));
  checkPolynomials(polynomials, run.threshold);
  const f = [...polynomials.f];
  const g = [...polynomials.g];
  // Constant-time multiplication: the coefficients are the dealer's secrets.
  const commitments = f.map((a, j) => opening(a, g[j] as bigint));
  if (commitments.some((c) => c.is0()))
    throw new RangeError("nullifier key: a coefficient commitment is the identity; redraw");
  const targets = keys.filter((m) => m.index !== seat.index);
  if (randomness.length !== targets.length)
    throw new RangeError("nullifier key: one sealing randomness per other seat");
  const shares = targets.map((t, at) => ({
    recipient: t.index,
    bytes: sealShare(
      run.context,
      seat.index,
      t,
      commitments,
      evaluatePolynomial(f, t.index),
      evaluatePolynomial(g, t.index),
      randomness[at] as ShareRandomness,
    ),
  }));
  const message = sign<DealingMessage>(seat.identitySecret, 2, h[1] as Uint8Array, {
    index: seat.index,
    commitments,
    share_hashes: shares.map((s) => dealtShareHash(s.bytes)),
  });
  return { message, shares, polynomials: { f, g } };
}

/** @internal A scalar uniform on 0 to `l − 1` from the CSPRNG: 64 bytes reduced, within 2⁻²⁶⁰ of uniform. */
export function randomBjjScalar(): bigint {
  let v = 0n;
  for (const x of randomBytes(64)) v = (v << 8n) | BigInt(x);
  return v % BJJ_ORDER;
}

/**
 * Round 2: a fresh sharing (docs/spec/nullifier-key.md, Round 2), every
 * coefficient, `μ` and `e` from the CSPRNG, redrawing a coefficient pair
 * whose commitment is the identity.
 */
export function dealingMessage(
  params: NullifierKeyParams,
  seat: RegistrationSecrets,
  keys: readonly RegistrationKeysMessage[],
): Dealing {
  const k = scopeOf(params).threshold;
  const f: bigint[] = [];
  const g: bigint[] = [];
  while (f.length < k) {
    const a = randomBjjScalar();
    const b = randomBjjScalar();
    if (opening(a, b).is0()) continue;
    f.push(a);
    g.push(b);
  }
  const others = keys.filter((m) => m.index !== seat.index).length;
  return dealingMessageWith(
    params,
    seat,
    keys,
    { f, g },
    Array.from({ length: others }, () => ({ mu: randomBytes(MLKEM_MSG_LEN), e: nonZeroRandom() })),
  );
}

export type DealtShareCode =
  | "share-malformed"
  | "share-context"
  | "share-hash"
  | "share-decrypt"
  | "share-verify";

export type DealtShareResult =
  | {
      readonly ok: true;
      readonly dealer: number;
      readonly share: bigint;
      readonly blind: bigint;
    }
  | { readonly ok: false; readonly code: DealtShareCode; readonly dealer?: number };

/**
 * Seat `recipient.index`'s check of a dealt-share message (docs/spec/
 * nullifier-key.md, Dealt-share check), in order: it decodes, is for this
 * run, this seat and a dealer of round 2 other than it, its hash is the one
 * that dealer signed for this seat, it opens, and the share opens the
 * dealer's commitment at this seat. Only the last two failures, on a
 * message whose hash matched, are grounds for a complaint; `dealer` is set
 * on those.
 */
export function checkDealtShare(
  params: NullifierKeyParams,
  recipient: { readonly index: number; readonly secretKey: KemSecretKey },
  rounds: Pick<NullifierKeyTranscript, "keys" | "dealings">,
  bytes: Uint8Array,
): DealtShareResult {
  const run = runOf(params);
  checkedPrefix(run, rounds);
  // Round-trips the secret key: a 64-byte seed and x in 1 to ℓ − 1.
  const secret = decode(KEM_SECRET_KEY, encode(KEM_SECRET_KEY, recipient.secretKey));
  // Only the key the seat registered: with any other, every honest share
  // would fail to open and look like grounds for a complaint.
  ownKeys(rounds.keys, recipient.index, {
    ek: ml_kem768.keygen(secret.seed).publicKey,
    dh: G.multiply(secret.x),
  });
  let msg: DealtShare;
  try {
    msg = decodeDealtShare(bytes, 1);
  } catch {
    return { ok: false, code: "share-malformed" };
  }
  const dealing = rounds.dealings.find((m) => m.index === msg.dealer);
  if (
    !equalBytes(msg.key_context, run.context) ||
    msg.recipient !== recipient.index ||
    msg.dealer === recipient.index ||
    dealing === undefined
  )
    return { ok: false, code: "share-context" };
  const position = rounds.keys
    .map((m) => m.index)
    .filter((i) => i !== msg.dealer)
    .indexOf(recipient.index);
  const signed = dealing.share_hashes[position];
  if (signed === undefined || !equalBytes(dealtShareHash(bytes), signed))
    return { ok: false, code: "share-hash" };
  return openShareWith(
    DEALT_SHARE_CHANNEL,
    run.context,
    secret,
    msg.dealer,
    recipient.index,
    dealing.commitments,
    msg,
  );
}

/**
 * @internal The last two steps of a share check, on a message whose hash
 * matched its dealer's signed one: it opens, and opens the dealer's
 * commitment at the recipient.
 */
export function openShareWith(
  channel: ShareChannel,
  context: Uint8Array,
  secret: KemSecretKey,
  dealer: number,
  recipient: number,
  commitments: readonly BjjPoint[],
  msg: { readonly ct_mlkem: Uint8Array; readonly ct_dh: Element; readonly sealed: Uint8Array },
): DealtShareResult {
  const { secretKey: dk } = ml_kem768.keygen(secret.seed);
  // FIPS 203 Decaps: implicit rejection returns a pseudorandom secret for a
  // ciphertext that fails re-encryption, so the AEAD then fails. Nothing
  // about the decapsulation is ever revealed: a complaint names the dealer.
  const ssM = ml_kem768.decapsulate(msg.ct_mlkem, dk);
  dk.fill(0);
  const k = combine(channel, ssM, msg.ct_dh.multiply(secret.x), msg.ct_dh, G.multiply(secret.x));
  ssM.fill(0);
  let share: bigint;
  let blind: bigint;
  let plain: Uint8Array | undefined;
  try {
    plain = chacha20poly1305(
      k,
      NONCE,
      associatedData(channel, context, dealer, recipient, commitments),
    ).decrypt(msg.sealed);
    [share, blind] = decode(SHARE_PAIR, plain);
  } catch {
    return { ok: false, code: "share-decrypt", dealer };
  } finally {
    k.fill(0);
    plain?.fill(0);
  }
  if (!opening(share, blind).equals(commitmentAt(commitments, recipient)))
    return { ok: false, code: "share-verify", dealer };
  return { ok: true, dealer, share, blind };
}

const SHARE_PAIR = {
  minLength: 64,
  write(w: Writer, [a, b]: readonly [bigint, bigint]) {
    bjjScalar.write(w, a);
    bjjScalar.write(w, b);
  },
  read(r: Parameters<typeof bjjScalar.read>[0]): [bigint, bigint] {
    return [bjjScalar.read(r), bjjScalar.read(r)];
  },
};

/**
 * Round 3: the dealers the seat complains about, each one whose message
 * matched its signed hash and then failed `share-decrypt` or `share-verify`.
 * A seat with none sends nothing; a missing message is never a complaint
 * (docs/spec/nullifier-key.md, Round 3).
 */
export function complaintsMessage(
  params: NullifierKeyParams,
  seat: RegistrationSecrets,
  rounds: Pick<NullifierKeyTranscript, "keys" | "dealings">,
  dealers: readonly number[],
): ComplaintsMessage {
  const run = runOf(params);
  seatKey(run, seat);
  const h = checkedPrefix(run, rounds);
  ownKeys(rounds.keys, seat.index, seat.kem.publicKey, identityKey(seat.signingSecret));
  const s2 = rounds.dealings.map((m) => m.index);
  if (
    dealers.length === 0 ||
    !increasing(dealers, MAX_TRUSTEES) ||
    dealers.some((d) => d === seat.index || !s2.includes(d))
  )
    throw new RangeError(
      "nullifier key: complaints name dealers of round 2 other than the seat, increasing, at least one",
    );
  return sign<ComplaintsMessage>(seat.identitySecret, 3, h[2] as Uint8Array, {
    index: seat.index,
    complaints: [...dealers],
  });
}

/**
 * Round 4: the dealer's answer to every complaint about it, its share for
 * each complainer in the clear. `polynomials` must be the ones behind the
 * dealer's round-2 message in this transcript.
 */
export function responsesMessage(
  params: NullifierKeyParams,
  seat: RegistrationSecrets,
  rounds: Pick<NullifierKeyTranscript, "keys" | "dealings" | "complaints">,
  polynomials: Polynomials,
): ResponsesMessage {
  const run = runOf(params);
  seatKey(run, seat);
  const h = checkedPrefix(run, rounds);
  const dealing = rounds.dealings.find((m) => m.index === seat.index);
  if (dealing === undefined) throw new RangeError("nullifier key: the seat dealt nothing");
  checkPolynomials(polynomials, run.threshold);
  // Revealing from other polynomials than the transcript's would get the
  // dealer itself disqualified (bad-reveal).
  const commitments = polynomials.f.map((a, j) => opening(a, polynomials.g[j] as bigint));
  if (
    commitments.length !== dealing.commitments.length ||
    commitments.some((c, j) => !c.equals(dealing.commitments[j] as BjjPoint))
  )
    throw new RangeError("nullifier key: the polynomials aren't the transcript's dealing");
  const complainers = complainersOf(rounds.complaints, seat.index);
  if (complainers.length === 0) throw new RangeError("nullifier key: no complaint about the seat");
  return sign<ResponsesMessage>(seat.identitySecret, 4, h[3] as Uint8Array, {
    index: seat.index,
    reveals: complainers.map((c) => ({
      complainer: c,
      share: evaluatePolynomial(polynomials.f, c),
      blind: evaluatePolynomial(polynomials.g, c),
    })),
  });
}

function complainersOf(complaints: readonly ComplaintsMessage[], dealer: number): number[] {
  return complaints.filter((m) => m.complaints.includes(dealer)).map((m) => m.index);
}

// A node checks the rounds it signs over, as a checker would, so its
// signature never commits to a malformed or forged earlier round.
function checkedPrefix(run: Run, rounds: Partial<Rounds>): Uint8Array[] {
  const code = structureCode(run, rounds);
  if (code !== null) throw new RangeError(`nullifier key: earlier rounds fail (${code})`);
  return chain(run.context, rounds);
}

/** Why a transcript is invalid as a whole (docs/spec/nullifier-key.md, Transcript check). */
export type NullifierKeyErrorCode =
  | DecodeErrorCode
  | "key-order"
  | "key-shape"
  | "key-signature"
  | "key-quorum";

/** Why a seat isn't qualified, in the order docs/spec/nullifier-key.md lists them. */
export type KeySeatReason =
  | "absent"
  | "possession"
  | "duplicate-key"
  | "no-dealing"
  | "unanswered"
  | "bad-reveal"
  | "identity-commitment";

export interface KeySeatResult {
  readonly index: number;
  readonly reasons: readonly KeySeatReason[];
}

/** A qualified seat: its registration keys and share commitment. */
export interface KeySeat {
  readonly index: number;
  readonly kemKey: KemPublicKey;
  readonly signingKey: Uint8Array;
  readonly commitment: BjjPoint;
}

export type NullifierKeyCheck =
  | {
      readonly ok: true;
      readonly keyId: Uint8Array;
      /** The transcript's version: only a version-2 key can count (Approval). */
      readonly version: 1 | 2;
      /** A version-2 run's deadline; `null` under version 1. */
      readonly deadline: bigint | null;
      readonly seats: readonly KeySeatResult[];
      readonly qualified: readonly KeySeat[];
      /** The qualified dealers (GJKR's `QUAL`), whose polynomials make up the key. */
      readonly dealers: readonly number[];
      /** What the answer check takes (docs/spec/keyed-nullifier.md, Answer check). */
      readonly key: NullifierKey;
    }
  | {
      readonly ok: false;
      readonly code: NullifierKeyErrorCode;
      readonly seats?: readonly KeySeatResult[];
    };

/** @internal Strictly increasing seats from 1 to `n`. */
export function increasing(indices: readonly number[], n: number): boolean {
  return indices.every(
    (i, at) => i >= 1 && i <= n && (at === 0 || i > (indices[at - 1] as number)),
  );
}

// Checks 1 to 3 over the rounds present: order, shape, then signatures.
function structureCode(run: Run, t: Partial<Rounds>): NullifierKeyErrorCode | null {
  const n = run.keys.length;
  const s1 = (t.keys ?? []).map((m) => m.index);
  const s2 = (t.dealings ?? []).map((m) => m.index);
  const inS1 = (i: number) => s1.includes(i);
  if (!increasing(s1, n)) return "key-order";
  for (const [round, senders, allowed] of [
    [t.dealings, s2, inS1],
    [t.complaints, (t.complaints ?? []).map((m) => m.index), inS1],
    [t.responses, (t.responses ?? []).map((m) => m.index), (i: number) => s2.includes(i)],
  ] as const)
    if (round !== undefined && (!increasing(senders, n) || !senders.every(allowed)))
      return "key-order";
  const others = (set: readonly number[], i: number) => set.filter((j) => j !== i).length;
  if (
    t.dealings?.some(
      (m) =>
        m.commitments.length !== run.threshold || m.share_hashes.length !== others(s1, m.index),
    )
  )
    return "key-shape";
  if (
    t.complaints?.some(
      (m) =>
        m.complaints.length === 0 ||
        !increasing(m.complaints, n) ||
        m.complaints.some((d) => d === m.index || !s2.includes(d)),
    )
  )
    return "key-shape";
  if (t.responses !== undefined) {
    const complaints = t.complaints ?? [];
    for (const m of t.responses) {
      const expected = complainersOf(complaints, m.index);
      const got = m.reveals.map((r) => r.complainer);
      if (expected.length === 0 || got.length !== expected.length) return "key-shape";
      if (got.some((c, at) => c !== expected[at])) return "key-shape";
    }
  }
  const h = chain(run.context, t);
  const rounds = [t.keys, t.dealings, t.complaints, t.responses];
  for (const [r, msgs] of rounds.entries())
    for (const m of msgs ?? [])
      if (!messageOk(run, r + 1, h[r] as Uint8Array, m)) return "key-signature";
  return null;
}

/** @internal */
export const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

// Check 4: each seat's reasons, from the transcript alone.
function seatResults(run: Run, t: Rounds): KeySeatResult[] {
  const n = run.keys.length;
  const reasons = new Map<number, KeySeatReason[]>();
  for (let i = 1; i <= n; i++) reasons.set(i, []);
  const add = (i: number, r: KeySeatReason) => {
    const list = reasons.get(i) as KeySeatReason[];
    if (!list.includes(r)) list.push(r);
  };
  const keys = new Map(t.keys.map((m) => [m.index, m]));
  const dealings = new Map(t.dealings.map((m) => [m.index, m]));
  const responses = new Map(t.responses.map((m) => [m.index, m]));
  const passing = t.keys.filter((m) => possessionOk(run.context, m));
  const identities = new Set(run.keys.map(hex));
  const sigCount = new Map<string, number>();
  for (const m of passing)
    sigCount.set(hex(m.signing_key), (sigCount.get(hex(m.signing_key)) ?? 0) + 1);

  for (let i = 1; i <= n; i++) {
    const k = keys.get(i);
    if (k === undefined) {
      add(i, "absent");
      continue;
    }
    if (!passing.includes(k)) add(i, "possession");
    else {
      const sk = hex(k.signing_key);
      if ((sigCount.get(sk) ?? 0) > 1 || identities.has(sk)) add(i, "duplicate-key");
    }
    const dealing = dealings.get(i);
    if (dealing === undefined) {
      add(i, "no-dealing");
      continue;
    }
    const complainers = complainersOf(t.complaints, i);
    if (complainers.length === 0) continue;
    const response = responses.get(i);
    if (response === undefined) {
      add(i, "unanswered");
      continue;
    }
    for (const r of response.reveals)
      if (!opening(r.share, r.blind).equals(commitmentAt(dealing.commitments, r.complainer)))
        add(i, "bad-reveal");
  }
  return Array.from(reasons, ([index, r]) => ({ index, reasons: r }));
}

// Every valid result this module's check returned, frozen, so approving and
// counting take a key's version, deadline, `key_id` and qualified seats only
// as one check gave them together, never as a caller assembled them: a copy,
// or a version-1 result relabelled version 2, isn't in it.
const CHECKED = new WeakSet<object>();

function checked(key: object): void {
  if (!CHECKED.has(key))
    throw new TypeError("nullifier key: expected a result of checkNullifierKeyTranscript");
}

/**
 * The transcript check of docs/spec/nullifier-key.md: the context rebuilt
 * from `scope` and the transcript's `run_id` and, under version 2, its
 * `deadline` (never the scope from the transcript), checks 1 to 5 in order,
 * and for a valid transcript the key: `key_id`, the threshold and each
 * qualified seat's registration keys and share commitment.
 */
export function checkNullifierKeyTranscript(
  scope: NullifierKeyScope,
  bytes: Uint8Array,
  pinned: 1 | 2,
): NullifierKeyCheck {
  let t: NullifierKeyTranscript | NullifierKeyTranscriptV2;
  let version: 1 | 2;
  try {
    ({ version, value: t } = SCHEMA.decode(NULLIFIER_KEY_TRANSCRIPT, bytes, pinned));
  } catch (e) {
    if (e instanceof DecodeError) return { ok: false, code: e.code };
    throw e;
  }
  // The scope's own fields only: a caller's object carrying a `deadline` must
  // not turn a version-1 transcript's context into version 2's.
  const pins = {
    l2ChainId: scope.l2ChainId,
    groupRegistry: scope.groupRegistry,
    panel: scope.panel,
  };
  const run = runOf(
    "deadline" in t
      ? { ...pins, runId: t.run_id, deadline: t.deadline }
      : { ...pins, runId: t.run_id, deadline: null },
  );
  const code = structureCode(run, t);
  if (code !== null) return { ok: false, code };
  const seats = seatResults(run, t);
  // The qualified dealers; a dealer whose own share commitment is the identity
  // still deals, but holds nothing (identity-commitment).
  const dealers = seats.filter((s) => s.reasons.length === 0).map((s) => s.index);
  const qualifiedDealings = t.dealings.filter((m) => dealers.includes(m.index));
  const holders = dealers.flatMap((index) => {
    let commitment = BJJ_G.subtract(BJJ_G);
    for (const d of qualifiedDealings)
      commitment = commitment.add(commitmentAt(d.commitments, index));
    if (commitment.is0()) {
      const seat = seats.find((s) => s.index === index) as KeySeatResult;
      (seat.reasons as KeySeatReason[]).push("identity-commitment");
      return [];
    }
    const m = t.keys.find((k) => k.index === index) as RegistrationKeysMessage;
    return [{ index, kemKey: m.kem_key, signingKey: m.signing_key, commitment }];
  });
  if (holders.length < run.threshold) return { ok: false, code: "key-quorum", seats };
  const qualified = holders;
  const keyId = nullifierKeyId(bytes);
  const n = run.keys.length;
  const key: NullifierKey = {
    keyId,
    threshold: run.threshold,
    signingKeys: Array.from(
      { length: n },
      (_, i) => qualified.find((s) => s.index === i + 1)?.signingKey ?? null,
    ),
    commitments: Array.from(
      { length: n },
      (_, i) => qualified.find((s) => s.index === i + 1)?.commitment ?? null,
    ),
  };
  const result = Object.freeze({
    ok: true as const,
    keyId,
    version,
    deadline: run.deadline,
    seats,
    dealers: Object.freeze(dealers),
    qualified: Object.freeze(qualified),
    key,
  });
  CHECKED.add(result);
  return result;
}

/** What a seat received from one other dealer: its dealt share, or the dealer's reveal. */
export interface ReceivedShare {
  readonly dealer: number;
  readonly share: bigint;
  readonly blind: bigint;
}

/**
 * Seat `index`'s share of the key (docs/spec/nullifier-key.md, Transcript
 * check): the sum over the qualified dealers of its own dealing's value, the
 * reveal where it complained, and what `received` holds otherwise. Throws
 * unless it opens the seat's share commitment, in which case the seat lacks a
 * share and doesn't approve the key (Approval, rule 2).
 */
export function seatShareOf(
  check: Extract<NullifierKeyCheck, { ok: true }>,
  transcript: NullifierKeyTranscript,
  index: number,
  own: Polynomials,
  received: readonly ReceivedShare[],
): SeatShare {
  const seat = check.qualified.find((s) => s.index === index);
  if (seat === undefined) throw new RangeError("nullifier key: the seat isn't qualified");
  let sk = 0n;
  let s = 0n;
  for (const dealer of check.dealers) {
    let value: { share: bigint; blind: bigint } | undefined;
    if (dealer === index)
      value = { share: evaluatePolynomial(own.f, index), blind: evaluatePolynomial(own.g, index) };
    else
      value =
        transcript.responses
          .find((m) => m.index === dealer)
          ?.reveals.find((r) => r.complainer === index) ??
        received.find((r) => r.dealer === dealer);
    if (value === undefined)
      throw new RangeError(`nullifier key: no share from qualified dealer ${dealer}`);
    sk = modL(sk + value.share);
    s = modL(s + value.blind);
  }
  if (sk === 0n || !opening(sk, s).equals(seat.commitment))
    throw new RangeError("nullifier key: the share doesn't open the seat's commitment");
  return { seat: index, sk, s };
}

/**
 * Seat `index`'s 101-byte statement approving a version-2 key with its run's
 * deadline, signed under `abolish/v1/sig/nullifier-key-approval-3`
 * (docs/spec/nullifier-key.md, Approval). The statements without the
 * deadline, version 1's and `abolish/v1/sig/nullifier-key-approval-2`, are
 * retired: a quorum's approvals held back past the run's deadline could be
 * recorded under them once its seats had erased their shares (T-54, T-03).
 */
export function nullifierKeyApprovalMessage(
  scope: NullifierKeyScope,
  index: number,
  keyId: Uint8Array,
  deadline: bigint,
): Uint8Array {
  const s = scopeOf(scope);
  if (!Number.isSafeInteger(index) || index < 1 || index > s.keys.length)
    throw new RangeError("nullifier key: index must be a seat of the panel");
  return nullifierKeyApprovalStatement(s, s.panelId, index, keyId, deadline);
}

/**
 * @internal Throws unless at least `RECORD_MARGIN` L2 blocks are left before
 * `deadline`: a seat approves or consents only with time to force the record
 * through the L1 portal (docs/spec/nullifier-key.md, Approval, Recording).
 */
export function checkRecordMargin(deadline: bigint, currentL2Block: bigint, name: string): void {
  if (deadline - currentL2Block < BigInt(RECORD_MARGIN))
    throw new RangeError(`${name}: too close to the run's deadline to be recorded`);
}

/**
 * Seat `index`'s approval of a version-2 key, as a check of its transcript
 * returned it (its `keyId`, `version` and `deadline` together, nothing a
 * caller assembled), refused for a version-1 key, for fewer than `q`
 * qualified seats (rule 1), for a seat that isn't qualified (rule 2), with
 * fewer than `RECORD_MARGIN` blocks left before the deadline, or if it lies
 * more than `MAX_KEY_WINDOW` ahead of `currentL2Block` (rule 5). The caller
 * MUST have checked the other approval rules of docs/spec/nullifier-key.md
 * first, rules 4 and 6 above all, from its own L2 node: the group registry
 * records no key for the scope, the seat approved no successor of any key of
 * it, and every other initial key it approved passed its deadline without
 * being recorded.
 */
export function approveNullifierKey(
  scope: NullifierKeyScope,
  identitySecret: Uint8Array,
  index: number,
  key: Extract<NullifierKeyCheck, { ok: true }>,
  currentL2Block: bigint,
): Uint8Array {
  checked(key);
  const { keyId, version, deadline } = key;
  if (version !== 2 || deadline === null)
    throw new RangeError("nullifier key: only a version-2 key is approved");
  if (key.qualified.length < nullifierKeyQuorum(scope))
    throw new RangeError("nullifier key: fewer than q qualified seats");
  if (!key.qualified.some((q) => q.index === index))
    throw new RangeError("nullifier key: the seat isn't qualified");
  checkRunDeadline(deadline, currentL2Block, MAX_KEY_WINDOW, "nullifier key");
  checkRecordMargin(deadline, currentL2Block, "nullifier key");
  const s = scopeOf(scope);
  const pinned = s.keys[index - 1];
  if (pinned === undefined || !equalBytes(identityKey(identitySecret), pinned))
    throw new RangeError("nullifier key: identitySecret is not the key of seat index");
  return signStatement(
    identitySecret,
    STATEMENT_TAGS.keyApproval,
    nullifierKeyApprovalMessage(scope, index, keyId, deadline),
  );
}

/**
 * The distinct seats whose approval of `keyId` with `deadline` verifies under
 * their pinned identity key, in increasing order. Counted per seat, never per
 * signature: one seat can make any number of valid signatures (T-14, T-37).
 */
export function approvingSeats(
  scope: NullifierKeyScope,
  keyId: Uint8Array,
  deadline: bigint,
  approvals: readonly { readonly index: number; readonly signature: Uint8Array }[],
): number[] {
  const s = scopeOf(scope);
  const seats = new Set<number>();
  for (const a of approvals) {
    const key = Number.isSafeInteger(a.index) ? s.keys[a.index - 1] : undefined;
    if (key === undefined || a.index < 1) continue;
    const m = nullifierKeyApprovalMessage(scope, a.index, keyId, deadline);
    if (verifyStatement(key, STATEMENT_TAGS.keyApproval, m, a.signature)) seats.add(a.index);
  }
  return [...seats].sort((x, y) => x - y);
}

/**
 * Whether an initial key's transcript and approvals are enough for it to
 * count (docs/spec/nullifier-key.md, Approval): `check` is a result of this
 * module's check, of a version-2 transcript with `q` qualified seats, and `q`
 * distinct seats approved it with its deadline. A version-1 key never counts:
 * its runs have no deadline, so a stalled one would hold its seats for good.
 * Whether it counts is then the group registry's record of it, by the
 * deadline and while no key is recorded (`replayNullifierKeyRecords`).
 */
export function nullifierKeyCounts(
  scope: NullifierKeyScope,
  check: Extract<NullifierKeyCheck, { ok: true }>,
  approvals: readonly { readonly index: number; readonly signature: Uint8Array }[],
): boolean {
  checked(check);
  const q = nullifierKeyQuorum(scope);
  return (
    check.version === 2 &&
    check.deadline !== null &&
    check.qualified.length >= q &&
    approvingSeats(scope, check.keyId, check.deadline, approvals).length >= q
  );
}

/** `q = max(k, n − 1)`: the approvals a key needs, and the qualified seats an honest seat requires. */
export function nullifierKeyQuorum(scope: NullifierKeyScope): number {
  const s = scopeOf(scope);
  return Math.max(s.threshold, s.keys.length - 1);
}

// Public values, so timing doesn't matter; written without early exit anyway.
/** @internal */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return d === 0;
}
