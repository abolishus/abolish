// The panel's side of the Tier 2 keyed nullifier (docs/spec/keyed-nullifier.md;
// docs/adr/0022-tier2-keyed-nullifier.md, option A): Baby Jubjub's prime-order
// subgroup with its `bjj-scalar` and `bjj-point` encodings, the generator `J`,
// share commitments, a seat's evaluation `Z_i = sk_i · B` with its proof of
// knowledge, the answer record (0x0010), the answer check, and the
// combination and unblinding. Group arithmetic and hash-to-field are
// @noble/curves'; nothing here implements a curve operation (T-39).

import { hash_to_field } from "@noble/curves/abstract/hash-to-curve.js";
import { babyjubjub } from "@noble/curves/misc.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import {
  bytesFixed,
  type Codec,
  type CodecValue,
  decode,
  DecodeError,
  type DecodeErrorCode,
  encode,
  EncodeError,
  fieldBn254,
  struct,
  u8,
  u16,
  Writer,
} from "./codec.ts";
import { assertSpecifiedTag, ds, type SpecifiedTagOf } from "./domain-separation.ts";
import { H } from "./group.ts";
import { RECORD_TYPES, RecordSchema, recordType } from "./record.ts";
import { MAX_TRUSTEES, p256Sig, signStatement, verifyStatement } from "./trustee.ts";

const Point = babyjubjub.Point;

/**
 * A point of Baby Jubjub, built by @noble/curves and typed by the operations
 * used here. Every point this module returns or accepts from a decoder is in
 * the prime-order subgroup.
 */
export type BjjPoint = InstanceType<typeof Point>;

/** `p`, the base field's order: BN254's scalar field order `r`. */
export const BJJ_FIELD_ORDER: bigint = Point.Fp.ORDER;

/** `l`, the order of the prime-order subgroup 𝔾 (EIP-2494). */
export const BJJ_ORDER: bigint = Point.Fn.ORDER;

/** `G`, EIP-2494's base point `B8`, which generates 𝔾. */
export const BJJ_G: BjjPoint = Point.BASE;

const BJJ_IDENTITY: BjjPoint = Point.ZERO;

const mod = (a: bigint, m: bigint) => ((a % m) + m) % m;

const isScalar = (v: unknown): v is bigint => typeof v === "bigint" && v >= 0n && v < BJJ_ORDER;

/** `bjj-scalar`: 32 bytes big-endian, value below `l`, never reduced (T-31). */
export const bjjScalar: Codec<bigint> = {
  minLength: 32,
  write(w, value) {
    if (!isScalar(value)) throw new EncodeError("bjj-scalar: expected a bigint from 0 to l - 1");
    const b = new Uint8Array(32);
    let v = value;
    for (let i = 31; i >= 0; i--) {
      b[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    w.bytes(b);
  },
  read(r) {
    const at = r.offset;
    let v = 0n;
    for (const x of r.take(32)) v = (v << 8n) | BigInt(x);
    if (v >= BJJ_ORDER) throw new DecodeError("non-canonical", at);
    return v;
  },
};

/** A point from affine coordinates, or `null` unless it lies on the curve and in 𝔾. */
function subgroupPoint(x: bigint, y: bigint): BjjPoint | null {
  if (x >= BJJ_FIELD_ORDER || y >= BJJ_FIELD_ORDER) return null;
  if (x === 0n && y === 1n) return BJJ_IDENTITY;
  let p: BjjPoint;
  try {
    p = Point.fromAffine({ x, y });
    p.assertValidity();
  } catch {
    return null;
  }
  // The curve has cofactor 8 and noble's decoding doesn't check the
  // subgroup: a small-order component in B would leak sk_i mod 8 (T-39).
  return p.isTorsionFree() ? p : null;
}

function bjjPointCodec(allowIdentity: boolean): Codec<BjjPoint> {
  return {
    minLength: 64,
    write(w, value) {
      if (
        value === null ||
        typeof value !== "object" ||
        Object.getPrototypeOf(value) !== Point.prototype
      )
        throw new EncodeError("bjj-point: expected a Baby Jubjub point");
      let x: bigint;
      let y: bigint;
      try {
        ({ x, y } = Point.prototype.toAffine.call(value));
      } catch {
        throw new EncodeError("bjj-point: not a valid Baby Jubjub point");
      }
      // Re-validated from the coordinates written, whatever the input object.
      const p = subgroupPoint(x, y);
      if (p === null) throw new EncodeError("bjj-point: not a point of the prime-order subgroup");
      if (!allowIdentity && p.is0()) throw new EncodeError("bjj-point: the identity isn't allowed");
      fieldBn254.write(w, x);
      fieldBn254.write(w, y);
    },
    read(r) {
      const at = r.offset;
      const x = fieldBn254.read(r);
      const y = fieldBn254.read(r);
      const p = subgroupPoint(x, y);
      if (p === null || (!allowIdentity && p.is0())) throw new DecodeError("non-canonical", at);
      return p;
    },
  };
}

/** `bjj-point`: `field<bn254>(x) ‖ field<bn254>(y)` of a point of 𝔾 other than the identity. */
export const bjjPoint: Codec<BjjPoint> = bjjPointCodec(false);

/** `bjj-point` in a field that allows the identity: only prover commitments. */
export const bjjPointOrIdentity: Codec<BjjPoint> = bjjPointCodec(true);

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

/**
 * `HashToScalarBJJ(m, DST)`: RFC 9380 `hash_to_field(m, 1)` over F_l with
 * `k = 128` (so `L = 48`) and `expand_message_xmd` over SHA-256. Protocol code
 * calls `challengeBjj`; this takes any `DST` so vectors under others test it.
 */
export function hashToScalarBjj(message: Uint8Array, dst: Uint8Array): bigint {
  if (!(message instanceof Uint8Array) || !ArrayBuffer.isView(message))
    throw new TypeError("message must be a Uint8Array");
  if (!(dst instanceof Uint8Array) || !ArrayBuffer.isView(dst))
    throw new TypeError("DST must be a Uint8Array");
  if (dst.length < 16 || dst.length > 255) throw new RangeError("DST must be 16 to 255 bytes");
  const [[u]] = hash_to_field(new Uint8Array(message), 1, {
    DST: new Uint8Array(dst),
    p: BJJ_ORDER,
    m: 1,
    k: 128,
    expand: "xmd",
    hash: sha256,
  }) as [[bigint]];
  return u;
}

/** A Fiat–Shamir challenge in 𝔾 under a Fiat–Shamir (Baby Jubjub) tag as its `DST` (T-30). */
export function challengeBjj(
  tag: SpecifiedTagOf<"fiat-shamir-bjj">,
  statement: Uint8Array,
): bigint {
  assertSpecifiedTag(tag, ["fiat-shamir-bjj"]);
  return hashToScalarBjj(statement, ascii(tag));
}

/**
 * `J`: the first counter whose `y = H(DS(tag, u8(ctr))) mod p` lies on the
 * curve, with the even square root as `x`, times the cofactor, so no one
 * knows `log_G J` (docs/spec/keyed-nullifier.md, Generator `J`; T-15).
 */
function deriveGeneratorJ(): BjjPoint {
  const Fp = Point.Fp;
  const { a, d } = Point.CURVE();
  for (let ctr = 0; ctr < 256; ctr++) {
    const digest = H(ds("abolish/v1/keyed-nullifier/generator-j", Uint8Array.of(ctr)));
    let y = 0n;
    for (const x of digest) y = (y << 8n) | BigInt(x);
    y = Fp.create(y);
    const u = Fp.sub(Fp.ONE, Fp.sqr(y));
    const v = Fp.sub(a, Fp.mul(d, Fp.sqr(y)));
    if (Fp.is0(v)) continue;
    let x: bigint;
    try {
      x = Fp.sqrt(Fp.div(u, v));
    } catch {
      continue;
    }
    if (x % 2n === 1n) x = Fp.neg(x);
    const p = Point.fromAffine({ x, y });
    p.assertValidity();
    const jPoint = p.clearCofactor();
    if (!jPoint.is0()) return jPoint;
  }
  throw new Error("no counter gives J");
}

/** `J`, the second generator of the share commitments. */
export const GENERATOR_J: BjjPoint = deriveGeneratorJ();

function checkSeat(seat: unknown, n: number, what: string): asserts seat is number {
  if (typeof seat !== "number" || !Number.isInteger(seat) || seat < 1 || seat > n)
    throw new RangeError(`${what}: seat must be an integer from 1 to ${n}`);
}

/** A point of 𝔾 other than the identity, re-read through the codec. */
function checkedPoint(p: BjjPoint, what: string): BjjPoint {
  try {
    return decode(bjjPoint, encode(bjjPoint, p));
  } catch {
    throw new RangeError(`${what}: expected a point of the prime-order subgroup, not the identity`);
  }
}

/**
 * Seat `i`'s share commitment `C_i = Σ_d Σ_j (i^j mod l) · A_{d,j}`
 * (docs/spec/keyed-nullifier.md, Share commitments), from each qualified
 * dealer's coefficient commitments `A_{d,0..k−1}`, all of length `k`.
 */
export function shareCommitment(dealers: readonly (readonly BjjPoint[])[], seat: number): BjjPoint {
  checkSeat(seat, MAX_TRUSTEES, "shareCommitment");
  const k = dealers[0]?.length ?? 0;
  if (k < 1 || k > MAX_TRUSTEES) throw new RangeError("shareCommitment: bad threshold");
  let c = BJJ_IDENTITY;
  for (const coefficients of dealers) {
    if (coefficients.length !== k)
      throw new RangeError("shareCommitment: dealers' commitments differ in length");
    let power = 1n;
    for (const a of coefficients) {
      c = c.add(checkedPoint(a, "shareCommitment").multiplyUnsafe(power));
      power = (power * BigInt(seat)) % BJJ_ORDER;
    }
  }
  return c;
}

const TAG = "abolish/v1/sig/nullifier-answer";

const VERSION = 1;

const answerFields = [
  ["key_id", bytesFixed(32)],
  ["query_hash", bytesFixed(32)],
  ["seat", u8],
  ["b", bjjPoint],
  ["z", bjjPoint],
  ["c", bjjScalar],
  ["z1", bjjScalar],
  ["z2", bjjScalar],
] as const;

const answerStatementV1 = struct(answerFields);

const answerV1 = struct([...answerFields, ["signature", p256Sig]] as const);

/** What a seat signs: the key, the query, its seat, `B`, `Z_i` and the proof. */
export type NullifierAnswerFields = CodecValue<typeof answerStatementV1>;

/** A seat's answer, version 1 (docs/spec/keyed-nullifier.md, Answer record). */
export type NullifierAnswer = CodecValue<typeof answerV1>;

/**
 * Record type `0x0010`. Never on the board and never pinned by a profile: the
 * Tier 2 key fixes its version.
 */
export const NULLIFIER_ANSWER = recordType(RECORD_TYPES.nullifierAnswer, { 1: answerV1 });

const SCHEMA = new RecordSchema([NULLIFIER_ANSWER]);

export function encodeNullifierAnswer(answer: NullifierAnswer): Uint8Array {
  return SCHEMA.encode(NULLIFIER_ANSWER, 1, answer);
}

/** Strictly decodes an answer under version 1, the version the Tier 2 key fixes. */
export function decodeNullifierAnswer(bytes: Uint8Array, pinned: 1): NullifierAnswer {
  return SCHEMA.decode(NULLIFIER_ANSWER, bytes, pinned).value;
}

/**
 * `u16(0x0010) ‖ u8(1) ‖ key_id ‖ query_hash ‖ u8(seat) ‖ b ‖ z ‖ c ‖ z1 ‖ z2`:
 * the record without its signature, header included, so a later version
 * can't reuse a version 1 signature (T-31).
 */
export function nullifierAnswerMessage(fields: NullifierAnswerFields): Uint8Array {
  const w = new Writer();
  u16.write(w, RECORD_TYPES.nullifierAnswer);
  u8.write(w, VERSION);
  // Through the struct, so only these fields are read even from a whole record.
  answerStatementV1.write(w, {
    key_id: fields.key_id,
    query_hash: fields.query_hash,
    seat: fields.seat,
    b: fields.b,
    z: fields.z,
    c: fields.c,
    z1: fields.z1,
    z2: fields.z2,
  });
  return w.finish();
}

/**
 * The Tier 2 key as a client or attester has it from the key's checked
 * transcript (`checkNullifierKeyTranscript`, docs/spec/nullifier-key.md).
 */
export interface NullifierKey {
  /** `key_id`, 32 bytes: the hash of the key's transcript. */
  readonly keyId: Uint8Array;
  /**
   * Each seat's registration signing key, seat `i` at index `i − 1`, or
   * `null` for a seat that isn't qualified; `n` is the length.
   */
  readonly signingKeys: readonly (Uint8Array | null)[];
  /** Each qualified seat's share commitment `C_i`, at index `i − 1`; `null` where the key is. */
  readonly commitments: readonly (BjjPoint | null)[];
  /**
   * `k`, the sharing's threshold, from the transcript. Never from a client:
   * fewer answers combine to a `Z` the client can compute, and so to a second
   * nullifier for one document (T-03).
   */
  readonly threshold: number;
}

/** The query an answer is for, as its client made it or an attester received it. */
export interface NullifierQuery {
  /** `query_hash`, 32 bytes (part 2b-3). */
  readonly queryHash: Uint8Array;
  /** `B = r · H1(x)`, never the identity. */
  readonly b: BjjPoint;
}

/** A seat's secret share of the key: `C_seat = sk · G + s · J`. */
export interface SeatShare {
  readonly seat: number;
  readonly sk: bigint;
  readonly s: bigint;
}

function evaluationChallenge(
  keyId: Uint8Array,
  queryHash: Uint8Array,
  seat: number,
  ci: BjjPoint,
  b: BjjPoint,
  zi: BjjPoint,
  t1: BjjPoint,
  t2: BjjPoint,
): bigint {
  const w = new Writer();
  bjjPoint.write(w, BJJ_G);
  bjjPoint.write(w, GENERATOR_J);
  bytesFixed(32).write(w, keyId);
  bytesFixed(32).write(w, queryHash);
  u8.write(w, seat);
  bjjPoint.write(w, ci);
  bjjPoint.write(w, b);
  bjjPoint.write(w, zi);
  bjjPointOrIdentity.write(w, t1);
  bjjPointOrIdentity.write(w, t2);
  return challengeBjj("abolish/v1/fs/keyed-nullifier/evaluation", w.finish());
}

/** Validates the key once, so a malformed one is an explicit error, never a result code. */
function checkKey(key: NullifierKey): number {
  const n = key.signingKeys.length;
  if (n < 1 || n > MAX_TRUSTEES || key.commitments.length !== n)
    throw new RangeError("key: needs 1 to MAX_TRUSTEES seats, each with its commitment");
  if (!Number.isInteger(key.threshold) || key.threshold < 1 || key.threshold > n)
    throw new RangeError("key: the threshold must be from 1 to n");
  if (!(key.keyId instanceof Uint8Array) || key.keyId.length !== 32)
    throw new RangeError("key: keyId must be 32 bytes");
  let qualified = 0;
  for (const [i, c] of key.commitments.entries()) {
    if ((c === null) !== (key.signingKeys[i] === null))
      throw new RangeError("key: a seat has a commitment without a signing key, or the reverse");
    if (c === null) continue;
    checkedPoint(c, "key: commitment");
    qualified++;
  }
  if (qualified < key.threshold) throw new RangeError("key: fewer qualified seats than k");
  return n;
}

const isNonZeroScalar = (v: unknown): v is bigint => isScalar(v) && v !== 0n;

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Internal: a seat's answer with the given nonces. Production code calls
 * `evaluate`; the package entry point doesn't export this.
 */
export function evaluateWith(
  key: NullifierKey,
  query: NullifierQuery,
  share: SeatShare,
  signingSecret: Uint8Array,
  w1: bigint,
  w2: bigint,
): NullifierAnswer {
  const n = checkKey(key);
  checkSeat(share.seat, n, "evaluate");
  if (!isNonZeroScalar(share.sk) || !isScalar(share.s))
    throw new RangeError("evaluate: the share must be scalars below l, sk non-zero");
  if (!isNonZeroScalar(w1) || !isNonZeroScalar(w2))
    throw new RangeError("evaluate: nonces must be scalars from 1 to l − 1");
  const commitment = key.commitments[share.seat - 1];
  const signingKey = key.signingKeys[share.seat - 1];
  if (commitment == null || signingKey == null)
    throw new RangeError("evaluate: the seat isn't qualified in the key");
  const ci = checkedPoint(commitment, "evaluate: C_i");
  // A seat that answers from a share its commitment doesn't open would sign a
  // wrong answer and be attributed for it (T-29).
  // Constant-time multiplication for the secret s_i too: with C_i, it gives
  // sk_i · G, which the commitment's hiding must keep (T-15, T-39).
  const sJ = share.s === 0n ? BJJ_IDENTITY : GENERATOR_J.multiply(share.s);
  if (!BJJ_G.multiply(share.sk).add(sJ).equals(ci))
    throw new RangeError("evaluate: the share doesn't open the seat's commitment");
  const b = checkedPoint(query.b, "evaluate: B");
  const zi = b.multiply(share.sk);
  const t1 = b.multiply(w1);
  const t2 = BJJ_G.multiply(w1).add(GENERATOR_J.multiply(w2));
  const c = evaluationChallenge(key.keyId, query.queryHash, share.seat, ci, b, zi, t1, t2);
  const fields: NullifierAnswerFields = {
    key_id: Uint8Array.from(key.keyId),
    query_hash: Uint8Array.from(query.queryHash),
    seat: share.seat,
    b,
    z: zi,
    c,
    z1: mod(w1 + c * share.sk, BJJ_ORDER),
    z2: mod(w2 + c * share.s, BJJ_ORDER),
  };
  const signature = signStatement(signingSecret, TAG, nullifierAnswerMessage(fields));
  if (!verifyStatement(signingKey, TAG, nullifierAnswerMessage(fields), signature))
    throw new RangeError("evaluate: the signing secret isn't the seat's registration key");
  return { ...fields, signature };
}

function randomNonZeroScalar(): bigint {
  for (;;) {
    const b = randomBytes(64);
    let v = 0n;
    for (const x of b) v = (v << 8n) | BigInt(x);
    v %= BJJ_ORDER;
    if (v !== 0n) return v;
  }
}

/**
 * Seat `share.seat`'s answer to a query whose proof it has checked
 * (docs/spec/keyed-nullifier.md, Evaluation): `Z_i = sk_i · B`, a proof of
 * knowledge of an opening of `C_i` whose first half is `log_B Z_i`, with fresh
 * nonces from the CSPRNG, signed with the seat's registration signing key. A seat MUST
 * check the query proof first: without it, answers are a static
 * Diffie–Hellman oracle (Security notes).
 */
export function evaluate(
  key: NullifierKey,
  query: NullifierQuery,
  share: SeatShare,
  signingSecret: Uint8Array,
): NullifierAnswer {
  return evaluateWith(
    key,
    query,
    share,
    signingSecret,
    randomNonZeroScalar(),
    randomNonZeroScalar(),
  );
}

export type AnswerCode =
  | DecodeErrorCode
  | "answer-key"
  | "answer-query"
  | "answer-seat"
  | "answer-signature"
  | "answer-proof";

export type AnswerResult =
  | { readonly ok: true; readonly answer: NullifierAnswer }
  | { readonly ok: false; readonly code: AnswerCode };

/**
 * The answer check (docs/spec/keyed-nullifier.md, Answer check), in its
 * order: the signature before the proof, so an answer failing only
 * `answer-proof` is a wrong answer its seat signed (T-29). The key and the
 * query come from what the caller checked or made, never from the answer.
 */
export function checkNullifierAnswer(
  key: NullifierKey,
  query: NullifierQuery,
  bytes: Uint8Array,
): AnswerResult {
  const n = checkKey(key);
  let a: NullifierAnswer;
  try {
    a = decodeNullifierAnswer(bytes, 1);
  } catch (e) {
    if (e instanceof DecodeError) return { ok: false, code: e.code };
    throw e;
  }
  if (!sameBytes(a.key_id, key.keyId)) return { ok: false, code: "answer-key" };
  if (!sameBytes(a.query_hash, query.queryHash) || !a.b.equals(query.b))
    return { ok: false, code: "answer-query" };
  const signingKey = a.seat >= 1 && a.seat <= n ? key.signingKeys[a.seat - 1] : null;
  const ci = a.seat >= 1 && a.seat <= n ? key.commitments[a.seat - 1] : null;
  if (signingKey == null || ci == null) return { ok: false, code: "answer-seat" };
  if (!verifyStatement(signingKey, TAG, nullifierAnswerMessage(a), a.signature))
    return { ok: false, code: "answer-signature" };
  // Public values only: the recomputed prover commitments.
  const t1 = a.b.multiplyUnsafe(a.z1).subtract(a.z.multiplyUnsafe(a.c));
  const t2 = BJJ_G.multiplyUnsafe(a.z1)
    .add(GENERATOR_J.multiplyUnsafe(a.z2))
    .subtract(ci.multiplyUnsafe(a.c));
  const c = evaluationChallenge(a.key_id, a.query_hash, a.seat, ci, a.b, a.z, t1, t2);
  if (c !== a.c) return { ok: false, code: "answer-proof" };
  return { ok: true, answer: a };
}

/** `λ_i = Π_{j ∈ S, j ≠ i} j · (j − i)⁻¹ mod l`, the Lagrange coefficient at 0. */
export function bjjLagrangeAtZero(seat: number, seats: readonly number[]): bigint {
  checkSeat(seat, MAX_TRUSTEES, "bjjLagrangeAtZero");
  if (!seats.includes(seat) || new Set(seats).size !== seats.length)
    throw new RangeError("bjjLagrangeAtZero: seats must be distinct and include the seat");
  let num = 1n;
  let den = 1n;
  for (const j of seats) {
    checkSeat(j, MAX_TRUSTEES, "bjjLagrangeAtZero");
    if (j === seat) continue;
    num = (num * BigInt(j)) % BJJ_ORDER;
    den = mod(den * BigInt(j - seat), BJJ_ORDER);
  }
  return (num * Point.Fn.inv(den)) % BJJ_ORDER;
}

/**
 * `Z = Σ λ_i · Z_i` over exactly `k` answers from distinct seats, all for one
 * key and query (docs/spec/keyed-nullifier.md, Combination and unblinding),
 * with `k` the key's own threshold. Only answers `checkNullifierAnswer`
 * passed: by their proofs, any `k` of them give the same `sk · B`.
 */
export function combineAnswers(key: NullifierKey, answers: readonly NullifierAnswer[]): BjjPoint {
  checkKey(key);
  const k = key.threshold;
  if (answers.length !== k) throw new RangeError("combineAnswers: needs exactly k answers");
  const [first] = answers as [NullifierAnswer];
  const seats = answers.map((a) => a.seat);
  if (new Set(seats).size !== k) throw new RangeError("combineAnswers: seats must be distinct");
  let z = BJJ_IDENTITY;
  for (const a of answers) {
    // Defence in depth: the answer check already refuses an unqualified seat.
    if (key.commitments[a.seat - 1] == null)
      throw new RangeError("combineAnswers: an answer from a seat the key doesn't qualify");
    if (
      !sameBytes(a.key_id, key.keyId) ||
      !sameBytes(a.key_id, first.key_id) ||
      !sameBytes(a.query_hash, first.query_hash) ||
      !a.b.equals(first.b)
    )
      throw new RangeError("combineAnswers: answers to different keys or queries");
    z = z.add(checkedPoint(a.z, "combineAnswers").multiplyUnsafe(bjjLagrangeAtZero(a.seat, seats)));
  }
  if (z.is0()) throw new RangeError("combineAnswers: the combination is the identity");
  return z;
}

/** `U = r⁻¹ · Z = sk · H1(x)`, with the client's own blinding scalar `r`. */
export function unblind(z: BjjPoint, r: bigint): BjjPoint {
  if (!isNonZeroScalar(r)) throw new RangeError("unblind: r must be a scalar from 1 to l − 1");
  return checkedPoint(z, "unblind").multiply(Point.Fn.inv(r));
}
