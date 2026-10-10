// Strict encoders and decoders for the primitive types of
// docs/spec/notation.md (option A of docs/adr/0001-canonical-encoding.md).
// Every value has exactly one encoding and every accepted byte string
// re-encodes to itself (T-31); decoders reject, never repair (T-36); lengths
// are checked before anything is read or allocated (T-52).

import { isWellFormedUtf8 } from "./utf8.ts";

/** The decode error codes of docs/spec/notation.md, "Strict decoding". */
export type DecodeErrorCode =
  | "truncated"
  | "trailing-bytes"
  | "length-over-max"
  | "unknown-record-type"
  | "unexpected-record-type"
  | "unknown-version"
  | "invalid-enum"
  | "invalid-utf8"
  | "non-canonical"
  | "profile-mismatch";

/** Input bytes rejected by a strict decoder. */
export class DecodeError extends Error {
  override readonly name = "DecodeError";
  constructor(
    readonly code: DecodeErrorCode,
    /** Offset in the input where the failing field starts. */
    readonly offset: number,
  ) {
    super(`${code} at byte ${offset}`);
  }
}

/** A value that has no encoding under its type; the encoder never emits a substitute. */
export class EncodeError extends Error {
  override readonly name = "EncodeError";
}

/** Reads a complete input left to right; every read is bounds-checked first. */
export class Reader {
  #offset = 0;
  readonly #bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    // Any other typed array would yield values outside their type (a
    // Uint16Array element of 300 read as a u8).
    // A Proxy has no typed-array slots, so isView is false for it.
    if (!(bytes instanceof Uint8Array) || !ArrayBuffer.isView(bytes))
      throw new TypeError("decode: input must be a Uint8Array");
    // Copied once, into a plain Uint8Array: nothing decoded can alias the
    // caller's buffer (a Buffer's slice is a view), and bytes in shared memory
    // can't change between a check and the copy that is returned.
    this.#bytes = new Uint8Array(bytes);
  }

  get offset(): number {
    return this.#offset;
  }

  get remaining(): number {
    return this.#bytes.length - this.#offset;
  }

  /** The next `n` bytes, as a view into the input. */
  take(n: number): Uint8Array {
    if (n > this.remaining) throw new DecodeError("truncated", this.#offset);
    const out = this.#bytes.subarray(this.#offset, this.#offset + n);
    this.#offset += n;
    return out;
  }

  uint(width: 1 | 2 | 4): number {
    const b = this.take(width);
    let v = 0;
    for (const x of b) v = v * 256 + x;
    return v;
  }

  /** Rejects anything left after the last field. */
  end(): void {
    if (this.remaining !== 0) throw new DecodeError("trailing-bytes", this.#offset);
  }
}

/** Accumulates an encoding. */
export class Writer {
  readonly #chunks: Uint8Array[] = [];
  #length = 0;

  bytes(b: Uint8Array): void {
    // Copied, so a caller mutating its buffer later can't change the output.
    const c = copyBytes(b, "bytes");
    this.#chunks.push(c);
    this.#length += c.length;
  }

  uint(width: 1 | 2 | 4, v: number): void {
    // Never wraps: a value that doesn't fit has no encoding at this width.
    checkUint(v, 2 ** (8 * width) - 1, `u${8 * width}`);
    const b = new Uint8Array(width);
    for (let i = width - 1; i >= 0; i--) {
      b[i] = v % 256;
      v = Math.floor(v / 256);
    }
    this.#chunks.push(b);
    this.#length += width;
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.#length);
    let at = 0;
    for (const c of this.#chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

/**
 * A primitive or composite type. `write` validates the value and throws
 * `EncodeError` rather than emit bytes the spec doesn't define; `read`
 * consumes exactly one encoding or throws `DecodeError`.
 */
export interface Codec<T> {
  /** Length of the shortest encoding. A list element type never has 0 (notation.md). */
  readonly minLength: number;
  write(w: Writer, value: T): void;
  read(r: Reader): T;
}

export type CodecValue<C> = C extends Codec<infer T> ? T : never;

/** The encoding of a value that is not a record (records use `RecordSchema`). */
export function encode<T>(codec: Codec<T>, value: T): Uint8Array {
  const w = new Writer();
  codec.write(w, value);
  return w.finish();
}

/** Strictly decodes a complete input as one value of `codec`'s type. */
export function decode<T>(codec: Codec<T>, bytes: Uint8Array): T {
  const r = new Reader(bytes);
  const value = codec.read(r);
  r.end();
  return value;
}

const MAX_U32 = 0xffff_ffff;

function checkUint(value: unknown, max: number, what: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max)
    throw new EncodeError(`${what}: expected an integer from 0 to ${max}`);
}

/**
 * A plain copy of a byte array, made before anything is validated so the
 * checks and the output see the same bytes. `new Uint8Array(typedArray)` reads
 * the source's internal slots, not its `length` or iterator, so a subclass
 * can't lie about its contents; `ArrayBuffer.isView` is false for a Proxy,
 * which has no such slots.
 */
function copyBytes(value: unknown, what: string): Uint8Array {
  if (!(value instanceof Uint8Array) || !ArrayBuffer.isView(value))
    throw new EncodeError(`${what}: expected a Uint8Array`);
  return new Uint8Array(value);
}

function checkMax(max: number, what: string): void {
  if (!Number.isInteger(max) || max < 0 || max > MAX_U32)
    throw new RangeError(`${what}: maximum must be an integer from 0 to 2^32 - 1`);
}

function uint(width: 1 | 2 | 4): Codec<number> {
  const max = 2 ** (8 * width) - 1;
  const what = `u${8 * width}`;
  return {
    minLength: width,
    write(w, value) {
      checkUint(value, max, what);
      w.uint(width, value);
    },
    read: (r) => r.uint(width),
  };
}

export const u8: Codec<number> = uint(1);
export const u16: Codec<number> = uint(2);
export const u32: Codec<number> = uint(4);

const MAX_U64 = (1n << 64n) - 1n;

/** `u64`, as a bigint: a JavaScript number can't hold every value exactly. */
export const u64: Codec<bigint> = {
  minLength: 8,
  write(w, value) {
    if (typeof value !== "bigint" || value < 0n || value > MAX_U64)
      throw new EncodeError("u64: expected a bigint from 0 to 2^64 - 1");
    w.uint(4, Number(value >> 32n));
    w.uint(4, Number(value & 0xffff_ffffn));
  },
  read(r) {
    const hi = BigInt(r.uint(4));
    return (hi << 32n) | BigInt(r.uint(4));
  },
};

export const bool: Codec<boolean> = {
  minLength: 1,
  write(w, value) {
    if (typeof value !== "boolean") throw new EncodeError("bool: expected a boolean");
    w.uint(1, value ? 1 : 0);
  },
  read(r) {
    const at = r.offset;
    const b = r.uint(1);
    if (b > 1) throw new DecodeError("invalid-enum", at);
    return b === 1;
  },
};

/** `enum8<…>`: a `u8` restricted to the listed values. */
export function enum8<const V extends number>(values: readonly V[]): Codec<V> {
  const allowed = new Set<number>(values);
  if (allowed.size === 0 || allowed.size !== values.length)
    throw new RangeError("enum8: values must be non-empty and distinct");
  for (const v of values) checkUint(v, 0xff, "enum8 value");
  return {
    minLength: 1,
    write(w, value) {
      if (!allowed.has(value)) throw new EncodeError(`enum8: ${String(value)} is not listed`);
      w.uint(1, value);
    },
    read(r) {
      const at = r.offset;
      const b = r.uint(1);
      if (!allowed.has(b)) throw new DecodeError("invalid-enum", at);
      return b as V;
    },
  };
}

/** `bytes[N]`: exactly `n` bytes, no prefix. */
export function bytesFixed(n: number): Codec<Uint8Array> {
  checkMax(n, "bytes[N]");
  return {
    minLength: n,
    write(w, value) {
      const b = copyBytes(value, `bytes[${n}]`);
      if (b.length !== n) throw new EncodeError(`bytes[${n}]: got ${b.length} bytes`);
      w.bytes(b);
    },
    read: (r) => r.take(n).slice(),
  };
}

function prefixed(max: number, what: string, valid: (b: Uint8Array) => boolean): Codec<Uint8Array> {
  checkMax(max, what);
  return {
    minLength: 4,
    write(w, value) {
      const b = copyBytes(value, what);
      if (b.length > max) throw new EncodeError(`${what}: ${b.length} bytes is over ${max}`);
      if (!valid(b)) throw new EncodeError(`${what}: not well-formed UTF-8`);
      w.uint(4, b.length);
      w.bytes(b);
    },
    read(r) {
      const at = r.offset;
      const n = r.uint(4);
      // T-52: the length is checked against its maximum before anything is
      // read, and `take` checks it against the input before any copy.
      if (n > max) throw new DecodeError("length-over-max", at);
      const content = r.take(n);
      if (!valid(content)) throw new DecodeError("invalid-utf8", at);
      return content.slice();
    },
  };
}

/** `bytes<M>`: a `u32` length, at most `max`, then that many bytes. */
export function bytesVar(max: number): Codec<Uint8Array> {
  return prefixed(max, `bytes<${max}>`, () => true);
}

/**
 * `utf8<M>`: as `bytes<M>`, holding well-formed UTF-8 (RFC 3629). The value is
 * the exact bytes: nothing is normalised, and a leading U+FEFF is kept.
 */
export function utf8(max: number): Codec<Uint8Array> {
  return prefixed(max, `utf8<${max}>`, isWellFormedUtf8);
}

/** Order of the BN254 scalar field (docs/spec/notation.md, `field<bn254>`). */
export const BN254_R = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;

/** `field<bn254>`: 32 bytes big-endian, below `BN254_R`; one encoding per element (T-04, T-31). */
export const fieldBn254: Codec<bigint> = {
  minLength: 32,
  write(w, value) {
    if (typeof value !== "bigint" || value < 0n || value >= BN254_R)
      throw new EncodeError("field<bn254>: expected a bigint from 0 to r - 1");
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
    if (v >= BN254_R) throw new DecodeError("non-canonical", at);
    return v;
  },
};

/** `list<T, M>`: a `u32` element count, at most `max`, then each element. */
export function list<T>(of: Codec<T>, max: number): Codec<readonly T[]> {
  checkMax(max, "list");
  // notation.md: a list's element type is never zero-width, so a count can't
  // stand for any number of elements read from no bytes (T-52).
  if (of.minLength === 0) throw new RangeError("list: element type must not be zero-width");
  return {
    minLength: 4,
    write(w, value) {
      if (!Array.isArray(value)) throw new EncodeError("list: expected an array");
      // The length is read once and the elements by index, so an overridden
      // iterator or a proxy can't make the count disagree with the elements.
      const items = value as readonly T[];
      const n = items.length;
      if (n > max) throw new EncodeError(`list: ${n} elements is over ${max}`);
      w.uint(4, n);
      for (let i = 0; i < n; i++) of.write(w, items[i] as T);
    },
    read(r) {
      const at = r.offset;
      const count = r.uint(4);
      if (count > max) throw new DecodeError("length-over-max", at);
      // Grown one element at a time, each read and validated before the next
      // (notation.md), so a hostile count can't make us allocate.
      const out: T[] = [];
      for (let i = 0; i < count; i++) out.push(of.read(r));
      return out;
    },
  };
}

type Fields = readonly (readonly [string, Codec<unknown>])[];

export type StructValue<F extends Fields> = {
  readonly [E in F[number] as E[0]]: CodecValue<E[1]>;
};

const FIELD_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * A structure: its fields in table order, with no header, prefix or padding
 * (notation.md, "Records"). Values are plain objects with exactly these keys.
 */
export function struct<const F extends Fields>(fields: F): Codec<StructValue<F>> {
  const names = fields.map(([name]) => name);
  for (const name of names)
    if (!FIELD_NAME.test(name)) throw new RangeError(`struct: bad field name ${name}`);
  const fieldSet: ReadonlySet<string | symbol> = new Set(names);
  if (fieldSet.size !== names.length) throw new RangeError("struct: duplicate field name");
  return {
    minLength: fields.reduce((n, [, c]) => n + c.minLength, 0),
    write(w, value) {
      if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new EncodeError("struct: expected an object");
      // No optional fields and no extras (notation.md): a value with any other
      // set of keys has no encoding under this type.
      // Every own key counts, including symbols and non-enumerable ones.
      const keys = Reflect.ownKeys(value);
      if (keys.length !== names.length || !keys.every((k) => fieldSet.has(k)))
        throw new EncodeError(`struct: expected exactly the fields ${names.join(", ")}`);
      const v = value as Readonly<Record<string, unknown>>;
      for (const [name, codec] of fields) codec.write(w, v[name]);
    },
    read(r) {
      const out: Record<string, unknown> = {};
      for (const [name, codec] of fields) out[name] = codec.read(r);
      return out as StructValue<F>;
    },
  };
}
