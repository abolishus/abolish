import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { deriveTagField } from "../src/circuit.ts";
import {
  BN254_R,
  circuitTagField,
  PACK_CHUNK,
  packBoundedBytes,
  packBytes,
  TAG_REGISTRY,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/circuit.json comes from an independent Python
// implementation (scripts/circuit-vectors.py), so these expected values never
// come from the code under test. packages/circuits runs the same packing
// vectors through its Noir functions.

interface CircuitVectors {
  readonly format: string;
  readonly tags: readonly {
    readonly tag: string;
    readonly digest: string;
    readonly field: string;
  }[];
  readonly packBytes: readonly {
    readonly id: string;
    readonly bytes: string;
    readonly fields: readonly string[];
  }[];
  readonly packBoundedBytes: readonly {
    readonly id: string;
    readonly max: number;
    readonly bytes: string;
    readonly fields?: readonly string[];
    readonly error?: string;
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("circuit.json", SPEC_VECTORS), "utf8"),
) as CircuitVectors;

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

/** The inverse of packBytes for a known length, written from the spec. */
function unpack(fields: readonly bigint[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  fields.forEach((f, c) => {
    const size = Math.min(PACK_CHUNK, length - c * PACK_CHUNK);
    for (let i = size - 1, v = f; i >= 0; i--, v >>= 8n)
      out[c * PACK_CHUNK + i] = Number(v & 0xffn);
  });
  return out;
}

describe("circuit vectors", () => {
  test("the file has the expected format", () => {
    expect(vectors.format).toBe("abolish-circuit-vectors/1");
  });

  test.each(vectors.tags)("tag_field($tag)", ({ tag, field }) => {
    expect(deriveTagField(tag)).toBe(BigInt(field));
  });

  test("the file lists exactly the registered tags, in registry order", () => {
    // A tag registered without regenerating circuit.json would otherwise go unvectored.
    expect(vectors.tags.map((t) => t.tag)).toEqual(TAG_REGISTRY.map((e) => e.tag));
  });

  test.each(vectors.packBytes)("packBytes $id", ({ bytes, fields }) => {
    expect(packBytes(hex(bytes))).toEqual(fields.map(BigInt));
  });

  test.each(vectors.packBoundedBytes)("packBoundedBytes $id", ({ bytes, max, fields, error }) => {
    if (error === undefined) expect(packBoundedBytes(hex(bytes), max)).toEqual(fields?.map(BigInt));
    else expect(() => packBoundedBytes(hex(bytes), max)).toThrow(RangeError);
  });
});

describe("tag field elements", () => {
  test("are below the BN254 order with 8 bits to spare, and distinct across the registry", () => {
    const fields = TAG_REGISTRY.map((e) => deriveTagField(e.tag));
    for (const f of fields) expect(f < 1n << 248n && f < BN254_R).toBe(true);
    expect(new Set(fields).size).toBe(fields.length);
  });

  test("circuitTagField refuses tags not registered as In-circuit", () => {
    // T-30: a plain-hash tag used in a circuit would get a second layout.
    for (const { tag } of TAG_REGISTRY) expect(() => circuitTagField(tag)).toThrow(RangeError);
    expect(() => circuitTagField("abolish/v1/not-registered")).toThrow(RangeError);
  });

  test("reject strings outside the tag grammar", () => {
    for (const bad of [
      "",
      "abolish/v1/",
      "abolish/v2/x-tag-ok",
      "Abolish/v1/display-text",
      "abolish/v1/a b",
    ])
      expect(() => deriveTagField(bad)).toThrow(RangeError);
  });
});

describe("byte packing", () => {
  test("packs ceil(n / 31) elements below 2^248 and unpacks to the same bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), (b) => {
        const fields = packBytes(b);
        expect(fields.length).toBe(Math.ceil(b.length / PACK_CHUNK));
        for (const f of fields) expect(f >= 0n && f < 1n << 248n).toBe(true);
        expect(unpack(fields, b.length)).toEqual(b);
      }),
      { numRuns },
    );
  });

  test("bounded packing is injective: different values of one maximum never pack alike", () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: 0, max: 70 })
          .chain((max) =>
            fc.tuple(
              fc.constant(max),
              fc.uint8Array({ maxLength: max }),
              fc.uint8Array({ maxLength: max }),
            ),
          ),
        ([max, a, b]) => {
          const same = a.length === b.length && a.every((x, i) => x === b[i]);
          expect(packBoundedBytes(a, max).join() === packBoundedBytes(b, max).join()).toBe(same);
        },
      ),
      { numRuns },
    );
  });

  test("bounded packing has 1 + ceil(max / 31) elements, the length first", () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: 0, max: 100 })
          .chain((max) => fc.tuple(fc.constant(max), fc.uint8Array({ maxLength: max }))),
        ([max, b]) => {
          const [len, ...content] = packBoundedBytes(b, max);
          expect(len).toBe(BigInt(b.length));
          expect(content.length).toBe(Math.ceil(max / PACK_CHUNK));
          expect(unpack(content, max).subarray(0, b.length)).toEqual(b);
        },
      ),
      { numRuns },
    );
  });

  test("rejects a value longer than its maximum, and a bad maximum", () => {
    expect(() => packBoundedBytes(new Uint8Array(4), 3)).toThrow(RangeError);
    expect(() => packBoundedBytes(new Uint8Array(0), -1)).toThrow(RangeError);
    expect(() => packBoundedBytes(new Uint8Array(0), 1.5)).toThrow(RangeError);
    expect(() => packBytes([1, 2] as unknown as Uint8Array)).toThrow(TypeError);
  });
});
