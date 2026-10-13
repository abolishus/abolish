import { p256 } from "@noble/curves/nist.js";
import { describe, expect, test } from "vite-plus/test";
import { DecodeError, ds, H, PARAMETERS, panelId, UNPINNED } from "../src/index.ts";
import { buildSchema, hex, readVectorFile, type VectorFile } from "./spec-vectors.ts";

// docs/spec/vectors/election-definition-v6.json, printed by
// scripts/definition-v6-vectors.py (P2-16 part 1a). packages/crypto has no
// codec for version 6 yet (part 1b), so, as for version 5, these tests decode
// the file with codecs built from its own type descriptors, beside version 5's,
// so a record labelled with the other version reads that layout (T-31, T-36),
// and read the author panels from docs/spec/trustee-identity.md directly.
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

interface AuthorPanelVector {
  readonly id: string;
  readonly threshold: string;
  readonly keys: readonly string[];
  readonly defaultKeys?: readonly string[];
  readonly authorPanelId?: string;
  readonly error?: string;
}

type V6File = VectorFile & {
  readonly tags: { readonly authorPanel: string };
  readonly minLiveBatch: string;
  readonly authorPanels: readonly AuthorPanelVector[];
};

const file = readVectorFile("election-definition-v6.json") as V6File;

function decodeError(f: () => unknown): string | undefined {
  try {
    f();
  } catch (e) {
    if (e instanceof DecodeError) return e.code;
    throw e;
  }
  return undefined;
}

const authorPanelId = (k: number, keys: readonly Uint8Array[]) =>
  H(
    ds(
      "abolish/v1/author-panel",
      Uint8Array.from([k, keys.length, ...keys.flatMap((x) => [...x])]),
    ),
  );

/** trustee-identity.md, Author panel identifier: the validity rules in their order. */
function authorPanelRule(k: number, keys: readonly Uint8Array[], defaults?: readonly string[]) {
  if (keys.length > PARAMETERS.MAX_TRUSTEES) return "size";
  if (k < 1 || k > keys.length) return "threshold";
  for (const [i, key] of keys.entries()) {
    if (key.length !== 33 || (key[0] !== 2 && key[0] !== 3)) return "key";
    try {
      p256.Point.fromBytes(key);
    } catch {
      return "key";
    }
    if (keys.slice(0, i).some((x) => toHex(x) === toHex(key))) return "duplicate-key";
  }
  if (defaults?.some((d) => keys.some((x) => toHex(x) === d))) return "default-seat";
  return undefined;
}

describe("election definition version 6 (docs/spec/election-definition.md, Layout (version 6))", () => {
  const v5 = readVectorFile("election-definition-v5.json");
  const { schema, type } = buildSchema({
    ...file,
    types: { ...v5.types, ...file.types },
    vectors: [...file.vectors, ...v5.vectors],
  });
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

  test("has unique ids, exactly one of value or error on each vector, and the floor", () => {
    expect(new Set(file.vectors.map((v) => v.id)).size).toBe(file.vectors.length);
    for (const v of file.vectors) expect("value" in v !== "error" in v).toBe(true);
    expect(file.minLiveBatch).toBe(String(PARAMETERS.MIN_LIVE_BATCH));
    expect(file.tags.authorPanel).toBe("abolish/v1/author-panel");
  });

  const valid = file.vectors.filter((v) => "value" in v).map((v) => [v.id, v] as const);
  const invalid = file.vectors.filter((v) => "error" in v).map((v) => [v.id, v] as const);

  test.each(valid)("%s decodes as version 6, re-encodes and hashes", (_id, v) => {
    const record = decode(hex(v.encoding));
    expect(record.version).toBe(6);
    expect(record.value).toEqual(type(v.type).built.fromJson(v.value));
    expect(toHex(schema.encode(recordType, 6, record.value as never))).toBe(v.encoding);
    expect(toHex(H(ds("abolish/v1/election-definition", hex(v.encoding))))).toBe(v.hash);
    // The stub zeroes both transcript hashes.
    const stub = {
      ...(record.value as object),
      ceremony_transcript_hash: new Uint8Array(32),
      author_transcript_hash: new Uint8Array(32),
    };
    expect(
      toHex(H(ds("abolish/v1/election-stub", schema.encode(recordType, 6, stub as never)))),
    ).toBe(v.stubHash);
    const { author_threshold: k, author_keys: keys } = record.value as {
      author_threshold: number;
      author_keys: Uint8Array[];
    };
    const want = (v as typeof v & { authorPanelId?: string }).authorPanelId;
    expect(want === undefined).toBe(keys.length === 0);
    if (want !== undefined) expect(toHex(authorPanelId(k, keys))).toBe(want);
  });

  test.each(invalid)("%s is rejected", (_id, v) => {
    expect(decodeError(() => decode(hex(v.encoding)))).toBe(v.error);
  });

  test("labels every well-formedness rule version 6 adds, beside version 5's", () => {
    const labelled = valid.map(([, v]) => v as typeof v & { illFormedQuestion?: string });
    expect(new Set(labelled.map((v) => v.illFormed).filter((r) => r !== undefined))).toEqual(
      new Set(["results", "civic-sealed", "author-panel", "receipt-keys", "selections"]),
    );
    for (const v of labelled)
      expect(v.illFormedQuestion !== undefined).toBe(v.illFormed === "selections");
  });
});

describe("author panel identifier (docs/spec/trustee-identity.md, Author panel identifier)", () => {
  test.each(file.authorPanels.map((v) => [v.id, v] as const))("%s", (_id, v) => {
    const k = Number(v.threshold);
    const keys = v.keys.map(hex);
    expect(authorPanelRule(k, keys, v.defaultKeys)).toBe(v.error);
    if (v.error !== undefined) return;
    expect(toHex(authorPanelId(k, keys))).toBe(v.authorPanelId);
    // Under its own tag, never a default panel's identifier over the same keys.
    if (k >= 2) expect(toHex(panelId({ threshold: k, keys }))).not.toBe(v.authorPanelId);
  });

  test("covers every validity code", () => {
    expect(new Set(file.authorPanels.map((v) => v.error))).toEqual(
      new Set([undefined, "size", "threshold", "key", "duplicate-key", "default-seat"]),
    );
  });
});
