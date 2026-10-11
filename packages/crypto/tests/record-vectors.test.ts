import { describe, expect, test } from "vite-plus/test";
import {
  DecodeError,
  decodeElectionDefinition,
  DISPLAY_TEXT,
  type DisplayText,
  displayTextCommitment,
  displayTextRule,
  type ElectionDefinition,
  electionDefinitionHash,
  electionDefinitionRule,
  encodeDisplayText,
  encodeElectionDefinition,
  PROTOCOL_SCHEMA,
} from "../src/index.ts";
import { buildSchema, hex, readVectorFile, type Vector } from "./spec-vectors.ts";

// docs/spec/vectors/election-definition.json and display-text.json, printed by
// scripts/definition-vectors.py from the spec tables. Every vector runs
// through the production codecs and rule checks; the expected values come
// from the files' own type descriptors (T-31, T-34, T-36).
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function decodeError(f: () => unknown): string | undefined {
  try {
    f();
  } catch (e) {
    if (e instanceof DecodeError) return e.code;
    throw e;
  }
  return undefined;
}

function checkFile(name: string, count: number) {
  const file = readVectorFile(name);
  test("is a draft file whose vectors each have exactly one of value or error", () => {
    expect(file.draft).toBe(true);
    expect(file.vectors.length).toBe(count);
    expect(new Set(file.vectors.map((v) => v.id)).size).toBe(file.vectors.length);
    for (const v of file.vectors) expect("value" in v !== "error" in v).toBe(true);
  });
  // From the file's own descriptors, never from the codecs under test.
  const { type } = buildSchema(file);
  const expected = (v: Vector) => type(v.type).built.fromJson(v.value);
  return {
    valid: file.vectors.filter((v) => "value" in v).map((v) => [v.id, v, expected] as const),
    invalid: file.vectors.filter((v) => "error" in v).map((v) => [v.id, v] as const),
  };
}

describe("election definition (docs/spec/election-definition.md)", () => {
  const { valid, invalid } = checkFile("election-definition.json", 58);

  test.each(valid)("%s decodes, re-encodes, hashes and meets its rules", (_id, v, expected) => {
    const value = expected(v) as ElectionDefinition;
    const decoded = decodeElectionDefinition(hex(v.encoding));
    expect(decoded).toEqual(value);
    expect(toHex(encodeElectionDefinition(decoded))).toBe(v.encoding);
    expect(toHex(electionDefinitionHash(decoded))).toBe(v.hash);
    expect(electionDefinitionRule(decoded)).toBe(v.illFormed);
  });

  test.each(invalid)("%s is rejected", (_id, v) => {
    expect(decodeError(() => decodeElectionDefinition(hex(v.encoding)))).toBe(v.error);
  });

  test("covers every well-formedness rule the spec lists", () => {
    const rules = new Set(valid.map(([, v]) => v.illFormed).filter((r) => r !== undefined));
    expect([...rules].toSorted()).toEqual(
      [
        "protocol-major",
        "profile-order",
        "profile-types",
        "profile-version",
        "option-count",
        "selections",
        "electorate",
        "panel",
        "chain",
        "timing",
      ].toSorted(),
    );
  });

  test("a display-text record is an unexpected type where a definition is read", () => {
    const [, dt] = readVectorFile("display-text.json").vectors.map((v) => [v.id, v] as const)[0]!; // the file has vectors (checked above)
    expect(decodeError(() => decodeElectionDefinition(hex(dt.encoding)))).toBe(
      "unexpected-record-type",
    );
  });
});

describe("display text (docs/spec/display-text.md)", () => {
  const { valid, invalid } = checkFile("display-text.json", 28);

  const definitionFor = (v: Vector) =>
    ({
      option_count: Number(v.definition?.optionCount),
      display_text_commitment: hex(v.definition?.displayTextCommitment ?? ""),
    }) as ElectionDefinition;

  test.each(valid)("%s decodes, re-encodes, commits and meets its rules", (_id, v, expected) => {
    const value = expected(v) as DisplayText;
    const decoded = PROTOCOL_SCHEMA.decode(DISPLAY_TEXT, hex(v.encoding), 1).value;
    expect(decoded).toEqual(value);
    expect(toHex(encodeDisplayText(decoded))).toBe(v.encoding);
    expect(toHex(displayTextCommitment(decoded))).toBe(v.commitment);
    expect(displayTextRule(decoded, definitionFor(v))).toBe(v.illFormed);
  });

  test.each(invalid)("%s is rejected", (_id, v) => {
    expect(v.pinned).toBe(1);
    expect(decodeError(() => PROTOCOL_SCHEMA.decode(DISPLAY_TEXT, hex(v.encoding), 1))).toBe(
      v.error,
    );
  });
});
