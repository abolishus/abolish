import { encodeDisplayTextV2, EncodeError } from "@abolishus/crypto";
import {
  draftDisplayText,
  MAX_CLOSE_SECONDS,
  MAX_DRAFT_TEXT,
  MAX_PLACE_LENGTH,
  MIN_OPEN_SECONDS,
  placeIsWellFormed,
  POLL_TOPICS,
  type PollDraft,
  pollDraftProblem,
  SETUP_SECONDS,
} from "@abolishus/core/poll-draft-rules";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import {
  ANSWER_RULES,
  checkForm,
  closesAtOf,
  closesErrors,
  draftOf,
  fieldErrors,
  fieldId,
  type FormQuestion,
  formOf,
  newPollForm,
  type PollForm,
  tidyPlace,
} from "../src/account/poll-form.ts";

// The poll form's model: that its field checks agree with the rules the
// drafts handler applies (`pollDraftProblem`, core's), that a saved draft
// reads back into the form and out again unchanged, and the closing window.

const runs = { numRuns: Number(process.env["FC_NUM_RUNS"] ?? 100) };

// 2026-10-18T12:00:00Z
const NOW = 1792324800n;

const option = (label: string, description = "") => ({ key: label, label, description });

const question = (over: Partial<FormQuestion> = {}): FormQuestion => ({
  key: "q",
  question: "Should the harbor library open on Sundays?",
  description: "",
  rule: "one",
  optional: false,
  min: 1,
  max: 2,
  options: [option("Yes"), option("No")],
  ...over,
});

const form = (over: Partial<PollForm> = {}): PollForm => ({
  ...newPollForm(),
  title: "Harbor library hours",
  questions: [question()],
  closesDate: "2026-11-04",
  closesTime: "15:00",
  ...over,
});

const problems = (f: PollForm) => fieldErrors(f).map((e) => e.problem);

// Text that is mostly fine and sometimes empty, repeated, too long by a byte
// or unstorable, so most forms break one rule at most and each check is seen alone.
const text = (limit: number) =>
  fc.oneof(
    { weight: 12, arbitrary: fc.constantFrom("Yes", "No", "Maybe", "a", "b") },
    { weight: 1, arbitrary: fc.constantFrom("", "\uD800", "a\0b", "é".repeat(limit / 2)) },
    {
      weight: 1,
      arbitrary: fc.constantFrom(
        "x".repeat(limit),
        "x".repeat(limit + 1),
        "é".repeat(limit / 2 + 1),
      ),
    },
    { weight: 1, arbitrary: fc.string({ maxLength: 8 }) },
  );

const formQuestion = fc.record({
  key: fc.uuid(),
  question: text(1024),
  description: text(8192),
  rule: fc.constantFrom(...ANSWER_RULES),
  optional: fc.boolean(),
  min: fc.integer({ min: 0, max: 4 }),
  max: fc.integer({ min: 0, max: 4 }),
  options: fc.array(fc.record({ key: fc.uuid(), label: text(512), description: text(1024) }), {
    maxLength: 4,
  }),
});

// Places that are mostly fine, sometimes untidy (which the form tidies), and
// sometimes holding what no tidying fixes: a bidi mark, an invisible
// character, U+0000, a lone surrogate half, or one letter too many.
const place = fc.oneof(
  {
    weight: 8,
    arbitrary: fc.constantFrom("", "Riverside", "São Paulo", "North  Ward ", "\tElm St\n"),
  },
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      "Elm\u200bStreet",
      "\u202eedisreviR",
      "a\u00adb",
      "a\0b",
      "\uDC00",
      "x".repeat(MAX_PLACE_LENGTH),
      "x".repeat(MAX_PLACE_LENGTH + 1),
      "é".repeat(MAX_PLACE_LENGTH),
      "e\u0301".repeat(MAX_PLACE_LENGTH),
      "   ",
    ),
  },
  { weight: 1, arbitrary: fc.string({ maxLength: 8, unit: "binary" }) },
);

const topic = fc.constantFrom("" as const, ...POLL_TOPICS);

const anyForm = fc.record({
  language: fc.constant("en"),
  title: text(1024),
  description: text(8192),
  place,
  topic,
  questions: fc.oneof(
    { weight: 20, arbitrary: fc.array(formQuestion, { maxLength: 3 }) },
    { weight: 1, arbitrary: fc.array(formQuestion, { minLength: 33, maxLength: 34 }) },
  ),
  tiers: fc.constant([0]),
  closesDate: fc.constant("2026-11-04"),
  closesTime: fc.constant("15:00"),
});

// A form the handler accepts, then at most one thing broken in it, so every
// check is seen on its own as well as among others.
const validQuestion = fc
  .record({
    key: fc.uuid(),
    question: fc.string({ minLength: 1, maxLength: 12 }),
    description: fc.string({ maxLength: 12 }),
    rule: fc.constantFrom(...ANSWER_RULES),
    optional: fc.boolean(),
    lo: fc.nat(),
    hi: fc.nat(),
    options: fc.uniqueArray(
      fc.record({
        key: fc.uuid(),
        label: fc.string({ minLength: 1, maxLength: 8 }),
        description: fc.string({ maxLength: 8 }),
      }),
      { minLength: 2, maxLength: 4, selector: (o) => o.label },
    ),
  })
  .map(({ lo, hi, ...q }): FormQuestion => {
    const max = 1 + (hi % q.options.length);
    return { ...q, max, min: Math.min(1 + (lo % max), max) };
  });

type Break = (f: PollForm, n: number) => PollForm;
const edit = (f: PollForm, n: number, change: (q: FormQuestion) => FormQuestion) => {
  const i = n % f.questions.length;
  return { ...f, questions: f.questions.map((q, j) => (j === i ? change(q) : q)) };
};
const BREAKS: readonly Break[] = [
  (f) => f,
  (f) => ({ ...f, title: "" }),
  (f) => ({ ...f, title: "é".repeat(513) }),
  (f) => ({ ...f, description: "x".repeat(8193) }),
  (f) => ({ ...f, title: `${f.title}\uDBFF` }),
  (f) => ({ ...f, questions: [] }),
  (f) => ({
    ...f,
    questions: Array.from({ length: 33 }, (_, i) => ({ ...f.questions[0]!, question: `${i}` })),
  }),
  (f) => ({ ...f, questions: [...f.questions, { ...f.questions[0]!, key: "copy" }] }),
  (f, n) => edit(f, n, (q) => ({ ...q, question: "" })),
  (f, n) => edit(f, n, (q) => ({ ...q, question: "x".repeat(1025) })),
  (f, n) => edit(f, n, (q) => ({ ...q, description: "\0" })),
  (f, n) => edit(f, n, (q) => ({ ...q, options: q.options.slice(0, 1) })),
  (f, n) =>
    edit(f, n, (q) => ({ ...q, options: [...q.options, { ...q.options[0]!, key: "copy" }] })),
  (f, n) =>
    edit(f, n, (q) => ({
      ...q,
      options: [...q.options, { key: "empty", label: "", description: "" }],
    })),
  (f, n) =>
    edit(f, n, (q) => ({
      ...q,
      options: q.options.map((o) => ({ ...o, label: "x".repeat(513) })),
    })),
  (f, n) =>
    edit(f, n, (q) => ({
      ...q,
      options: q.options.map((o) => ({ ...o, description: "x".repeat(1025) })),
    })),
  (f, n) => edit(f, n, (q) => ({ ...q, rule: "exactly", max: q.options.length + 1 })),
  (f, n) => edit(f, n, (q) => ({ ...q, rule: "between", min: 2, max: 1 })),
  (f, n) => edit(f, n, (q) => ({ ...q, rule: "upTo", max: 0 })),
  (f, n) =>
    edit(f, n, (q) => ({
      ...q,
      options: Array.from({ length: 65 }, (_, i) => ({
        key: `${i}`,
        label: `${i}`,
        description: "",
      })),
    })),
];

const brokenForm = fc
  .record({
    title: fc.string({ minLength: 1, maxLength: 12 }),
    description: fc.string({ maxLength: 12 }),
    questions: fc.uniqueArray(validQuestion, {
      minLength: 1,
      maxLength: 3,
      selector: (q) => q.question,
    }),
    place,
    topic,
    which: fc.nat({ max: BREAKS.length - 1 }),
    n: fc.nat(),
  })
  .map(({ which, n, ...rest }) => BREAKS[which]!({ ...form(), ...rest }, n));

/** Whether a draft's fields each fit their bounds but its text is over `MAX_DRAFT_TEXT`. */
function wholeTooLong(d: PollDraft) {
  try {
    return encodeDisplayTextV2(draftDisplayText(d, new Uint8Array(32))).length > MAX_DRAFT_TEXT;
  } catch (e) {
    if (e instanceof EncodeError) return false;
    throw e;
  }
}

describe("the poll form's checks", () => {
  test("pass exactly when the handler's rules do, but for the whole text's size", () => {
    fc.assert(
      fc.property(fc.oneof(anyForm, brokenForm), (f) => {
        const errors = fieldErrors(f);
        const problem = pollDraftProblem(draftOf(f)!);
        if (problem === undefined) expect(errors).toEqual([]);
        // The one rule no field can be blamed for: every field fits, the whole doesn't.
        if (errors.length === 0)
          expect(problem).toEqual(wholeTooLong(draftOf(f)!) ? { rule: "too-long" } : undefined);
        // What the page sends is what the handler accepts, or nothing.
        const checked = checkForm(f, NOW);
        if (checked.draft !== undefined) expect(pollDraftProblem(checked.draft)).toBeUndefined();
        else expect(checked.errors.length).toBeGreaterThan(0);
      }),
      runs,
    );
  });

  test("name each problem on its field, in page order, with its question", () => {
    expect(fieldErrors(form())).toEqual([]);
    const q = question({
      key: "q2",
      question: "Which evenings?",
      options: [option("Yes"), option("Yes"), option("")],
      rule: "exactly",
      max: 4,
    });
    expect(fieldErrors(form({ title: "", questions: [question(), q] }))).toEqual([
      { id: fieldId.title, problem: "titleMissing" },
      { id: fieldId.max("q2"), problem: "rangeInvalid", question: 2 },
      { id: fieldId.label("q2", "Yes"), problem: "labelRepeated", question: 2 },
      { id: fieldId.label("q2", ""), problem: "labelMissing", question: 2 },
    ]);
    expect(problems(form({ questions: [question(), question({ key: "b" })] }))).toEqual([
      "questionRepeated",
    ]);
    expect(problems(form({ questions: [question({ options: [option("Yes")] })] }))).toEqual([
      "tooFewOptions",
    ]);
    expect(problems(form({ questions: [] }))).toEqual(["questionMissing"]);
    const many = Array.from({ length: 33 }, (_, i) => question({ key: `q${i}`, question: `${i}` }));
    expect(problems(form({ questions: many })).at(-1)).toBe("tooManyQuestions");
    expect(problems(form({ title: "a\uDC00" }))).toEqual(["unstorable"]);
    // Bounds are the codec's, in UTF-8 bytes: 512 two-byte letters is 1024.
    expect(problems(form({ title: "é".repeat(512) }))).toEqual([]);
    expect(problems(form({ title: "é".repeat(513) }))).toEqual(["tooLong"]);
  });

  test("tidy a place's spacing and name what tidying can't fix", () => {
    expect(fieldErrors(form({ place: "  Riverside \n North  " }))).toEqual([]);
    expect(draftOf(form({ place: "  Riverside \n North  " }))?.place).toBe("Riverside North");
    // Only spaces is no place, as an empty field is.
    expect(draftOf(form({ place: " \t " }))).not.toHaveProperty("place");
    expect(draftOf(form({ place: "" }))).not.toHaveProperty("place");
    // Composed to NFC, so two spellings of one letter are one place.
    expect(draftOf(form({ place: "Sa\u0303o Paulo" }))?.place).toBe("São Paulo");
    expect(problems(form({ place: "x".repeat(MAX_PLACE_LENGTH) }))).toEqual([]);
    expect(fieldErrors(form({ place: "x".repeat(MAX_PLACE_LENGTH + 1) }))).toEqual([
      { id: fieldId.place, problem: "placeTooLong" },
    ]);
    // Counted in code points after composing: 80 decomposed é are 80 letters.
    expect(problems(form({ place: "e\u0301".repeat(MAX_PLACE_LENGTH) }))).toEqual([]);
    for (const refused of ["Elm\u200bStreet", "\u202eedisreviR", "a\u00adb", "\u2066x\u2069"])
      expect(problems(form({ place: refused }))).toEqual(["placeRefused"]);
    expect(problems(form({ place: "a\0b" }))).toEqual(["unstorable"]);
    expect(problems(form({ place: "\uD800" }))).toEqual(["unstorable"]);
  });

  test("tidy any place to its own tidy form, which the handler's rule accepts when short and clean", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 40 }), (raw) => {
        const tidy = tidyPlace(raw);
        expect(tidyPlace(tidy)).toBe(tidy);
        // Whatever the field doesn't name is a place the handler accepts.
        const named = fieldErrors(form({ place: raw })).some((e) => e.id === fieldId.place);
        if (!named && tidy !== "") expect(placeIsWellFormed(tidy)).toBe(true);
      }),
      runs,
    );
  });

  test("send a topic only when one is chosen", () => {
    expect(draftOf(form())).not.toHaveProperty("topic");
    for (const topic of POLL_TOPICS) expect(draftOf(form({ topic }))?.topic).toBe(topic);
  });

  test("count options across every question, as definition version 5 does", () => {
    const many = (key: string, n: number) =>
      question({
        key,
        question: key,
        options: Array.from({ length: n }, (_, i) => option(String(i))),
      });
    expect(problems(form({ questions: [many("a", 32), many("b", 32)] }))).toEqual([]);
    expect(fieldErrors(form({ questions: [many("a", 32), many("b", 33)] }))).toEqual([
      { id: fieldId.addOption("b"), problem: "tooManyOptions", question: 2 },
    ]);
  });

  test("refuse, as a whole, a draft whose fields fit but whose text doesn't", () => {
    const long = Array.from({ length: 5 }, (_, i) =>
      question({ key: `q${i}`, question: `Question ${i}`, description: "x".repeat(8000) }),
    );
    const f = form({ questions: long });
    expect(fieldErrors(f)).toEqual([]);
    expect(checkForm(f, NOW)).toEqual({
      draft: undefined,
      errors: [{ id: fieldId.form, problem: "draftTooLong" }],
    });
  });

  test("hold the closing time to the window submission allows", () => {
    const at = (s: bigint) => {
      const d = new Date(Number(s) * 1000).toISOString();
      return form({ closesDate: d.slice(0, 10), closesTime: d.slice(11, 16) });
    };
    const earliest = NOW + BigInt(SETUP_SECONDS + MIN_OPEN_SECONDS);
    expect(closesErrors(at(earliest), NOW)).toEqual([]);
    expect(closesErrors(at(earliest - 60n), NOW)).toEqual([
      { id: fieldId.closes, problem: "closesTooSoon" },
    ]);
    const latest = NOW + BigInt(MAX_CLOSE_SECONDS);
    expect(closesErrors(at(latest), NOW)).toEqual([]);
    expect(closesErrors(at(latest + 60n), NOW)).toEqual([
      { id: fieldId.closes, problem: "closesTooLate" },
    ]);
    for (const [closesDate, closesTime] of [
      ["", "15:00"],
      ["2026-11-04", ""],
      ["2026-02-31", "12:00"],
      ["2026-11-04", "24:00"],
      ["2026-11-04", "12:60"],
      ["1969-12-31", "23:59"],
      ["2026-11-4", "12:00"],
    ] as const) {
      expect(closesAtOf({ closesDate, closesTime })).toBeUndefined();
      expect(closesErrors(form({ closesDate, closesTime }), NOW)).toEqual([
        { id: fieldId.closes, problem: "closesMissing" },
      ]);
    }
    expect(closesAtOf({ closesDate: "2026-11-04", closesTime: "15:00" })).toBe(1793804400n);
  });
});

// Drafts the handler accepts, with closing times to the minute the form shows.
const savedDraft: fc.Arbitrary<PollDraft> = fc
  .record({
    title: fc.string({ minLength: 1, maxLength: 20 }),
    description: fc.string({ maxLength: 20 }),
    questions: fc.uniqueArray(
      fc.record({
        question: fc.string({ minLength: 1, maxLength: 20 }),
        description: fc.string({ maxLength: 20 }),
        options: fc.uniqueArray(
          fc.record({
            label: fc.string({ minLength: 1, maxLength: 10 }),
            description: fc.string({ maxLength: 10 }),
          }),
          { minLength: 2, maxLength: 6, selector: (o) => o.label },
        ),
        lo: fc.nat(),
        hi: fc.nat(),
      }),
      { minLength: 1, maxLength: 4, selector: (q) => q.question },
    ),
    minutes: fc.bigInt({ min: 0n, max: 4_000_000_000n / 60n }),
    topic: fc.option(fc.constantFrom(...POLL_TOPICS), { nil: undefined }),
    place: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
  })
  .map(({ questions, minutes, topic, place, ...rest }) => ({
    language: "en",
    ...rest,
    ...(topic === undefined ? {} : { topic }),
    ...(place === undefined ? {} : { place }),
    questions: questions.map(({ lo, hi, ...q }) => {
      const m = q.options.length;
      const max = 1 + (hi % m);
      return { ...q, minSelections: lo % (max + 1), maxSelections: max };
    }),
    tiers: [0],
    closesAt: minutes * 60n,
  }))
  .filter((d) => pollDraftProblem(d) === undefined);

describe("a saved draft in the form", () => {
  test("reads back into the form and out again unchanged, whatever its ranges", () => {
    fc.assert(
      fc.property(savedDraft, (d) => {
        expect(draftOf(formOf(d))).toEqual(d);
        expect(fieldErrors(formOf(d))).toEqual([]);
      }),
      runs,
    );
  });

  test("reads each range as the rule that says it", () => {
    const rule = (min: number, max: number, m = 4) => {
      const [q] = formOf({
        ...draftOf(form())!,
        questions: [
          {
            question: "q",
            description: "",
            options: Array.from({ length: m }, (_, i) => ({ label: `${i}`, description: "" })),
            minSelections: min,
            maxSelections: max,
          },
        ],
      }).questions;
      return [q!.rule, q!.optional];
    };
    expect(rule(1, 1)).toEqual(["one", false]);
    expect(rule(0, 1)).toEqual(["one", true]);
    expect(rule(1, 4)).toEqual(["any", false]);
    expect(rule(0, 4)).toEqual(["any", true]);
    expect(rule(0, 3)).toEqual(["upTo", true]);
    expect(rule(3, 3)).toEqual(["exactly", false]);
    expect(rule(2, 3)).toEqual(["between", false]);
  });

  test("leaves the closing time empty when no date can show it", () => {
    const f = formOf({ ...draftOf(form())!, closesAt: (1n << 64n) - 1n });
    expect([f.closesDate, f.closesTime]).toEqual(["", ""]);
    expect(closesErrors(f, NOW)).toEqual([{ id: fieldId.closes, problem: "closesMissing" }]);
  });
});
