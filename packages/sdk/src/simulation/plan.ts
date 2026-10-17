// The plan of a simulated election: who votes, in which tier, for what and
// when, drawn from the scenario's seed so a run can be repeated and its
// expected result is known before any ballot is encrypted. The seed decides
// the plan only; every secret of the run comes from the CSPRNG inside
// @abolishus/crypto.

import type { QuestionRules } from "@abolishus/crypto";
import { finalizedAt, nameBlock } from "./l1.ts";
import { type Scenario, SIMULATED_TIERS, type SimulatedTier } from "./scenario.ts";

/** The definition's voting period, in L2 time: one day. */
export const SIMULATED_OPENS_AT = 1_000_000n;
export const SIMULATED_CLOSES_AT = 1_086_400n;
const PERIOD = SIMULATED_CLOSES_AT - SIMULATED_OPENS_AT;

/** The time, in seconds, a share `at` of the voting period stands for. */
export const secondsAt = (at: number): bigint =>
  SIMULATED_OPENS_AT + BigInt(Math.floor(at * Number(PERIOD)));

/** One ballot a voter casts. */
export interface PlannedBallot {
  /** One 0 or 1 per option, every question's options in flat order. */
  readonly votes: readonly (0 | 1)[];
  /** When the voter casts, as a share of the voting period, in `[0, 1)`. */
  readonly at: number;
  /** `direct` when our servers are down at `at`: the voter submits without them. */
  readonly path: "server" | "direct";
  /**
   * Whether the voter, finding a seat's intake unreachable for this ballot,
   * posts that seat's share through the contract path: drawn for every
   * ballot, and acted on only when a seat is down at `at` (`downAt`).
   */
  readonly posts: boolean;
}

/**
 * A voter's last ballot cast again, the same committed vote under a new L1
 * reference, after its first cast named a block reorganised away
 * (docs/spec/revoting.md, Client rule 4). Its shares, receipts and postings
 * are the first cast's, which cover its ballot hash.
 */
export interface PlannedRecast {
  /**
   * When the client, checking the named block once it is finalized, casts
   * again: in seconds, exactly the block's finality, before close.
   */
  readonly seconds: bigint;
  /** The same time as a share of the voting period, in `(0, 1)`, which decides its path. */
  readonly at: number;
  readonly path: PlannedBallot["path"];
}

/** A voter and the ballot that counts for it: its last, unless that is lost to a reorganisation. */
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
   * check): with no seat down when it is cast, or when the voter posts it. An earlier
   * ballot delivered never counts in its place (No fallback); only a last
   * ballot that is never admitted (`reorg`) leaves the earlier one selected.
   */
  readonly delivered: boolean;
  /**
   * A ballot the voter cast earlier, at a time no later than `at`, which the
   * re-vote rule must not count (docs/spec/revoting.md); `null` if the
   * voter casts once.
   */
  readonly earlier: PlannedBallot | null;
  /**
   * Whether the last ballot's first cast names an L1 block reorganised away
   * after the client named it, so the verifier rejects it (`l1-ref-unknown`),
   * and if so its recast, or `null` when the block is finalized too late to
   * cast again before close: then the ballot is lost and the re-vote rule
   * selects the earlier ballot, if any (docs/spec/revoting.md, Residuals).
   */
  readonly reorg: { readonly recast: PlannedRecast | null } | null;
  /**
   * The ballot the re-vote rule selects for the voter: `last` (its recast,
   * after a reorganisation), `earlier` when the last is lost, or `null` when
   * the voter has no admitted ballot.
   */
  readonly selected: "last" | "earlier" | null;
}

export interface Plan {
  readonly voters: readonly PlannedVoter[];
  /** The tiers with a positive weight, ascending: the electorate's cells. */
  readonly tiers: readonly SimulatedTier[];
  /** Per tier of `tiers`, per option, the count the tally must open: each voter's selected ballot, when delivered. */
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

/** The selection range a one-question election's ballots are proved against. */
export function selectionRange(scenario: Scenario): { min: number; max: number } {
  // ADR 0003: a blank plurality ballot is valid, so plurality is [0, 1].
  return scenario.election === "plurality" ? { min: 0, max: 1 } : { min: 0, max: scenario.options };
}

/** Each question's option count and limits, in ballot order: one question unless `questions`. */
export function questionRules(scenario: Scenario): QuestionRules[] {
  if (scenario.questions === undefined) {
    const { min, max } = selectionRange(scenario);
    return [{ optionCount: scenario.options, minSelections: min, maxSelections: max }];
  }
  return scenario.questions.map((q) => ({
    optionCount: q.options,
    minSelections: q.min,
    maxSelections: q.max,
  }));
}

// Seed the challenge, re-vote, publication and posting draws apart from the rest of the plan and
// from each other, so a scenario's voters, votes and times don't change with
// any of the shares.
const CHALLENGE_STREAM = 0x9e37_79b9;
const REVOTE_STREAM = 0x85eb_ca6b;
const PUBLISH_STREAM = 0xc2b2_ae35;
const POSTING_STREAM = 0x27d4_eb2f;
const REORG_STREAM = 0x1656_67b1;

function drawVotes(scenario: Scenario, next: () => number): (0 | 1)[] {
  // Each question: how many it picks, uniform over its limits, then which,
  // the first that many of a Fisher–Yates shuffle. A fixed number of draws
  // per question, so one voter's answers never shift another's.
  if (scenario.questions !== undefined)
    return scenario.questions.flatMap(({ options, min, max }) => {
      const picks = min + Math.floor(next() * (max - min + 1));
      const order = Array.from({ length: options }, (_, j) => j);
      for (let j = options - 1; j > 0; j--) {
        const i = Math.floor(next() * (j + 1));
        [order[i], order[j]] = [order[j] as number, order[i] as number];
      }
      const picked = new Set(order.slice(0, picks));
      return Array.from({ length: options }, (_, j): 0 | 1 => (picked.has(j) ? 1 : 0));
    });
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

/**
 * Whether every qualified seat gets a receipt or a posting for `ballot`: no
 * seat is down at its cast, or its voter posts them.
 */
export const deliveredAt = (scenario: Scenario, ballot: PlannedBallot): boolean =>
  downAt(scenario, ballot.at).length === 0 || ballot.posts;

/**
 * The seats down for a ballot cast at `at`, ascending: the offline seats and
 * those departed by then. Each takes no share of it, so it is delivered only
 * if its voter posts them.
 */
export function downAt(scenario: Scenario, at: number): number[] {
  const { offline, departures } = scenario.trustees;
  return [...offline, ...departures.filter((d) => d.at <= at).map((d) => d.seat)].sort(
    (a, b) => a - b,
  );
}

export function planElection(scenario: Scenario): Plan {
  const next = generator(scenario.seed);
  const nextChallenge = generator(scenario.seed ^ CHALLENGE_STREAM);
  const nextRevote = generator(scenario.seed ^ REVOTE_STREAM);
  const nextPublish = generator(scenario.seed ^ PUBLISH_STREAM);
  const nextPosting = generator(scenario.seed ^ POSTING_STREAM);
  const nextReorg = generator(scenario.seed ^ REORG_STREAM);
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
    const delivered = downAt(scenario, at).length === 0 || posts;
    const earlier = revotes
      ? {
          votes: earlierVotes,
          at: earlierAt,
          path: pathAt(scenario, earlierAt),
          posts: earlierPosts,
        }
      : null;
    // The client casts again once the named block is finalized, if that is
    // before close (Client rule 4); the block it named is the one the run
    // names, from the same clock and the voter's earlier block (Client rule 3).
    // A recast at close itself is taken as too late: the close rule that
    // would judge it isn't simulated (P1-18).
    const reorged = nextReorg() < scenario.reorgs;
    let reorg: PlannedVoter["reorg"] = null;
    if (reorged) {
      const before = earlier === null ? undefined : nameBlock(secondsAt(earlier.at), undefined);
      const seconds = finalizedAt(nameBlock(secondsAt(at), before));
      const recastAt = Number(seconds - SIMULATED_OPENS_AT) / Number(PERIOD);
      reorg = {
        recast:
          seconds < SIMULATED_CLOSES_AT
            ? { seconds, at: recastAt, path: pathAt(scenario, recastAt) }
            : null,
      };
    }
    const selected: PlannedVoter["selected"] =
      reorg !== null && reorg.recast === null ? (earlier === null ? null : "earlier") : "last";
    const counted =
      selected === "last" && delivered
        ? votes
        : selected === "earlier" && earlier !== null && deliveredAt(scenario, earlier)
          ? earlier.votes
          : null;
    if (counted !== null) {
      const counts = expected.get(tier) as number[];
      counted.forEach((v, j) => {
        counts[j] = (counts[j] as number) + v;
      });
    }
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
      reorg,
      selected,
    });
  }
  // Cast in time order, as voters would.
  voters.sort((a, b) => a.at - b.at || a.index - b.index);
  return { voters, tiers, expected };
}
