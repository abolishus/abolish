// Trustee identity keys, signatures and the panel identifier
// (docs/spec/trustee-identity.md, ADR 0012): ECDSA over P-256 with SHA-256 on
// `DS(tag, m)`, SEC 1 compressed keys, `r ‖ s` signatures with the low-s rule.
// The curve arithmetic, ECDSA and RFC 6979 are @noble/curves'; this module
// only fixes the encodings and the checks around them.

import { p256 } from "@noble/curves/nist.js";
import {
  bytesFixed,
  type Codec,
  DecodeError,
  encode,
  EncodeError,
  struct,
  u64,
  u8,
} from "./codec.ts";
import { ds, dsSignature, type SpecifiedTagOf } from "./domain-separation.ts";
import { H } from "./group.ts";

const Point = p256.Point;
const P = Point.Fp.ORDER;
const N = Point.Fn.ORDER;
const HALF_N = (N - 1n) / 2n;

/** `MAX_TRUSTEES` of docs/spec/parameters.md: the largest panel. */
export const MAX_TRUSTEES = 16;

/** A tag registered with the primitive Signature. */
export type SignatureTag = SpecifiedTagOf<"signature">;

function bigEndian(b: Uint8Array): bigint {
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
}

// Copies before checking the length: a Uint8Array subclass could report a
// false `length` while holding another number of bytes (codec.ts, copyBytes).
function bytesOf(x: unknown, length: number, what: string): Uint8Array {
  if (!(x instanceof Uint8Array) || !ArrayBuffer.isView(x))
    throw new TypeError(`${what}: expected ${length} bytes`);
  const copy = new Uint8Array(x);
  if (copy.length !== length) throw new TypeError(`${what}: expected ${length} bytes`);
  return copy;
}

/** Whether `b` (33 bytes) is a canonical compressed P-256 point. */
function isCanonicalKey(b: Uint8Array): boolean {
  // Only the compressed forms: the identity (0x00), uncompressed (0x04) and
  // hybrid (0x06, 0x07) encodings would give a key a second spelling (T-31).
  if (b[0] !== 0x02 && b[0] !== 0x03) return false;
  // x ≥ p would alias x − p; checked here rather than trusting the library's
  // decoder to reject it.
  if (bigEndian(b.subarray(1)) >= P) return false;
  try {
    // Rejects an x with no point on the curve. The cofactor is 1, so every
    // point but the identity has prime order: no subgroup check exists.
    Point.fromBytes(b);
  } catch {
    return false;
  }
  return true;
}

/**
 * `p256-key`: an identity key as its 33-byte SEC 1 compressed encoding. The
 * value is the encoding itself, so keys compare, hash and deduplicate as
 * bytes; every point but the identity has exactly one.
 */
export const p256Key: Codec<Uint8Array> = {
  minLength: 33,
  write(w, value) {
    const b =
      value instanceof Uint8Array && ArrayBuffer.isView(value) ? new Uint8Array(value) : null;
    if (b?.length !== 33 || !isCanonicalKey(b))
      throw new EncodeError("p256-key: expected a canonical compressed P-256 point");
    w.bytes(b);
  },
  read(r) {
    const at = r.offset;
    const b = new Uint8Array(r.take(33));
    if (!isCanonicalKey(b)) throw new DecodeError("non-canonical", at);
    return b;
  },
};

function isCanonicalSignature(b: Uint8Array): boolean {
  const r = bigEndian(b.subarray(0, 32));
  const s = bigEndian(b.subarray(32));
  // The low-s rule: (r, n − s) verifies whenever (r, s) does, so without it
  // anyone could re-encode a signature and the record that carries it (T-31).
  return r >= 1n && r < N && s >= 1n && s <= HALF_N;
}

/** `p256-sig`: `r ‖ s`, 32 bytes each big-endian, `1 ≤ r < n`, `1 ≤ s ≤ (n − 1) / 2`. */
export const p256Sig: Codec<Uint8Array> = {
  minLength: 64,
  write(w, value) {
    const b =
      value instanceof Uint8Array && ArrayBuffer.isView(value) ? new Uint8Array(value) : null;
    if (b?.length !== 64 || !isCanonicalSignature(b))
      throw new EncodeError("p256-sig: expected r ‖ s with 1 ≤ r < n and 1 ≤ s ≤ (n − 1) / 2");
    w.bytes(b);
  },
  read(r) {
    const at = r.offset;
    const b = new Uint8Array(r.take(64));
    if (!isCanonicalSignature(b)) throw new DecodeError("non-canonical", at);
    return b;
  },
};

function secretScalar(secretKey: unknown): Uint8Array {
  const d = bytesOf(secretKey, 32, "secretKey");
  const v = bigEndian(d);
  if (v < 1n || v >= N) throw new RangeError("secretKey: must be from 1 to n − 1");
  return d;
}

/** The identity key of a 32-byte big-endian secret scalar, for nodes and test ceremonies. */
export function identityKey(secretKey: Uint8Array): Uint8Array {
  return p256.getPublicKey(secretScalar(secretKey), true);
}

/**
 * Signs `m` under `tag`: ECDSA P-256 over `DS(tag, m)` with SHA-256, an RFC
 * 6979 deterministic nonce (no RNG at signing time, so no nonce reuse from a
 * broken one) and `s` normalised to the low half.
 */
export function signStatement(secretKey: Uint8Array, tag: SignatureTag, m: Uint8Array): Uint8Array {
  return signMessage(secretKey, dsSignature(tag, m));
}

/**
 * `Verify(Q, tag, m, sig)` of docs/spec/trustee-identity.md. False for any
 * key or signature that doesn't decode strictly (wrong length and high-s
 * included); a conforming verifier accepts exactly what this accepts.
 */
export function verifyStatement(
  key: Uint8Array,
  tag: SignatureTag,
  m: Uint8Array,
  sig: Uint8Array,
): boolean {
  return verifyMessage(key, dsSignature(tag, m), sig);
}

/**
 * ECDSA P-256/SHA-256 over the complete message `M`, low-s. Exported for the
 * published-vector tests (RFC 6979, Wycheproof), which sign raw messages;
 * the protocol signs only through `signStatement`, which frames `M` as
 * `DS(tag, m)`.
 */
export function signMessage(secretKey: Uint8Array, message: Uint8Array): Uint8Array {
  const sig = p256.sign(copyOf(message, "message"), secretScalar(secretKey), {
    prehash: true,
    lowS: true,
    format: "compact",
  });
  // The library's own guarantee, checked rather than assumed: only an
  // encoding the verifier accepts ever leaves this function.
  return encode(p256Sig, sig);
}

/** The verification rule over the complete message `M`; see `signMessage`. */
export function verifyMessage(key: Uint8Array, message: Uint8Array, sig: Uint8Array): boolean {
  const q = copyOf(key, "key");
  const s = copyOf(sig, "sig");
  const m = copyOf(message, "message");
  // Decoded by our own rules first: the library accepts uncompressed keys and
  // high s, which would give a key or signature a second encoding (T-31).
  if (q.length !== 33 || s.length !== 64 || !isCanonicalKey(q) || !isCanonicalSignature(s))
    return false;
  return p256.verify(s, m, q, { prehash: true, lowS: true, format: "compact" });
}

function copyOf(x: unknown, what: string): Uint8Array {
  if (!(x instanceof Uint8Array) || !ArrayBuffer.isView(x))
    throw new TypeError(`${what}: expected a Uint8Array`);
  return new Uint8Array(x);
}

/** A trustee panel: `k` and the seats' identity keys, seat 1 first. */
export interface Panel {
  readonly threshold: number;
  readonly keys: readonly Uint8Array[];
}

function checkedPanel(panel: Panel): { threshold: number; keys: Uint8Array[] } {
  if (panel === null || typeof panel !== "object") throw new TypeError("panel: expected an object");
  const { threshold } = panel;
  // Copied once, so the keys checked are the keys hashed.
  const keys = Array.isArray(panel.keys)
    ? panel.keys.map((k: unknown, i) => bytesOf(k, 33, `panel key ${i + 1}`))
    : null;
  if (keys === null) throw new TypeError("panel: keys must be an array");
  const n = keys.length;
  // T-14: k = 1 would let one trustee open every sharing alone.
  if (!Number.isSafeInteger(threshold) || threshold < 2 || threshold > n || n > MAX_TRUSTEES)
    throw new RangeError(`panel: need 2 ≤ k ≤ n ≤ ${MAX_TRUSTEES}`);
  const seen = new Set<string>();
  for (const [i, key] of keys.entries()) {
    if (!isCanonicalKey(key)) throw new RangeError(`panel: key ${i + 1} is not a P-256 key`);
    // Encodings are canonical, so equal points have equal bytes. T-14: one
    // key in two seats gives its holder two shares of every ballot.
    const hex = Array.from(key, (x) => x.toString(16).padStart(2, "0")).join("");
    if (seen.has(hex)) throw new RangeError(`panel: key ${i + 1} sits in two seats`);
    seen.add(hex);
  }
  return { threshold, keys };
}

/**
 * `panel_id = H(DS("abolish/v1/panel", u8(k) ‖ u8(n) ‖ Q_1 ‖ … ‖ Q_n))`.
 * Binds k, n, every key and its seat, so no definition can name a known
 * panel with a lower threshold, another order or a substituted key (T-37).
 */
export function panelId(panel: Panel): Uint8Array {
  return panelIdOf(checkedPanel(panel));
}

function panelIdOf({ threshold, keys }: { threshold: number; keys: Uint8Array[] }): Uint8Array {
  const input = new Uint8Array(2 + 33 * keys.length);
  input[0] = threshold;
  input[1] = keys.length;
  for (const [i, key] of keys.entries()) input.set(key, 2 + 33 * i);
  return H(ds("abolish/v1/panel", input));
}

/** The fields of a ceremony registration a signer supplies; the panel fixes the rest. */
export interface CeremonyRegistration {
  readonly l2ChainId: bigint;
  readonly trusteeRegistry: Uint8Array;
  readonly index: number;
  readonly stubHash: Uint8Array;
  readonly ceremonyTranscriptHash: Uint8Array;
}

const CEREMONY_REGISTRATION = struct([
  ["l2_chain_id", u64],
  ["trustee_registry", bytesFixed(20)],
  ["panel_id", bytesFixed(32)],
  ["index", u8],
  ["stub_hash", bytesFixed(32)],
  ["ceremony_transcript_hash", bytesFixed(32)],
] as const);

/**
 * The 125-byte statement `abolish/v1/sig/ceremony-registration` signs. The
 * panel identifier is computed from `panel`, never taken from the caller, and
 * the seat must be one of its seats.
 */
export function ceremonyRegistrationMessage(panel: Panel, reg: CeremonyRegistration): Uint8Array {
  return registration(checkedPanel(panel), reg).message;
}

// The statement and the key of its seat, both from one checked copy of the
// panel, so the key verified against is the key the identifier hashed.
function registration(
  checked: { threshold: number; keys: Uint8Array[] },
  reg: CeremonyRegistration,
): { message: Uint8Array; key: Uint8Array } {
  const key = Number.isSafeInteger(reg.index) ? checked.keys[reg.index - 1] : undefined;
  if (key === undefined || reg.index < 1)
    throw new RangeError("ceremony registration: index must be a seat of the panel");
  const message = encode(CEREMONY_REGISTRATION, {
    l2_chain_id: reg.l2ChainId,
    trustee_registry: reg.trusteeRegistry,
    panel_id: panelIdOf(checked),
    index: reg.index,
    stub_hash: reg.stubHash,
    ceremony_transcript_hash: reg.ceremonyTranscriptHash,
  });
  return { message, key };
}

/** Seat `reg.index`'s signature on a ceremony registration. */
export function signCeremonyRegistration(
  secretKey: Uint8Array,
  panel: Panel,
  reg: CeremonyRegistration,
): Uint8Array {
  const { message, key } = registration(checkedPanel(panel), reg);
  // A key outside its seat would sign a statement no verifier attributes to it.
  if (!equalBytes(identityKey(secretKey), key))
    throw new RangeError("ceremony registration: secretKey is not the key of seat index");
  return signStatement(secretKey, "abolish/v1/sig/ceremony-registration", message);
}

/**
 * Whether `sig` is seat `reg.index`'s signature on the registration, checked
 * against the key the pinned `panel` puts in that seat (T-37, T-71).
 */
export function verifyCeremonyRegistration(
  panel: Panel,
  reg: CeremonyRegistration,
  sig: Uint8Array,
): boolean {
  const { message, key } = registration(checkedPanel(panel), reg);
  return verifyStatement(key, "abolish/v1/sig/ceremony-registration", message, sig);
}

// Public keys, so timing doesn't matter; written without early exit anyway.
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return d === 0;
}
