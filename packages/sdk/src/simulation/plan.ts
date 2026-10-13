// The plan of a simulated election: who votes, in which tier, for what and
// when, drawn from the scenario's seed so a run can be repeated and its
// expected result is known before any ballot is encrypted. The seed decides
// the plan only; every secret of the run comes from the CSPRNG inside
// @abolishus/crypto.

import { type Scenario, SIMULATED_TIERS, type SimulatedTier } from "./scenario.ts";

export interface PlannedVoter {
  readonly index: number;
  readonly tier: SimulatedTier;
  /** One 0 or 1 per option. */
  readonly votes: readonly (0 | 1)[];
  /** When the voter casts, as a share of the voting period, in `[0, 1)`. */
  readonly at: number;
  /** `direct` when our servers are down at `at`: the voter submits without them. */
  readonly path: "server" | "direct";
  /** Whether the voter challenges one attempt before casting a fresh one. */
  readonly challenged: boolean;
}

export interface Plan {
  readonly voters: readonly PlannedVoter[];
  /** The tiers with a positive weight, ascending: the electorate's cells. */
  readonly tiers: readonly SimulatedTier[];
  /** Per tier of `tiers`, per option, the count the tally must open. */
  readonly expected: ReadonlyMap<SimulatedTier, readonly number[]>;
}

/**
 * mulberry32 (Tommy Ettinger, public domain): a small, fast 32-bit generator.
 * Not a CSPRNG and never used for one; it only makes the plan reproducible.
 */
function generator(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

/** The selection range each election type's ballots are proved against. */
export function selectionRange(scenario: Scenario): { min: number; max: number } {
  // ADR 0003: a blank plurality ballot is valid, so plurality is [0, 1].
  return scenario.election === "plurality" ? { min: 0, max: 1 } : { min: 0, max: scenario.options };
}

// Seeds the challenge draws apart from the rest of the plan, so a scenario's
// voters, votes and times don't change with its challenge share.
const CHALLENGE_STREAM = 0x9e37_79b9;

export function planElection(scenario: Scenario): Plan {
  const next = generator(scenario.seed);
  const nextChallenge = generator(scenario.seed ^ CHALLENGE_STREAM);
  const tiers = SIMULATED_TIERS.filter((t) => scenario.tiers[`${t}`] > 0);
  const total = tiers.reduce<number>((a, t) => a + scenario.tiers[`${t}`], 0);
  const expected = new Map(
    tiers.map((t) => [t, Array.from({ length: scenario.options }, () => 0)]),
  );
  const voters: PlannedVoter[] = [];
  for (let index = 0; index < scenario.voters; index++) {
    let pick = next() * total;
    // The last tier absorbs rounding, so a voter always lands in one.
    let tier = tiers[tiers.length - 1] as SimulatedTier;
    for (const t of tiers) {
      pick -= scenario.tiers[`${t}`];
      if (pick < 0) {
        tier = t;
        break;
      }
    }
    let votes: (0 | 1)[];
    if (scenario.election === "plurality") {
      const choice = Math.floor(next() * scenario.options);
      votes = Array.from({ length: scenario.options }, (_, j) => (j === choice ? 1 : 0));
    } else votes = Array.from({ length: scenario.options }, () => (next() < 0.5 ? 1 : 0));
    const at = next();
    const down = scenario.outage !== null && at >= scenario.outage.from && at < scenario.outage.to;
    const counts = expected.get(tier) as number[];
    votes.forEach((v, j) => {
      counts[j] = (counts[j] as number) + v;
    });
    const challenged = nextChallenge() < scenario.challenges;
    voters.push({ index, tier, votes, at, path: down ? "direct" : "server", challenged });
  }
  // Cast in time order, as voters would.
  voters.sort((a, b) => a.at - b.at || a.index - b.index);
  return { voters, tiers, expected };
}
