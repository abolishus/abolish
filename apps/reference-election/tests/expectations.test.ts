import { expect, test } from "vite-plus/test";
import {
  checkBallots,
  checkControl,
  checkExpectations,
  checkRows,
  checkSelected,
  checkTallied,
  type ExpectedBallots,
  REQUIRED_PASSES,
  TALLY_PASSES,
} from "../src/expectations.ts";
import type { ReportRow } from "../src/verify.ts";
import { STAGES } from "../src/stages.ts";

const rows = (status: Record<string, ReportRow["status"]>): ReportRow[] =>
  ["2.1", ...REQUIRED_PASSES].map((id) => ({
    id,
    status: status[id] ?? "pass",
    ...(status[id] !== undefined && status[id] !== "pass" && { code: "x" }),
  }));
const none = { admitted: 0, rejected: [] };
const fromStore = { byCid: { storeBlocks: 1, storeUnreadableBytes: 0 } };
const honest = {
  report: {
    verdict: "unverifiable",
    checks: rows({ "2.1": "unverifiable" }),
    board: fromStore,
    ballots: { admitted: 0, rejected: [] },
  },
  exitCode: 21,
};
const fromGateway = {
  ...honest,
  report: { ...honest.report, board: { byCid: { gateways: { requests: 2, blocks: 2 } } } },
};

test("the honest shape passes, from a block store and from a gateway", () => {
  expect(checkExpectations(honest, "blocks.car", none)).toEqual([]);
  expect(checkExpectations(fromGateway, "gateway", none)).toEqual([]);
});

test("the copy must be read by CID, whole, from the source the run gave", () => {
  const withBoard = (board: object) => ({ ...honest, report: { ...honest.report, board } });
  // board.bin: no byCid in the report.
  expect(checkExpectations(withBoard({}), "blocks.car", none)).toEqual([
    "honest: the board copy must be read by CID",
  ]);
  expect(checkExpectations(honest, "gateway", none)).toHaveLength(1);
  expect(checkExpectations(fromGateway, "blocks.car", none)).toHaveLength(1);
  // A gateway that failed some requests, or served nothing.
  for (const gateways of [
    { requests: 3, blocks: 2 },
    { requests: 0, blocks: 0 },
  ])
    expect(checkExpectations(withBoard({ byCid: { gateways } }), "gateway", none)).toHaveLength(1);
  expect(
    checkExpectations(
      withBoard({ byCid: { storeBlocks: 0, storeUnreadableBytes: 0 } }),
      "blocks.car",
      none,
    ),
  ).toHaveLength(1);
  expect(
    checkExpectations(
      withBoard({
        byCid: { ...fromStore.byCid, stopped: { checkpoint: 0, reason: "unavailable" } },
      }),
      "blocks.car",
      none,
    ),
  ).toEqual(['honest: the copy by CID stopped short: {"checkpoint":0,"reason":"unavailable"}']);
});

test("every required row must pass", () => {
  for (const id of REQUIRED_PASSES)
    expect(
      checkExpectations(
        {
          ...honest,
          report: {
            ...honest.report,
            checks: rows({ "2.1": "unverifiable", [id]: "unverifiable" }),
          },
        },
        "blocks.car",
        none,
      ),
    ).toEqual([`honest: check ${id} must pass, got unverifiable x`]);
  expect(
    checkExpectations({ ...honest, report: { ...honest.report, checks: [] } }, "blocks.car", none),
  ).toHaveLength(REQUIRED_PASSES.length);
});

test("any failed row, a failed verdict or a verified one stops the run", () => {
  expect(
    checkExpectations(
      {
        ...honest,
        report: { ...honest.report, checks: rows({ "2.1": "fail" }) },
      },
      "blocks.car",
      none,
    ),
  ).toContain("honest: check 2.1 failed: x");
  expect(
    checkExpectations(
      {
        ...honest,
        report: { ...honest.report, verdictAgainstInputs: "failed" },
      },
      "blocks.car",
      none,
    ),
  ).toContain("honest: the checks failed the election against its inputs");
  expect(
    checkExpectations(
      { exitCode: 0, report: { ...honest.report, verdict: "verified" } },
      "blocks.car",
      none,
    ),
  ).toEqual(["honest: the verdict must be unverifiable from local inputs, got verified"]);
  expect(checkExpectations({ ...honest, exitCode: 0 }, "blocks.car", none)).toEqual([
    "honest: the verifier exited 0, not 21 for unverifiable",
  ]);
});

test("the ballots admitted and rejected must be exactly those expected", () => {
  const four = { admitted: 4, rejected: [] };
  const withBallots = (ballots: ExpectedBallots) => ({
    ...honest,
    report: { ...honest.report, ballots },
  });
  expect(checkExpectations(withBallots(four), "blocks.car", four)).toEqual([]);
  // Admission rows pass vacuously on an empty board, so an empty one isn't the run's.
  expect(checkExpectations(honest, "blocks.car", four)).toEqual([
    "honest: 0 ballots admitted, not 4",
  ]);
  expect(
    checkExpectations(
      {
        ...honest,
        report: {
          verdict: honest.report.verdict,
          checks: honest.report.checks,
          board: honest.report.board,
        },
      },
      "blocks.car",
      four,
    ),
  ).toEqual(["honest: the report has no ballots"]);
  const rejected = { admitted: 1, rejected: [{ entry: 2, code: "membership-proof" }] };
  expect(checkBallots("c", { report: withBallots(rejected).report }, rejected)).toEqual([]);
  expect(
    checkBallots(
      "c",
      {
        report: withBallots({ admitted: 1, rejected: [{ entry: 2, code: "validity-shape" }] })
          .report,
      },
      rejected,
    ),
  ).toEqual([
    'c: rejected [{"entry":2,"code":"validity-shape"}], not [{"entry":2,"code":"membership-proof"}]',
  ]);
  expect(
    checkBallots("c", { report: withBallots({ admitted: 2, rejected: [] }).report }, rejected),
  ).toHaveLength(2);
});

test("a control must show each row it pins, with its code", () => {
  const report = { verdict: "unverifiable", checks: rows({ "3.2": "unverifiable" }) };
  expect(checkControl("c", { report }, { "3.2": { status: "unverifiable", code: "x" } })).toEqual(
    [],
  );
  expect(checkControl("c", { report }, { "3.2": { status: "unverifiable", code: "y" } })).toEqual([
    "control c: check 3.2 must be unverifiable y, got unverifiable x",
  ]);
  expect(checkControl("c", { report }, { "4.1": { status: "fail" } })).toEqual([
    "control c: check 4.1 must be fail , got pass ",
  ]);
  expect(checkControl("c", { report }, { "9.9": { status: "pass" } })).toEqual([
    "control c: check 9.9 must be pass , got no row ",
  ]);
});

test("rows pinned outside a control are reported under the run's own name", () => {
  const report = { verdict: "unverifiable", checks: rows({ "3.2": "fail" }) };
  expect(checkRows("q", { report }, { "3.2": { status: "fail", code: "x" } })).toEqual([]);
  expect(checkRows("q", { report }, { "3.2": { status: "pass" } })).toEqual([
    "q: check 3.2 must be pass , got fail x",
  ]);
});

test("the selected ballots must be exactly the entries expected, in order", () => {
  const withSelected = (selected?: number[]) => ({
    report: {
      ...honest.report,
      ballots: {
        admitted: 3,
        rejected: [],
        ...(selected !== undefined && { selected: selected.map((entry) => ({ entry })) }),
      },
    },
  });
  expect(checkSelected("q", withSelected([1, 3, 4]), [1, 3, 4])).toEqual([]);
  expect(checkSelected("q", withSelected([1, 2, 3]), [1, 3, 4])).toEqual([
    "q: selected [1,2,3], not [1,3,4]",
  ]);
  expect(checkSelected("q", withSelected([3, 1, 4]), [1, 3, 4])).toHaveLength(1);
  // A report where selection didn't pass has no selected ballots.
  expect(checkSelected("q", withSelected(), [1, 3, 4])).toEqual(["q: selected null, not [1,3,4]"]);
});

test("the transcript lists the nine stages of AGENTS.md once each, in order", () => {
  expect(STAGES.map((s) => s.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  // A stage not yet covered names the items that bring it.
  for (const s of STAGES) if (s.coverage !== "covered") expect(s.note).toMatch(/P\d-\d+/);
});

test("an election's name and its own rows reach the report's problems", () => {
  const options = { name: "questions", passes: ["2.9"] };
  const withRow = (status: ReportRow["status"]) => ({
    ...honest,
    report: {
      ...honest.report,
      checks: [...honest.report.checks, { id: "2.9", status, code: "x" }],
    },
  });
  expect(checkExpectations(withRow("pass"), "blocks.car", none, options)).toEqual([]);
  expect(checkExpectations(withRow("unverifiable"), "blocks.car", none, options)).toEqual([
    "questions: check 2.9 must pass, got unverifiable x",
  ]);
  expect(checkExpectations(honest, "blocks.car", none, options)).toEqual([
    "questions: check 2.9 must pass, got no row ",
  ]);
});

test("a tallied election must pass the tally rows, open its one cell to the counts expected and have every seat destroyed", () => {
  const expected = { counted: 3, counts: [1, 0, 1] };
  const tallied = (report: object) => ({
    report: {
      verdict: "unverifiable",
      checks: TALLY_PASSES.map((id) => ({ id, status: "pass" as const })),
      cells: [{ cell: 0, counted: 3, counts: ["1", "0", "1"] }],
      destruction: { seats: [1, 2, 3].map((seat) => ({ seat, code: "destroyed" })) },
      ...report,
    },
  });
  expect(checkTallied("honest", tallied({}), expected, 3)).toEqual([]);
  // A failing tally row, by its code.
  expect(
    checkTallied(
      "honest",
      tallied({
        checks: TALLY_PASSES.map((id) =>
          id === "7.2"
            ? { id, status: "fail" as const, code: "tally-missing" }
            : { id, status: "pass" as const },
        ),
      }),
      expected,
      3,
    ),
  ).toEqual(["honest: check 7.2 must be pass , got fail tally-missing"]);
  // Another counted set, other counts, no cell, or two.
  for (const cells of [
    [{ cell: 0, counted: 2, counts: ["1", "0", "1"] }],
    [{ cell: 0, counted: 3, counts: ["0", "1", "1"] }],
    [{ cell: 0, counted: 3 }],
    [],
    [
      { cell: 0, counted: 3, counts: ["1", "0", "1"] },
      { cell: 1, counted: 0, counts: ["0", "0", "0"] },
    ],
  ])
    expect(checkTallied("honest", tallied({ cells }), expected, 3)).toHaveLength(1);
  // A seat whose statement is missing or early, or a report without destruction.
  for (const destruction of [
    { seats: [1, 2].map((seat) => ({ seat, code: "destroyed" })) },
    {
      seats: [1, 2, 3].map((seat) => ({
        seat,
        code: seat === 2 ? "destruction-early" : "destroyed",
      })),
    },
    undefined,
  ])
    expect(checkTallied("honest", tallied({ destruction }), expected, 3)).toHaveLength(1);
});
