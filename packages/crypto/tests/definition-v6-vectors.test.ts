import { describe, expect, test } from "vite-plus/test";
import {
  authorPanelId,
  authorPanelRule,
  DecodeError,
  decodeElectionDefinitionRecord,
  decodeElectionDefinitionV5,
  decodeElectionDefinitionV6,
  electionAuthorStubV6Hash,
  electionDefinitionV6Hash,
  electionDefinitionV6Rule,
  electionStubV6Hash,
  encodeElectionDefinitionV6,
  PanelError,
  panelId,
  PARAMETERS,
} from "../src/index.ts";
import { buildSchema, hex, readVectorFile, type Vector, type VectorFile } from "./spec-vectors.ts";

// docs/spec/vectors/election-definition-v6.json, printed by
// scripts/definition-v6-vectors.py (P2-16 part 1a), an implementation of the
// spec independent of this package, through the production codec, hashes and
// rules for version 6 (P2-16 part 1b). The file's own type descriptors build
// the expected values only.
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

interface AuthorPanelVector {
  readonly id: string;
  readonly threshold: string;
  readonly keys: readonly string[];
  readonly defaultKeys?: readonly string[];
  readonly authorPanelId?: string;
  readonly error?: string;
}

type V6Vector = Vector & {
  readonly authorStubHash?: string;
  readonly authorPanelId?: string;
  readonly illFormedQuestion?: string;
};

type V6File = VectorFile & {
  readonly tags: { readonly authorPanel: string };
  readonly minLiveBatch: string;
  readonly authorPanels: readonly AuthorPanelVector[];
};

const file = readVectorFile("election-definition-v6.json") as V6File;
const vectors = file.vectors as readonly V6Vector[];

function decodeError(f: () => unknown): string | undefined {
  try {
    f();
  } catch (e) {
    if (e instanceof DecodeError) return e.code;
    throw e;
  }
  return undefined;
}

describe("election definition version 6 (docs/spec/election-definition.md, Layout (version 6))", () => {
  const v5 = readVectorFile("election-definition-v5.json");
  const { type } = buildSchema({
    ...file,
    types: { ...v5.types, ...file.types },
    vectors: [...file.vectors, ...v5.vectors],
  });

  test("has unique ids, exactly one of value or error on each vector, and the floor", () => {
    expect(new Set(vectors.map((v) => v.id)).size).toBe(vectors.length);
    for (const v of vectors) expect("value" in v !== "error" in v).toBe(true);
    expect(file.minLiveBatch).toBe(String(PARAMETERS.MIN_LIVE_BATCH));
    expect(file.tags.authorPanel).toBe("abolish/v1/author-panel");
  });

  const valid = vectors.filter((v) => "value" in v).map((v) => [v.id, v] as const);
  const invalid = vectors.filter((v) => "error" in v).map((v) => [v.id, v] as const);

  test.each(valid)("%s decodes, re-encodes, hashes and meets its rules", (_id, v) => {
    const decoded = decodeElectionDefinitionV6(hex(v.encoding));
    expect(decoded).toEqual(type(v.type).built.fromJson(v.value));
    expect(toHex(encodeElectionDefinitionV6(decoded))).toBe(v.encoding);
    expect(toHex(electionDefinitionV6Hash(decoded))).toBe(v.hash);
    // The default panel's stub zeroes its own transcript hash and keeps the
    // author panel's, so its registration binds it; the author panel's stub
    // zeroes both.
    expect(toHex(electionStubV6Hash(decoded))).toBe(v.stubHash);
    expect(toHex(electionAuthorStubV6Hash(decoded))).toBe(v.authorStubHash);
    const failure = electionDefinitionV6Rule(decoded);
    expect(failure?.rule).toBe(v.illFormed);
    expect(
      failure !== undefined && "question" in failure ? String(failure.question) : undefined,
    ).toBe(v.illFormedQuestion);
    // The file gives the formula's output for every non-empty key list;
    // `authorPanelId` computes it only for a panel valid under rules 1 to 3.
    const panel = { threshold: decoded.author_threshold, keys: decoded.author_keys };
    expect(v.authorPanelId === undefined).toBe(panel.keys.length === 0);
    if (authorPanelRule(panel) === undefined)
      expect(toHex(authorPanelId(panel))).toBe(v.authorPanelId);
    else expect(() => authorPanelId(panel)).toThrow(PanelError);
  });

  test.each(invalid)("%s is rejected", (_id, v) => {
    expect(decodeError(() => decodeElectionDefinitionV6(hex(v.encoding)))).toBe(v.error);
  });

  // The verifier reads versions 1, 3 and 4 until P2-16 part 4: a version-6
  // record is unknown-version at its version byte, read before any field,
  // so 2.3 leaves it unverifiable whatever its fields hold (T-36).
  test("a version-6 definition is unknown-version at its version byte to the verifier's decoder", () => {
    const sixes = vectors.filter((x) => hex(x.encoding)[2] === 6);
    expect(sixes.length).toBeGreaterThan(0);
    for (const v of sixes) {
      let error: unknown;
      try {
        decodeElectionDefinitionRecord(hex(v.encoding));
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(DecodeError);
      expect((error as DecodeError).code).toBe("unknown-version");
      expect((error as DecodeError).offset).toBe(2);
    }
  });

  test("version 5 and version 6 each refuse the other's well-labelled definitions", () => {
    const five = v5.vectors.find((x) => x.id === "definition-v5-typical");
    const six = vectors.find((x) => x.id === "definition-v6-typical");
    expect(decodeError(() => decodeElectionDefinitionV6(hex(five!.encoding)))).toBe(
      "unknown-version",
    );
    expect(decodeError(() => decodeElectionDefinitionV5(hex(six!.encoding)))).toBe(
      "unknown-version",
    );
  });

  test("labels every well-formedness rule version 6 adds, beside version 5's", () => {
    const labelled = valid.map(([, v]) => v);
    expect(new Set(labelled.map((v) => v.illFormed).filter((r) => r !== undefined))).toEqual(
      new Set(["results", "civic-sealed", "author-panel", "receipt-keys", "selections"]),
    );
    for (const v of labelled)
      expect(v.illFormedQuestion !== undefined).toBe(v.illFormed === "selections");
  });
});

describe("author panel identifier (docs/spec/trustee-identity.md, Author panel identifier)", () => {
  test.each(file.authorPanels.map((v) => [v.id, v] as const))("%s", (_id, v) => {
    const panel = { threshold: Number(v.threshold), keys: v.keys.map(hex) };
    expect(authorPanelRule(panel, v.defaultKeys?.map(hex))).toBe(v.error);
    if (v.error === undefined) {
      expect(toHex(authorPanelId(panel))).toBe(v.authorPanelId);
      // Under its own tag, never a default panel's identifier over the same keys.
      if (panel.threshold >= 2) expect(toHex(panelId(panel))).not.toBe(v.authorPanelId);
      return;
    }
    // Rule 4 needs the default panel, so the identifier exists without it.
    if (v.error === "default-seat") expect(authorPanelRule(panel)).toBeUndefined();
    else expect(() => authorPanelId(panel)).toThrow(PanelError);
  });

  test("covers every validity code", () => {
    expect(new Set(file.authorPanels.map((v) => v.error))).toEqual(
      new Set([undefined, "size", "threshold", "key", "duplicate-key", "default-seat"]),
    );
  });
});
