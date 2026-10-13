// The plan of a simulated election: who votes, in which tier, for what and
// when, drawn from the scenario's seed so a run can be repeated and its
// expected result is known before any ballot is encrypted. The seed decides
// the plan only; every secret of the run comes from the CSPRNG inside
// @abolishus/crypto.

import { type Scenario, SIMULATED_TIERS, type SimulatedTier } from "./scenario.ts";

/** One ballot a voter casts. */
export interface PlannedBallot {
  /** One 0 or 1 per option. */
  readonly votes: readonly (0 | 1)[];
  /** When the voter casts, as a share of the voting period, in `[0, 1)`. */
  readonly at: number;
  /** `direct` when our servers are down at `at`: the voter submits without them. */
  readonly path: "server" | "direct";
  /**
   * Whether the voter, finding an offline seat's intake unreachable for this
   * ballot, posts that seat's share through the contract path: drawn for
   * every ballot, and acted on only when a seat is offline.
   */
  readonly posts: boolean;
}

/** A voter and the ballot that counts for it: its last. */
export interface PlannedVoter extends PlannedBallot {
  readonly index: number;
  readonly tier: SimulatedTier;
  /** Whether the voter challenges one attempt before casting the ballot that counts. */
  readonly challenged: boolean;
  /** Whether a challenging voter asks after close for that attempt's opening to be published. */
  readonly published: boolean;
  /**
   * Whether every qualified seat gets a receipt or a posting for the
   * voter's last ballot, so it counts (docs/spec/delivery.md, Delivery
   * check): with no offline seat, or when the voter posts it. An earlier
   * ballot delivered never counts in its place (No fallback).
   */
  readonly delivered: boolean;
  /**
   * A ballot the voter cast earlier, at a time no later than `at`, which the
   * re-vote rule must not count (docs/spec/revoting.md); `null` if the
   * voter casts once.
   */
  readonly earlier: PlannedBallot | null;
}

export interface Plan {
  readonly voters: readonly PlannedVoter[];
  /** The tiers with a positive weight, ascending: the electorate's cells. */
  readonly tiers: readonly SimulatedTier[];
  /** Per tier of `tiers`, per option, the count the tally must open: each delivered voter's last ballot. */
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

// Seed the challenge, re-vote, publication and posting draws apart from the rest of the plan and
// from each other, so a scenario's voters, votes and times don't change with
// any of the shares.
const CHALLENGE_STREAM = 0x9e37_79b9;
const REVOTE_STREAM = 0x85eb_ca6b;
const PUBLISH_STREAM = 0xc2b2_ae35;
const POSTING_STREAM = 0x27d4_eb2f;

function drawVotes(scenario: Scenario, next: () => number): (0 | 1)[] {
  if (scenario.election === "plurality") {
    const choice = Math.floor(next() * scenario.options);
    return Array.from({ length: scenario.options }, (_, j) => (j === choice ? 1 : 0));
  }
  return Array.from({ length: scenario.options }, () => (next() < 0.5 ? 1 : 0));
}

const pathAt = (scenario: Scenario, at: number): PlannedBallot["path"] =>
  scenario.outage !== null && at >= scenario.outage.from && at < scenario.outage.to
    ? "direct"
    : "server";

export function planElection(scenario: Scenario): Plan {
  const next = generator(scenario.seed);
  const nextChallenge = generator(scenario.seed ^ CHALLENGE_STREAM);
  const nextRevote = generator(scenario.seed ^ REVOTE_STREAM);
  const nextPublish = generator(scenario.seed ^ PUBLISH_STREAM);
  const nextPosting = generator(scenario.seed ^ POSTING_STREAM);
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
    const votes = drawVotes(scenario, next);
    const at = next();
    const challenged = nextChallenge() < scenario.challenges;
    // Drawn for every voter, so who publishes changes with neither share.
    const published = nextPublish() < scenario.publications && challenged;
    // Every voter draws the same number of values, so whether one voter
    // re-votes changes no other voter's earlier ballot.
    const revotes = nextRevote() < scenario.revotes;
    const earlierVotes = drawVotes(scenario, nextRevote);
    const earlierAt = nextRevote() * at;
    // Two draws for every voter, so whether one re-votes changes no other's.
    const posts = nextPosting() < scenario.postings;
    const earlierPosts = nextPosting() < scenario.postings;
    const delivered = scenario.trustees.offline.length === 0 || posts;
    if (delivered) {
      const counts = expected.get(tier) as number[];
      votes.forEach((v, j) => {
        counts[j] = (counts[j] as number) + v;
      });
    }
    const earlier = revotes
      ? {
          votes: earlierVotes,
          at: earlierAt,
          path: pathAt(scenario, earlierAt),
          posts: earlierPosts,
        }
      : null;
    voters.push({
      index,
      tier,
      votes,
      at,
      path: pathAt(scenario, at),
      challenged,
      published,
      posts,
      delivered,
      earlier,
    });
  }
  // Cast in time order, as voters would.
  voters.sort((a, b) => a.at - b.at || a.index - b.index);
  return { voters, tiers, expected };
}
