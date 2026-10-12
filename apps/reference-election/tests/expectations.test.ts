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
const honest = {
  report: { verdict: "unverifiable", checks: rows({ "2.1": "unverifiable" }) },
  exitCode: 21,
};

test("the honest shape passes", () => {
  expect(checkExpectations(honest)).toEqual([]);
});

test("every required row must pass", () => {
  for (const id of REQUIRED_PASSES)
    expect(
      checkExpectations({
        ...honest,
        report: { ...honest.report, checks: rows({ "2.1": "unverifiable", [id]: "unverifiable" }) },
      }),
    ).toEqual([`check ${id} must pass, got unverifiable x`]);
  expect(checkExpectations({ ...honest, report: { ...honest.report, checks: [] } })).toHaveLength(
    REQUIRED_PASSES.length,
  );
});

test("any failed row, a failed verdict or a verified one stops the run", () => {
  expect(
    checkExpectations({
      ...honest,
      report: { ...honest.report, checks: rows({ "2.1": "fail" }) },
    }),
  ).toContain("check 2.1 failed: x");
  expect(
    checkExpectations({
      ...honest,
      report: { ...honest.report, verdictAgainstInputs: "failed" },
    }),
  ).toContain("the checks failed the election against its inputs");
  expect(
    checkExpectations({ exitCode: 0, report: { ...honest.report, verdict: "verified" } }),
  ).toEqual(["the verdict must be unverifiable from local inputs, got verified"]);
  expect(checkExpectations({ ...honest, exitCode: 0 })).toEqual([
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
