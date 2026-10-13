import { describe, expect, test } from "vite-plus/test";
import {
  DecodeError,
  decodeElectionDefinition,
  decodeElectionDefinitionRecord,
  DISPLAY_TEXT,
  type DisplayText,
  displayTextCommitment,
  displayTextRule,
  type ElectionDefinition,
  electionDefinitionHash,
  electionStubHash,
  electionDefinitionRule,
  type ElectionDefinitionV3,
  electionDefinitionV3Hash,
  electionDefinitionV3Rule,
  electionStubV3Hash,
  type ElectionDefinitionV4,
  electionDefinitionV4Hash,
  electionDefinitionV4Rule,
  electionStubV4Hash,
  encodeDisplayText,
  encodeElectionDefinition,
  encodeElectionDefinitionV3,
  encodeElectionDefinitionV4,
  receiptKeyJudgement,
  receiptKeyRecordFromWord,
  receiptKeysCastCheck,
} from "../src/index.ts";
import { PROTOCOL_SCHEMA } from "../src/protocol.ts";
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
  test("is a frozen file whose vectors each have exactly one of value or error", () => {
    expect(file).not.toHaveProperty("draft");
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
  const { valid, invalid } = checkFile("election-definition.json", 59);

  test.each(valid)("%s decodes, re-encodes, hashes and meets its rules", (_id, v, expected) => {
    const value = expected(v) as ElectionDefinition;
    const decoded = decodeElectionDefinition(hex(v.encoding));
    expect(decoded).toEqual(value);
    expect(toHex(encodeElectionDefinition(decoded))).toBe(v.encoding);
    expect(toHex(electionDefinitionHash(decoded))).toBe(v.hash);
    expect(toHex(electionStubHash(decoded))).toBe(v.stubHash);
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

describe("election definition version 3 (docs/spec/election-definition.md, Layout (version 3))", () => {
  const { valid, invalid } = checkFile("election-definition-v3.json", 42);

  test.each(valid)("%s decodes, re-encodes, hashes and meets its rules", (_id, v, expected) => {
    const value = expected(v) as ElectionDefinitionV3;
    const record = decodeElectionDefinitionRecord(hex(v.encoding));
    expect(record.version).toBe(3);
    const decoded = record.value as ElectionDefinitionV3;
    expect(decoded).toEqual(value);
    expect(toHex(encodeElectionDefinitionV3(decoded))).toBe(v.encoding);
    expect(toHex(electionDefinitionV3Hash(decoded))).toBe(v.hash);
    expect(toHex(electionStubV3Hash(decoded))).toBe(v.stubHash);
    expect(electionDefinitionV3Rule(decoded)).toBe(v.illFormed);
  });

  test.each(invalid)("%s is rejected", (_id, v) => {
    expect(decodeError(() => decodeElectionDefinitionRecord(hex(v.encoding)))).toBe(v.error);
  });

  test("a version-3 definition is unknown-version to callers that read only version 1", () => {
    for (const [, v] of valid)
      expect(decodeError(() => decodeElectionDefinition(hex(v.encoding)))).toBe("unknown-version");
  });

  test("covers every rule of version 3 that version 1 doesn't share, and rules on both sides", () => {
    const rules = new Set(valid.map(([, v]) => v.illFormed).filter((r) => r !== undefined));
    expect([...rules].toSorted()).toEqual(
      ["protocol-major", "selections", "electorate", "cells", "panel"].toSorted(),
    );
  });
});

describe("election definition version 4 (docs/spec/election-definition.md, Layout (version 4))", () => {
  const { valid, invalid } = checkFile("election-definition-v4.json", 21);

  test.each(valid)("%s decodes, re-encodes, hashes and meets its rules", (_id, v, expected) => {
    const value = expected(v) as ElectionDefinitionV4;
    const record = decodeElectionDefinitionRecord(hex(v.encoding));
    expect(record.version).toBe(4);
    const decoded = record.value as ElectionDefinitionV4;
    expect(decoded).toEqual(value);
    expect(toHex(encodeElectionDefinitionV4(decoded))).toBe(v.encoding);
    expect(toHex(electionDefinitionV4Hash(decoded))).toBe(v.hash);
    expect(toHex(electionStubV4Hash(decoded))).toBe(v.stubHash);
    expect(electionDefinitionV4Rule(decoded)).toBe(v.illFormed);
  });

  test.each(invalid)("%s is rejected", (_id, v) => {
    expect(decodeError(() => decodeElectionDefinitionRecord(hex(v.encoding)))).toBe(v.error);
  });

  test("a version-4 definition is unknown-version to callers that read only version 1", () => {
    for (const [, v] of valid)
      expect(decodeError(() => decodeElectionDefinition(hex(v.encoding)))).toBe("unknown-version");
  });

  test("covers receipt-keys and its place after version 3's rules", () => {
    const rules = new Set(valid.map(([, v]) => v.illFormed).filter((r) => r !== undefined));
    expect([...rules].toSorted()).toEqual(
      ["protocol-major", "cells", "timing", "receipt-keys"].toSorted(),
    );
  });

  const judging = (readVectorFile("election-definition-v4.json") as { judging?: Judging[] })
    .judging;
  interface Judging {
    readonly id: string;
    readonly registeredAt: string;
    readonly retiredAt: string;
    readonly opensAt: string;
    readonly provenAt: string;
    readonly judgement?: string;
    readonly error?: string;
    readonly word: string;
    readonly castable: boolean;
  }
  const cases = (judging ?? []).map((j) => [j.id, j] as const);

  test("has judging vectors for every judgement and impossible records", () => {
    expect(new Set(cases.map(([, j]) => j.judgement ?? j.error))).toEqual(
      new Set(["judges", "unregistered", "retired", "unsettled", "impossible-record"]),
    );
  });

  test.each(cases)("judging %s", (_id, j) => {
    const judge = () =>
      receiptKeyJudgement(
        { registeredAt: BigInt(j.registeredAt), retiredAt: BigInt(j.retiredAt) },
        BigInt(j.opensAt),
        BigInt(j.provenAt),
      );
    if (j.error === undefined) expect(judge()).toBe(j.judgement);
    else expect(judge).toThrow(RangeError);
    const read = receiptKeyRecordFromWord(hex(j.word), BigInt(j.provenAt));
    if (j.error === undefined)
      expect(read).toEqual({
        registeredAt: BigInt(j.registeredAt),
        retiredAt: BigInt(j.retiredAt),
      });
    else expect(read).toBeUndefined();
    expect(receiptKeysCastCheck([hex(j.word)], BigInt(j.opensAt), BigInt(j.provenAt))).toEqual(
      j.castable ? { castable: true } : { castable: false, code: "receipt-key-unjudged", key: 0 },
    );
  });

  interface Casting {
    readonly id: string;
    readonly opensAt: string;
    readonly provenAt: string;
    readonly words: readonly string[];
    readonly castable: boolean;
    readonly refusedKey?: number;
  }
  const casting = (readVectorFile("election-definition-v4.json") as { casting?: Casting[] })
    .casting;
  const castingCases = (casting ?? []).map((c) => [c.id, c] as const);

  test("has casting vectors that cast and that refuse", () => {
    expect(new Set(castingCases.map(([, c]) => c.castable))).toEqual(new Set([true, false]));
  });

  test.each(castingCases)("casting %s", (_id, c) => {
    expect(receiptKeysCastCheck(c.words.map(hex), BigInt(c.opensAt), BigInt(c.provenAt))).toEqual(
      c.castable
        ? { castable: true }
        : { castable: false, code: "receipt-key-unjudged", key: c.refusedKey },
    );
  });

  test("the cast check throws on no list, words that aren't 32 bytes and opens_at outside u64", () => {
    expect(() => receiptKeysCastCheck([], 0n, 0n)).toThrow(RangeError);
    expect(() => receiptKeysCastCheck([new Uint8Array(31)], 0n, 0n)).toThrow(RangeError);
    expect(() => receiptKeysCastCheck([new Uint8Array(33)], 0n, 0n)).toThrow(RangeError);
    expect(() => receiptKeysCastCheck([new Uint8Array(32).fill(0xff)], -1n, 0n)).toThrow(
      RangeError,
    );
    expect(() => receiptKeysCastCheck([new Uint8Array(32)], 1n << 64n, 0n)).toThrow(RangeError);
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
    const decoded = PROTOCOL_SCHEMA.decode(DISPLAY_TEXT, hex(v.encoding), 1).value as DisplayText;
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
