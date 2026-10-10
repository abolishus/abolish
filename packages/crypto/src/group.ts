// The prime-order group, protocol hash and hash-to-group/scalar layer of
// docs/spec/group.md (docs/adr/0007-group-and-hash.md, option A): ristretto255
// (RFC 9496), SHA-256 as `H`, RFC 9380 `hash_to_ristretto255` and RFC 9497
// `HashToScalar`. Thin wrappers over @noble/curves and @noble/hashes: no group
// or field arithmetic is implemented here (T-39).

import { ristretto255, ristretto255_hasher } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { type Codec, DecodeError, EncodeError } from "./codec.ts";
import { assertSpecifiedTag, type SpecifiedTagOf } from "./domain-separation.ts";

const Point = ristretto255.Point;

/**
 * A ristretto255 group element: a point built by @noble/curves, typed by the
 * operations the protocol uses (the library doesn't export its class type).
 * Elements are immutable; every operation returns a new one.
 */
export interface Element {
  add(other: Element): Element;
  subtract(other: Element): Element;
  negate(): Element;
  /** Multiplication by a scalar in 1 to ℓ − 1, in constant time. */
  multiply(scalar: bigint): Element;
  equals(other: Element): boolean;
  is0(): boolean;
  toBytes(): Uint8Array;
}

/** ℓ, the order of the group: 2²⁵² + 27742317777372353535851937790883648493. */
export const GROUP_ORDER: bigint = Point.Fn.ORDER;

/** `g`, the RFC 9496 generator. */
export const G: Element = Point.BASE;

/** The identity element, whose only encoding is 32 zero bytes. */
export const IDENTITY: Element = Point.ZERO;

const isZero = (b: Uint8Array) => b.every((x) => x === 0);

/**
 * `scalar`: 32 bytes little-endian, value below ℓ (RFC 9497 `SerializeScalar`).
 * A value at or above ℓ is rejected, never reduced, so each scalar has exactly
 * one encoding (T-31).
 */
export const scalar: Codec<bigint> = {
  minLength: 32,
  write(w, value) {
    if (typeof value !== "bigint" || value < 0n || value >= GROUP_ORDER)
      throw new EncodeError("scalar: expected a bigint from 0 to ℓ - 1");
    const b = new Uint8Array(32);
    let v = value;
    for (let i = 0; i < 32; i++) {
      b[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    w.bytes(b);
  },
  read(r) {
    const at = r.offset;
    const b = r.take(32);
    let v = 0n;
    for (let i = 31; i >= 0; i--) v = (v << 8n) | BigInt(b[i] ?? 0);
    if (v >= GROUP_ORDER) throw new DecodeError("non-canonical", at);
    return v;
  },
};

function elementCodec(allowIdentity: boolean): Codec<Element> {
  return {
    minLength: 32,
    write(w, value) {
      // Only a point built by @noble/curves itself (a subclass could override
      // toBytes), encoded with the library's own method. A Proxy passes the
      // prototype check and can fake the coordinates, so the output is decoded
      // again: whatever the input, only a valid encoding is ever written.
      if (
        value === null ||
        typeof value !== "object" ||
        Object.getPrototypeOf(value) !== Point.prototype
      )
        throw new EncodeError("element: expected a ristretto255 point");
      let b: Uint8Array;
      try {
        b = Point.prototype.toBytes.call(value as InstanceType<typeof Point>);
        Point.fromBytes(b);
      } catch {
        throw new EncodeError("element: not a valid ristretto255 point");
      }
      if (!allowIdentity && isZero(b)) throw new EncodeError("element: the identity isn't allowed");
      w.bytes(b);
    },
    read(r) {
      const at = r.offset;
      const b = r.take(32);
      // RFC 9496 Decode rejects every non-canonical encoding, and the group
      // has prime order, so there is no subgroup to check (T-31, T-39).
      let p: InstanceType<typeof Point>;
      try {
        p = Point.fromBytes(b);
      } catch {
        throw new DecodeError("non-canonical", at);
      }
      if (!allowIdentity && isZero(b)) throw new DecodeError("non-canonical", at);
      return p;
    },
  };
}

/**
 * `element`: the 32-byte RFC 9496 encoding of a group element other than the
 * identity. Trustee keys, DH keys and ephemerals and `h` are never the
 * identity: an identity ephemeral makes the DH value trivial (T-39).
 */
export const element: Codec<Element> = elementCodec(false);

/** `element`, in a field the spec explicitly allows to hold the identity. */
export const elementOrIdentity: Codec<Element> = elementCodec(true);

/** `H`: SHA-256 (FIPS 180-4), the protocol hash. Inputs are `DS(tag, m)`. */
export function H(message: Uint8Array): Uint8Array {
  if (!(message instanceof Uint8Array) || !ArrayBuffer.isView(message))
    throw new TypeError("H: message must be a Uint8Array");
  return sha256(new Uint8Array(message));
}

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

/**
 * The `DST`, checked: RFC 9380 §5.3.1 aborts above 255 bytes (§5.3.3 hashes
 * longer ones down) and §3.1 recommends at least 16, which docs/spec requires.
 * There is no default: @noble/curves would substitute its own (ADR 0007).
 */
function checkDst(dst: Uint8Array): Uint8Array {
  if (!(dst instanceof Uint8Array) || !ArrayBuffer.isView(dst))
    throw new TypeError("DST must be a Uint8Array");
  if (dst.length < 16 || dst.length > 255) throw new RangeError("DST must be 16 to 255 bytes");
  return new Uint8Array(dst);
}

function checkMessage(message: Uint8Array): Uint8Array {
  if (!(message instanceof Uint8Array) || !ArrayBuffer.isView(message))
    throw new TypeError("message must be a Uint8Array");
  return new Uint8Array(message);
}

/**
 * RFC 9497 §4.1 `HashToScalar` for ristretto255-SHA512 under an explicit
 * `DST`: `expand_message_xmd` over SHA-512 to 64 bytes, read little-endian and
 * reduced modulo ℓ, so the result is within about 2⁻²⁶² of uniform whatever
 * the shape of ℓ (T-30). Protocol code calls `challenge`; this takes any `DST`
 * so the published vectors under other `DST`s can test it.
 */
export function hashToScalarXmd(message: Uint8Array, dst: Uint8Array): bigint {
  return ristretto255_hasher.hashToScalar(checkMessage(message), { DST: checkDst(dst) });
}

/**
 * RFC 9380 Appendix B `hash_to_ristretto255` under an explicit `DST`:
 * `expand_message_xmd` over SHA-512 to 64 bytes, then RFC 9496 element
 * derivation. Protocol code calls `hashToGroup`.
 */
export function hashToRistretto255(message: Uint8Array, dst: Uint8Array): Element {
  return ristretto255_hasher.hashToCurve(checkMessage(message), { DST: checkDst(dst) });
}

/**
 * A Fiat–Shamir challenge: `HashToScalar(t)` with the tag as `DST`, where `t`
 * is the canonical encoding of the whole statement and every prover
 * commitment, laid out in the proof's own section (T-30).
 */
export function challenge(tag: SpecifiedTagOf<"fiat-shamir">, statement: Uint8Array): bigint {
  assertSpecifiedTag(tag, ["fiat-shamir"]);
  return hashToScalarXmd(statement, ascii(tag));
}

/** Hash-to-group under a registered hash-to-curve tag, as its `DST`. */
export function hashToGroup(tag: SpecifiedTagOf<"hash-to-curve">, message: Uint8Array): Element {
  assertSpecifiedTag(tag, ["hash-to-curve"]);
  return hashToRistretto255(message, ascii(tag));
}

/**
 * `h`, the second Pedersen generator: `hash_to_ristretto255("", DST =
 * "abolish/v1/generator-h")`, so no one chose it and no one knows its
 * discrete log relative to `g` (T-15; docs/adr/0002-everlasting-privacy.md).
 */
export const GENERATOR_H: Element = hashToGroup("abolish/v1/generator-h", new Uint8Array());
