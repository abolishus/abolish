import { describe, expect, test } from "vite-plus/test";
import { DecodeError, ds, H, UNPINNED } from "../src/index.ts";
import { buildSchema, hex, readVectorFile, type VectorFile } from "./spec-vectors.ts";

// docs/spec/vectors/election-definition-v5.json and display-text-v2.json,
// printed by scripts/definition-v5-vectors.py (P2-14 part 1a). packages/crypto
// has no codec for either version yet (part 2), so these tests decode them
// with codecs built from the files' own type descriptors: they check that the
// Python generator's bytes, values and decode errors agree with an independent
// reading of the same layouts, beside the version each one is mislabelled as
// (T-31, T-36). Part 2 runs them through the production codecs and rules.
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** One schema over several files, so a record labelled with another version reads that version's layout. */
function merged(...names: string[]): VectorFile {
  const files = names.map(readVectorFile);
  return {
    ...files[0]!, // at least one name
    types: Object.assign({}, ...files.map((f) => f.types)),
    vectors: files.flatMap((f) => f.vectors),
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

describe("election definition version 5 (docs/spec/election-definition.md, Layout (version 5))", () => {
  const file = readVectorFile("election-definition-v5.json");
  const { schema, type } = buildSchema(
    merged("election-definition-v5.json", "election-definition-v4.json"),
  );
  const { recordType } = type(file.vectors[0]!.type); // the file has vectors

  // Decoding, steps 1 and 2: strictly with no pin, then the record's own profile pin.
  const decode = (bytes: Uint8Array) => {
    const record = schema.decode(recordType, bytes, UNPINNED);
    const pins = (
      record.value as { profile: { pins: { record_type: number; version: number }[] } }
    ).profile.pins.filter((p) => p.record_type === 1);
    if (pins.length !== 1 || pins[0]!.version !== record.version)
      throw new DecodeError("profile-mismatch", 0);
    return record;
  };

  test("has unique ids, and exactly one of value or error on each vector", () => {
    expect(new Set(file.vectors.map((v) => v.id)).size).toBe(file.vectors.length);
    for (const v of file.vectors) expect("value" in v !== "error" in v).toBe(true);
  });

  const valid = file.vectors.filter((v) => "value" in v).map((v) => [v.id, v] as const);
  const invalid = file.vectors.filter((v) => "error" in v).map((v) => [v.id, v] as const);

  test.each(valid)("%s decodes as version 5, re-encodes and hashes", (_id, v) => {
    const record = decode(hex(v.encoding));
    expect(record.version).toBe(5);
    expect(record.value).toEqual(type(v.type).built.fromJson(v.value));
    expect(toHex(schema.encode(recordType, 5, record.value as never))).toBe(v.encoding);
    expect(toHex(H(ds("abolish/v1/election-definition", hex(v.encoding))))).toBe(v.hash);
    const stub = { ...(record.value as object), ceremony_transcript_hash: new Uint8Array(32) };
    expect(
      toHex(H(ds("abolish/v1/election-stub", schema.encode(recordType, 5, stub as never)))),
    ).toBe(v.stubHash);
  });

  test.each(invalid)("%s is rejected", (_id, v) => {
    expect(decodeError(() => decode(hex(v.encoding)))).toBe(v.error);
  });

  test("labels every well-formedness rule of version 5's questions, and the question for each", () => {
    const labelled = valid.map(([, v]) => v as typeof v & { illFormedQuestion?: string });
    expect(new Set(labelled.map((v) => v.illFormed).filter((r) => r !== undefined))).toEqual(
      new Set([
        "protocol-major",
        "profile-types",
        "questions",
        "option-count",
        "selections",
        "cells",
        "timing",
        "receipt-keys",
      ]),
    );
    for (const v of labelled)
      expect(v.illFormedQuestion !== undefined).toBe(
        v.illFormed === "option-count" || v.illFormed === "selections",
      );
  });
});

describe("display text version 2 (docs/spec/display-text.md, Layout (version 2))", () => {
  const file = readVectorFile("display-text-v2.json") as VectorFile & { maxDisplayText?: string };
  const { schema, type } = buildSchema(merged("display-text-v2.json", "display-text.json"));
  const { recordType } = type(file.vectors[0]!.type); // the file has vectors

  test("has unique ids, exactly one of value or error on each vector, and the cap", () => {
    expect(new Set(file.vectors.map((v) => v.id)).size).toBe(file.vectors.length);
    for (const v of file.vectors) expect("value" in v !== "error" in v).toBe(true);
    expect(file.maxDisplayText).toBe("4194304");
    for (const v of file.vectors) expect(v.encoding.length / 2).toBeLessThanOrEqual(4194304);
  });

  const valid = file.vectors.filter((v) => "value" in v).map((v) => [v.id, v] as const);
  const invalid = file.vectors.filter((v) => "error" in v).map((v) => [v.id, v] as const);

  test.each(valid)("%s decodes against a pin of 2, re-encodes and commits", (_id, v) => {
    expect(v.pinned).toBe(2);
    const record = schema.decode(recordType, hex(v.encoding), 2);
    expect(record.value).toEqual(type(v.type).built.fromJson(v.value));
    expect(toHex(schema.encode(recordType, 2, record.value as never))).toBe(v.encoding);
    expect(toHex(H(ds("abolish/v1/display-text", hex(v.encoding))))).toBe(v.commitment);
  });

  test.each(invalid)("%s is rejected", (_id, v) => {
    const pinned = v.pinned === 1 ? 1 : 2;
    expect(v.pinned).toBe(pinned);
    expect(decodeError(() => schema.decode(recordType, hex(v.encoding), pinned))).toBe(v.error);
  });
});
