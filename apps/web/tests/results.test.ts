import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import type { PollView } from "../src/poll.ts";
import { leadersOf, resultsView, type ServedResults, shareOf } from "../src/results.ts";

const runs = { numRuns: Number(process.env["FC_NUM_RUNS"] ?? 100) };

type Read = Extract<ServedResults, { state: "read" }>;

const one: Pick<PollView, "version" | "questions" | "electorate"> = {
  version: 1,
  questions: [{ optionCount: 3, minSelections: 0, maxSelections: 1 }],
  electorate: [
    { tier: 0, groupSize: "50" },
    { tier: 2, groupSize: "5" },
  ],
};

const two: Pick<PollView, "version" | "questions" | "electorate"> = {
  version: 5,
  questions: [
    { optionCount: 3, minSelections: 0, maxSelections: 1 },
    { optionCount: 2, minSelections: 0, maxSelections: 2 },
  ],
  electorate: [{ tier: 0, groupSize: "50" }],
};

const read = (tiers: Read["tiers"]): Read => ({
  state: "read",
  openings: 1,
  passed: true,
  cells: [],
  tiers,
});

describe("resultsView", () => {
  test("says nothing is opened while the API says so", () => {
    expect(resultsView(one, { state: "unopened" })).toEqual({ kind: "unopened" });
  });

  test("takes a version-1 poll's counts as its one question", () => {
    expect(
      resultsView(
        one,
        read([
          { tier: 0, counted: 10, counts: ["6", "3", "0"] },
          { tier: 2, counted: 2 },
        ]),
      ),
    ).toEqual({
      kind: "read",
      tiers: [
        { tier: 0, counted: 10, questions: [["6", "3", "0"]] },
        { tier: 2, counted: 2, questions: undefined },
      ],
    });
  });

  test("takes a version-5 poll's slices question by question, never the joined counts", () => {
    expect(
      resultsView(
        two,
        read([
          {
            tier: 0,
            counted: 4,
            counts: ["1", "2", "1", "4", "3"],
            byQuestion: [
              ["1", "2", "1"],
              ["4", "3"],
            ],
          },
        ]),
      ),
    ).toEqual({
      kind: "read",
      tiers: [
        {
          tier: 0,
          counted: 4,
          questions: [
            ["1", "2", "1"],
            ["4", "3"],
          ],
        },
      ],
    });
  });

  // T-34: counts that don't fit the definition would print under the wrong options.
  test.each([
    [
      "a tier the electorate doesn't hold",
      read([{ tier: 1, counted: 1, counts: ["1", "0", "0"] }]),
    ],
    ["a tier beyond the three", read([{ tier: 3, counted: 1, counts: ["1", "0", "0"] }])],
    [
      "a tier named twice",
      read([
        { tier: 0, counted: 1, counts: ["1", "0", "0"] },
        { tier: 0, counted: 1, counts: ["0", "1", "0"] },
      ]),
    ],
    ["too few options", read([{ tier: 0, counted: 1, counts: ["1", "0"] }])],
    ["too many options", read([{ tier: 0, counted: 1, counts: ["1", "0", "0", "0"] }])],
    ["more picks than ballots", read([{ tier: 0, counted: 1, counts: ["2", "0", "0"] }])],
  ])("refuses %s", (_, served) => {
    expect(resultsView(one, served)).toEqual({ kind: "unavailable" });
  });

  test.each([
    ["no slices", read([{ tier: 0, counted: 1, counts: ["1", "0", "0", "1", "0"] }])],
    [
      "a question missing",
      read([{ tier: 0, counted: 1, counts: ["1", "0", "0"], byQuestion: [["1", "0", "0"]] }]),
    ],
    [
      "a slice of the wrong size",
      read([
        {
          tier: 0,
          counted: 1,
          counts: ["1", "0", "0", "1", "0"],
          byQuestion: [
            ["1", "0"],
            ["0", "1", "0"],
          ],
        },
      ]),
    ],
  ])("refuses a version-5 tier with %s", (_, served) => {
    expect(resultsView(two, served)).toEqual({ kind: "unavailable" });
  });

  test("takes every tier's counts that fit, whatever their values", () => {
    fc.assert(
      fc.property(
        fc
          .nat({ max: 1_000_000 })
          .chain((counted) =>
            fc.tuple(
              fc.constant(counted),
              fc.array(fc.nat({ max: counted }), { minLength: 3, maxLength: 3 }),
            ),
          ),
        ([counted, values]) => {
          const counts = values.map(String);
          expect(resultsView(one, read([{ tier: 0, counted, counts }]))).toEqual({
            kind: "read",
            tiers: [{ tier: 0, counted, questions: [counts] }],
          });
        },
      ),
      runs,
    );
  });
});

describe("shareOf", () => {
  test("is 0 when nobody answered", () => {
    expect(shareOf("0", 0)).toBe(0);
  });

  test("is exact for counts past a double's integers", () => {
    expect(shareOf("4503599627370496", 2 ** 53 - 1)).toBeCloseTo(0.5, 6);
  });

  test("lies in [0, 1] and agrees with the ratio", () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: 1, max: 2 ** 31 })
          .chain((counted) => fc.tuple(fc.constant(counted), fc.nat({ max: counted }))),
        ([counted, count]) => {
          const share = shareOf(String(count), counted);
          expect(share).toBeGreaterThanOrEqual(0);
          expect(share).toBeLessThanOrEqual(1);
          expect(Math.abs(share - count / counted)).toBeLessThanOrEqual(1e-6);
        },
      ),
      runs,
    );
  });
});

describe("leadersOf", () => {
  test("names none when nothing was picked", () => {
    expect(leadersOf(["0", "0"])).toEqual([]);
  });

  test("names every option tied at the top, in option order", () => {
    expect(leadersOf(["3", "5", "1", "5"])).toEqual([1, 3]);
  });

  test("names exactly the options with the most picks", () => {
    fc.assert(
      fc.property(fc.array(fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }), { minLength: 1 }), (xs) => {
        const leaders = leadersOf(xs.map(String));
        const most = xs.reduce((a, b) => (b > a ? b : a));
        const expected = most === 0n ? [] : xs.flatMap((x, i) => (x === most ? [i] : []));
        expect(leaders).toEqual(expected);
      }),
      runs,
    );
  });
});
