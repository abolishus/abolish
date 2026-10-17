// A simulation of several questions on one ballot (P2-14 part 6b-2;
// [[0026-multi-question-ballots]]): the scenario's questions, the plan's
// answers within each question's limits, definition version 5 with ballot
// version 3 registered and served, the board contract's version-3 checks,
// and whole runs that open every cell to the plan per question, agree with
// the verifier and rebuild from chain and IPFS (T-28, T-29, T-34).

import {
  type BallotRecordV3,
  cellBallotCore,
  decodeMembershipProof,
  electionDefinitionV5Hash,
  electionDefinitionV5Rule,
  encryptShares,
  encodeBallotV3,
  identityKey,
  membershipVkEncoding,
  pinnedVersion,
  profileCombinationRule,
  QUESTION_METHODS,
  RECORD_TYPES,
} from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import { parseScenario, planElection, runSimulation, type Scenario } from "../src/index.ts";
import { SimulatedBoardContract } from "../src/simulation/board-contract.ts";
import { simulateElection } from "../src/simulation/election.ts";
import { SimulatedL1 } from "../src/simulation/l1.ts";
import { l2BlockAt } from "../src/simulation/l2.ts";
import { SIMULATED_OPENS_AT } from "../src/simulation/plan.ts";
import type { SimulatedQuestion } from "../src/simulation/scenario.ts";
import { simulatedBallots } from "../src/simulation/versions.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
// Each ballot costs about 0.1 s per online seat (intake checks its proofs).
const timeout = 120_000;

// Pick one, pick any and pick exactly two.
const QUESTIONS: readonly SimulatedQuestion[] = [
  { options: 3, min: 1, max: 1 },
  { options: 3, min: 0, max: 3 },
  { options: 4, min: 2, max: 2 },
];

const base: Scenario = {
  voters: 8,
  election: "questions",
  options: 10,
  questions: QUESTIONS,
  trustees: { panel: 3, threshold: 2, offline: [3], faulty: [], departures: [] },
  tiers: { "0": 1, "1": 0, "2": 1 },
  outage: { from: 0.3, to: 0.7 },
  challenges: 0.5,
  revotes: 0.5,
  publications: 1,
  postings: 0.5,
  reorgs: 0,
  seed: 11,
};

const json = (o: Record<string, unknown>) => ({
  voters: 2,
  election: "questions",
  questions: [{ options: 2, min: 0, max: 1 }],
  trustees: { panel: 3, threshold: 2 },
  tiers: { "0": 1 },
  seed: 1,
  ...o,
});

const refusal = (input: unknown) => {
  const r = parseScenario(input);
  return r.ok ? "accepted" : r.path;
};

describe("parseScenario with questions", () => {
  it("takes the questions in ballot order, with the options their total", () => {
    const r = parseScenario(json({ questions: QUESTIONS }));
    expect(r.ok && r.scenario).toMatchObject({
      election: "questions",
      options: 10,
      questions: QUESTIONS,
    });
  });

  it("refuses an option count beside the questions, and questions beside one question's type", () => {
    expect(refusal(json({ options: 2 }))).toBe("$.options");
    expect(refusal({ ...json({ election: "approval", options: 2 }) })).toBe("$.questions");
    const { questions: _, ...none } = json({});
    expect(refusal(none)).toBe("$.questions");
  });

  it("refuses questions version 5's rules or limits refuse", () => {
    const one = (q: unknown) => refusal(json({ questions: [q] }));
    expect(refusal(json({ questions: [] }))).toBe("$.questions");
    expect(
      refusal(
        json({ questions: Array.from({ length: 33 }, () => ({ options: 2, min: 0, max: 1 })) }),
      ),
    ).toBe("$.questions");
    // option-count: at least 2 options; selections: 1 ≤ max, min ≤ max ≤ options.
    expect(one({ options: 1, min: 0, max: 1 })).toBe("$.questions[0].options");
    expect(one({ options: 2, min: 3, max: 3 })).toBe("$.questions[0].min");
    expect(one({ options: 2, min: 0, max: 0 })).toBe("$.questions[0].max");
    expect(one({ options: 3, min: 2, max: 1 })).toBe("$.questions[0].max");
    expect(one({ options: 2, min: 0, max: 3 })).toBe("$.questions[0].max");
    expect(one({ options: 2, min: 0, max: 1, method: 1 })).toBe("$.questions[0].method");
    expect(one({ options: 2, min: 0 })).toBe("$.questions[0].max");
    // At most MAX_OPTIONS over the whole poll.
    expect(
      refusal(
        json({
          questions: [
            { options: 40, min: 0, max: 1 },
            { options: 25, min: 0, max: 1 },
          ],
        }),
      ),
    ).toBe("$.questions");
    expect(
      refusal(
        json({
          questions: [
            { options: 40, min: 0, max: 1 },
            { options: 24, min: 0, max: 1 },
          ],
        }),
      ),
    ).toBe("accepted");
  });
});

const question = fc
  .integer({ min: 2, max: 6 })
  .chain((options) =>
    fc
      .integer({ min: 0, max: options })
      .chain((min) =>
        fc
          .integer({ min: Math.max(min, 1), max: options })
          .map((max): SimulatedQuestion => ({ options, min, max })),
      ),
  );

describe("planElection with questions", () => {
  it("answers each question within its limits, and expects the counted ballots' answers", () => {
    fc.assert(
      fc.property(
        fc.array(question, { minLength: 1, maxLength: 5 }),
        fc.integer({ min: 0, max: 0xffff_ffff }),
        (questions, seed) => {
          const s: Scenario = {
            ...base,
            voters: 20,
            questions,
            options: questions.reduce((n, q) => n + q.options, 0),
            trustees: { ...base.trustees, offline: [] },
            seed,
          };
          const plan = planElection(s);
          const answers = (votes: readonly number[]) => {
            let at = 0;
            return questions.map((q) => votes.slice(at, (at += q.options)));
          };
          for (const v of plan.voters)
            for (const ballot of [v, ...(v.earlier === null ? [] : [v.earlier])]) {
              expect(ballot.votes).toHaveLength(s.options);
              answers(ballot.votes).forEach((a, q) => {
                const picked = a.filter((x) => x === 1).length;
                expect(picked).toBeGreaterThanOrEqual((questions[q] as SimulatedQuestion).min);
                expect(picked).toBeLessThanOrEqual((questions[q] as SimulatedQuestion).max);
              });
            }
          // No seat is down, so each voter's selected ballot counts.
          const sums = Array.from({ length: s.options }, () => 0);
          for (const v of plan.voters) {
            const counted = v.selected === "earlier" ? v.earlier?.votes : v.votes;
            counted?.forEach((x, j) => (sums[j] = (sums[j] as number) + x));
          }
          const expected = [...plan.expected.values()].reduce((a, c) =>
            a.map((x, j) => x + (c[j] as number)),
          );
          expect(expected).toEqual(sums);
        },
      ),
      { numRuns },
    );
  });

  it("is the same plan from the same seed", () => {
    expect(planElection(base)).toEqual(planElection(base));
  });
});

const receiptKey = () => identityKey(crypto.getRandomValues(new Uint8Array(32)));

describe("simulateElection with questions", { timeout }, () => {
  const e = simulateElection(base, planElection(base), receiptKey());
  const d = e.definition;

  it("registers a well-formed definition version 5 pinning ballot version 3", () => {
    if (!("questions" in d)) throw new Error("expected version 5");
    expect(electionDefinitionV5Rule(d)).toBeUndefined();
    expect(profileCombinationRule(d)).toBeUndefined();
    expect(d.questions).toEqual(
      QUESTIONS.map((q) => ({
        method: QUESTION_METHODS.selection,
        option_count: q.options,
        min_selections: q.min,
        max_selections: q.max,
      })),
    );
    expect(pinnedVersion(d, RECORD_TYPES.electionDefinition)).toBe(5);
    expect(pinnedVersion(d, RECORD_TYPES.ballot)).toBe(3);
    expect(pinnedVersion(d, RECORD_TYPES.spoiledBallotOpening)).toBe(2);
    expect(pinnedVersion(d, RECORD_TYPES.displayText)).toBe(2);
    expect(e.definitionHash).toEqual(electionDefinitionV5Hash(d));
    const held = e.electionRegistry.definitionHashOf(d.election_id);
    expect(held).toEqual(e.definitionHash);
    // The board reads each question's limits from the registry, never a submitter.
    expect(e.electionRegistry.parametersOf(e.definitionHash)).toMatchObject({
      ballotVersion: 3,
      optionCount: 10,
      questions: QUESTIONS.map((q) => ({
        method: 1,
        options: q.options,
        minSelections: q.min,
        maxSelections: q.max,
      })),
    });
  });

  it("checks a version-3 ballot's shape on the board contract, per question", () => {
    const ballots = simulatedBallots(d, e.registered);
    const board = new SimulatedBoardContract(
      d.l2_chain_id,
      d.board,
      e.electionRegistry,
      e.trusteeRegistry,
    );
    const l1 = new SimulatedL1();
    const ref = l1.firstAfter(SIMULATED_OPENS_AT);
    const vk = membershipVkEncoding();
    const sharing = ballots.share([0, 1, 0, 1, 1, 0, 0, 0, 1, 1]);
    const encrypted = encryptShares(
      { definitionHash: e.definitionHash },
      sharing,
      e.registered.map((r) => r.kemKey),
    );
    const core = cellBallotCore(ballots.election, 0, encrypted);
    const vote = ballots.prove(ballots.context(0, 1n), sharing, core.shareHashes);
    if (!("sum_proofs" in vote)) throw new Error("expected a version-3 committed vote");
    const record: BallotRecordV3 = {
      definition_hash: e.definitionHash,
      cell: 0,
      nullifier: 1n,
      l1_ref_number: ref,
      l1_ref_hash: l1.block(ref).hash,
      // A placeholder: the board doesn't check the membership proof (step 9).
      membership_proof: decodeMembershipProof(
        Uint8Array.from([...vk.subarray(0, 192), ...vk.subarray(0, 64)]),
      ),
      committed_vote: vote,
    };
    const during = l2BlockAt(SIMULATED_OPENS_AT + 600n);
    const submit = (r: BallotRecordV3) => {
      const got = board.submitBallot(encodeBallotV3(r), during);
      return got.ok ? got.emitted : got.refusal;
    };
    // Question 2's range proof with a branch too few, then question 1's left out.
    const [q0, q1, q2] = vote.sum_proofs as typeof vote.sum_proofs;
    if (q0 === undefined || q1 === undefined || q2 === undefined)
      throw new Error("three questions");
    const short = { ...vote, sum_proofs: [q0, q1, q2.slice(1)] };
    const missing = { ...vote, sum_proofs: [q0, q2] };
    expect(submit({ ...record, committed_vote: short })).toBe("validity-shape");
    expect(submit({ ...record, committed_vote: missing })).toBe("validity-shape");
    // A version-2 record under a definition pinning version 3.
    const v2 = encodeBallotV3(record);
    v2[2] = 2;
    expect(board.submitBallot(v2, during)).toEqual({ ok: false, refusal: "profile-mismatch" });
    expect(submit(record)).toBe(1);
  });
});

describe("runSimulation with questions", { timeout }, () => {
  it("opens every cell to the plan per question, agrees with the verifier and rebuilds", async () => {
    const r = await runSimulation(base);
    expect(r.ok).toBe(true);
    const { challenged, published, superseded, server, direct, postings, undelivered } = r.ballots;
    for (const n of [challenged, published, superseded, server, direct, postings, undelivered])
      expect(n).toBeGreaterThan(0);
    expect(r.verifier.passed).toEqual(["2.9", "3.2", "4.1", "4.2", "5.4", "5.5", "5.7"]);
    expect(r.verifier.failed.map((f) => f.code)).toEqual(Array(3).fill("membership-proof"));
    expect(r.cells.map((c) => c.tier)).toEqual([0, 2]);
    for (const c of r.cells) {
      expect(c.outcome).toBe("opened");
      expect(c.counts).toEqual(c.expected);
      // Each question's slice of the flat options, tallied on its own.
      let at = 0;
      expect(c.questions).toEqual(
        QUESTIONS.map((q) => {
          const slice = c.expected.slice(at, (at += q.options));
          return { expected: slice, counts: slice };
        }),
      );
      // Pick one and pick exactly two: every counted ballot answers them.
      const counted = (c.questions?.[0]?.counts ?? []).reduce((a, x) => a + x, 0);
      expect((c.questions?.[2]?.counts ?? []).reduce((a, x) => a + x, 0)).toBe(2 * counted);
    }
    expect(r.rebuild.entries).toBe(r.board.entries);
  });

  it("submits every ballot to the board contract while our servers are down throughout", async () => {
    const r = await runSimulation({
      ...base,
      voters: 4,
      outage: { from: 0, to: 1 },
      challenges: 0,
      revotes: 0,
      publications: 0,
      postings: 1,
    });
    expect(r.ok).toBe(true);
    expect(r.ballots.direct).toBe(r.ballots.cast);
    // Each ballot, its online seats' receipts and its posting of the offline seat.
    expect(r.board.contractEvents).toBe(4 * (1 + 2 + 1));
    for (const c of r.cells) expect(c.counts).toEqual(c.expected);
  });

  it("reports tally-quorum per cell, with no question's counts, when fewer than k seats remain", async () => {
    const r = await runSimulation({
      ...base,
      voters: 3,
      trustees: { ...base.trustees, offline: [2, 3] },
      challenges: 0,
      revotes: 0,
      publications: 0,
    });
    expect(r.ok).toBe(true);
    for (const c of r.cells) {
      expect(c.outcome).toBe("tally-quorum");
      expect(c.questions?.map((q) => q.counts)).toEqual([undefined, undefined, undefined]);
    }
    expect(r.total).toBeUndefined();
  });
});
