// The verifier over a simulated election (docs/spec/verifier.md): what
// packages/verifier must report for a run's format-4 bundle, given what the
// simulation stubs. Every check the verifier implements and the simulation
// exercises must pass, or, for 6.2 and 7.4, whose rows stay unverifiable
// until the verifier knows `s_S`, report every opening with no break; the
// ballots' placeholder membership proofs are the one thing it must reject
// (SIMULATION_STUBS), and nothing may fail the election. Any other row is a
// disagreement between the simulation and the verifier, which the run
// treats as a bug (T-23, T-37, T-54).
//
// Four of the passing rows check little here: admission rejects on the
// membership proof before it verifies the validity proofs, so 5.4 covers
// only each ballot's shape and qualified share hashes; 5.5 and 5.7 run over
// no admitted ballot; and a version-1 definition lists no receipt keys, so 2.9
// has nothing to read. They are required anyway, so a change that fails
// them is caught.

import type { CheckCode, Report } from "@abolishus/verifier";

/** Rows the verifier must pass for every simulated election. */
export const VERIFIER_PASSES: readonly string[] = Object.freeze([
  "2.9",
  "3.2",
  "4.1",
  "4.2",
  "5.4",
  "5.5",
  "5.7",
]);

/** Rows the placeholder membership proofs fail, with every ballot rejected under this code. */
export const VERIFIER_MEMBERSHIP_ROWS: readonly string[] = Object.freeze(["5.1", "5.2", "5.3"]);
const MEMBERSHIP_CODE: CheckCode = "membership-proof";

/** What the run boarded, which the verifier's report must account for. */
export interface VerifierExpectation {
  readonly entries: number;
  /** Seats the ceremony registered: every seat takes part. */
  readonly registered: number;
  readonly ballots: number;
  readonly openings: number;
  readonly tallies: number;
  /** Every anchor the authority made, in L1 order: its segment and checkpoint hash in hex. */
  readonly anchors: readonly { readonly segment: number; readonly hash: string }[];
}

/**
 * Every way the verifier's report differs from what the simulated election
 * must show, as messages; empty when it agrees.
 */
export function judgeVerifierReport(report: Report, expected: VerifierExpectation): string[] {
  const problems: string[] = [];
  const row = new Map(report.checks.map((c) => [c.id, c]));
  for (const id of VERIFIER_PASSES)
    if (row.get(id)?.status !== "pass") problems.push(`${id} didn't pass`);
  for (const id of VERIFIER_MEMBERSHIP_ROWS) {
    const c = row.get(id);
    if (c?.status !== "fail" || c.code !== MEMBERSHIP_CODE)
      problems.push(`${id} didn't fail the placeholder membership proofs`);
  }
  for (const c of report.checks)
    if (c.status === "fail" && !VERIFIER_MEMBERSHIP_ROWS.includes(c.id))
      problems.push(`${c.id} failed (${c.code ?? "no code"})`);
  if (report.verdictAgainstInputs === "failed") problems.push("the election failed");
  if (report.board.entries !== expected.entries || report.board.unreadableBytes !== 0)
    problems.push("the verifier split another board");
  if ((report.board.unauthenticated ?? 0) !== 0) problems.push("an entry no anchor authenticates");
  const anchors = report.l1?.anchors ?? [];
  if (
    anchors.length !== expected.anchors.length ||
    anchors.some(
      (a, i) =>
        a.source !== "copy" ||
        a.segment !== expected.anchors[i]?.segment ||
        a.hash !== expected.anchors[i]?.hash,
    )
  )
    problems.push("the anchors read from L1 state aren't the authority's, matched by the copy");
  // The transcript is the board's first entry, and every seat qualifies.
  if (report.ceremony?.entry !== 0 || report.ceremony.registered.length !== expected.registered)
    problems.push("3.2 didn't register every seat from the board's first entry");
  const ballots = report.ballots;
  if (
    ballots === undefined ||
    ballots.admitted !== 0 ||
    ballots.rejected.length !== expected.ballots ||
    ballots.rejected.some((b) => b.code !== MEMBERSHIP_CODE)
  )
    problems.push("admission didn't reject exactly every ballot's placeholder membership proof");
  const openings = report.openings ?? [];
  if (
    openings.length !== expected.openings ||
    openings.some((o) => o.code !== undefined || o.breaks.length > 0)
  )
    problems.push("6.2 didn't report every published opening without a break");
  const tallies = report.tallies ?? [];
  if (
    tallies.length !== expected.tallies ||
    tallies.some((t) => t.code !== undefined || t.breaks.length > 0)
  )
    problems.push("7.4 didn't report every tally opening without a break");
  return problems;
}
