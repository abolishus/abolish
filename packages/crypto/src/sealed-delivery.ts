// The sealed delivery (docs/spec/sealed-delivery.md; ADR 0043; record types
// 0x0027 and 0x0028): a ballot client seals its delivery envelope, padded to a
// bucket, to the seat's per-election KEM key, a relay carries it to the seat's
// node, and the node seals its answer under a key derived from the request's,
// so the node never learns the voter's address and the relay never reads the
// ballot or the answer (T-11, T-13, T-15). The hybrid KEM, its combiner and
// the AEAD are share encryption's, under this channel's own tags; ML-KEM,
// ristretto255 and ChaCha20-Poly1305 are @noble's, and this module only
// composes them.

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { kemKeyHash } from "./ceremony.ts";
import {
  bytesFixed,
  bytesVar,
  type Codec,
  type CodecValue,
  DecodeError,
  decode,
  encode,
  EncodeError,
  Reader,
  struct,
  u16,
  u8,
  Writer,
} from "./codec.ts";
import { ds } from "./domain-separation.ts";
import { type Element, element, G, GROUP_ORDER, H } from "./group.ts";
import type { SealRandomness } from "./nullifier-transport.ts";
import { RECORD_TYPES, RecordSchema, recordType } from "./record.ts";
import {
  AEAD_TAG_LEN,
  KEM_PUBLIC_KEY,
  KEM_SECRET_KEY,
  type KemPublicKey,
  type KemSecretKey,
  MLKEM_CT_LEN,
  MLKEM_MSG_LEN,
  nonZeroRandom,
} from "./share-encryption.ts";

const VERSION = 1;

/** 2²⁰: the largest field of the delivery envelope. */
export const MAX_DELIVERY_FIELD = 1 << 20;

/** The largest envelope: four fields of `MAX_DELIVERY_FIELD` bytes and their lengths. */
export const MAX_DELIVERY = 4 * (4 + MAX_DELIVERY_FIELD);

/** The shortest envelope: four empty fields. */
const MIN_DELIVERY = 4 * 4;

/** The lengths a padded envelope may have: 16 KiB to 4 MiB by powers of two, then `MAX_DELIVERY`. */
export const PAD_BUCKETS: readonly number[] = Object.freeze([
  ...Array.from({ length: 9 }, (_, k) => 2 ** (14 + k)),
  MAX_DELIVERY,
]);

/** A sealed delivery's fields before its sealed envelope: header, key hash, `ct_M`, `ct_DH` and the length. */
const REQUEST_FIXED = 3 + 32 + MLKEM_CT_LEN + 32 + 4;

/** The longest sealed delivery: the fixed part, then `MAX_DELIVERY` and the tag. */
export const MAX_SEALED_REQUEST = REQUEST_FIXED + MAX_DELIVERY + AEAD_TAG_LEN;

/** The length of every answer's plaintext. */
export const ANSWER_PLAINTEXT = 256;

/** The longest body an answer carries: the plaintext less the outcome and the body's length. */
export const MAX_ANSWER_BODY = ANSWER_PLAINTEXT - 1 - 4;

/** The longest refusal code an answer carries. */
export const MAX_REFUSAL_CODE = 64;

/** Every sealed answer's length: its header, nonce, plaintext and tag. */
export const SEALED_ANSWER_LENGTH = 3 + 32 + ANSWER_PLAINTEXT + AEAD_TAG_LEN;

/** What a node's intake takes for one ballot (docs/spec/sealed-delivery.md, Delivery envelope). */
export const DELIVERY_ENVELOPE = struct([
  ["stub", bytesVar(MAX_DELIVERY_FIELD)],
  ["transcript", bytesVar(MAX_DELIVERY_FIELD)],
  ["record", bytesVar(MAX_DELIVERY_FIELD)],
  ["ciphertext", bytesVar(MAX_DELIVERY_FIELD)],
] as const);

export type DeliveryEnvelope = CodecValue<typeof DELIVERY_ENVELOPE>;

const SEALED_LENGTHS = new Set(PAD_BUCKETS.map((b) => b + AEAD_TAG_LEN));
const MAX_SEALED = MAX_DELIVERY + AEAD_TAG_LEN;

// `bytes<MAX_DELIVERY + 16>` whose length is a bucket plus the tag, any other
// a decode error. The length is judged before anything is read (T-52).
const sealedEnvelope: Codec<Uint8Array> = {
  minLength: 4 + (PAD_BUCKETS[0] as number) + AEAD_TAG_LEN,
  write(w, value) {
    if (!(value instanceof Uint8Array) || !SEALED_LENGTHS.has(value.length))
      throw new EncodeError("sealed delivery: sealed must be a padding bucket and the tag");
    bytesVar(MAX_SEALED).write(w, value);
  },
  read(r) {
    const at = r.offset;
    const n = r.uint(4);
    if (n > MAX_SEALED) throw new DecodeError("length-over-max", at);
    if (!SEALED_LENGTHS.has(n)) throw new DecodeError("non-canonical", at);
    return r.take(n).slice();
  },
};

const requestV1 = struct([
  ["kem_key_hash", bytesFixed(32)],
  ["ct_mlkem", bytesFixed(MLKEM_CT_LEN)],
  ["ct_dh", element],
  ["sealed", sealedEnvelope],
] as const);

const answerV1 = struct([
  ["answer_nonce", bytesFixed(32)],
  ["sealed", bytesFixed(ANSWER_PLAINTEXT + AEAD_TAG_LEN)],
] as const);

/** A sealed delivery, version 1 (docs/spec/sealed-delivery.md, Sealed delivery). */
export type SealedDelivery = CodecValue<typeof requestV1>;

/** A sealed answer, version 1 (docs/spec/sealed-delivery.md, Sealed answer). */
export type SealedAnswer = CodecValue<typeof answerV1>;

/** Record type `0x0027`. Never on the board; a client release and the nodes fix its version. */
export const SEALED_DELIVERY = recordType(RECORD_TYPES.sealedDelivery, { 1: requestV1 });

/** Record type `0x0028`. Never on the board; a client release and the nodes fix its version. */
export const SEALED_ANSWER = recordType(RECORD_TYPES.sealedAnswer, { 1: answerV1 });

const SCHEMA = new RecordSchema([SEALED_DELIVERY, SEALED_ANSWER]);

export function encodeSealedDelivery(request: SealedDelivery): Uint8Array {
  return SCHEMA.encode(SEALED_DELIVERY, VERSION, request);
}

/** Strictly decodes a sealed delivery under version 1, the only version a node takes. */
export function decodeSealedDelivery(bytes: Uint8Array, pinned: 1): SealedDelivery {
  return SCHEMA.decode(SEALED_DELIVERY, bytes, pinned).value;
}

export function encodeSealedAnswer(answer: SealedAnswer): Uint8Array {
  return SCHEMA.encode(SEALED_ANSWER, VERSION, answer);
}

/** Strictly decodes a sealed answer under version 1, the only version a client takes. */
export function decodeSealedAnswer(bytes: Uint8Array, pinned: 1): SealedAnswer {
  return SCHEMA.decode(SEALED_ANSWER, bytes, pinned).value;
}

/** `request_hash`, over the sealed delivery's full record encoding: what its answer binds. */
export function sealedDeliveryHash(encoded: Uint8Array): Uint8Array {
  return H(ds("abolish/v1/sealed-delivery/request", encoded));
}

/** The smallest length in `PAD_BUCKETS` at or above an envelope of `length` bytes. */
export function paddedDeliveryLength(length: number): number {
  if (!Number.isInteger(length) || length < MIN_DELIVERY || length > MAX_DELIVERY)
    throw new RangeError(
      `sealed delivery: an envelope is ${MIN_DELIVERY} to ${MAX_DELIVERY} bytes`,
    );
  // MAX_DELIVERY is the last bucket, so one is always found.
  return PAD_BUCKETS.find((b) => b >= length) as number;
}

/** The envelope's encoding followed by zero bytes to its bucket: the plaintext a client seals. */
export function padDeliveryEnvelope(envelope: DeliveryEnvelope): Uint8Array {
  const encoded = encode(DELIVERY_ENVELOPE, envelope);
  const padded = new Uint8Array(paddedDeliveryLength(encoded.length));
  padded.set(encoded);
  return padded;
}

/**
 * The envelope in a plaintext, if it is one padded as the spec pads it: an
 * envelope that decodes strictly, then only zero bytes to the smallest bucket
 * at or above its length. One envelope has one padded form (T-31).
 */
function unpadDeliveryEnvelope(plain: Uint8Array): DeliveryEnvelope | null {
  try {
    const r = new Reader(plain);
    const envelope = DELIVERY_ENVELOPE.read(r);
    const length = r.offset;
    if (r.take(r.remaining).some((b) => b !== 0)) return null;
    return plain.length === paddedDeliveryLength(length) ? envelope : null;
  } catch (e) {
    if (e instanceof DecodeError) return null;
    throw e;
  }
}

// Each AEAD key seals exactly one message: a request's `K` hashes a fresh
// 32-byte ML-KEM message and a fresh ephemeral, an answer's key a fresh
// 32-byte nonce, so a fixed nonce never repeats under a key.
const NONCE = new Uint8Array(12);

/** `K`: share encryption's X-Wing-style combiner, under the sealed delivery's own tag. */
function combine(ssM: Uint8Array, ssDh: Element, ctDh: Element, dh: Element): Uint8Array {
  const w = new Writer();
  w.bytes(ssM);
  element.write(w, ssDh);
  element.write(w, ctDh);
  element.write(w, dh);
  return H(ds("abolish/v1/kem/sealed-delivery", w.finish()));
}

function requestAad(keyHash: Uint8Array): Uint8Array {
  const w = new Writer();
  u16.write(w, RECORD_TYPES.sealedDelivery);
  u8.write(w, VERSION);
  w.bytes(keyHash);
  return ds("abolish/v1/kem/sealed-delivery-aad", w.finish());
}

function answerKey(key: Uint8Array, requestHash: Uint8Array, answerNonce: Uint8Array): Uint8Array {
  const w = new Writer();
  w.bytes(key);
  w.bytes(requestHash);
  w.bytes(answerNonce);
  return H(ds("abolish/v1/kem/sealed-delivery-answer", w.finish()));
}

function answerAad(requestHash: Uint8Array): Uint8Array {
  const w = new Writer();
  u16.write(w, RECORD_TYPES.sealedAnswer);
  u8.write(w, VERSION);
  w.bytes(requestHash);
  return ds("abolish/v1/kem/sealed-delivery-answer-aad", w.finish());
}

/** The plaintext under `sealed`, or `null` if the AEAD doesn't open. */
function aeadOpen(key: Uint8Array, aad: Uint8Array, sealed: Uint8Array): Uint8Array | null {
  try {
    return chacha20poly1305(key, NONCE, aad).decrypt(sealed);
  } catch {
    return null;
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * What the client keeps of one request until its answer passes the answer
 * check or the attempt fails, then erases (docs/spec/sealed-delivery.md,
 * Retention): the request's `K` and its `request_hash`. The node holds the
 * same pair for a request it opened, to seal its answer.
 */
export interface DeliveryKey {
  readonly key: Uint8Array;
  readonly requestHash: Uint8Array;
}

// `answer_key` hashes `K ‖ request_hash ‖ answer_nonce` unframed, which is
// unambiguous only while each is 32 bytes.
function checkDeliveryKey(k: DeliveryKey): void {
  for (const b of [k.key, k.requestHash])
    if (!(b instanceof Uint8Array) || b.length !== 32)
      throw new RangeError("sealed answer: K and request_hash must be 32 bytes each");
}

/** A sealed delivery ready to send, and what its answer is opened with. */
export interface SealedDeliveryRequest {
  readonly request: Uint8Array;
  readonly sent: DeliveryKey;
}

/**
 * Internal: the sealed delivery of `envelope` to `kemKey` under the given
 * randomness. Production code calls `sealDelivery`; the package entry point
 * doesn't export this.
 */
export function sealDeliveryWith(
  kemKey: KemPublicKey,
  envelope: DeliveryEnvelope,
  randomness: SealRandomness,
): SealedDeliveryRequest {
  const { mu, e } = randomness;
  if (!(mu instanceof Uint8Array) || mu.length !== MLKEM_MSG_LEN)
    throw new RangeError("sealed delivery: mu must be 32 bytes");
  if (typeof e !== "bigint" || e <= 0n || e >= GROUP_ORDER)
    throw new RangeError("sealed delivery: e must be a scalar from 1 to ℓ − 1");
  // Round-trips the key through its codec: the modulus check and a
  // non-identity DH key, whatever the caller passed (T-39).
  const key = decode(KEM_PUBLIC_KEY, encode(KEM_PUBLIC_KEY, kemKey));
  const keyHash = kemKeyHash(key);
  const plain = padDeliveryEnvelope(envelope);
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(key.ek, mu);
  const ctDh = G.multiply(e);
  const k = combine(sharedSecret, key.dh.multiply(e), ctDh, key.dh);
  // Best effort: JavaScript can't guarantee erasure (T-39).
  sharedSecret.fill(0);
  const sealed = chacha20poly1305(k, NONCE, requestAad(keyHash)).encrypt(plain);
  plain.fill(0);
  const request = encodeSealedDelivery({
    kem_key_hash: keyHash,
    ct_mlkem: cipherText,
    ct_dh: ctDh,
    sealed,
  });
  return { request, sent: { key: k, requestHash: sealedDeliveryHash(request) } };
}

/**
 * Seals `envelope` to seat `i`'s `kemKey` with fresh `μ` and `e`, as every
 * attempt must (Client rules, rule 4). `kemKey` comes from the ceremony
 * transcript the client checked under a pinned panel, never from a relay,
 * the API or the node (rule 2; T-37, T-43).
 */
export function sealDelivery(
  kemKey: KemPublicKey,
  envelope: DeliveryEnvelope,
): SealedDeliveryRequest {
  const mu = randomBytes(MLKEM_MSG_LEN);
  try {
    return sealDeliveryWith(kemKey, envelope, { mu, e: nonZeroRandom() });
  } finally {
    // Retention: the client erases `μ` once it has `K`; best effort (T-39).
    mu.fill(0);
  }
}

/** One election's KEM secret a node holds, beside its key's `kem_key_hash`. */
export interface DeliveryHolder {
  readonly kemKeyHash: Uint8Array;
  readonly secretKey: KemSecretKey;
}

/** The holder of `secretKey`, its key hash computed from the key it derives. */
export function deliveryHolder(secretKey: KemSecretKey): DeliveryHolder {
  encode(KEM_SECRET_KEY, secretKey);
  const { publicKey: ek } = ml_kem768.keygen(secretKey.seed);
  return { kemKeyHash: kemKeyHash({ ek, dh: G.multiply(secretKey.x) }), secretKey };
}

/** The checks that get a 400 with no body: all alike to the sender (T-39). */
export type SealedDeliveryCode = "sealed-malformed" | "sealed-key" | "sealed-decrypt";

export type SealedDeliveryResult =
  | {
      readonly ok: true;
      /** The envelope, which the node's intake checks next, as `POST /v1/intake` does. */
      readonly envelope: DeliveryEnvelope;
      readonly opened: DeliveryKey;
    }
  | {
      readonly ok: false;
      readonly code: "sealed-envelope";
      /** The request opened, so the node seals its refusal under this. */
      readonly opened: DeliveryKey;
    }
  | { readonly ok: false; readonly code: SealedDeliveryCode };

/**
 * The request check (docs/spec/sealed-delivery.md, Request check), up to
 * intake: `holders` are the elections whose secrets the node hasn't
 * destroyed. Nothing about the decapsulation leaves this function: ML-KEM's
 * implicit rejection returns a pseudorandom secret for a malformed `ct_M`,
 * and revealing it would leak the key; whether the AEAD opened is all a
 * caller learns (T-39).
 */
export function openSealedDelivery(
  holders: readonly DeliveryHolder[],
  bytes: Uint8Array,
): SealedDeliveryResult {
  // T-52: a body past the longest request is refused before it is copied.
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_SEALED_REQUEST)
    return { ok: false, code: "sealed-malformed" };
  let request: SealedDelivery;
  try {
    request = decodeSealedDelivery(bytes, 1);
  } catch (e) {
    if (e instanceof DecodeError) return { ok: false, code: "sealed-malformed" };
    throw e;
  }
  const holder = holders.find((h) => equalBytes(h.kemKeyHash, request.kem_key_hash));
  if (holder === undefined) return { ok: false, code: "sealed-key" };
  const secret = holder.secretKey;
  encode(KEM_SECRET_KEY, secret);
  const { secretKey: dk } = ml_kem768.keygen(secret.seed);
  const ssM = ml_kem768.decapsulate(request.ct_mlkem, dk);
  dk.fill(0);
  const k = combine(ssM, request.ct_dh.multiply(secret.x), request.ct_dh, G.multiply(secret.x));
  ssM.fill(0);
  const plain = aeadOpen(k, requestAad(request.kem_key_hash), request.sealed);
  if (plain === null) {
    k.fill(0);
    return { ok: false, code: "sealed-decrypt" };
  }
  const opened = { key: k, requestHash: sealedDeliveryHash(bytes) };
  const envelope = unpadDeliveryEnvelope(plain);
  plain.fill(0);
  if (envelope === null) return { ok: false, code: "sealed-envelope", opened };
  return { ok: true, envelope, opened };
}

/** An answer's plaintext (docs/spec/sealed-delivery.md, Sealed answer). */
export type DeliveryAnswer =
  | {
      readonly outcome: "receipt";
      /** The share receipt record, which the client checks next (Client rule 1's `share-receipt`). */
      readonly receipt: Uint8Array;
    }
  | { readonly outcome: "refused"; readonly code: string }
  | { readonly outcome: "busy" };

const OUTCOMES = { receipt: 1, refused: 2, busy: 3 } as const;

// 1 to 64 bytes of `a`–`z`, `0`–`9` and `-`, neither starting nor ending
// with `-` and with no two together.
const REFUSAL_CODE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const ascii = (b: Uint8Array) => String.fromCharCode(...b);

function isRefusalCode(code: Uint8Array): boolean {
  return code.length <= MAX_REFUSAL_CODE && REFUSAL_CODE.test(ascii(code));
}

function answerBody(answer: DeliveryAnswer): Uint8Array {
  switch (answer.outcome) {
    case "receipt": {
      const body = Uint8Array.from(answer.receipt);
      if (body.length === 0 || body.length > MAX_ANSWER_BODY)
        throw new RangeError(`sealed answer: a receipt is 1 to ${MAX_ANSWER_BODY} bytes`);
      return body;
    }
    case "refused": {
      // Judged as a string first: a character above U+007F would otherwise
      // lose its high bits in the byte it maps to.
      const code: unknown = answer.code;
      if (typeof code !== "string" || code.length > MAX_REFUSAL_CODE || !REFUSAL_CODE.test(code))
        throw new RangeError("sealed answer: not a refusal code");
      return Uint8Array.from(code, (c) => c.charCodeAt(0));
    }
    case "busy":
      return new Uint8Array(0);
  }
}

function encodeAnswerPlaintext(answer: DeliveryAnswer): Uint8Array {
  const w = new Writer();
  u8.write(w, OUTCOMES[answer.outcome]);
  bytesVar(MAX_ANSWER_BODY).write(w, answerBody(answer));
  const head = w.finish();
  const plain = new Uint8Array(ANSWER_PLAINTEXT);
  plain.set(head);
  return plain;
}

function decodeAnswerPlaintext(plain: Uint8Array): DeliveryAnswer | null {
  try {
    const r = new Reader(plain);
    const outcome = r.uint(1);
    const body = bytesVar(MAX_ANSWER_BODY).read(r);
    if (r.take(r.remaining).some((b) => b !== 0)) return null;
    if (outcome === OUTCOMES.receipt)
      return body.length > 0 ? { outcome: "receipt", receipt: body } : null;
    if (outcome === OUTCOMES.refused)
      return isRefusalCode(body) ? { outcome: "refused", code: ascii(body) } : null;
    if (outcome === OUTCOMES.busy) return body.length === 0 ? { outcome: "busy" } : null;
    return null;
  } catch (e) {
    if (e instanceof DecodeError) return null;
    throw e;
  }
}

/**
 * Internal: the node's answer to a request it opened, under the given
 * `answer_nonce`. Production code calls `sealAnswer`; the package entry point
 * doesn't export this.
 */
export function sealAnswerWith(
  opened: DeliveryKey,
  answer: DeliveryAnswer,
  answerNonce: Uint8Array,
): Uint8Array {
  checkDeliveryKey(opened);
  if (!(answerNonce instanceof Uint8Array) || answerNonce.length !== 32)
    throw new RangeError("sealed answer: the answer nonce must be 32 bytes");
  const nonce = Uint8Array.from(answerNonce);
  const plain = encodeAnswerPlaintext(answer);
  const key = answerKey(opened.key, opened.requestHash, nonce);
  const sealed = chacha20poly1305(key, NONCE, answerAad(opened.requestHash)).encrypt(plain);
  key.fill(0);
  plain.fill(0);
  return encodeSealedAnswer({ answer_nonce: nonce, sealed });
}

/**
 * Seals the node's answer to a request it opened, under a fresh
 * `answer_nonce`, so answering one request again, as a relay's replay makes
 * a node do, never seals two plaintexts under one key (T-25).
 */
export function sealAnswer(opened: DeliveryKey, answer: DeliveryAnswer): Uint8Array {
  return sealAnswerWith(opened, answer, randomBytes(32));
}

export type SealedAnswerCode = "answer-malformed" | "answer-decrypt" | "answer-body";

export type SealedAnswerResult =
  | { readonly ok: true; readonly answer: DeliveryAnswer }
  | { readonly ok: false; readonly code: SealedAnswerCode };

/**
 * The answer check (docs/spec/sealed-delivery.md, Answer check), against the
 * client's own `K` and `request_hash` for the request it sent, never values
 * the answer supplies. A receipt that passes is only the node's word that it
 * sent it; it counts once it passes Client rule 1's `share-receipt` check.
 */
export function openSealedAnswer(sent: DeliveryKey, bytes: Uint8Array): SealedAnswerResult {
  checkDeliveryKey(sent);
  let answer: SealedAnswer;
  try {
    answer = decodeSealedAnswer(bytes, 1);
  } catch (e) {
    if (e instanceof DecodeError) return { ok: false, code: "answer-malformed" };
    throw e;
  }
  const key = answerKey(sent.key, sent.requestHash, answer.answer_nonce);
  const plain = aeadOpen(key, answerAad(sent.requestHash), answer.sealed);
  key.fill(0);
  if (plain === null) return { ok: false, code: "answer-decrypt" };
  const opened = decodeAnswerPlaintext(plain);
  plain.fill(0);
  return opened === null ? { ok: false, code: "answer-body" } : { ok: true, answer: opened };
}
