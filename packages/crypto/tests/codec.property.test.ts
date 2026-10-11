import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  BN254_R,
  bool,
  bytesFixed,
  bytesVar,
  type Codec,
  decode,
  DecodeError,
  encode,
  EncodeError,
  enum8,
  fieldBn254,
  list,
  RecordSchema,
  type RecordType,
  recordType,
  struct,
  u16,
  u32,
  u64,
  u8,
  UNPINNED,
  utf8,
  Writer,
} from "../src/index.ts";

// Properties of docs/spec/notation.md, "Strict decoding": decode(encode(x)) = x,
// encode(decode(b)) = b for every accepted b, random bytes are rejected or
// re-encode to themselves, and the first failure is reported (T-31, T-52).
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const opts = { numRuns };

/** A codec together with an arbitrary over exactly its valid values. */
interface Typed {
  readonly name: string;
  readonly codec: Codec<unknown>;
  readonly value: fc.Arbitrary<unknown>;
}

const utf8Text = (maxLength: number) =>
  fc
    .string({ unit: "binary", maxLength })
    .map((s) => new TextEncoder().encode(s))
    .filter((b) => b.length <= maxLength);

const leaves: readonly Typed[] = [
  { name: "u8", codec: u8, value: fc.integer({ min: 0, max: 0xff }) },
  { name: "u16", codec: u16, value: fc.integer({ min: 0, max: 0xffff }) },
  { name: "u32", codec: u32, value: fc.integer({ min: 0, max: 0xffff_ffff }) },
  { name: "u64", codec: u64, value: fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }) },
  { name: "bool", codec: bool, value: fc.boolean() },
  { name: "enum8<1,7,255>", codec: enum8([1, 7, 255]), value: fc.constantFrom(1, 7, 255) },
  { name: "bytes[3]", codec: bytesFixed(3), value: fc.uint8Array({ minLength: 3, maxLength: 3 }) },
  { name: "bytes<5>", codec: bytesVar(5), value: fc.uint8Array({ maxLength: 5 }) },
  { name: "utf8<8>", codec: utf8(8), value: utf8Text(8) },
  { name: "field<bn254>", codec: fieldBn254, value: fc.bigInt({ min: 0n, max: BN254_R - 1n }) },
];

/** Arbitrary codecs of nested lists and structs over the leaves, with their values. */
const typed: fc.Arbitrary<Typed> = fc.letrec<{ t: Typed }>((tie) => ({
  t: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    fc.constantFrom(...leaves),
    fc.tuple(tie("t"), fc.integer({ min: 0, max: 3 })).map(([of, max]) => ({
      name: `list<${of.name}, ${max}>`,
      codec: list(of.codec, max),
      value: fc.array(of.value, { maxLength: max }),
    })),
    fc.array(tie("t"), { minLength: 1, maxLength: 3 }).map((fields) => {
      const named = fields.map((f, i) => [`f${i}`, f] as const);
      return {
        name: `struct{${fields.map((f) => f.name).join(", ")}}`,
        codec: struct(named.map(([n, f]) => [n, f.codec] as const)) as Codec<unknown>,
        value: fc.record(Object.fromEntries(named.map(([n, f]) => [n, f.value]))),
      };
    }),
  ),
})).t;

const typedWithValue = typed.chain((t) => t.value.map((v) => ({ t, v })));

function outcome(f: () => unknown): { ok: true; value: unknown } | { ok: false; code: string } {
  try {
    return { ok: true, value: f() };
  } catch (e) {
    if (e instanceof DecodeError) return { ok: false, code: e.code };
    throw e;
  }
}

describe("canonical encoding properties", () => {
  test("decode(encode(x)) = x for every value of every type", () => {
    fc.assert(
      fc.property(typedWithValue, ({ t, v }) => {
        expect(decode(t.codec, encode(t.codec, v))).toEqual(v);
      }),
      opts,
    );
  });

  test("random bytes are rejected or re-encode to themselves", () => {
    fc.assert(
      fc.property(typed, fc.uint8Array({ maxLength: 48 }), (t, bytes) => {
        const r = outcome(() => decode(t.codec, bytes));
        if (r.ok) expect(encode(t.codec, r.value)).toEqual(bytes);
      }),
      opts,
    );
  });

  test("mutated encodings are rejected or re-encode to themselves", () => {
    // Random bytes rarely get past a length prefix; flipping one byte of a
    // valid encoding exercises the deeper fields.
    fc.assert(
      fc.property(typedWithValue, fc.nat(), fc.integer({ min: 1, max: 255 }), ({ t, v }, i, x) => {
        const bytes = encode(t.codec, v);
        if (bytes.length === 0) return;
        const at = i % bytes.length;
        bytes[at] = (bytes[at] ?? 0) ^ x;
        const r = outcome(() => decode(t.codec, bytes));
        if (r.ok) expect(encode(t.codec, r.value)).toEqual(bytes);
      }),
      opts,
    );
  });

  test("every proper prefix of an encoding is truncated", () => {
    fc.assert(
      fc.property(typedWithValue, fc.nat(), ({ t, v }, i) => {
        const bytes = encode(t.codec, v);
        if (bytes.length === 0) return;
        const r = outcome(() => decode(t.codec, bytes.subarray(0, i % bytes.length)));
        expect(r).toEqual({ ok: false, code: "truncated" });
      }),
      opts,
    );
  });

  test("any extra byte after an encoding is trailing-bytes", () => {
    fc.assert(
      fc.property(
        typedWithValue,
        fc.uint8Array({ minLength: 1, maxLength: 4 }),
        ({ t, v }, extra) => {
          const bytes = encode(t.codec, v);
          const r = outcome(() => decode(t.codec, Uint8Array.from([...bytes, ...extra])));
          expect(r).toEqual({ ok: false, code: "trailing-bytes" });
        },
      ),
      opts,
    );
  });

  test("decoded values don't alias the input", () => {
    const codec = struct([
      ["a", bytesFixed(2)],
      ["b", bytesVar(4)],
    ] as const);
    const input = Uint8Array.from([1, 2, 0, 0, 0, 1, 3]);
    const value = decode(codec, input);
    input.fill(0);
    expect(value).toEqual({ a: Uint8Array.from([1, 2]), b: Uint8Array.from([3]) });
  });
});

describe("decoders reject, never repair", () => {
  test("rejects field<bn254> values at or above r, whatever the low bytes", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: BN254_R, max: (1n << 256n) - 1n }), (x) => {
        const b = Uint8Array.from(Buffer.from(x.toString(16).padStart(64, "0"), "hex"));
        expect(outcome(() => decode(fieldBn254, b))).toEqual({ ok: false, code: "non-canonical" });
      }),
      opts,
    );
  });

  test("rejects lengths over the maximum before reading the content", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 64 }),
        fc.integer({ min: 1, max: 0xffff_ffff }),
        (max, extra) => {
          const n = Math.min(max + extra, 0xffff_ffff);
          // Only the 4-byte length is present: reading the content first would
          // report truncated, and allocating first would cost up to 4 GiB.
          const prefix = encode(u32, n);
          for (const codec of [bytesVar(max), utf8(max), list(u8, max)] as Codec<unknown>[])
            expect(outcome(() => decode(codec, prefix))).toEqual({
              ok: false,
              code: "length-over-max",
            });
        },
      ),
      opts,
    );
  });

  test("rejects bool and enum8 values outside their lists", () => {
    const e = enum8([2, 3]);
    for (let b = 0; b < 256; b++) {
      const input = Uint8Array.of(b);
      expect(outcome(() => decode(bool, input)).ok).toBe(b <= 1);
      expect(outcome(() => decode(e, input)).ok).toBe(b === 2 || b === 3);
    }
  });

  test("checks each field in order: the first failure wins", () => {
    const codec = struct([
      ["flag", bool],
      ["text", utf8(4)],
    ] as const);
    // An invalid bool followed by ill-formed, truncated text reports the bool.
    expect(outcome(() => decode(codec, Uint8Array.of(2, 0, 0, 0, 9, 0xc0)))).toEqual({
      ok: false,
      code: "invalid-enum",
    });
  });
});

describe("encoders emit only defined encodings", () => {
  const rejects = (codec: Codec<unknown>, value: unknown) =>
    expect(() => encode(codec, value)).toThrow(EncodeError);

  test("rejects integers outside their width, fractions and wrong types", () => {
    for (const [codec, max] of [
      [u8, 0xff],
      [u16, 0xffff],
      [u32, 0xffff_ffff],
    ] as const) {
      for (const v of [-1, max + 1, 0.5, Number.NaN, Infinity, "1", 1n]) rejects(codec, v);
    }
    for (const v of [-1n, 1n << 64n, 1]) rejects(u64, v);
  });

  test("rejects values with no encoding", () => {
    rejects(bool, 1);
    rejects(enum8([1, 2]), 3);
    rejects(bytesFixed(2), Uint8Array.of(1));
    rejects(bytesFixed(2), [1, 2]);
    rejects(bytesVar(2), Uint8Array.of(1, 2, 3));
    rejects(utf8(4), Uint8Array.of(0xc0, 0xaf));
    rejects(utf8(2), new TextEncoder().encode("abc"));
    rejects(fieldBn254, BN254_R);
    rejects(fieldBn254, -1n);
    rejects(list(u8, 1), [1, 2]);
    rejects(list(u8, 1), new Uint8Array(1));
  });

  test("rejects structs with missing, extra or invalid fields", () => {
    const codec = struct([
      ["a", u8],
      ["b", bool],
    ] as const) as Codec<unknown>;
    rejects(codec, { a: 1 });
    rejects(codec, { a: 1, b: true, c: 0 });
    rejects(codec, { a: 1, b: 2 });
    rejects(codec, null);
    rejects(codec, [1, true]);
    expect(encode(codec, { b: true, a: 1 })).toEqual(Uint8Array.of(1, 1));
  });

  test("refuses types the spec doesn't allow", () => {
    expect(() => list(bytesFixed(0), 4)).toThrow(RangeError);
    expect(() => list(struct([] as const), 4)).toThrow(RangeError);
    expect(() => enum8([])).toThrow(RangeError);
    expect(() => enum8([1, 1])).toThrow(RangeError);
    expect(() => enum8([256])).toThrow();
    expect(() => bytesVar(2 ** 32)).toThrow(RangeError);
    expect(() =>
      struct([
        ["a", u8],
        ["a", u8],
      ] as const),
    ).toThrow(RangeError);
    expect(() => struct([["__proto__", u8]] as const)).toThrow(RangeError);
  });

  test("a struct's layout can't change after it is made", () => {
    const fields: [string, Codec<unknown>][] = [["a", u8 as Codec<unknown>]];
    const codec = struct(fields);
    fields[0] = ["a", u16 as Codec<unknown>];
    fields.push(["b", u8 as Codec<unknown>]);
    expect(encode(codec, { a: 1 })).toEqual(Uint8Array.of(1));
    expect(decode(codec, Uint8Array.of(7))).toEqual({ a: 7 });
  });
});

describe("record framing", () => {
  const t1 = recordType(0x0002, {
    1: struct([["x", u8]] as const),
    3: struct([["y", u16]] as const),
  });
  const t2 = recordType(0x0003, { 1: struct([["z", bool]] as const) });
  const schema = new RecordSchema([t1, t2]);

  test("round-trips every version and returns the version read", () => {
    expect(schema.decode(t1, schema.encode(t1, 1, { x: 7 }), UNPINNED)).toEqual({
      version: 1,
      value: { x: 7 },
    });
    expect(schema.decode(t1, schema.encode(t1, 3, { y: 258 }), 3)).toEqual({
      version: 3,
      value: { y: 258 },
    });
    expect(schema.encode(t1, 3, { y: 258 })).toEqual(Uint8Array.of(0, 0x02, 3, 1, 2));
  });

  test("rejects a version other than the one the profile pins, right after the header", () => {
    const v1 = schema.encode(t1, 1, { x: 7 });
    expect(outcome(() => schema.decode(t1, v1, 3))).toEqual({
      ok: false,
      code: "profile-mismatch",
    });
    // Checked before any field: a body that would fail to decode still reports the profile.
    expect(outcome(() => schema.decode(t1, Uint8Array.of(0, 0x02, 1), 3))).toEqual({
      ok: false,
      code: "profile-mismatch",
    });
    expect(schema.decode(t1, v1, 1).version).toBe(1);
  });

  test("a version both unpinned and unknown is profile-mismatch, not unknown-version", () => {
    // notation.md: the pin is checked first, because it is what the election requires.
    expect(outcome(() => schema.decode(t1, Uint8Array.of(0, 0x02, 2, 0), 1))).toEqual({
      ok: false,
      code: "profile-mismatch",
    });
    expect(outcome(() => schema.decode(t1, Uint8Array.of(0, 0x02, 2, 0), UNPINNED))).toEqual({
      ok: false,
      code: "unknown-version",
    });
    // A pin the schema has no layout for is a caller's bug, not a decode result.
    expect(() => schema.decode(t1, Uint8Array.of(0, 0x02, 1, 0), 2 as never)).toThrow(RangeError);
  });

  test("production schemas take only numbers the registry assigns", () => {
    expect(() => new RecordSchema([recordType(0x000a, { 1: u8 })])).toThrow(RangeError);
    expect(() => new RecordSchema([recordType(0xfeff, { 1: u8 })])).toThrow(RangeError);
    expect(
      () => new RecordSchema([recordType(0x000a, { 1: u8 })], { allowTestRange: true }),
    ).toThrow(RangeError);
  });

  test("distinguishes unknown, unexpected and unknown-version", () => {
    const code = (b: number[]) => outcome(() => schema.decode(t1, Uint8Array.from(b), UNPINNED));
    expect(code([0, 0x12, 1, 0])).toEqual({ ok: false, code: "unknown-record-type" });
    expect(code([0, 0, 1, 0])).toEqual({ ok: false, code: "unknown-record-type" });
    expect(code([0, 0x03, 1, 0])).toEqual({ ok: false, code: "unexpected-record-type" });
    expect(code([0, 0x02, 2, 0])).toEqual({ ok: false, code: "unknown-version" });
    expect(code([0, 0x02, 0, 0])).toEqual({ ok: false, code: "unknown-version" });
    expect(code([0, 0x02])).toEqual({ ok: false, code: "truncated" });
  });

  test("random bytes are rejected or re-encode to themselves", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 8 }),
        fc.constantFrom<RecordType>(t1, t2),
        (bytes, t) => {
          try {
            const { version, value } = schema.decode(t, bytes, UNPINNED);
            expect(schema.encode(t, version as never, value as never)).toEqual(bytes);
          } catch (e) {
            if (!(e instanceof DecodeError)) throw e;
          }
        },
      ),
      opts,
    );
  });

  test("production schemas reject type 0, version 0, duplicates and the test range", () => {
    expect(() => recordType(0, { 1: u8 })).toThrow(RangeError);
    expect(() => recordType(0x10000, { 1: u8 })).toThrow(RangeError);
    expect(() => recordType(1, { 0: u8 })).toThrow(RangeError);
    expect(() => recordType(1, { 256: u8 })).toThrow(RangeError);
    expect(() => recordType(1, {})).toThrow(RangeError);
    expect(() => new RecordSchema([t1, recordType(0x0002, { 1: u8 })])).toThrow(RangeError);
    const test = recordType(0xff01, { 1: u8 });
    expect(() => new RecordSchema([test])).toThrow(RangeError);
    expect(
      new RecordSchema([test], { allowTestRange: true }).decode(
        test,
        Uint8Array.of(0xff, 1, 1, 9),
        1,
      ).value,
    ).toBe(9);
  });

  test("encodes and expects only the types it was built with", () => {
    const other = recordType(0x0002, { 1: struct([["x", u8]] as const) });
    expect(() => schema.encode(other, 1, { x: 1 })).toThrow(RangeError);
    expect(() => schema.decode(other, Uint8Array.of(0, 0x02, 1, 1), UNPINNED)).toThrow(RangeError);
    expect(() => schema.encode(t1, 2 as never, { x: 1 } as never)).toThrow(EncodeError);
  });
});

describe("hostile JavaScript inputs", () => {
  test("decodes a Buffer into plain arrays that don't alias it", () => {
    const input = Buffer.from([0, 0, 0, 2, 7, 8]);
    const value = decode(bytesVar(4), input);
    input.fill(0);
    expect(value).toEqual(Uint8Array.of(7, 8));
    expect(Object.getPrototypeOf(value)).toBe(Uint8Array.prototype);
    expect(Object.getPrototypeOf(decode(bytesFixed(1), Buffer.of(1)))).toBe(Uint8Array.prototype);
  });

  test("rejects inputs that aren't byte arrays", () => {
    expect(() => decode(u8, Uint16Array.of(300) as never)).toThrow(TypeError);
    expect(() => decode(u8, [1] as never)).toThrow(TypeError);
    expect(() => decode(u8, new Proxy(Uint8Array.of(1), {}))).toThrow(TypeError);
  });

  test("the writer copies its input and never wraps an integer", () => {
    const w = new Writer();
    const b = Buffer.from([1, 2]);
    w.bytes(b);
    b.fill(9);
    expect(w.finish()).toEqual(Uint8Array.of(1, 2));
    expect(() => new Writer().uint(1, 256)).toThrow(EncodeError);
    expect(() => new Writer().uint(2, -1)).toThrow(EncodeError);
    expect(() => new Writer().bytes([1] as never)).toThrow(EncodeError);
  });

  test("a list's count always matches the elements written", () => {
    const sneaky = [1, 2];
    Object.defineProperty(sneaky, Symbol.iterator, {
      value: function* () {
        yield 1;
      },
    });
    expect(encode(list(u8, 4), sneaky)).toEqual(Uint8Array.of(0, 0, 0, 2, 1, 2));
  });

  test("a struct value must have exactly its fields as own keys", () => {
    const codec = struct([
      ["a", u8],
      ["b", u8],
    ] as const) as Codec<unknown>;
    expect(() => encode(codec, { "a,b": 1 })).toThrow(EncodeError);
    expect(() =>
      encode(codec, Object.assign(Object.create({ a: 1 }) as object, { b: 2, c: 3 })),
    ).toThrow(EncodeError);
  });

  test("record schemas take only types made by recordType()", () => {
    expect(() => new RecordSchema([{ recordType: 0x1ff01, versions: { 300: u8 } }])).toThrow(
      TypeError,
    );
    expect(() => new RecordSchema([{ recordType: 0, versions: { 0: u8 } }])).toThrow(TypeError);
    expect(() => recordType(1, { "01": u8 } as never)).toThrow(RangeError);
    const t = recordType(0x0004, { 1: u8 });
    expect(Object.isFrozen(t) && Object.isFrozen(t.versions)).toBe(true);
  });

  test("a version found only on Object.prototype is unknown", () => {
    const t = recordType(0x0004, { 1: u8 });
    const schema = new RecordSchema([t]);
    const proto = Object.prototype as Record<number, unknown>;
    proto[5] = u8;
    try {
      expect(outcome(() => schema.decode(t, Uint8Array.of(0, 0x04, 5, 0), UNPINNED))).toEqual({
        ok: false,
        code: "unknown-version",
      });
    } finally {
      delete proto[5];
    }
  });
});

describe("byte inputs are copied before they are checked", () => {
  class Lying extends Uint8Array {
    override get length() {
      return 2;
    }
  }

  test("a Proxy around a Uint8Array is not a byte array", () => {
    const p = new Proxy(Uint8Array.of(0x41, 0x42), {});
    expect(() => encode(utf8(8), p)).toThrow(EncodeError);
    expect(() => encode(bytesFixed(2), p)).toThrow(EncodeError);
    expect(() => new Writer().bytes(p)).toThrow(EncodeError);
  });

  test("a subclass's own length getter is ignored", () => {
    const four = new Lying([0xc0, 0xaf, 0, 0]);
    expect(() => encode(utf8(8), four)).toThrow(EncodeError);
    expect(() => encode(bytesFixed(2), four)).toThrow(EncodeError);
    expect(encode(bytesVar(8), new Lying([1, 2, 3]))).toEqual(Uint8Array.of(0, 0, 0, 3, 1, 2, 3));
  });

  test("struct values with symbol or non-enumerable extra keys are rejected", () => {
    const codec = struct([["a", u8]] as const) as Codec<unknown>;
    expect(() => encode(codec, { a: 1, [Symbol("x")]: 2 })).toThrow(EncodeError);
    const hidden = Object.defineProperty({ x: 5 }, "a", { value: 7, enumerable: false });
    expect(() => encode(codec, hidden)).toThrow(EncodeError);
    expect(() => encode(codec, Object.defineProperty({ a: 1 }, "b", { value: 2 }))).toThrow(
      EncodeError,
    );
  });
});
