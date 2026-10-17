import { expect, test } from "vite-plus/test";
import { checkControl, checkExpectations, REQUIRED_PASSES } from "../src/expectations.ts";
import type { ReportRow } from "../src/verify.ts";
import { STAGES } from "../src/stages.ts";

const rows = (status: Record<string, ReportRow["status"]>): ReportRow[] =>
  ["2.1", ...REQUIRED_PASSES].map((id) => ({
    id,
    status: status[id] ?? "pass",
    ...(status[id] !== undefined && status[id] !== "pass" && { code: "x" }),
  }));
const fromStore = { byCid: { storeBlocks: 1, storeUnreadableBytes: 0 } };
const honest = {
  report: { verdict: "unverifiable", checks: rows({ "2.1": "unverifiable" }), board: fromStore },
  exitCode: 21,
};
const fromGateway = {
  ...honest,
  report: { ...honest.report, board: { byCid: { gateways: { requests: 2, blocks: 2 } } } },
};

test("the honest shape passes, from a block store and from a gateway", () => {
  expect(checkExpectations(honest, "blocks.car")).toEqual([]);
  expect(checkExpectations(fromGateway, "gateway")).toEqual([]);
});

test("the copy must be read by CID, whole, from the source the run gave", () => {
  const withBoard = (board: object) => ({ ...honest, report: { ...honest.report, board } });
  // board.bin: no byCid in the report.
  expect(checkExpectations(withBoard({}), "blocks.car")).toEqual([
    "the board copy must be read by CID",
  ]);
  expect(checkExpectations(honest, "gateway")).toHaveLength(1);
  expect(checkExpectations(fromGateway, "blocks.car")).toHaveLength(1);
  // A gateway that failed some requests, or served nothing.
  for (const gateways of [
    { requests: 3, blocks: 2 },
    { requests: 0, blocks: 0 },
  ])
    expect(checkExpectations(withBoard({ byCid: { gateways } }), "gateway")).toHaveLength(1);
  expect(
    checkExpectations(
      withBoard({ byCid: { storeBlocks: 0, storeUnreadableBytes: 0 } }),
      "blocks.car",
    ),
  ).toHaveLength(1);
  expect(
    checkExpectations(
      withBoard({
        byCid: { ...fromStore.byCid, stopped: { checkpoint: 0, reason: "unavailable" } },
      }),
      "blocks.car",
    ),
  ).toEqual(['the copy by CID stopped short: {"checkpoint":0,"reason":"unavailable"}']);
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
      ),
    ).toEqual([`check ${id} must pass, got unverifiable x`]);
  expect(
    checkExpectations({ ...honest, report: { ...honest.report, checks: [] } }, "blocks.car"),
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
    ),
  ).toContain("check 2.1 failed: x");
  expect(
    checkExpectations(
      {
        ...honest,
        report: { ...honest.report, verdictAgainstInputs: "failed" },
      },
      "blocks.car",
    ),
  ).toContain("the checks failed the election against its inputs");
  expect(
    checkExpectations(
      { exitCode: 0, report: { ...honest.report, verdict: "verified" } },
      "blocks.car",
    ),
  ).toEqual(["the verdict must be unverifiable from local inputs, got verified"]);
  expect(checkExpectations({ ...honest, exitCode: 0 }, "blocks.car")).toEqual([
    "the verifier exited 0, not 21 for unverifiable",
  ]);
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

test("the transcript lists the nine stages of AGENTS.md once each, in order", () => {
  expect(STAGES.map((s) => s.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  // A stage not yet covered names the items that bring it.
  for (const s of STAGES) if (s.coverage !== "covered") expect(s.note).toMatch(/P\d-\d+/);
});
