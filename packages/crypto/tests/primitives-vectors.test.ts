import { describe, expect, test } from "vite-plus/test";
import { decode, DecodeError, encode, UNPINNED } from "../src/index.ts";
import { build, buildSchema, hex, readVectorFile, type Vector } from "./spec-vectors.ts";

// docs/spec/vectors/primitives.json: the primitive types, record framing and
// strict-decoding rejections of docs/spec/notation.md; group.json: the scalar
// and element codecs of docs/spec/group.md (T-31, T-36, T-39).
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

for (const [name, count] of [
  ["primitives.json", 0],
  ["group.json", 36],
] as const) {
  const file = readVectorFile(name);
  const { schema, type } = buildSchema(file);

  function run(v: Vector) {
    const input = hex(v.encoding);
    if (v.type.kind === "record") {
      const { recordType, built } = type(v.type);
      const version = v.type.version;
      return {
        decode: () => schema.decode(recordType, input, UNPINNED).value,
        encode: (value: unknown) => schema.encode(recordType, version, value),
        fromJson: built.fromJson,
      };
    }
    const { codec, fromJson } = build(v.type);
    return {
      decode: () => decode(codec, input),
      encode: (value: unknown) => encode(codec, value),
      fromJson,
    };
  }

  function decodeError(f: () => unknown): string | undefined {
    try {
      f();
    } catch (e) {
      if (e instanceof DecodeError) return e.code;
      throw e;
    }
    return undefined;
  }

  describe(`${file.title} (${file.spec})`, () => {
    test("every vector has an encoding and exactly one of value or error", () => {
      expect(file.vectors.length).toBeGreaterThan(0);
      if (count > 0) expect(file.vectors.length).toBe(count);
      expect(new Set(file.vectors.map((v) => v.id)).size).toBe(file.vectors.length);
      for (const v of file.vectors) expect("value" in v !== "error" in v).toBe(true);
    });

    const valid = file.vectors.filter((v) => "value" in v);
    const invalid = file.vectors.filter((v) => "error" in v);

    test.each(valid.map((v) => [v.id, v] as const))(
      "%s decodes to its value and back",
      (_id, v) => {
        const { decode, encode, fromJson } = run(v);
        const expected = fromJson(v.value);
        expect(decode()).toEqual(expected);
        expect(toHex(encode(expected))).toBe(v.encoding);
      },
    );

    test.each(invalid.map((v) => [v.id, v] as const))("%s is rejected", (_id, v) => {
      expect(decodeError(run(v).decode)).toBe(v.error);
    });
  });
}
