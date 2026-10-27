// What the reference election requires of the verifier's report. Each stage
// that becomes covered adds the rows it must make pass; a row that fails, or
// a failed verdict, always stops the run.

import type { ReportRow, VerifierRun } from "./verify.ts";

/**
 * Rows that must pass on the honest run: 3.2 (the ceremony, stage 1), 4.1
 * and 4.2 (the board against its anchors, stage 7), and ballot admission:
 * 5.1 to 5.4, the close rule's window (5.5) and repeats (5.7) (stage 4).
 */
export const REQUIRED_PASSES: readonly string[] = Object.freeze([
  "3.2",
  "4.1",
  "4.2",
  "5.1",
  "5.2",
  "5.3",
  "5.4",
  "5.5",
  "5.7",
]);

/** What the report's `ballots` must hold: how many entries admitted, and each rejected one. */
export interface ExpectedBallots {
  readonly admitted: number;
  readonly rejected: readonly { readonly entry: number; readonly code: string }[];
}

/**
 * Why the report's ballots differ from `expected`; empty if they don't. The
 * admission rows pass vacuously on a board without ballots, so a run that
 * boards ballots pins how many the verifier admitted, and which it rejected.
 */
export function checkBallots(
  name: string,
  run: Pick<VerifierRun, "report">,
  expected: ExpectedBallots,
): string[] {
  const ballots = run.report.ballots;
  if (ballots === undefined) return [`${name}: the report has no ballots`];
  const rejected = ballots.rejected.map((r) => ({ entry: r.entry, code: r.code }));
  const problems: string[] = [];
  if (ballots.admitted !== expected.admitted)
    problems.push(`${name}: ${ballots.admitted} ballots admitted, not ${expected.admitted}`);
  if (JSON.stringify(rejected) !== JSON.stringify(expected.rejected))
    problems.push(
      `${name}: rejected ${JSON.stringify(rejected)}, not ${JSON.stringify(expected.rejected)}`,
    );
  return problems;
}

/**
 * Why the report's selected ballots (6.1) aren't the entries `expected`
 * lists, in copy order; empty if they are. Selection passes over any set,
 * so a run whose ballots include a re-vote pins which one counts.
 */
export function checkSelected(
  name: string,
  run: Pick<VerifierRun, "report">,
  expected: readonly number[],
): string[] {
  const selected = run.report.ballots?.selected?.map((s) => s.entry);
  return selected !== undefined && selected.join() === expected.join()
    ? []
    : [`${name}: selected ${JSON.stringify(selected ?? null)}, not ${JSON.stringify(expected)}`];
}

/**
 * Rows a tallied election's format-5 bundle must pass: its ballots' L1
 * references (5.8), their delivery (5.9), selection (6.1), the tally (7.1 to
 * 7.3) and every seat's destruction (8.5) (stage 6).
 */
export const TALLY_PASSES: readonly string[] = Object.freeze([
  "5.8",
  "5.9",
  "6.1",
  "7.1",
  "7.2",
  "7.3",
  "8.5",
]);

/** What a tallied election's one cell must report: its counted ballots and its count per option. */
export interface ExpectedTally {
  readonly counted: number;
  readonly counts: readonly number[];
}

/**
 * Why a tallied election's report isn't what stage 6 requires; empty if it
 * is: `TALLY_PASSES`, its one cell's counted ballots and counts, and every
 * registered seat `destroyed`. The tally rows pass vacuously on the wrong
 * counted set's honest opening, so the run pins the result the votes cast
 * add up to.
 */
export function checkTallied(
  name: string,
  run: Pick<VerifierRun, "report">,
  expected: ExpectedTally,
  seats: number,
): string[] {
  const problems = checkRows(
    name,
    run,
    Object.fromEntries(TALLY_PASSES.map((id) => [id, { status: "pass" }])),
  );
  const cells = run.report.cells ?? [];
  const [cell] = cells;
  const counts = cell?.counts?.join();
  if (cells.length !== 1 || cell?.counted !== expected.counted || counts !== expected.counts.join())
    problems.push(
      `${name}: cells ${JSON.stringify(cells)}, not one of ${expected.counted} counted ballots with counts ${expected.counts.join()}`,
    );
  const destroyed = run.report.destruction?.seats.filter((s) => s.code === "destroyed") ?? [];
  if (destroyed.map((s) => s.seat).join() !== Array.from({ length: seats }, (_, i) => i + 1).join())
    problems.push(
      `${name}: destroyed ${JSON.stringify(run.report.destruction?.seats ?? null)}, not every seat`,
    );
  return problems;
}

// The verifier's exit codes (packages/verifier, EXIT_CODES).
const EXIT = { verified: 0, failed: 20, unverifiable: 21 } as const;

/**
 * Where the honest run's board copy must come from: by CID from the bundle's
 * `blocks.car`, from a gateway alone, or from the objects the archive lists
 * alone (`arweave`, with neither). Never `board.bin`: the board is rebuilt
 * from the CIDs anchored on L1 (stage 8; docs/spec/verifier.md, Board by CID).
 */
export type CopySource = "blocks.car" | "gateway" | "arweave";

/**
 * Why an honest election's report isn't what the reference election
 * requires; empty if it is. `passes` are the rows it must pass beyond
 * `REQUIRED_PASSES`.
 */
export function checkExpectations(
  run: Pick<VerifierRun, "report" | "exitCode">,
  source: CopySource,
  ballots: ExpectedBallots,
  { name = "honest", passes = [] }: { name?: string; passes?: readonly string[] } = {},
): string[] {
  const { report } = run;
  const problems: string[] = checkBallots(name, run, ballots);
  const byCid = report.board?.byCid;
  if (byCid === undefined) problems.push(`${name}: the board copy must be read by CID`);
  else {
    if (byCid.stopped !== undefined)
      problems.push(`${name}: the copy by CID stopped short: ${JSON.stringify(byCid.stopped)}`);
    const read =
      source === "blocks.car"
        ? byCid.storeBlocks !== undefined &&
          byCid.storeBlocks > 0 &&
          byCid.storeUnreadableBytes === 0 &&
          byCid.gateways === undefined
        : source === "gateway"
          ? byCid.storeBlocks === undefined &&
            byCid.gateways !== undefined &&
            byCid.gateways.blocks > 0 &&
            byCid.gateways.blocks === byCid.gateways.requests
          : byCid.storeBlocks === undefined && byCid.gateways === undefined;
    if (!read)
      problems.push(
        `${name}: the copy must be read from ${source} alone: ${JSON.stringify(byCid)}`,
      );
  }
  const rows = new Map(report.checks.map((c) => [c.id, c]));
  for (const id of [...REQUIRED_PASSES, ...passes]) {
    const row = rows.get(id);
    if (row?.status !== "pass")
      problems.push(
        `${name}: check ${id} must pass, got ${row?.status ?? "no row"} ${row?.code ?? ""}`,
      );
  }
  for (const row of report.checks)
    if (row.status === "fail") problems.push(`${name}: check ${row.id} failed: ${row.code ?? ""}`);
  // Every input is a local file today, so nothing can verify the election
  // yet (docs/spec/verifier.md, Bundle); a verdict of verified here would
  // mean the verifier stopped counting its inputs.
  if (report.verdict !== "unverifiable")
    problems.push(
      `${name}: the verdict must be unverifiable from local inputs, got ${report.verdict}`,
    );
  if (report.verdictAgainstInputs === "failed")
    problems.push(`${name}: the checks failed the election against its inputs`);
  const exit = EXIT[report.verdict as keyof typeof EXIT];
  if (run.exitCode !== exit)
    problems.push(
      `${name}: the verifier exited ${run.exitCode}, not ${exit} for ${report.verdict}`,
    );
  return problems;
}

/** A row as a control expects it. */
export interface ExpectedRow {
  readonly status: ReportRow["status"];
  readonly code?: string;
}

/**
 * Why a report differs from the rows it must show, each with its status and
 * code; empty if it doesn't.
 */
export function checkRows(
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
        `${name}: check ${id} must be ${want.status} ${want.code ?? ""}, got ${got?.status ?? "no row"} ${got?.code ?? ""}`,
      );
  }
  return problems;
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
  return checkRows(`control ${name}`, run, expected);
}

/**
 * Why 4.4's replay of the archive differs from `held`, each L2 contract's
 * event count by role; empty if it doesn't. Every record the archive lists
 * must be proven and reproduced by the runs, which reach its count with no
 * gap, so each contract holds every event it emitted (docs/spec/verifier.md,
 * 4.4, step 6; T-71). 4.4 itself stays unverifiable while the root is the
 * record's word, so a run that passes this pins what its row can't.
 */
export function checkArchivedEvents(
  name: string,
  run: Pick<VerifierRun, "report">,
  held: Readonly<Record<string, bigint>>,
): string[] {
  const replay = run.report.archive?.replay;
  if (replay === undefined) return [`${name}: the report has no replay of the archive`];
  const problems = replay.findings.length > 0 ? [`${name}: the replay reports findings`] : [];
  const roles = replay.contracts.map((c) => c.role);
  if (roles.join() !== Object.keys(held).join())
    problems.push(
      `${name}: the replay covers ${roles.join(", ")}, not ${Object.keys(held).join(", ")}`,
    );
  for (const c of replay.contracts) {
    if (c.held !== held[c.role]?.toString())
      problems.push(`${name}: ${c.role} holds ${c.held} events, not ${held[c.role] ?? "none"}`);
    if (c.evidence.findings.length > 0 || c.evidence.records.some((r) => r.replay !== null))
      problems.push(`${name}: ${c.role}'s evidence doesn't all replay`);
    if (!c.runs.complete || c.runs.findings.length > 0)
      problems.push(`${name}: ${c.role}'s runs aren't complete`);
  }
  return problems;
}
