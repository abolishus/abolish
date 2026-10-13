import { describe, expect, test } from "vite-plus/test";
import {
  DecodeError,
  decodeDisplayText,
  decodeDisplayTextV2,
  decodeElectionDefinitionRecord,
  decodeElectionDefinitionV5,
  DISPLAY_TEXT_V2_LIMITS,
  type DisplayTextV2,
  displayTextV2Commitment,
  displayTextV2Rule,
  type ElectionDefinition,
  type ElectionDefinitionV5,
  electionDefinitionV5Hash,
  electionDefinitionV5Rule,
  electionStubV5Hash,
  encodeDisplayTextV2,
  encodeElectionDefinitionV5,
  RECORD_TYPES,
  UNPINNED,
  UnsupportedVersionError,
} from "../src/index.ts";
import { buildSchema, hex, readVectorFile, type Vector, type VectorFile } from "./spec-vectors.ts";

// docs/spec/vectors/election-definition-v5.json and display-text-v2.json,
// printed by scripts/definition-v5-vectors.py (P2-14 part 1a). Every vector
// runs through the production codecs and rules (P2-14 part 2); the expected
// values come from the files' own type descriptors, read beside the version
// each record is mislabelled as, never from the codecs under test (T-31,
// T-34, T-36, T-41).
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

type QuestionsVector = Vector & {
  readonly illFormedQuestion?: string;
  readonly definition?: { readonly optionCounts?: readonly string[] };
};

describe("election definition version 5 (docs/spec/election-definition.md, Layout (version 5))", () => {
  const file = readVectorFile("election-definition-v5.json");
  const { schema, type } = buildSchema(
    merged("election-definition-v5.json", "election-definition-v4.json"),
  );
  const vectors = file.vectors as readonly QuestionsVector[];

  test("has unique ids, and exactly one of value or error on each vector", () => {
    expect(new Set(vectors.map((v) => v.id)).size).toBe(vectors.length);
    for (const v of vectors) expect("value" in v !== "error" in v).toBe(true);
  });

  const valid = vectors.filter((v) => "value" in v).map((v) => [v.id, v] as const);
  const invalid = vectors.filter((v) => "error" in v).map((v) => [v.id, v] as const);

  test.each(valid)("%s decodes, re-encodes, hashes and meets its rules", (_id, v) => {
    const decoded = decodeElectionDefinitionV5(hex(v.encoding));
    expect(decoded).toEqual(type(v.type).built.fromJson(v.value));
    expect(toHex(encodeElectionDefinitionV5(decoded))).toBe(v.encoding);
    expect(toHex(electionDefinitionV5Hash(decoded))).toBe(v.hash);
    expect(toHex(electionStubV5Hash(decoded))).toBe(v.stubHash);
    const failure = electionDefinitionV5Rule(decoded);
    expect(failure?.rule).toBe(v.illFormed);
    expect(
      failure !== undefined && "question" in failure ? String(failure.question) : undefined,
    ).toBe(v.illFormedQuestion);
  });

  test.each(invalid)("%s is rejected", (_id, v) => {
    const bytes = hex(v.encoding);
    // An unknown-version vector is read by a decoder of its file's versions
    // only (vectors README, Rules): this package also lays out version 6, so
    // it rejects version 5's bytes labelled 6 under version 6's layout, as
    // election-definition-v6.json's definition-v5-labelled-six gives.
    if (v.error === "unknown-version" && bytes[2] === 6) {
      expect(decodeError(() => schema.decode(type(v.type).recordType, bytes, UNPINNED))).toBe(
        v.error,
      );
      expect(decodeError(() => decodeElectionDefinitionV5(bytes))).toBeDefined();
      return;
    }
    expect(decodeError(() => decodeElectionDefinitionV5(bytes))).toBe(v.error);
  });

  // The verifier reads versions 1, 3 and 4 until P2-14 part 5: a version-5
  // record is unknown-version at its version byte, read before any field,
  // so 2.3 leaves it unverifiable whatever its fields hold (T-36).
  test("a version-5 definition is unknown-version at its version byte to the verifier's decoder", () => {
    for (const v of vectors.filter((x) => hex(x.encoding)[2] === 5)) {
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

  test("a version-4 definition is unknown-version to callers that read only version 5", () => {
    const v4 = readVectorFile("election-definition-v4.json").vectors.find(
      (x) => x.id === "definition-v4-typical",
    );
    expect(decodeError(() => decodeElectionDefinitionV5(hex(v4!.encoding)))).toBe(
      "unknown-version",
    );
  });

  test("labels every well-formedness rule of version 5's questions, and the question for each", () => {
    const labelled = valid.map(([, v]) => v);
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
  const { type } = buildSchema(merged("display-text-v2.json", "display-text.json"));
  const vectors = file.vectors as readonly QuestionsVector[];

  // The rules read only the profile, the questions' option counts and the
  // commitment, so a definition with those fields stands in for each vector's.
  const definitionFor = (v: QuestionsVector, pinned = 2) =>
    ({
      profile: {
        protocol_major: 1,
        pins: [{ record_type: RECORD_TYPES.displayText, version: pinned }],
      },
      questions: (v.definition?.optionCounts ?? []).map((m) => ({
        method: 1,
        option_count: Number(m),
        min_selections: 0,
        max_selections: 1,
      })),
      display_text_commitment: hex(v.definition?.displayTextCommitment ?? ""),
    }) as unknown as ElectionDefinitionV5;

  test("has unique ids, exactly one of value or error on each vector, and the cap", () => {
    expect(new Set(vectors.map((v) => v.id)).size).toBe(vectors.length);
    for (const v of vectors) expect("value" in v !== "error" in v).toBe(true);
    expect(file.maxDisplayText).toBe(String(DISPLAY_TEXT_V2_LIMITS.maxRecord));
    for (const v of vectors)
      expect(v.encoding.length / 2).toBeLessThanOrEqual(DISPLAY_TEXT_V2_LIMITS.maxRecord);
  });

  const valid = vectors.filter((v) => "value" in v).map((v) => [v.id, v] as const);
  const invalid = vectors.filter((v) => "error" in v).map((v) => [v.id, v] as const);

  test.each(valid)(
    "%s decodes against a pin of 2, re-encodes, commits and meets its rules",
    (_id, v) => {
      expect(Number(v.pinned)).toBe(2);
      const decoded = decodeDisplayTextV2(hex(v.encoding), definitionFor(v));
      expect(decoded).toEqual(type(v.type).built.fromJson(v.value));
      expect(toHex(encodeDisplayTextV2(decoded))).toBe(v.encoding);
      expect(toHex(displayTextV2Commitment(decoded))).toBe(v.commitment);
      expect(displayTextV2Rule(decoded, definitionFor(v))).toBe(v.illFormed);
    },
  );

  test.each(invalid)("%s is rejected", (_id, v) => {
    const bytes = hex(v.encoding);
    if (Number(v.pinned) === 1) {
      const definition = {
        profile: {
          protocol_major: 1,
          pins: [{ record_type: RECORD_TYPES.displayText, version: 1 }],
        },
      } as unknown as ElectionDefinition;
      expect(decodeError(() => decodeDisplayText(bytes, definition))).toBe(v.error);
    } else {
      expect(Number(v.pinned)).toBe(2);
      expect(decodeError(() => decodeDisplayTextV2(bytes, definitionFor(v)))).toBe(v.error);
    }
  });

  test("labels every well-formedness rule of version 2", () => {
    expect(new Set(valid.map(([, v]) => v.illFormed).filter((r) => r !== undefined))).toEqual(
      new Set([
        "commitment",
        "translations",
        "language-tag",
        "question-count",
        "option-count",
        "question",
        "labels",
        "question-texts",
      ]),
    );
  });

  test("a version-5 definition that pins display-text version 1 can't decode its text as version 2", () => {
    const [, v] = valid[0]!; // the file has valid vectors
    expect(() => decodeDisplayTextV2(hex(v.encoding), definitionFor(v, 1))).toThrow(
      UnsupportedVersionError,
    );
  });
});

describe("display text version 2's whole-record cap (docs/spec/display-text.md, Size)", () => {
  const cap = DISPLAY_TEXT_V2_LIMITS.maxRecord;
  const filled = (n: number, c: number) => new Uint8Array(n).fill(c);
  const label = (i: number) => new TextEncoder().encode(`option ${i}`);
  const questionText = (i: number, description: number) => ({
    question: new TextEncoder().encode(`question ${String(i).padStart(2, "0")}`),
    description: filled(description, 0x61),
    options: [0, 1].map((o) => ({ label: label(o), description: filled(1024, 0x62) })),
  });
  const translation = (language: number, questions: ReturnType<typeof questionText>[]) => ({
    language: new TextEncoder().encode(`l${String(language).padStart(2, "0")}`),
    title: filled(1024, 0x63),
    description: filled(8192, 0x64),
    questions,
  });
  const record = (translations: ReturnType<typeof translation>[]): DisplayTextV2 => ({
    salt: new Uint8Array(32),
    translations,
  });
  const length = (t: DisplayTextV2) => encodeDisplayTextV2(t).length;

  // A record of exactly `size` bytes: as many questions as fit, 32 to a
  // translation, each with a half-length description, then the gap spread
  // over those descriptions. Each size is measured on small records, so the
  // large one is encoded once.
  function recordOfLength(size: number): DisplayTextV2 {
    const empty = length(record([translation(0, [])]));
    const perTranslation = length(record([translation(0, []), translation(1, [])])) - empty;
    const perQuestion = length(record([translation(0, [questionText(0, 4096)])])) - empty;
    let total = empty;
    const translations = [translation(0, [])];
    for (;;) {
      const full = translations.at(-1)!.questions.length === 32; // never empty
      const next = perQuestion + (full ? perTranslation : 0);
      if (total + next > size) break;
      if (full) translations.push(translation(translations.length, []));
      const current = translations.at(-1)!; // never empty
      current.questions.push(questionText(current.questions.length, 4096));
      total += next;
    }
    let gap = size - total;
    for (const t of translations)
      for (const q of t.questions) {
        const add = Math.min(4096, gap);
        q.description = filled(4096 + add, 0x61);
        gap -= add;
      }
    if (gap !== 0) throw new Error("the gap didn't fit");
    return record(translations);
  }

  const atCap = recordOfLength(cap);
  const atCapBytes = encodeDisplayTextV2(atCap);
  const pinned2 = {
    profile: { protocol_major: 1, pins: [{ record_type: RECORD_TYPES.displayText, version: 2 }] },
  } as unknown as ElectionDefinitionV5;

  test("a record of exactly MAX_DISPLAY_TEXT bytes encodes and decodes", () => {
    expect(atCapBytes.length).toBe(cap);
    // Compared as bytes: a deep comparison of 4 MiB is slower than the decode.
    const decoded = decodeDisplayTextV2(atCapBytes, pinned2);
    expect(Buffer.compare(encodeDisplayTextV2(decoded), atCapBytes)).toBe(0);
  });

  test("one byte over is length-over-max at offset 0, before the header is read", () => {
    const over = new Uint8Array(cap + 1);
    over.set(atCapBytes);
    let error: unknown;
    try {
      decodeDisplayTextV2(over, pinned2);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DecodeError);
    expect((error as DecodeError).code).toBe("length-over-max");
    expect((error as DecodeError).offset).toBe(0);
    // Any bytes at all: a header the decoder would reject first isn't read.
    expect(decodeError(() => decodeDisplayTextV2(new Uint8Array(cap + 1), pinned2))).toBe(
      "length-over-max",
    );
  });

  test("the builder refuses a record one byte over, and so can't commit to it", () => {
    const over = recordOfLength(cap + 1);
    expect(() => encodeDisplayTextV2(over)).toThrow(/MAX_DISPLAY_TEXT/);
    expect(() => displayTextV2Commitment(over)).toThrow(/MAX_DISPLAY_TEXT/);
  });
});
