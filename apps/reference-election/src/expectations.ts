// What the reference election requires of the verifier's report. Each stage
// that becomes covered adds the rows it must make pass; a row that fails, or
// a failed verdict, always stops the run.

import type { ReportRow, VerifierRun } from "./verify.ts";

/**
 * Rows that must pass on the honest run: 3.2 (the ceremony, stage 1) and 4.1
 * and 4.2 (the board against its anchors, stage 7).
 */
export const REQUIRED_PASSES: readonly string[] = Object.freeze(["3.2", "4.1", "4.2"]);

// The verifier's exit codes (packages/verifier, EXIT_CODES).
const EXIT = { verified: 0, failed: 20, unverifiable: 21 } as const;

/**
 * Where the honest run's board copy must come from: by CID from the bundle's
 * `blocks.car`, or from a gateway alone. Never `board.bin`: the board is
 * rebuilt from the CIDs anchored on L1 (stage 8; docs/spec/verifier.md, Board
 * by CID).
 */
export type CopySource = "blocks.car" | "gateway";

/** Why the honest run's report isn't what the reference election requires; empty if it is. */
export function checkExpectations(
  run: Pick<VerifierRun, "report" | "exitCode">,
  source: CopySource,
): string[] {
  const { report } = run;
  const problems: string[] = [];
  const byCid = report.board?.byCid;
  if (byCid === undefined) problems.push("the board copy must be read by CID");
  else {
    if (byCid.stopped !== undefined)
      problems.push(`the copy by CID stopped short: ${JSON.stringify(byCid.stopped)}`);
    const read =
      source === "blocks.car"
        ? byCid.storeBlocks !== undefined &&
          byCid.storeBlocks > 0 &&
          byCid.storeUnreadableBytes === 0 &&
          byCid.gateways === undefined
        : byCid.storeBlocks === undefined &&
          byCid.gateways !== undefined &&
          byCid.gateways.blocks > 0 &&
          byCid.gateways.blocks === byCid.gateways.requests;
    if (!read)
      problems.push(`the copy must be read from ${source} alone: ${JSON.stringify(byCid)}`);
  }
  const rows = new Map(report.checks.map((c) => [c.id, c]));
  for (const id of REQUIRED_PASSES) {
    const row = rows.get(id);
    if (row?.status !== "pass")
      problems.push(`check ${id} must pass, got ${row?.status ?? "no row"} ${row?.code ?? ""}`);
  }
  for (const row of report.checks)
    if (row.status === "fail") problems.push(`check ${row.id} failed: ${row.code ?? ""}`);
  // Every input is a local file today, so nothing can verify the election
  // yet (docs/spec/verifier.md, Bundle); a verdict of verified here would
  // mean the verifier stopped counting its inputs.
  if (report.verdict !== "unverifiable")
    problems.push(`the verdict must be unverifiable from local inputs, got ${report.verdict}`);
  if (report.verdictAgainstInputs === "failed")
    problems.push("the checks failed the election against its inputs");
  const exit = EXIT[report.verdict as keyof typeof EXIT];
  if (run.exitCode !== exit)
    problems.push(`the verifier exited ${run.exitCode}, not ${exit} for ${report.verdict}`);
  return problems;
}

/** A row as a control expects it. */
export interface ExpectedRow {
  readonly status: ReportRow["status"];
  readonly code?: string;
}

/**
 * Why a control's report differs from the rows it must show; empty if it
 * doesn't. A control pins each row's code, not only that it didn't pass, so
 * it can't be satisfied by an unrelated reason such as a rejected bundle.
 */
export function checkControl(
  name: string,
  run: Pick<VerifierRun, "report">,
  expected: Readonly<Record<string, ExpectedRow>>,
): string[] {
  const rows = new Map(run.report.checks.map((c) => [c.id, c]));
  const problems: string[] = [];
  for (const [id, want] of Object.entries(expected)) {
    const got = rows.get(id);
    if (got?.status !== want.status || got.code !== want.code)
      problems.push(
        `control ${name}: check ${id} must be ${want.status} ${want.code ?? ""}, got ${got?.status ?? "no row"} ${got?.code ?? ""}`,
      );
  }
  return problems;
}
