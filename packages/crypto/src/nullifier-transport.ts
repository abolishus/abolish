// The Tier 2 keyed nullifier's transport (docs/spec/nullifier-transport.md;
// ADR 0022, Consequences, Channels; record types 0x0022 and 0x0023): a
// client seals its query to each seat's registration KEM key and names a
// fresh client key, and each seat seals its answer to that key, so a relay or
// an eavesdropper never holds a query, its proof's witness or a `(B, Z_i)`
// pair (T-15). The hybrid KEM, its combiner and the AEAD are share
// encryption's, under this channel's own tags; ML-KEM, ristretto255 and
// ChaCha20-Poly1305 are @noble's, and this module only composes them.

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import {
  bytesFixed,
  bytesVar,
  type CodecValue,
  DecodeError,
  decode,
  encode,
  struct,
  u16,
  u8,
  Writer,
} from "./codec.ts";
import { ds, type SpecifiedTagOf } from "./domain-separation.ts";
import { type Element, element, G, GROUP_ORDER, H } from "./group.ts";
import {
  decodeNullifierAnswer,
  encodeNullifierAnswer,
  type NullifierAnswer,
} from "./keyed-nullifier.ts";
import {
  decodeNullifierQuery,
  encodeNullifierQuery,
  type NullifierQueryRecord,
} from "./nullifier-query.ts";
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

/**
 * The longest query record version 1 encodes (a 3-byte header, 228 bytes of
 * fields, the proof's 4-byte length and at most 65,536 bytes), and the tag.
 */
export const MAX_REQUEST_SEALED = 3 + 228 + 4 + 65_536 + AEAD_TAG_LEN;

/** A nullifier answer record (0x0010, version 1) and the tag. */
const REPLY_SEALED = 356 + AEAD_TAG_LEN;

const requestV1 = struct([
  ["key_id", bytesFixed(32)],
  ["seat", u8],
  ["reply_key", KEM_PUBLIC_KEY],
  ["ct_mlkem", bytesFixed(MLKEM_CT_LEN)],
  ["ct_dh", element],
  ["sealed", bytesVar(MAX_REQUEST_SEALED)],
] as const);

const replyV1 = struct([
  ["request_hash", bytesFixed(32)],
  ["seat", u8],
  ["ct_mlkem", bytesFixed(MLKEM_CT_LEN)],
  ["ct_dh", element],
  ["sealed", bytesFixed(REPLY_SEALED)],
] as const);

/** A nullifier request, version 1 (docs/spec/nullifier-transport.md, Request). */
export type NullifierRequest = CodecValue<typeof requestV1>;

/** A nullifier reply, version 1 (docs/spec/nullifier-transport.md, Reply). */
export type NullifierReply = CodecValue<typeof replyV1>;

/** Record type `0x0022`. Never on the board; the Tier 2 key fixes its version. */
export const NULLIFIER_REQUEST = recordType(RECORD_TYPES.nullifierRequest, { 1: requestV1 });

/** Record type `0x0023`. Never on the board; the Tier 2 key fixes its version. */
export const NULLIFIER_REPLY = recordType(RECORD_TYPES.nullifierReply, { 1: replyV1 });

const SCHEMA = new RecordSchema([NULLIFIER_REQUEST, NULLIFIER_REPLY]);

export function encodeNullifierRequest(request: NullifierRequest): Uint8Array {
  return SCHEMA.encode(NULLIFIER_REQUEST, VERSION, request);
}

/** Strictly decodes a request under version 1, the version the Tier 2 key fixes. */
export function decodeNullifierRequest(bytes: Uint8Array, pinned: 1): NullifierRequest {
  return SCHEMA.decode(NULLIFIER_REQUEST, bytes, pinned).value;
}

export function encodeNullifierReply(reply: NullifierReply): Uint8Array {
  return SCHEMA.encode(NULLIFIER_REPLY, VERSION, reply);
}

/** Strictly decodes a reply under version 1, the version the Tier 2 key fixes. */
export function decodeNullifierReply(bytes: Uint8Array, pinned: 1): NullifierReply {
  return SCHEMA.decode(NULLIFIER_REPLY, bytes, pinned).value;
}

/** `request_hash`, over the request's full record encoding: what its reply binds. */
export function nullifierRequestHash(encoded: Uint8Array): Uint8Array {
  return H(ds("abolish/v1/keyed-nullifier/request", encoded));
}

/** The ML-KEM message and DH ephemeral that seal one request or reply. */
export interface SealRandomness {
  readonly mu: Uint8Array;
  readonly e: bigint;
}

/** A qualified seat of the key, as the key's checked transcript lists it. */
export interface RequestRecipient {
  readonly index: number;
  readonly kemKey: KemPublicKey;
}

type KemTag = SpecifiedTagOf<"kdf-aead">;

// Each AEAD key seals exactly one message: it hashes a fresh 32-byte ML-KEM
// message and a fresh ephemeral, so a fixed nonce never repeats under a key.
const NONCE = new Uint8Array(12);

/** `K`: share encryption's X-Wing-style combiner, under the channel's own tag. */
function combine(tag: KemTag, ssM: Uint8Array, ssDh: Element, ctDh: Element, dh: Element) {
  const w = new Writer();
  w.bytes(ssM);
  element.write(w, ssDh);
  element.write(w, ctDh);
  element.write(w, dh);
  return H(ds(tag, w.finish()));
}

function requestAad(keyId: Uint8Array, seat: number, replyKey: KemPublicKey): Uint8Array {
  const w = new Writer();
  u16.write(w, RECORD_TYPES.nullifierRequest);
  u8.write(w, VERSION);
  w.bytes(keyId);
  u8.write(w, seat);
  KEM_PUBLIC_KEY.write(w, replyKey);
  return ds("abolish/v1/kem/nullifier-request-aad", w.finish());
}

function replyAad(requestHash: Uint8Array, seat: number): Uint8Array {
  const w = new Writer();
  u16.write(w, RECORD_TYPES.nullifierReply);
  u8.write(w, VERSION);
  w.bytes(requestHash);
  u8.write(w, seat);
  return ds("abolish/v1/kem/nullifier-reply-aad", w.finish());
}

function seal(
  tag: KemTag,
  recipient: KemPublicKey,
  aad: Uint8Array,
  plain: Uint8Array,
  randomness: SealRandomness,
): { readonly ct_mlkem: Uint8Array; readonly ct_dh: Element; readonly sealed: Uint8Array } {
  const { mu, e } = randomness;
  if (!(mu instanceof Uint8Array) || mu.length !== MLKEM_MSG_LEN)
    throw new RangeError("nullifier transport: mu must be 32 bytes");
  if (typeof e !== "bigint" || e <= 0n || e >= GROUP_ORDER)
    throw new RangeError("nullifier transport: e must be a scalar from 1 to ℓ − 1");
  // Round-trips the key through its codec: the modulus check and a
  // non-identity DH key, whatever the caller passed (T-39).
  const key = decode(KEM_PUBLIC_KEY, encode(KEM_PUBLIC_KEY, recipient));
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(key.ek, mu);
  const ctDh = G.multiply(e);
  const k = combine(tag, sharedSecret, key.dh.multiply(e), ctDh, key.dh);
  sharedSecret.fill(0);
  const sealed = chacha20poly1305(k, NONCE, aad).encrypt(plain);
  k.fill(0);
  return { ct_mlkem: cipherText, ct_dh: ctDh, sealed };
}

/**
 * The plaintext under `sealed`, or `null` if the AEAD doesn't open. Nothing
 * about the decapsulation leaves this function: ML-KEM's implicit rejection
 * returns a pseudorandom secret for a malformed `ct_M`, and revealing it
 * would leak the key (T-39). Whether the AEAD opened is all a caller learns.
 */
function open(
  tag: KemTag,
  secret: KemSecretKey,
  aad: Uint8Array,
  msg: { readonly ct_mlkem: Uint8Array; readonly ct_dh: Element; readonly sealed: Uint8Array },
): Uint8Array | null {
  encode(KEM_SECRET_KEY, secret);
  const { secretKey: dk } = ml_kem768.keygen(secret.seed);
  const ssM = ml_kem768.decapsulate(msg.ct_mlkem, dk);
  dk.fill(0);
  const k = combine(tag, ssM, msg.ct_dh.multiply(secret.x), msg.ct_dh, G.multiply(secret.x));
  ssM.fill(0);
  try {
    return chacha20poly1305(k, NONCE, aad).decrypt(msg.sealed);
  } catch {
    return null;
  } finally {
    k.fill(0);
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Internal: a request sealing `query` to `recipient` under the given
 * randomness. Production code calls `sealNullifierRequest`; the package entry
 * point doesn't export this.
 */
export function sealNullifierRequestWith(
  recipient: RequestRecipient,
  replyKey: KemPublicKey,
  query: NullifierQueryRecord,
  randomness: SealRandomness,
): Uint8Array {
  const plain = encodeNullifierQuery(query);
  const keyId = Uint8Array.from(query.key_id);
  return encodeNullifierRequest({
    key_id: keyId,
    seat: recipient.index,
    reply_key: replyKey,
    ...seal(
      "abolish/v1/kem/nullifier-request",
      recipient.kemKey,
      requestAad(keyId, recipient.index, replyKey),
      plain,
      randomness,
    ),
  });
}

/**
 * Seals `query` to one qualified seat of the key it is asked under, with
 * `replyKey`, the client key made fresh for this query (`kemKeygen`), for the
 * reply. `recipient` comes from the key's checked transcript
 * (`checkNullifierKeyTranscript`'s `qualified`, or the reshare check's),
 * never from the seat or a relay.
 */
export function sealNullifierRequest(
  recipient: RequestRecipient,
  replyKey: KemPublicKey,
  query: NullifierQueryRecord,
): Uint8Array {
  return sealNullifierRequestWith(recipient, replyKey, query, {
    mu: randomBytes(MLKEM_MSG_LEN),
    e: nonZeroRandom(),
  });
}

/** One key a seat holds a share of: its `key_id`, its index and its registration KEM secret. */
export interface RequestHolder {
  readonly keyId: Uint8Array;
  readonly seat: number;
  readonly secretKey: KemSecretKey;
}

export type RequestCode = "request-malformed" | "request-key" | "request-decrypt" | "request-query";

export type RequestResult =
  | {
      readonly ok: true;
      readonly keyId: Uint8Array;
      readonly seat: number;
      /** The query, which the seat checks next (`checkNullifierQuery`) before it answers. */
      readonly query: NullifierQueryRecord;
      readonly replyKey: KemPublicKey;
      readonly requestHash: Uint8Array;
    }
  | { readonly ok: false; readonly code: RequestCode };

/**
 * The request check (docs/spec/nullifier-transport.md, Request check), up to
 * the query check: `holders` are the keys the seat holds a share of, none
 * retired. A failure carries its code alone, which is all a seat may say.
 */
export function openNullifierRequest(
  holders: readonly RequestHolder[],
  bytes: Uint8Array,
): RequestResult {
  let request: NullifierRequest;
  try {
    request = decodeNullifierRequest(bytes, 1);
  } catch (e) {
    if (e instanceof DecodeError) return { ok: false, code: "request-malformed" };
    throw e;
  }
  const holder = holders.find((h) => equalBytes(h.keyId, request.key_id));
  if (holder === undefined || holder.seat !== request.seat)
    return { ok: false, code: "request-key" };
  const plain = open(
    "abolish/v1/kem/nullifier-request",
    holder.secretKey,
    requestAad(request.key_id, request.seat, request.reply_key),
    request,
  );
  if (plain === null) return { ok: false, code: "request-decrypt" };
  let query: NullifierQueryRecord;
  try {
    query = decodeNullifierQuery(plain, 1);
  } catch (e) {
    if (e instanceof DecodeError) return { ok: false, code: "request-query" };
    throw e;
  }
  if (!equalBytes(query.key_id, request.key_id)) return { ok: false, code: "request-query" };
  return {
    ok: true,
    keyId: request.key_id,
    seat: request.seat,
    query,
    replyKey: request.reply_key,
    requestHash: nullifierRequestHash(bytes),
  };
}

/** What a seat answers: a request that passed `openNullifierRequest`. */
export interface OpenedRequest {
  readonly seat: number;
  readonly replyKey: KemPublicKey;
  readonly requestHash: Uint8Array;
}

/**
 * Internal: the reply sealing `answer` for `request` under the given
 * randomness. Production code calls `sealNullifierReply`; the package entry
 * point doesn't export this.
 */
export function sealNullifierReplyWith(
  request: OpenedRequest,
  answer: NullifierAnswer,
  randomness: SealRandomness,
): Uint8Array {
  if (answer.seat !== request.seat)
    throw new RangeError("nullifier transport: the answer must be the request's seat's");
  const requestHash = Uint8Array.from(request.requestHash);
  return encodeNullifierReply({
    request_hash: requestHash,
    seat: request.seat,
    ...seal(
      "abolish/v1/kem/nullifier-reply",
      request.replyKey,
      replyAad(requestHash, request.seat),
      encodeNullifierAnswer(answer),
      randomness,
    ),
  });
}

/** Seals the seat's answer to the request's client key. */
export function sealNullifierReply(request: OpenedRequest, answer: NullifierAnswer): Uint8Array {
  return sealNullifierReplyWith(request, answer, {
    mu: randomBytes(MLKEM_MSG_LEN),
    e: nonZeroRandom(),
  });
}

/** A request the client sent: its hash, its seat and the query's client secret. */
export interface SentRequest {
  readonly requestHash: Uint8Array;
  readonly seat: number;
  readonly secretKey: KemSecretKey;
}

export type ReplyCode = "reply-malformed" | "reply-request" | "reply-decrypt" | "reply-answer";

export type ReplyResult =
  | {
      readonly ok: true;
      /** The answer, which the client checks next (`checkNullifierAnswer`) before combining. */
      readonly answer: NullifierAnswer;
    }
  | { readonly ok: false; readonly code: ReplyCode };

/**
 * The reply check (docs/spec/nullifier-transport.md, Reply check), up to the
 * answer check, against the request the client sent, never values the reply
 * supplies.
 */
export function openNullifierReply(sent: SentRequest, bytes: Uint8Array): ReplyResult {
  let reply: NullifierReply;
  try {
    reply = decodeNullifierReply(bytes, 1);
  } catch (e) {
    if (e instanceof DecodeError) return { ok: false, code: "reply-malformed" };
    throw e;
  }
  if (!equalBytes(reply.request_hash, sent.requestHash) || reply.seat !== sent.seat)
    return { ok: false, code: "reply-request" };
  const plain = open(
    "abolish/v1/kem/nullifier-reply",
    sent.secretKey,
    replyAad(sent.requestHash, sent.seat),
    reply,
  );
  if (plain === null) return { ok: false, code: "reply-decrypt" };
  try {
    return { ok: true, answer: decodeNullifierAnswer(plain, 1) };
  } catch (e) {
    if (e instanceof DecodeError) return { ok: false, code: "reply-answer" };
    throw e;
  }
}
