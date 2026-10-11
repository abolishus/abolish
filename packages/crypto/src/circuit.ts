// Circuit-facing values (docs/spec/notation.md, Circuit-facing values;
// docs/spec/domain-separation.md, In-circuit hashes): how tags and bytes become
// BN254 field elements, the same way packages/circuits does in Noir, so the
// in-circuit and off-circuit forms can't drift (T-31, T-30).

import { ds, isWellFormedTag } from "./domain-separation.ts";
import { H } from "./group.ts";

/** Bytes per field element when packing: 31 bytes is 248 bits, below the BN254 order. */
export const PACK_CHUNK = 31;

function bytesOf(x: unknown, what: string): Uint8Array {
  if (!(x instanceof Uint8Array) || !ArrayBuffer.isView(x))
    throw new TypeError(`${what}: expected a Uint8Array`);
  // Copied, so the length checked and the bytes read are the same.
  return new Uint8Array(x);
}

function bigEndian(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

/**
 * `tag_field(tag) = int(H(DS("abolish/v1/circuit-tag", tag))) >> 8`: the one
 * field element by which a tag enters a circuit. Circuits embed it as a
 * constant; deriving it from the registered string, rather than choosing a
 * constant per circuit, means a circuit and an off-circuit implementation of
 * the same hash can't use different tags. The shift leaves 248 bits, so the
 * value is below the field order with no reduction, as Semaphore's `F`.
 */
export function circuitTagField(tag: string): bigint {
  if (typeof tag !== "string" || !isWellFormedTag(tag))
    throw new RangeError("circuitTagField: not a well-formed tag");
  const ascii = new Uint8Array(tag.length);
  // The grammar admits only ASCII, so each character is one byte.
  for (let i = 0; i < tag.length; i++) ascii[i] = tag.charCodeAt(i);
  return bigEndian(H(ds("abolish/v1/circuit-tag", ascii))) >> 8n;
}

/**
 * Packs `bytes[N]` into `ceil(N / 31)` field elements: chunk `i` is bytes
 * `[31i, min(31i + 31, N))` read big-endian. `N` is fixed by the type, so a
 * short last chunk is unambiguous.
 */
export function packBytes(bytes: Uint8Array): bigint[] {
  const b = bytesOf(bytes, "packBytes");
  const out: bigint[] = [];
  for (let i = 0; i < b.length; i += PACK_CHUNK) out.push(bigEndian(b.subarray(i, i + PACK_CHUNK)));
  return out;
}

/**
 * Packs a `bytes<max>` or `utf8<max>` value: its length, then its content
 * zero-padded to `max` bytes and packed as `bytes[max]`. The circuit checks
 * that every padding byte is zero, so each value has one packing (T-31).
 */
export function packBoundedBytes(bytes: Uint8Array, max: number): bigint[] {
  const b = bytesOf(bytes, "packBoundedBytes");
  if (!Number.isSafeInteger(max) || max < 0)
    throw new RangeError("packBoundedBytes: max must be a non-negative integer");
  if (b.length > max) throw new RangeError("packBoundedBytes: longer than max");
  const padded = new Uint8Array(max);
  padded.set(b);
  return [BigInt(b.length), ...packBytes(padded)];
}
