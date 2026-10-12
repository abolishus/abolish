// What the reference election requires of the verifier's report. Each stage
// that becomes covered adds the rows it must make pass; a row that fails, or
// a failed verdict, always stops the run.

import type { VerifierRun } from "./verify.ts";

/**
 * Rows that must pass on the honest run: 3.2 (the ceremony, stage 1) and 4.1
 * and 4.2 (the board against its anchors, stage 7).
 */
export const REQUIRED_PASSES: readonly string[] = Object.freeze(["3.2", "4.1", "4.2"]);

// The verifier's exit codes (packages/verifier, EXIT_CODES).
const EXIT = { verified: 0, failed: 20, unverifiable: 21 } as const;

/** Why the honest run's report isn't what the reference election requires; empty if it is. */
export function checkExpectations(run: Pick<VerifierRun, "report" | "exitCode">): string[] {
  const { report } = run;
  const problems: string[] = [];
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

/**
 * Why a run over a copy whose transcript was altered isn't what it must be:
 * the ceremony check can't pass on bytes the definition doesn't bind, so a
 * pass on the honest run isn't vacuous.
 */
export function checkTamperedCopy(run: Pick<VerifierRun, "report">): string[] {
  const row = run.report.checks.find((c) => c.id === "3.2");
  return row?.status === "pass" ? ["check 3.2 passed on a copy with an altered transcript"] : [];
}
