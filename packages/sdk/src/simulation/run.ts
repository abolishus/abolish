// Runs a simulated election in memory through @abolishus/crypto's own code:
// a well-formed definition and its signed key ceremony (./election.ts), each
// voter's sharing and share encryption, the tracking code shown before the
// cast-or-challenge choice, a challenged attempt's opening and its checker's
// verdict (./challenge.ts), the cast attempt's validity proof, each online
// trustee's intake (proof checks, decryption,
// share checks, receipt) and the receipt's check under the seat's registered
// signing key, the summed shares, each cell's combination from the
// k lowest passing seats, and the verifier's check of every opening. Nothing
// here reimplements a check the verifier makes (AGENTS.md, Architecture): it
// only calls them and compares the result with the plan (T-29, T-54, T-25).

import {
  ballotCore,
  ballotElection,
  type CellOpening,
  checkOpening,
  checkShareReceipt,
  type CommittedVote,
  coreHash,
  deriveTotal,
  encodeOpening,
  encryptShares,
  GROUP_ORDER,
  intake,
  openCell,
  openChallenge,
  openedCommitments,
  opensBallotCommitment,
  proveValidity,
  type SeatSecrets,
  type Share,
  shareVote,
  type SpoiledBallotOpening,
  sumShares,
  type TallyRules,
  trackingCode,
  type ValidityContext,
} from "@abolishus/crypto";
import { checkChallenge } from "./challenge.ts";
import { simulateElection } from "./election.ts";
import { type Plan, planElection, selectionRange } from "./plan.ts";
import type { Scenario, SimulatedTier } from "./scenario.ts";

/**
 * What this run models only in outline, until the items that build each
 * piece land (docs/status/P1-21.md). Every report carries the list, so no
 * result is mistaken for a run of the whole protocol.
 */
export const SIMULATION_STUBS = Object.freeze([
  "definition: a well-formed version-1 definition, but its contracts, chain IDs, election counter, clock and tier roots are placeholders and nothing registers it on L2 (P1-18, P3-2)",
  "ceremony: every seat takes part in the four signed rounds; no release pins the panel, whose identity keys are fresh per run (P1-7)",
  "membership: no membership proofs; each voter's nullifier is its index plus one (P1-17b, P3-2)",
  "delivery: ciphertexts reach trustees in memory, with no board, receipts at cast or contract path; a direct ballot differs only in its label (P1-12c, P4-2)",
  "trustees: offline seats go down after the ceremony, for the whole voting period and tally; faulty seats lie only in their summed shares",
  "challenges: the checker records each tracking code and checks the opening in memory, with the election the run built rather than one fetched from chain and IPFS; no opening is published to the board after close (P1-21 part 2)",
  "not yet simulated: re-voting, anchoring, destruction and wipe-and-rebuild (P1-21 part 2)",
] as const);

export type CellOutcome = "opened" | "tally-quorum" | "tally-opening" | "tally-range";

export interface CellReport {
  readonly tier: SimulatedTier;
  readonly ballots: number;
  /** The plan's counts, per option. */
  readonly expected: readonly number[];
  readonly expectedOutcome: CellOutcome;
  readonly outcome: CellOutcome;
  /** The opened counts, when `outcome` is `opened`. */
  readonly counts?: readonly number[];
  /** The seats combined, the `k` lowest whose summed shares passed. */
  readonly combined?: readonly number[];
  /** Seats whose summed shares failed the check. */
  readonly excluded: readonly number[];
  /** Whether the verifier's opening check passed on the opened counts. */
  readonly verified: boolean;
  /** The outcome is the expected one and, when opened, the counts are the plan's. */
  readonly matches: boolean;
}

export interface SimulationReport {
  /** Every cell matched the plan. */
  readonly ok: boolean;
  readonly scenario: Scenario;
  /** The definition's hash, which every ballot, receipt and opening binds, in hex. */
  readonly definition: { readonly hash: string };
  /** The ceremony transcript's hash, which the definition names, and the seats it registered. */
  readonly ceremony: { readonly transcriptHash: string; readonly registered: readonly number[] };
  readonly ballots: {
    readonly cast: number;
    readonly server: number;
    readonly direct: number;
    /** Attempts challenged before a fresh one was cast, each opening checked by the voter's checker. */
    readonly challenged: number;
  };
  readonly trustees: {
    /** Every seat not offline, faulty ones included. */
    readonly online: readonly number[];
    readonly offline: readonly number[];
    readonly faulty: readonly number[];
  };
  readonly cells: readonly CellReport[];
  /** The election's total, derived from the opened cells, when every cell opened. */
  readonly total?: readonly number[];
  readonly stubs: readonly string[];
}

export interface SimulationProgress {
  readonly stage: "cast" | "tally";
  readonly done: number;
  readonly total: number;
}

export interface SimulationOptions {
  /** Called after each ballot and each cell. */
  readonly onProgress?: (progress: SimulationProgress) => void;
}

// A faulty seat's lie: option 0's summed vote share plus one, which the
// summed-share check must catch (verifier 7.2).
function corrupt(summed: readonly Share[]): Share[] {
  return summed.map((s, j) => (j === 0 ? { v: (s.v + 1n) % GROUP_ORDER, r: s.r } : s));
}

/** What every cell must show: the outcome and, for each, which seats are excluded and combined. */
export interface CellExpectation {
  readonly outcome: CellOutcome;
  /** The faulty seats, ascending: the summed-share check must catch each. */
  readonly excluded: readonly number[];
  /** When opened, the `k` lowest honest online seats. */
  readonly combined: readonly number[];
}

export function expectCells(scenario: Scenario): CellExpectation {
  const { panel, threshold, offline, faulty } = scenario.trustees;
  const honest = Array.from({ length: panel }, (_, i) => i + 1).filter(
    (s) => !offline.includes(s) && !faulty.includes(s),
  );
  return {
    outcome: honest.length >= threshold ? "opened" : "tally-quorum",
    excluded: faulty,
    combined: honest.slice(0, threshold),
  };
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const same32 = (a: Uint8Array, b: Uint8Array) =>
  a.length === 32 && b.length === 32 && a.every((x, i) => x === b[i]);

const same = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Judges one cell's tally against the plan: the outcome, the excluded and
 * combined seats, and, when opened, the verifier's check and the counts.
 * Any difference is a `matches: false` the report carries.
 */
export function judgeCell(
  cell: {
    readonly tier: SimulatedTier;
    readonly ballots: number;
    readonly expected: readonly number[];
  },
  want: CellExpectation,
  opened: CellOpening,
  verified: boolean,
): CellReport {
  const base = {
    ...cell,
    expectedOutcome: want.outcome,
    excluded: opened.excluded,
  };
  if (!opened.ok)
    return {
      ...base,
      outcome: opened.code,
      verified: false,
      matches: opened.code === want.outcome && same(opened.excluded, want.excluded),
    };
  const counts = opened.counts.map(Number);
  return {
    ...base,
    outcome: "opened",
    counts,
    combined: opened.combined,
    verified,
    matches:
      want.outcome === "opened" &&
      verified &&
      same(counts, cell.expected) &&
      same(opened.excluded, want.excluded) &&
      same(opened.combined, want.combined),
  };
}

/** Runs `scenario` and reports each cell's result against the plan. Throws only on a bug. */
export function runSimulation(
  scenario: Scenario,
  options: SimulationOptions = {},
): SimulationReport {
  const plan: Plan = planElection(scenario);
  const { panel: n, threshold: k, offline, faulty } = scenario.trustees;
  const { min, max } = selectionRange(scenario);
  const rules = {
    optionCount: scenario.options,
    minSelections: min,
    maxSelections: max,
    threshold: k,
    panelSize: n,
  };
  const election = simulateElection(scenario, plan);
  const { definitionHash, seats, registered } = election;
  // Ballots go only to the keys the ceremony check registered, by seat (T-37).
  const keys = registered.map((r) => r.kemKey);
  // The checker's election and the casting device's: one definition and the
  // key set its ceremony check registered.
  const ballots = ballotElection(election.definition, registered);
  const online = seats.map((s) => s.index).filter((i) => !offline.includes(i));

  const tallyRules: TallyRules = { optionCount: scenario.options, threshold: k, panelSize: n };
  // Per tier: the counted ballots' VSS commitments, and each online seat's
  // running sum of its shares of them, so shares don't accumulate per ballot.
  const zero = () => Array.from({ length: scenario.options }, () => ({ v: 0n, r: 0n }));
  const cells = new Map(
    plan.tiers.map((t) => [
      t,
      {
        vss: [] as CommittedVote["vss"][],
        sums: new Map<number, readonly Share[]>(online.map((i) => [i, zero()])),
      },
    ]),
  );
  type Cell = NonNullable<ReturnType<typeof cells.get>>;
  // A missing entry is a bug in this file, never a scenario's doing.
  const cellOf = (tier: SimulatedTier): Cell => {
    const cell = cells.get(tier);
    if (cell === undefined) throw new Error("simulation: a voter outside the electorate");
    return cell;
  };
  const sumOf = (cell: Cell, seat: number): readonly Share[] => {
    const sum = cell.sums.get(seat);
    if (sum === undefined) throw new Error("simulation: no running sum for an online seat");
    return sum;
  };
  let server = 0;
  let challenged = 0;
  plan.voters.forEach((voter, done) => {
    const ctx: ValidityContext = {
      ...rules,
      definitionHash,
      tier: voter.tier,
      nullifier: BigInt(voter.index + 1),
    };
    // A challenged attempt: the checker records the code shown before the
    // choice, then checks the opening the device hands over (T-42).
    let opening: SpoiledBallotOpening | undefined;
    if (voter.challenged) {
      const attempt = encryptShares({ definitionHash }, shareVote(rules, voter.votes), keys);
      const recorded = trackingCode(ballots, voter.tier, attempt);
      const verdict = checkChallenge(
        ballots,
        recorded,
        voter,
        encodeOpening(openChallenge(ballots, voter.tier, attempt).opening),
      );
      if (!verdict.ok)
        throw new Error(`simulation: an honest challenge failed its check (${verdict.code})`);
      opening = verdict.opening;
      challenged++;
    }
    // The cast attempt is a fresh sharing: crypto refuses to prove an opened one.
    const sharing = shareVote(rules, voter.votes);
    const encrypted = encryptShares({ definitionHash }, sharing, keys);
    const core = ballotCore(ballots, voter.tier, encrypted);
    // The code shown before the cast choice, which the checker records.
    const shown = trackingCode(ballots, voter.tier, encrypted);
    const vote = proveValidity(ctx, sharing, core.shareHashes);
    // Client rule 3: the core cast, as the ballot carries it, is the one whose code was shown.
    const cast = coreHash({
      definitionHash: ctx.definitionHash,
      tier: voter.tier,
      vss: vote.vss,
      shareHashes: vote.share_hashes,
    });
    if (!same32(cast, shown)) throw new Error("simulation: the cast core isn't the one shown");
    // Checker rule 4: no challenged attempt opens a commitment of the cast ballot.
    if (
      opening !== undefined &&
      opensBallotCommitment(openedCommitments(opening), { definitionHash, vss: vote.vss })
    )
      throw new Error("simulation: a challenged attempt opens the cast ballot");
    const cell = cellOf(voter.tier);
    for (const seat of online) {
      const s = seats[seat - 1] as SeatSecrets;
      const result = intake(
        ctx,
        { seat, kemSecret: s.kem.secretKey, signingSecret: s.signingSecret },
        vote,
        encrypted.ciphertexts[seat - 1] as Uint8Array,
      );
      // An honest client's ballot that intake refuses is a bug in the protocol code.
      if (!result.ok)
        throw new Error(`simulation: intake refused an honest ballot (${result.code})`);
      // The voter's client checks each receipt at cast against the seat's
      // registered signing key ([[share-encryption]], Intake and receipts).
      if (!checkShareReceipt(registered, ctx, vote, seat, result.receipt))
        throw new Error("simulation: an honest seat's receipt failed its check");
      cell.sums.set(seat, sumShares(tallyRules, [sumOf(cell, seat), result.shares]));
    }
    cell.vss.push(vote.vss);
    if (voter.path === "server") server++;
    options.onProgress?.({ stage: "cast", done: done + 1, total: plan.voters.length });
  });

  const want = expectCells(scenario);
  const reports: CellReport[] = plan.tiers.map((tier, done) => {
    const cell = cellOf(tier);
    const summed = new Map<number, readonly Share[]>();
    for (const seat of online) {
      const sum = sumOf(cell, seat);
      summed.set(seat, faulty.includes(seat) ? corrupt(sum) : sum);
    }
    const opened = openCell(tallyRules, cell.vss, summed);
    const verified =
      opened.ok &&
      checkOpening(
        tallyRules,
        cell.vss,
        opened.counts.map((v, j) => ({ v, r: opened.randomness[j] as bigint })),
      ).ok;
    options.onProgress?.({ stage: "tally", done: done + 1, total: plan.tiers.length });
    const expected = plan.expected.get(tier) as readonly number[];
    return judgeCell({ tier, ballots: cell.vss.length, expected }, want, opened, verified);
  });

  const allOpened = reports.every((c) => c.counts !== undefined);
  return {
    ok: reports.every((c) => c.matches),
    scenario,
    definition: { hash: hex(definitionHash) },
    ceremony: {
      transcriptHash: hex(election.transcriptHash),
      registered: registered.map((r) => r.index),
    },
    ballots: { cast: plan.voters.length, server, direct: plan.voters.length - server, challenged },
    trustees: { online, offline, faulty },
    cells: reports,
    ...(allOpened
      ? {
          total: deriveTotal(reports.map((c) => (c.counts as readonly number[]).map(BigInt))).map(
            Number,
          ),
        }
      : {}),
    stubs: SIMULATION_STUBS,
  };
}
