import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import {
  type BallotQuestion,
  firstUnfit,
  fits,
  instructionOf,
  pickLanguage,
  questionsOf,
  skippable,
  stillNeeded,
  toggle,
} from "../src/answers.ts";
import type { CheckedElection } from "../src/election.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const question = (options: number, min: number, max: number): BallotQuestion => ({
  question: "Which?",
  description: "",
  options: Array.from({ length: options }, (_, i) => ({ label: `Option ${i}`, description: "" })),
  minSelections: min,
  maxSelections: max,
});

// Every question the definition's well-formedness allows: at least two
// options, `1 ≤ max ≤ m` and `min ≤ max` ([[0026-multi-question-ballots]], Definition).
const wellFormed = fc
  .integer({ min: 2, max: 12 })
  .chain((m) =>
    fc
      .integer({ min: 1, max: m })
      .chain((max) => fc.integer({ min: 0, max }).map((min) => question(m, min, max))),
  );

/** A question and a run of taps on its options. */
const taps = wellFormed.chain((q) =>
  fc.tuple(fc.constant(q), fc.array(fc.nat({ max: q.options.length - 1 }), { maxLength: 40 })),
);

function tapAll(q: BallotQuestion, options: readonly number[]) {
  let selection: readonly number[] = [];
  for (const option of options) selection = toggle(q, selection, option).selection;
  return selection;
}

describe("the instruction comes from the question's limits", () => {
  test("the owner's four methods read as themselves", () => {
    expect(instructionOf(question(4, 0, 1))).toEqual({ kind: "one" });
    expect(instructionOf(question(4, 0, 4))).toEqual({ kind: "any" });
    expect(instructionOf(question(4, 0, 2))).toEqual({ kind: "upTo", max: 2 });
    expect(instructionOf(question(4, 2, 2))).toEqual({ kind: "exactly", count: 2 });
  });

  test("any other range the rules allow is said as its limits", () => {
    expect(instructionOf(question(4, 1, 1))).toEqual({ kind: "exactly", count: 1 });
    expect(instructionOf(question(4, 1, 4))).toEqual({ kind: "atLeast", min: 1 });
    expect(instructionOf(question(5, 2, 4))).toEqual({ kind: "between", min: 2, max: 4 });
    // Two options, pick any: "any", not "up to two".
    expect(instructionOf(question(2, 0, 2))).toEqual({ kind: "any" });
  });

  test("every instruction states exactly the limits the proof enforces", () => {
    fc.assert(
      fc.property(wellFormed, (q) => {
        const i = instructionOf(q);
        const m = q.options.length;
        const [min, max] =
          i.kind === "one"
            ? [0, 1]
            : i.kind === "any"
              ? [0, m]
              : i.kind === "upTo"
                ? [0, i.max]
                : i.kind === "exactly"
                  ? [i.count, i.count]
                  : i.kind === "atLeast"
                    ? [i.min, m]
                    : [i.min, i.max];
        expect([min, max]).toEqual([q.minSelections, q.maxSelections]);
      }),
      { numRuns },
    );
  });
});

describe("tapping an option", () => {
  test("never builds an overvote, a duplicate, an unsorted answer or an unknown option", () => {
    fc.assert(
      fc.property(taps, ([q, options]) => {
        const selection = tapAll(q, options);
        expect(selection.length).toBeLessThanOrEqual(q.maxSelections);
        for (const [i, o] of selection.entries()) {
          expect(o).toBeGreaterThanOrEqual(0);
          expect(o).toBeLessThan(q.options.length);
          if (i > 0) expect(o).toBeGreaterThan(selection[i - 1] ?? Infinity);
        }
        // So it fits exactly when it meets the minimum.
        expect(fits(q, selection)).toBe(selection.length >= q.minSelections);
      }),
      { numRuns },
    );
  });

  test("is refused, changing nothing, only when it would choose more than the question allows", () => {
    fc.assert(
      fc.property(taps, fc.nat(), ([q, options], pick) => {
        const before = tapAll(q, options);
        const option = pick % q.options.length;
        const { selection, refused } = toggle(q, before, option);
        const wouldOvervote =
          q.maxSelections > 1 && !before.includes(option) && before.length >= q.maxSelections;
        expect(refused).toBe(wouldOvervote);
        if (refused) expect(selection).toBe(before);
      }),
      { numRuns },
    );
  });

  test("twice, on a question with several choices, takes the choice back", () => {
    fc.assert(
      fc.property(taps, fc.nat(), ([q, options], pick) => {
        fc.pre(q.maxSelections > 1);
        const before = tapAll(q, options);
        const option = pick % q.options.length;
        const once = toggle(q, before, option);
        fc.pre(!once.refused);
        expect(toggle(q, once.selection, option).selection).toEqual(before);
      }),
      { numRuns },
    );
  });

  test("on a pick-one question replaces the answer rather than adding to it", () => {
    const q = question(4, 0, 1);
    expect(tapAll(q, [2])).toEqual([2]);
    expect(tapAll(q, [2, 0])).toEqual([0]);
    expect(tapAll(q, [2, 2])).toEqual([2]);
  });

  test("refuses an option the question doesn't have", () => {
    const q = question(3, 0, 3);
    for (const option of [-1, 3, 1.5, Number.NaN])
      expect(() => toggle(q, [], option), String(option)).toThrow(RangeError);
  });
});

describe("blanks and undervotes", () => {
  test("only a question whose minimum is 0 can be skipped", () => {
    expect(skippable(question(4, 0, 2))).toBe(true);
    expect(skippable(question(4, 2, 2))).toBe(false);
    expect(skippable(question(4, 1, 4))).toBe(false);
  });

  test("says how many more a short answer needs", () => {
    expect(stillNeeded(question(4, 2, 2), [])).toBe(2);
    expect(stillNeeded(question(4, 2, 2), [1])).toBe(1);
    expect(stillNeeded(question(4, 2, 3), [0, 1, 3])).toBe(0);
    expect(stillNeeded(question(4, 0, 1), [])).toBe(0);
  });

  test("an answer fits only within its question's limits, in order, without repeats", () => {
    const q = question(4, 1, 2);
    expect(fits(q, [0])).toBe(true);
    expect(fits(q, [0, 3])).toBe(true);
    expect(fits(q, [])).toBe(false);
    expect(fits(q, [0, 1, 2])).toBe(false);
    expect(fits(q, [3, 0])).toBe(false);
    expect(fits(q, [1, 1])).toBe(false);
    expect(fits(q, [4])).toBe(false);
    expect(fits(q, [-1])).toBe(false);
    expect(fits(q, [0.5])).toBe(false);
  });

  test("names the first question whose answer doesn't fit", () => {
    const questions = [question(3, 0, 1), question(4, 2, 2), question(2, 1, 1)];
    expect(firstUnfit(questions, [[], [0, 2], [1]])).toBeUndefined();
    expect(firstUnfit(questions, [[], [0], []])).toBe(1);
    expect(firstUnfit(questions, [[], [0, 2]])).toBe(2);
  });
});

describe("the questions of a checked election", () => {
  const election: CheckedElection = {
    electionId: "00".repeat(32),
    definitionHash: "11".repeat(32),
    electionType: "approval",
    minSelections: 0,
    maxSelections: 2,
    opensAt: 0n,
    closesAt: 1n,
    translations: [
      {
        language: "en",
        question: "Which events?",
        description: "Pick the ones you'd go to.",
        options: [
          { label: "Market", description: "" },
          { label: "Cinema", description: "Outdoors" },
          { label: "Clean-up", description: "" },
        ],
      },
      {
        language: "es",
        question: "¿Qué eventos?",
        description: "",
        options: [
          { label: "Mercado", description: "" },
          { label: "Cine", description: "Al aire libre" },
          { label: "Limpieza", description: "" },
        ],
      },
    ],
  };

  test("carry the definition's limits and the chosen translation's text", () => {
    expect(questionsOf(election, "es")).toEqual([
      {
        question: "¿Qué eventos?",
        description: "",
        options: election.translations[1]?.options,
        minSelections: 0,
        maxSelections: 2,
      },
    ]);
  });

  test("come only from a translation the election checked", () => {
    expect(() => questionsOf(election, "fr")).toThrow(RangeError);
  });
});

describe("the translation shown is the reader's where the election has it", () => {
  const of = (...tags: string[]) => tags.map((language) => ({ language }));

  test("an exact tag first, then the primary language, then the election's first", () => {
    expect(pickLanguage(of("en", "es-419"), ["es-419", "en"])).toBe("es-419");
    expect(pickLanguage(of("en", "es"), ["es-MX", "en-US"])).toBe("es");
    expect(pickLanguage(of("en", "es"), ["fr-FR", "es"])).toBe("es");
    expect(pickLanguage(of("en", "es"), ["fr-FR"])).toBe("en");
    expect(pickLanguage(of("de"), [])).toBe("de");
  });

  test("only one of the election's own tags is ever chosen", () => {
    const tag = fc.stringMatching(/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/);
    fc.assert(
      fc.property(
        fc.uniqueArray(tag, { minLength: 1, maxLength: 6 }),
        fc.array(fc.oneof(tag, fc.string()), { maxLength: 6 }),
        (tags, preferred) => {
          expect(tags).toContain(pickLanguage(of(...tags), preferred));
        },
      ),
      { numRuns },
    );
  });
});
