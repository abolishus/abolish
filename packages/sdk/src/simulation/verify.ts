// The verifier over a simulated election (docs/spec/verifier.md): what
// packages/verifier must report for a run's format-4 bundle, given what the
// simulation stubs. Every check the verifier implements and the simulation
// exercises must pass, or, for 6.2 and 7.4, whose rows stay unverifiable
// until the verifier knows `s_S`, report every opening with no break, and
// nothing may fail the election. With a prover, admission (5.1 to 5.5) must
// admit every ballot, its membership proof and validity proofs verified;
// without one, the ballots' placeholder membership proofs are the one thing
// it must reject (SIMULATION_STUBS). Any other row is a disagreement between
// the simulation and the verifier, which the run treats as a bug (T-23,
// T-37, T-54).
//
// Without a prover, three of the passing rows check little: admission
// rejects on the membership proof before it verifies the validity proofs,
// so 5.4 covers only each ballot's shape and qualified share hashes, and
// 5.5 and 5.7 run over no admitted ballot. They are required anyway, so a
// change that fails them is caught. Either way 5.9 onwards stay not reached
// while the verifier doesn't judge L1 references from a format-4 bundle
// (5.8), so the selection, delivery and tally rows judge nothing yet
// (SIMULATION_STUBS). 2.9 reads the definition's one receipt key from the
// anchor's receipt-key record in the bundle's L1 state, registered a day
// before opening (T-26, T-71).

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
  // A sealed definition has no releases, and its board no running opening
  // (verifier.md, Releases, step 1).
  "7.5",
  "7.6",
]);

/** Admission's membership rows: passed with a prover, else failed by the placeholder proofs, every ballot rejected under this code. */
export const VERIFIER_MEMBERSHIP_ROWS: readonly string[] = Object.freeze(["5.1", "5.2", "5.3"]);
const MEMBERSHIP_CODE: CheckCode = "membership-proof";

/** What the run boarded, which the verifier's report must account for. */
export interface VerifierExpectation {
  /** Whether every ballot carries a real membership proof, so admission must admit them all. */
  readonly proven: boolean;
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
    if (expected.proven) {
      if (c?.status !== "pass") problems.push(`${id} didn't pass`);
    } else if (c?.status !== "fail" || c.code !== MEMBERSHIP_CODE)
      problems.push(`${id} didn't fail the placeholder membership proofs`);
  }
  for (const c of report.checks)
    if (c.status === "fail" && (expected.proven || !VERIFIER_MEMBERSHIP_ROWS.includes(c.id)))
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
  if (expected.proven) {
    if (
      ballots === undefined ||
      ballots.admitted !== expected.ballots ||
      ballots.rejected.length !== 0 ||
      ballots.repeats.length !== 0
    )
      problems.push("admission didn't admit exactly every ballot");
  } else if (
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
