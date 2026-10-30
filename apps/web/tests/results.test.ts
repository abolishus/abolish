import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import type { PartitionCell, PollView } from "../src/poll.ts";
import {
  cellResultsView,
  leadersOf,
  resultsView,
  type ServedResults,
  shareOf,
} from "../src/results.ts";

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

type ServedCell = Read["cells"][number];

// Tier 0 in three cells, Tier 2 in one, as the typical version-5 vector folds them.
const partition: readonly PartitionCell[] = [
  { tier: 0, members: "5000", regions: [0] },
  { tier: 0, members: "1200", regions: [1] },
  { tier: 0, members: "1020", regions: [2, 3] },
  { tier: 2, members: "120", regions: [0] },
];

const opened = (cell: number, tier: number, counted: number, counts: string[]): ServedCell => ({
  cell,
  tier,
  counted,
  counts,
  signers: [0],
});
const unopened = (cell: number, tier: number, counted: number, code = "tally-missing") => ({
  cell,
  tier,
  counted,
  code,
  signers: [],
});

const withCells = (tiers: Read["tiers"], cells: ServedCell[]): Read => ({
  ...read(tiers),
  cells,
});

const honest = withCells(
  [
    { tier: 0, counted: 9, counts: ["5", "3", "1"] },
    { tier: 2, counted: 2 },
  ],
  [
    opened(0, 0, 5, ["3", "2", "0"]),
    opened(1, 0, 3, ["2", "1", "0"]),
    opened(2, 0, 1, ["0", "0", "1"]),
    unopened(3, 2, 2),
  ],
);

const v1 = { version: 1 as const, questions: one.questions };

describe("cellResultsView", () => {
  test("is empty while nothing is opened", () => {
    expect(cellResultsView(v1, partition, { state: "unopened" })).toEqual([]);
  });

  test("gives each cell's results with its partition cell, in partition order", () => {
    expect(cellResultsView(v1, partition, honest)).toEqual([
      { cell: partition[0], counted: 5, state: "opened", questions: [["3", "2", "0"]] },
      { cell: partition[1], counted: 3, state: "opened", questions: [["2", "1", "0"]] },
      { cell: partition[2], counted: 1, state: "opened", questions: [["0", "0", "1"]] },
      { cell: partition[3], counted: 2, state: "missing", questions: undefined },
    ]);
  });

  test("tells a cell whose openings failed from one not yet opened", () => {
    const served = withCells(
      [
        { tier: 0, counted: 9 },
        { tier: 2, counted: 2 },
      ],
      [
        opened(0, 0, 5, ["3", "2", "0"]),
        unopened(1, 0, 3, "tally-range"),
        unopened(2, 0, 1),
        unopened(3, 2, 2),
      ],
    );
    expect(cellResultsView(v1, partition, served)?.map((c) => c.state)).toEqual([
      "opened",
      "failed",
      "missing",
      "missing",
    ]);
  });

  test("takes a version-5 cell's slices question by question", () => {
    const p = [{ tier: 0 as const, members: "50", regions: [0] }];
    const served = withCells(
      [
        {
          tier: 0,
          counted: 4,
          counts: ["1", "2", "1", "4", "3"],
          byQuestion: [
            ["1", "2", "1"],
            ["4", "3"],
          ],
        },
      ],
      [
        {
          ...opened(0, 0, 4, ["1", "2", "1", "4", "3"]),
          byQuestion: [
            ["1", "2", "1"],
            ["4", "3"],
          ],
        },
      ],
    );
    expect(cellResultsView(two, p, served)?.[0]?.questions).toEqual([
      ["1", "2", "1"],
      ["4", "3"],
    ]);
  });

  // T-34: a cell's figures that disagree with its tier's, or sit under another cell.
  const cells = honest.cells;
  test.each([
    ["a cell missing", withCells(honest.tiers, cells.slice(0, 3))],
    ["a cell too many", withCells(honest.tiers, [...cells, unopened(4, 2, 0)])],
    ["cells out of order", withCells(honest.tiers, [cells[1]!, cells[0]!, cells[2]!, cells[3]!])],
    [
      "a cell in another tier",
      withCells(honest.tiers, [...cells.slice(0, 3), { ...cells[3]!, tier: 0 }]),
    ],
    ["a cell whose tier isn't reported", withCells([honest.tiers[0]!], cells)],
    [
      "counted ballots that don't sum to the tier's",
      withCells(honest.tiers, [opened(0, 0, 6, ["3", "2", "0"]), ...cells.slice(1)]),
    ],
    [
      "counts that don't sum to the tier's",
      withCells(honest.tiers, [opened(0, 0, 5, ["2", "3", "0"]), ...cells.slice(1)]),
    ],
    [
      "a tier counted while one of its cells isn't",
      withCells(honest.tiers, [unopened(0, 0, 5), ...cells.slice(1)]),
    ],
    [
      "a tier without counts while every one of its cells has them",
      withCells([{ tier: 0, counted: 9 }, honest.tiers[1]!], cells),
    ],
    [
      "a cell with too few options",
      withCells(honest.tiers, [opened(0, 0, 5, ["3", "2"]), ...cells.slice(1)]),
    ],
    [
      "a cell with more picks than ballots",
      withCells(
        [
          { tier: 0, counted: 9, counts: ["7", "3", "1"] },
          { tier: 2, counted: 2 },
        ],
        [opened(0, 0, 5, ["6", "2", "0"]), ...cells.slice(1)],
      ),
    ],
  ])("refuses %s", (_, served) => {
    expect(cellResultsView(v1, partition, served)).toBeUndefined();
  });

  test("takes any split of a tier's counts into its cells, and nothing that doesn't sum", () => {
    const cell = fc
      .nat({ max: 1_000 })
      .chain((counted) =>
        fc.tuple(
          fc.constant(counted),
          fc.array(fc.nat({ max: counted }), { minLength: 3, maxLength: 3 }),
        ),
      );
    fc.assert(
      fc.property(
        fc.array(cell, { minLength: 3, maxLength: 3 }),
        fc.option(fc.tuple(fc.nat({ max: 2 }), fc.nat({ max: 2 }), fc.integer({ min: 1, max: 5 }))),
        (split, tamper) => {
          const sum = (j: number) => split.reduce((n, [, c]) => n + c[j]!, 0);
          const tier0 = {
            tier: 0,
            counted: split.reduce((n, [c]) => n + c, 0),
            counts: [0, 1, 2].map((j) => String(sum(j))),
          };
          const served = withCells(
            [tier0, { tier: 2, counted: 0 }],
            [
              ...split.map(([counted, c], i) =>
                opened(
                  i,
                  0,
                  counted,
                  c.map((n, j) =>
                    String(
                      tamper !== null && tamper[0] === i && tamper[1] === j ? n + tamper[2] : n,
                    ),
                  ),
                ),
              ),
              unopened(3, 2, 0),
            ],
          );
          const view = cellResultsView(v1, partition, served);
          if (tamper === null)
            expect(view?.map((c) => c.questions)).toEqual([
              ...split.map(([, c]) => [c.map(String)]),
              undefined,
            ]);
          else expect(view).toBeUndefined();
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
