import { createHash } from "node:crypto";

import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  checkElectionRecordToShow,
  checkElectionToShow,
  DecodeError,
  decodeDisplayTextV2,
  decodeElectionDefinition,
  decodeElectionDefinitionV5,
  DEFINITION_V1_LIMITS,
  DEFINITION_V5_LIMITS,
  definitionQuestionsRule,
  DISPLAY_TEXT_V2_LIMITS,
  type DisplayTextV2,
  displayTextV2Rule,
  type ElectionDefinitionV5,
  electionDefinitionV5Rule,
  electionStubV5Hash,
  encodeDisplayTextV2,
  encodeElectionDefinition,
  encodeElectionDefinitionV5,
  flatOptionIndex,
  PARAMETERS,
  type Question,
  questionOffsets,
  questionOption,
  RECORD_TYPES,
} from "../src/index.ts";
import { hex, readVectorFile } from "./spec-vectors.ts";

// Properties of election-definition version 5 and display-text version 2
// (docs/spec/election-definition.md, Layout (version 5), Questions,
// Well-formedness; docs/spec/display-text.md, Layout (version 2), Checks):
// every value round-trips and every accepted encoding re-encodes to itself,
// the question rules accept exactly what the spec's tables say and name the
// first failing question, the flat index is a bijection, the questions are in
// the stub, and the show check refuses whatever the spec refuses (T-28, T-31,
// T-34, T-41).
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const opts = { numRuns };

const vector = (file: string, id: string) => {
  const v = readVectorFile(file).vectors.find((x) => x.id === id);
  if (v === undefined) throw new Error(`${id} is missing`);
  return v;
};

const typical = decodeElectionDefinitionV5(
  hex(vector("election-definition-v5.json", "definition-v5-typical").encoding),
);

/** `H(DS(tag, bytes))` by the spec's formula, with node:crypto rather than the code under test. */
function specHash(tag: string, bytes: Uint8Array): Uint8Array {
  const t = Buffer.from(tag, "ascii");
  return Uint8Array.from(
    createHash("sha256")
      .update(Buffer.concat([Buffer.from([t.length]), t, bytes]))
      .digest(),
  );
}

const u16 = fc.integer({ min: 0, max: 0xffff });
// Small counts and limits hit every rule's boundary; any u16 checks the codec.
const small = fc.integer({ min: 0, max: 70 });
const question = (n: fc.Arbitrary<number>): fc.Arbitrary<Question> =>
  fc.record({
    method: fc.constant(1 as const),
    option_count: n,
    min_selections: n,
    max_selections: n,
  });
const questions = (n: fc.Arbitrary<number>) =>
  fc.array(question(n), { minLength: 0, maxLength: DEFINITION_V5_LIMITS.maxQuestions });

/**
 * The spec's `questions`, `option-count` and `selections` rows, read
 * directly: the first rule broken and its question, or undefined.
 */
function specQuestionsRule(qs: readonly Question[]) {
  if (qs.length === 0) return { rule: "questions" };
  let o = 0;
  for (const [q, x] of qs.entries()) {
    if (x.option_count < 2 || o + x.option_count > PARAMETERS.MAX_OPTIONS)
      return { rule: "option-count", question: q };
    o += x.option_count;
  }
  for (const [q, x] of qs.entries())
    if (
      !(x.min_selections <= x.max_selections) ||
      !(x.max_selections <= x.option_count) ||
      !(x.max_selections >= 1)
    )
      return { rule: "selections", question: q };
  return undefined;
}

describe("definition version 5's questions", () => {
  test("its limits are the spec's parameters", () => {
    expect(DEFINITION_V5_LIMITS.maxQuestions).toBe(PARAMETERS.MAX_QUESTIONS);
    expect(DEFINITION_V5_LIMITS.maxOptions).toBe(PARAMETERS.MAX_OPTIONS);
    expect(DEFINITION_V5_LIMITS.maxOptions).toBe(DEFINITION_V1_LIMITS.maxOptions);
    expect(DISPLAY_TEXT_V2_LIMITS.maxQuestions).toBe(PARAMETERS.MAX_QUESTIONS);
    expect(DISPLAY_TEXT_V2_LIMITS.maxOptions).toBe(PARAMETERS.MAX_OPTIONS);
    expect(DISPLAY_TEXT_V2_LIMITS.maxRecord).toBe(PARAMETERS.MAX_DISPLAY_TEXT);
  });

  test("every list of up to 32 questions round-trips, and each encoding re-encodes to itself", () => {
    fc.assert(
      fc.property(questions(u16), (qs) => {
        const d = { ...typical, questions: qs };
        const bytes = encodeElectionDefinitionV5(d);
        const decoded = decodeElectionDefinitionV5(bytes);
        expect(decoded).toEqual(d);
        expect(encodeElectionDefinitionV5(decoded)).toEqual(bytes);
      }),
      opts,
    );
  });

  test("33 questions don't encode, and a list count of 33 is length-over-max", () => {
    const q = { method: 1 as const, option_count: 2, min_selections: 0, max_selections: 1 };
    expect(() =>
      encodeElectionDefinitionV5({ ...typical, questions: Array.from({ length: 33 }, () => q) }),
    ).toThrow();
    const bytes = encodeElectionDefinitionV5({
      ...typical,
      questions: Array.from({ length: 32 }, () => q),
    });
    // The count is the first byte that differs from the same definition with no questions.
    const none = encodeElectionDefinitionV5({ ...typical, questions: [] });
    const at = none.findIndex((b, i) => b !== bytes[i]);
    expect(bytes[at]).toBe(32);
    const over = new Uint8Array(bytes);
    over[at] = 33;
    let error: unknown;
    try {
      decodeElectionDefinitionV5(over);
    } catch (e) {
      error = e;
    }
    expect((error as DecodeError).code).toBe("length-over-max");
  });

  test("the question rules accept exactly what the spec's rows accept, naming the first failing question", () => {
    fc.assert(
      fc.property(questions(small), (qs) => {
        const failure = electionDefinitionV5Rule({ ...typical, questions: qs });
        expect(failure).toEqual(specQuestionsRule(qs));
        // The rules alone, as a poll's draft is checked before any definition exists.
        expect(definitionQuestionsRule(qs)).toEqual(specQuestionsRule(qs));
      }),
      opts,
    );
  });

  test("the question rules come after the profile's and before the electorate's", () => {
    const broken = { ...typical, questions: [] };
    expect(electionDefinitionV5Rule(broken)).toEqual({ rule: "questions" });
    const major = { ...broken, profile: { ...broken.profile, protocol_major: 2 } };
    expect(electionDefinitionV5Rule(major)).toEqual({ rule: "protocol-major" });
    const electorate = { ...typical, electorate: [] };
    expect(electionDefinitionV5Rule(electorate)).toEqual({ rule: "electorate" });
    expect(electionDefinitionV5Rule({ ...electorate, questions: [] })).toEqual({
      rule: "questions",
    });
  });

  test("the owner's four methods are limits, and pick exactly N has no blank", () => {
    const m = 5;
    const q = (min: number, max: number) => ({
      method: 1 as const,
      option_count: m,
      min_selections: min,
      max_selections: max,
    });
    for (const [min, max] of [
      [0, 1], // pick one
      [0, m], // pick any
      [0, 2], // pick up to N
      [3, 3], // pick exactly N
      [1, 1], // pick one, an answer required
    ] as const)
      expect(electionDefinitionV5Rule({ ...typical, questions: [q(min, max)] })).toBeUndefined();
    // A question that forbids every answer, or one no ballot can answer.
    for (const [min, max] of [
      [0, 0],
      [3, 2],
      [0, m + 1],
      [m + 1, m + 1],
    ] as const)
      expect(electionDefinitionV5Rule({ ...typical, questions: [q(min, max)] })).toEqual({
        rule: "selections",
        question: 0,
      });
  });

  test("changing any question changes the stub hash, so the ceremony binds the questions", () => {
    fc.assert(
      fc.property(questions(small), questions(small), (a, b) => {
        fc.pre(JSON.stringify(a) !== JSON.stringify(b));
        expect(electionStubV5Hash({ ...typical, questions: a })).not.toEqual(
          electionStubV5Hash({ ...typical, questions: b }),
        );
      }),
      opts,
    );
  });

  test("the flat index is question-major and a bijection onto 0 to T − 1", () => {
    const counts = fc.array(fc.integer({ min: 1, max: 8 }), { minLength: 1, maxLength: 8 });
    fc.assert(
      fc.property(counts, (ms) => {
        const qs = ms.map((m) => ({ option_count: m }));
        const { offsets, total } = questionOffsets(qs);
        expect(total).toBe(ms.reduce((a, b) => a + b, 0));
        let flat = 0;
        for (const [q, m] of ms.entries()) {
          expect(offsets[q]).toBe(flat);
          for (let j = 0; j < m; j++, flat++) {
            expect(flatOptionIndex(qs, q, j)).toBe(flat);
            expect(questionOption(qs, flat)).toEqual({ question: q, option: j });
          }
          expect(() => flatOptionIndex(qs, q, m)).toThrow(RangeError);
          expect(() => flatOptionIndex(qs, q, -1)).toThrow(RangeError);
        }
        expect(() => questionOption(qs, total)).toThrow(RangeError);
        expect(() => questionOption(qs, -1)).toThrow(RangeError);
        expect(() => flatOptionIndex(qs, ms.length, 0)).toThrow(RangeError);
      }),
      opts,
    );
  });
});

describe("display text version 2", () => {
  // A small alphabet, so equal labels and question texts turn up often.
  const text = fc.constantFrom("", "a", "b", "Yes", "No").map((s) => new TextEncoder().encode(s));
  const optionText = fc.record({ label: text, description: text });
  const questionText = fc.record({
    question: text,
    description: text,
    options: fc.array(optionText, { minLength: 0, maxLength: 4 }),
  });
  const translation = fc.record({
    language: fc
      .constantFrom("", "en", "es", "EN", "es-419")
      .map((s) => new TextEncoder().encode(s)),
    title: text,
    description: text,
    questions: fc.array(questionText, { minLength: 0, maxLength: 3 }),
  });
  const record: fc.Arbitrary<DisplayTextV2> = fc.record({
    salt: fc.uint8Array({ minLength: 32, maxLength: 32 }),
    translations: fc.array(translation, { minLength: 0, maxLength: 3 }),
  });
  const counts = fc.array(fc.integer({ min: 0, max: 4 }), { minLength: 0, maxLength: 3 });

  const definition = (t: DisplayTextV2, optionCounts: readonly number[]) =>
    ({
      profile: { protocol_major: 1, pins: [{ record_type: RECORD_TYPES.displayText, version: 2 }] },
      questions: optionCounts.map((m) => ({
        method: 1,
        option_count: m,
        min_selections: 0,
        max_selections: 1,
      })),
      display_text_commitment: specHash("abolish/v1/display-text", encodeDisplayTextV2(t)),
    }) as unknown as ElectionDefinitionV5;

  const compare = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const distinct = (xs: readonly Uint8Array[]) =>
    xs.every((a, i) => xs.slice(i + 1).every((b) => compare(a, b) !== 0));
  const isTag = (b: Uint8Array) => b.length >= 1 && /^[a-z0-9-]+$/.test(Buffer.from(b).toString());

  /** The spec's version-2 table after `commitment`, read directly. */
  function specRule(t: DisplayTextV2, ms: readonly number[]) {
    const ts = t.translations;
    if (
      ts.length === 0 ||
      ts.some((x, i) => i > 0 && compare(ts[i - 1]!.language, x.language) >= 0)
    )
      return "translations";
    if (!ts.every((x) => isTag(x.language))) return "language-tag";
    if (!ts.every((x) => x.questions.length === ms.length)) return "question-count";
    if (!ts.every((x) => x.questions.every((q, i) => q.options.length === ms[i])))
      return "option-count";
    const nonEmpty = (b: Uint8Array) => b.length > 0;
    if (
      !ts.every(
        (x) =>
          nonEmpty(x.title) &&
          x.questions.every(
            (q) => nonEmpty(q.question) && q.options.every((o) => nonEmpty(o.label)),
          ),
      )
    )
      return "question";
    if (!ts.every((x) => x.questions.every((q) => distinct(q.options.map((o) => o.label)))))
      return "labels";
    if (!ts.every((x) => distinct(x.questions.map((q) => q.question)))) return "question-texts";
    return undefined;
  }

  test("every record round-trips, and each encoding re-encodes to itself", () => {
    fc.assert(
      fc.property(record, (t) => {
        const bytes = encodeDisplayTextV2(t);
        const decoded = decodeDisplayTextV2(bytes, definition(t, []));
        expect(decoded).toEqual(t);
        expect(encodeDisplayTextV2(decoded)).toEqual(bytes);
      }),
      opts,
    );
  });

  test("the rules accept exactly what the spec's table accepts, in its order", () => {
    fc.assert(
      fc.property(record, counts, (t, ms) => {
        expect(displayTextV2Rule(t, definition(t, ms))).toBe(specRule(t, ms));
      }),
      opts,
    );
  });

  test("any other salt or text fails the commitment first", () => {
    fc.assert(
      fc.property(record, record, counts, (t, other, ms) => {
        fc.pre(compare(encodeDisplayTextV2(t), encodeDisplayTextV2(other)) !== 0);
        expect(displayTextV2Rule(other, definition(t, ms))).toBe("commitment");
      }),
      opts,
    );
  });
});

describe("showing a version-5 election (docs/spec/display-text.md, Checks)", () => {
  const text = vector("display-text-v2.json", "display-text-v2-two-questions");
  const textBytes = hex(text.encoding);
  // The text's two questions: 3 options then 2.
  const definition: ElectionDefinitionV5 = {
    ...typical,
    questions: [
      { method: 1, option_count: 3, min_selections: 0, max_selections: 1 },
      { method: 1, option_count: 2, min_selections: 0, max_selections: 2 },
    ],
    display_text_commitment: hex(text.commitment!), // a valid text vector commits
  };
  const definitionBytes = encodeElectionDefinitionV5(definition);
  const registered = specHash("abolish/v1/election-definition", definitionBytes);
  const show = (d: Uint8Array, t: Uint8Array, id = definition.election_id, hash = registered) =>
    checkElectionRecordToShow(id, hash, d, t);

  test("a registered, well-formed election with its own text is shown as version 5", () => {
    const checked = show(definitionBytes, textBytes);
    expect(checked.ok).toBe(true);
    if (!checked.ok || checked.version !== 5) throw new Error("not shown as version 5");
    expect(checked.definition).toEqual(definition);
    expect(encodeDisplayTextV2(checked.displayText)).toEqual(textBytes);
    // The version-1 check refuses it as before: it reads version 1 only.
    expect(
      checkElectionToShow(definition.election_id, registered, definitionBytes, textBytes),
    ).toEqual({ ok: false, problem: "definition-undecodable" });
  });

  test("each check refuses in the spec's order", () => {
    expect(show(definitionBytes.subarray(1), textBytes)).toEqual({
      ok: false,
      problem: "definition-undecodable",
    });
    expect(show(definitionBytes, textBytes, new Uint8Array(32))).toEqual({
      ok: false,
      problem: "another-election",
    });
    expect(show(definitionBytes, textBytes, definition.election_id, new Uint8Array(32))).toEqual({
      ok: false,
      problem: "unregistered-definition",
    });
    const illFormed = encodeElectionDefinitionV5({
      ...definition,
      questions: [definition.questions[0]!, { ...definition.questions[1]!, max_selections: 3 }],
    });
    expect(
      show(
        illFormed,
        textBytes,
        definition.election_id,
        specHash("abolish/v1/election-definition", illFormed),
      ),
    ).toEqual({ ok: false, problem: "definition-ill-formed", rule: "selections", question: 1 });
    expect(show(definitionBytes, textBytes.subarray(1))).toEqual({
      ok: false,
      problem: "display-text-undecodable",
    });
    // A text with one question too few for the definition, committed to by it.
    const shortText = vector("display-text-v2.json", "display-text-v2-one-question-of-two");
    const shortDefinition = encodeElectionDefinitionV5({
      ...definition,
      display_text_commitment: hex(shortText.commitment!), // a valid text vector commits
    });
    expect(
      show(
        shortDefinition,
        hex(shortText.encoding),
        definition.election_id,
        specHash("abolish/v1/election-definition", shortDefinition),
      ),
    ).toEqual({ ok: false, problem: "display-text-ill-formed", rule: "question-count" });
    // Another record's text fails the commitment.
    const other = vector("display-text-v2.json", "display-text-v2-minimal");
    expect(show(definitionBytes, hex(other.encoding))).toEqual({
      ok: false,
      problem: "display-text-ill-formed",
      rule: "commitment",
    });
  });

  test("an earlier check wins when several fail at once", () => {
    const illFormed = encodeElectionDefinitionV5({ ...definition, questions: [] });
    const illHash = specHash("abolish/v1/election-definition", illFormed);
    expect(show(illFormed, textBytes, new Uint8Array(32), illHash)).toEqual({
      ok: false,
      problem: "another-election",
    });
    expect(show(illFormed, textBytes.subarray(1), definition.election_id, illHash)).toEqual({
      ok: false,
      problem: "definition-ill-formed",
      rule: "questions",
    });
    expect(show(definitionBytes, textBytes.subarray(1), definition.election_id, illHash)).toEqual({
      ok: false,
      problem: "unregistered-definition",
    });
  });

  test("definition versions 3 and 4 are refused as undecodable, as checkElectionToShow refuses them", () => {
    for (const [file, id] of [
      ["election-definition-v3.json", "definition-v3-typical"],
      ["election-definition-v4.json", "definition-v4-typical"],
    ] as const) {
      const bytes = hex(vector(file, id).encoding);
      expect(
        show(
          bytes,
          textBytes,
          definition.election_id,
          specHash("abolish/v1/election-definition", bytes),
        ),
      ).toEqual({ ok: false, problem: "definition-undecodable" });
    }
  });

  test("a version-5 definition pinning display-text version 1 has its text refused", () => {
    const pinsOne = encodeElectionDefinitionV5({
      ...definition,
      profile: {
        ...definition.profile,
        pins: definition.profile.pins.map((p) =>
          p.record_type === RECORD_TYPES.displayText ? { ...p, version: 1 } : p,
        ),
      },
    });
    expect(
      show(
        pinsOne,
        textBytes,
        definition.election_id,
        specHash("abolish/v1/election-definition", pinsOne),
      ),
    ).toEqual({ ok: false, problem: "display-text-undecodable" });
  });

  test("a version-1 election is shown as version 1, as checkElectionToShow shows it", () => {
    const t1 = vector("display-text.json", "display-text-two-languages");
    const d1 = encodeElectionDefinition({
      ...decodeElectionDefinition(
        hex(vector("election-definition.json", "definition-typical").encoding),
      ),
      option_count: 3,
      display_text_commitment: hex(t1.commitment!), // a valid text vector commits
    });
    const hash = specHash("abolish/v1/election-definition", d1);
    const id = decodeElectionDefinition(d1).election_id;
    const expected = checkElectionToShow(id, hash, d1, hex(t1.encoding));
    expect(expected.ok).toBe(true);
    expect(checkElectionRecordToShow(id, hash, d1, hex(t1.encoding))).toEqual({
      ...expected,
      version: 1,
    });
  });
});
