// Runs a simulated election in memory through @abolishus/crypto's own code:
// per-election trustee keys, each voter's sharing, share encryption and
// validity proof, each online trustee's intake (proof checks, decryption,
// share checks, receipt), the summed shares, each cell's combination from the
// k lowest passing seats, and the verifier's check of every opening. Nothing
// here reimplements a check the verifier makes (AGENTS.md, Architecture): it
// only calls them and compares the result with the plan (T-29, T-54, T-25).

import {
  ceremonyKeygen,
  checkOpening,
  type CommittedVote,
  deriveTotal,
  encryptShares,
  GROUP_ORDER,
  intake,
  openCell,
  proveValidity,
  type SeatSecrets,
  type Share,
  shareVote,
  sumShares,
  type TallyRules,
  type ValidityContext,
} from "@abolishus/crypto";
import { type Plan, planElection, selectionRange } from "./plan.ts";
import type { Scenario, SimulatedTier } from "./scenario.ts";

/**
 * What this run models only in outline, until the items that build each
 * piece land (docs/status/P1-21.md). Every report carries the list, so no
 * result is mistaken for a run of the whole protocol.
 */
export const SIMULATION_STUBS = Object.freeze([
  "definition: a random 32-byte definition hash, not a registered election definition (P1-20)",
  "ceremony: per-election keys from ceremonyKeygen without the four signed rounds (P1-20)",
  "membership: no membership proofs; each voter's nullifier is its index plus one (P1-17b, P3-2)",
  "delivery: ciphertexts reach trustees in memory, with no board, receipts at cast or contract path; a direct ballot differs only in its label (P1-12c, P4-2)",
  "trustees: offline seats are down for the whole election; faulty seats lie only in their summed shares",
  "not yet simulated: Benaloh challenges, re-voting, anchoring, destruction and wipe-and-rebuild (P1-21 part 2)",
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
  readonly ballots: { readonly cast: number; readonly server: number; readonly direct: number };
  readonly trustees: {
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

const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));

// A faulty seat's lie: option 0's summed vote share plus one, which the
// summed-share check must catch (verifier 7.2).
function corrupt(summed: readonly Share[]): Share[] {
  return summed.map((s, j) => (j === 0 ? { v: (s.v + 1n) % GROUP_ORDER, r: s.r } : s));
}

function expectedOutcome(scenario: Scenario): CellOutcome {
  const { panel, threshold, offline, faulty } = scenario.trustees;
  return panel - offline.length - faulty.length >= threshold ? "opened" : "tally-quorum";
}

const sameCounts = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

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
  const definitionHash = randomBytes(32);
  const seats: SeatSecrets[] = Array.from({ length: n }, (_, i) =>
    ceremonyKeygen(i + 1, randomBytes(32)),
  );
  const keys = seats.map((s) => s.kem.publicKey);
  const online = seats.map((s) => s.index).filter((i) => !offline.includes(i));

  // Per tier: the counted ballots' VSS commitments, and each online seat's shares of them.
  const cells = new Map(
    plan.tiers.map((t) => [
      t,
      {
        vss: [] as CommittedVote["vss"][],
        shares: new Map(online.map((i) => [i, [] as (readonly Share[])[]])),
      },
    ]),
  );
  let server = 0;
  plan.voters.forEach((voter, done) => {
    const ctx: ValidityContext = {
      ...rules,
      definitionHash,
      tier: voter.tier,
      nullifier: BigInt(voter.index + 1),
    };
    const sharing = shareVote(rules, voter.votes);
    const encrypted = encryptShares({ definitionHash }, sharing, keys);
    const vote = proveValidity(ctx, sharing, encrypted.hashes);
    const cell = cells.get(voter.tier);
    if (cell === undefined) throw new Error("simulation: a voter outside the electorate");
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
      cell.shares.get(seat)?.push(result.shares);
    }
    cell.vss.push(vote.vss);
    if (voter.path === "server") server++;
    options.onProgress?.({ stage: "cast", done: done + 1, total: plan.voters.length });
  });

  const tallyRules: TallyRules = { optionCount: scenario.options, threshold: k, panelSize: n };
  const want = expectedOutcome(scenario);
  const reports: CellReport[] = plan.tiers.map((tier, done) => {
    const cell = cells.get(tier) as NonNullable<ReturnType<typeof cells.get>>;
    const expected = plan.expected.get(tier) as readonly number[];
    const summed = new Map<number, readonly Share[]>();
    for (const seat of online) {
      const sum = sumShares(tallyRules, cell.shares.get(seat) ?? []);
      summed.set(seat, faulty.includes(seat) ? corrupt(sum) : sum);
    }
    const opened = openCell(tallyRules, cell.vss, summed);
    options.onProgress?.({ stage: "tally", done: done + 1, total: plan.tiers.length });
    if (!opened.ok) {
      const outcome = opened.code;
      return {
        tier,
        ballots: cell.vss.length,
        expected,
        expectedOutcome: want,
        outcome,
        excluded: opened.excluded,
        verified: false,
        matches: outcome === want,
      };
    }
    const shares = opened.counts.map((v, j) => ({ v, r: opened.randomness[j] as bigint }));
    const verified = checkOpening(tallyRules, cell.vss, shares).ok;
    const counts = opened.counts.map(Number);
    return {
      tier,
      ballots: cell.vss.length,
      expected,
      expectedOutcome: want,
      outcome: "opened",
      counts,
      combined: opened.combined,
      excluded: opened.excluded,
      verified,
      matches: want === "opened" && verified && sameCounts(counts, expected),
    };
  });

  const allOpened = reports.every((c) => c.counts !== undefined);
  return {
    ok: reports.every((c) => c.matches),
    scenario,
    ballots: { cast: plan.voters.length, server, direct: plan.voters.length - server },
    trustees: { online: online.filter((i) => !faulty.includes(i)), offline, faulty },
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
