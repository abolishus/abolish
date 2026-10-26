import { describe, expect, test } from "vite-plus/test";
import {
  DecodeError,
  decodeElectionDefinitionRecord,
  decodeElectionDefinitionV6,
  decodeElectionDefinitionV7,
  electionAuthorStubV7Hash,
  electionDefinitionV7Hash,
  electionDefinitionV7Rule,
  electionStubV7Hash,
  encodeElectionDefinitionV7,
  rollingMembershipScope,
  rollingNullifierScope,
  semaphoreField,
} from "../src/index.ts";
import { decodeRegistrableElectionDefinition } from "../src/protocol.ts";
import { buildSchema, hex, readVectorFile, type Vector, type VectorFile } from "./spec-vectors.ts";

// docs/spec/vectors/election-definition-v7.json, printed by
// scripts/rolling-electorate-vectors.py (P2-17 part 1), an implementation of
// the spec independent of this package, through the production codec, hashes,
// rules and rolling scope for version 7 (P2-17 part 3a). The file's own type
// descriptors build the expected values only.
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

type V7Vector = Vector & {
  readonly authorStubHash?: string;
  readonly illFormedQuestion?: string;
  readonly rollingScopes?: readonly { readonly tier: string; readonly scope: string }[];
};

type V7File = VectorFile & { readonly tags: { readonly rollingScope: string } };

const file = readVectorFile("election-definition-v7.json") as V7File;
const vectors = file.vectors as readonly V7Vector[];

function decodeError(f: () => unknown): string | undefined {
  try {
    f();
  } catch (e) {
    if (e instanceof DecodeError) return e.code;
    throw e;
  }
  return undefined;
}

describe("election definition version 7 (docs/spec/election-definition.md, Layout (version 7))", () => {
  const v6 = readVectorFile("election-definition-v6.json");
  const { type } = buildSchema({
    ...file,
    types: { ...v6.types, ...file.types },
    vectors: [...file.vectors, ...v6.vectors],
  });

  test("has unique ids, exactly one of value or error on each vector, and the tag", () => {
    expect(new Set(vectors.map((v) => v.id)).size).toBe(vectors.length);
    for (const v of vectors) expect("value" in v !== "error" in v).toBe(true);
    expect(file.tags.rollingScope).toBe("abolish/v1/rolling-nullifier-scope");
  });

  const valid = vectors.filter((v) => "value" in v).map((v) => [v.id, v] as const);
  const invalid = vectors.filter((v) => "error" in v).map((v) => [v.id, v] as const);

  test.each(valid)("%s decodes, re-encodes, hashes and meets its rules", (_id, v) => {
    const decoded = decodeElectionDefinitionV7(hex(v.encoding));
    expect(decoded).toEqual(type(v.type).built.fromJson(v.value));
    expect(toHex(encodeElectionDefinitionV7(decoded))).toBe(v.encoding);
    const hash = electionDefinitionV7Hash(decoded);
    expect(toHex(hash)).toBe(v.hash);
    expect(toHex(electionStubV7Hash(decoded))).toBe(v.stubHash);
    expect(toHex(electionAuthorStubV7Hash(decoded))).toBe(v.authorStubHash);
    const failure = electionDefinitionV7Rule(decoded);
    expect(failure?.rule).toBe(v.illFormed);
    expect(
      failure !== undefined && "question" in failure ? String(failure.question) : undefined,
    ).toBe(v.illFormedQuestion);
    // Membership, Rolling scope: one per rolling tier, from the definition
    // hash and the tier alone.
    expect(v.rollingScopes === undefined).toBe(decoded.electorate_mode === 1);
    for (const [i, s] of (v.rollingScopes ?? []).entries()) {
      const tier = decoded.rolling_electorate[i]!.tier;
      expect(s.tier).toBe(String(tier));
      const scope = rollingNullifierScope(hash, tier);
      expect(toHex(scope)).toBe(s.scope);
      expect(rollingMembershipScope(hash, tier)).toBe(semaphoreField(scope));
    }
  });

  test.each(invalid)("%s is rejected", (_id, v) => {
    expect(decodeError(() => decodeElectionDefinitionV7(hex(v.encoding)))).toBe(v.error);
  });

  // The verifier reads rolling electorates in P2-17 part 4 and the registry
  // in part 5: until then a version-7 record is unknown-version at its
  // version byte to both, so 2.3 leaves it unverifiable (T-36).
  test("a version-7 definition is unknown-version to the verifier's and the registry's decoders", () => {
    const sevens = valid.map(([, v]) => v);
    expect(sevens.length).toBeGreaterThan(0);
    for (const v of sevens) {
      let error: unknown;
      try {
        decodeElectionDefinitionRecord(hex(v.encoding));
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(DecodeError);
      expect((error as DecodeError).code).toBe("unknown-version");
      expect((error as DecodeError).offset).toBe(2);
      expect(decodeError(() => decodeRegistrableElectionDefinition(hex(v.encoding)))).toBe(
        "unknown-version",
      );
    }
  });

  test("version 6 and version 7 each refuse the other's well-labelled definitions", () => {
    const six = v6.vectors.find((x) => x.id === "definition-v6-typical");
    const seven = vectors.find((x) => x.id === "definition-v7-fixed-typical");
    expect(decodeError(() => decodeElectionDefinitionV7(hex(six!.encoding)))).toBe(
      "unknown-version",
    );
    expect(decodeError(() => decodeElectionDefinitionV6(hex(seven!.encoding)))).toBe(
      "unknown-version",
    );
  });

  test("labels every well-formedness rule version 7 adds, beside earlier ones", () => {
    const labelled = valid.map(([, v]) => v);
    expect(new Set(labelled.map((v) => v.illFormed).filter((r) => r !== undefined))).toEqual(
      new Set([
        "electorate",
        "rolling-class",
        "rolling-tier",
        "author-panel",
        "civic-sealed",
        "selections",
        "panel",
      ]),
    );
    for (const v of labelled)
      expect(v.illFormedQuestion !== undefined).toBe(v.illFormed === "selections");
  });
});
