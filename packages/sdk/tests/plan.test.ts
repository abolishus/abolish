import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import { downAt, planElection, type PlannedVoter, type Scenario } from "../src/index.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const base: Scenario = {
  voters: 500,
  election: "plurality",
  options: 4,
  trustees: { panel: 5, threshold: 3, offline: [], faulty: [], departures: [] },
  tiers: { "0": 2, "1": 1, "2": 1 },
  outage: { from: 0.5, to: 1 },
  challenges: 0.5,
  revotes: 0.5,
  publications: 0.5,
  postings: 0.5,
  seed: 7,
};

const scenario = fc.record({
  voters: fc.integer({ min: 1, max: 300 }),
  election: fc.constantFrom("plurality" as const, "approval" as const),
  options: fc.integer({ min: 2, max: 8 }),
  trustees: fc.constant(base.trustees),
  tiers: fc.record({
    "0": fc.integer({ min: 0, max: 5 }),
    "1": fc.integer({ min: 0, max: 5 }),
    "2": fc.integer({ min: 1, max: 5 }),
  }),
  outage: fc.option(
    fc
      .tuple(fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }))
      .filter(([a, b]) => a < b)
      .map(([from, to]) => ({ from, to })),
    { nil: null },
  ),
  challenges: fc.double({ min: 0, max: 1, noNaN: true }),
  revotes: fc.double({ min: 0, max: 1, noNaN: true }),
  publications: fc.double({ min: 0, max: 1, noNaN: true }),
  postings: fc.double({ min: 0, max: 1, noNaN: true }),
  seed: fc.integer({ min: 0, max: 0xffff_ffff }),
});

// Each property plans up to 300 voters per run, so CI's FC_NUM_RUNS=1000
// runs take several seconds, past the 5 s default.
describe("planElection", { timeout: 60_000 }, () => {
  it("is a function of the scenario: the same seed gives the same plan", () => {
    expect(planElection(base)).toEqual(planElection(base));
    expect(planElection({ ...base, seed: 8 })).not.toEqual(planElection(base));
  });

  it("plans every voter once, in time order, in a tier with weight, with a ballot the election allows", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const plan = planElection(s);
        expect(plan.voters.map((v) => v.index).sort((a, b) => a - b)).toEqual(
          Array.from({ length: s.voters }, (_, i) => i),
        );
        for (let i = 1; i < plan.voters.length; i++)
          expect((plan.voters[i] as { at: number }).at).toBeGreaterThanOrEqual(
            (plan.voters[i - 1] as { at: number }).at,
          );
        for (const v of plan.voters) {
          expect(s.tiers[`${v.tier}`]).toBeGreaterThan(0);
          expect(v.votes).toHaveLength(s.options);
          const chosen = v.votes.reduce<number>((a, x) => a + x, 0);
          if (s.election === "plurality") expect(chosen).toBe(1);
          expect(v.at).toBeGreaterThanOrEqual(0);
          expect(v.at).toBeLessThan(1);
        }
      }),
      { numRuns },
    );
  });

  it("expects exactly the planned votes, per tier and option", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const plan = planElection(s);
        expect(plan.tiers).toEqual([0, 1, 2].filter((t) => s.tiers[`${t}` as "0"] > 0));
        for (const tier of plan.tiers) {
          const counts = Array.from({ length: s.options }, (_, j) =>
            plan.voters
              .filter((v) => v.tier === tier)
              .reduce((a, v) => a + (v.votes[j] as number), 0),
          );
          expect(plan.expected.get(tier)).toEqual(counts);
        }
      }),
      { numRuns },
    );
  });

  it("sends a voter direct exactly when the servers are down at its time", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        for (const v of planElection(s).voters) {
          const down = s.outage !== null && v.at >= s.outage.from && v.at < s.outage.to;
          expect(v.path).toBe(down ? "direct" : "server");
        }
      }),
      { numRuns },
    );
  });

  it("draws challenges apart: the share changes no voter's tier, votes, time or path", () => {
    fc.assert(
      fc.property(scenario, fc.double({ min: 0, max: 1, noNaN: true }), (s, other) => {
        // Only a challenger publishes, so the share changes who may.
        const strip = (c: number) =>
          planElection({ ...s, challenges: c }).voters.map((v) => ({
            ...v,
            challenged: false,
            published: false,
          }));
        expect(strip(other)).toEqual(strip(s.challenges));
      }),
      { numRuns },
    );
  });

  it("draws re-votes apart: the share changes no voter's tier, last ballot or challenge", () => {
    fc.assert(
      fc.property(scenario, fc.double({ min: 0, max: 1, noNaN: true }), (s, other) => {
        const strip = (r: number) =>
          planElection({ ...s, revotes: r }).voters.map((v) => ({ ...v, earlier: null }));
        expect(strip(other)).toEqual(strip(s.revotes));
      }),
      { numRuns },
    );
  });

  it("draws postings apart, and counts only the delivered voters: all of them with no offline seat", () => {
    fc.assert(
      fc.property(scenario, fc.double({ min: 0, max: 1, noNaN: true }), (s, p) => {
        const strip = (v: PlannedVoter) => ({
          ...v,
          posts: false,
          delivered: false,
          earlier: v.earlier === null ? null : { ...v.earlier, posts: false },
        });
        const other = planElection({ ...s, postings: p });
        expect(other.voters.map(strip)).toEqual(planElection(s).voters.map(strip));
        expect(other.voters.every((v) => v.delivered)).toBe(true);
        const offline = { ...s, postings: p, trustees: { ...s.trustees, offline: [1] } };
        const plan = planElection(offline);
        for (const v of plan.voters) expect(v.delivered).toBe(v.posts);
        for (const tier of plan.tiers)
          expect(plan.expected.get(tier)).toEqual(
            Array.from({ length: s.options }, (_, j) =>
              plan.voters
                .filter((v) => v.tier === tier && v.delivered)
                .reduce((a, v) => a + (v.votes[j] as number), 0),
            ),
          );
      }),
      { numRuns },
    );
  });

  it("takes a departing seat down from its time on: a ballot cast then is delivered only if its voter posts", () => {
    const departing = fc
      .tuple(
        fc.double({ min: 0, max: 1, noNaN: true, minExcluded: true }),
        fc.double({ min: 0, max: 1, noNaN: true, minExcluded: true }),
      )
      .map(([a, b]) => [
        { seat: 2, at: a },
        { seat: 4, at: b },
      ]);
    fc.assert(
      fc.property(scenario, departing, (s, departures) => {
        const left = { ...s, trustees: { ...s.trustees, offline: [5], departures } };
        const plan = planElection(left);
        // Departures change no draw: only who is delivered, and so the counts.
        const strip = (v: PlannedVoter) => ({ ...v, delivered: false });
        expect(plan.voters.map(strip)).toEqual(planElection(s).voters.map(strip));
        for (const v of plan.voters) {
          // Every ballot, a re-voter's earlier one too, by its own time.
          for (const { at } of v.earlier === null ? [v] : [v.earlier, v])
            expect(downAt(left, at)).toEqual(
              [2, 4, 5].filter(
                (seat) => seat === 5 || departures.some((d) => d.seat === seat && d.at <= at),
              ),
            );
          expect(v.delivered).toBe(v.posts);
        }
        const none = { ...left, trustees: { ...left.trustees, offline: [] } };
        for (const v of planElection(none).voters)
          expect(v.delivered).toBe(downAt(none, v.at).length === 0 || v.posts);
        for (const tier of plan.tiers)
          expect(plan.expected.get(tier)).toEqual(
            Array.from({ length: s.options }, (_, j) =>
              plan.voters
                .filter((v) => v.tier === tier && v.delivered)
                .reduce((a, v) => a + (v.votes[j] as number), 0),
            ),
          );
      }),
      { numRuns },
    );
  });

  it("draws publications apart: the share changes no voter's tier, ballots or challenge", () => {
    fc.assert(
      fc.property(scenario, fc.double({ min: 0, max: 1, noNaN: true }), (s, other) => {
        const strip = (p: number) =>
          planElection({ ...s, publications: p }).voters.map((v) => ({ ...v, published: false }));
        expect(strip(other)).toEqual(strip(s.publications));
      }),
      { numRuns },
    );
  });

  it("publishes only a challenged attempt: no voter who didn't challenge publishes", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        for (const v of planElection(s).voters) if (v.published) expect(v.challenged).toBe(true);
      }),
      { numRuns },
    );
  });

  it("publishes with no voter at share 0 and with every challenger at share 1", () => {
    expect(planElection({ ...base, publications: 0 }).voters.some((v) => v.published)).toBe(false);
    const all = planElection({ ...base, publications: 1 }).voters;
    expect(all.every((v) => v.published === v.challenged)).toBe(true);
    expect(all.some((v) => v.published)).toBe(true);
  });

  it("plans a re-voter's earlier ballot no later than its last, with a ballot the election allows, sent direct exactly during the outage", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        for (const v of planElection(s).voters) {
          if (v.earlier === null) continue;
          const e = v.earlier;
          expect(e.at).toBeGreaterThanOrEqual(0);
          expect(e.at).toBeLessThanOrEqual(v.at);
          expect(e.votes).toHaveLength(s.options);
          if (s.election === "plurality")
            expect(e.votes.reduce<number>((a, x) => a + x, 0)).toBe(1);
          const down = s.outage !== null && e.at >= s.outage.from && e.at < s.outage.to;
          expect(e.path).toBe(down ? "direct" : "server");
        }
      }),
      { numRuns },
    );
  });

  it("re-votes with no voter at share 0 and with every voter at share 1", () => {
    expect(planElection({ ...base, revotes: 0 }).voters.some((v) => v.earlier !== null)).toBe(
      false,
    );
    expect(planElection({ ...base, revotes: 1 }).voters.every((v) => v.earlier !== null)).toBe(
      true,
    );
  });

  it("challenges with no voter at share 0 and with every voter at share 1", () => {
    expect(planElection({ ...base, challenges: 0 }).voters.some((v) => v.challenged)).toBe(false);
    expect(planElection({ ...base, challenges: 1 }).voters.every((v) => v.challenged)).toBe(true);
  });

  it("spreads voters across tiers by weight, the outage across time, and challenges, re-votes and publications by their shares", () => {
    const plan = planElection({ ...base, voters: 4000 });
    const share = (tier: number) => plan.voters.filter((v) => v.tier === tier).length / 4000;
    expect(share(0)).toBeCloseTo(0.5, 1);
    expect(share(1)).toBeCloseTo(0.25, 1);
    expect(plan.voters.filter((v) => v.path === "direct").length / 4000).toBeCloseTo(0.5, 1);
    expect(plan.voters.filter((v) => v.challenged).length / 4000).toBeCloseTo(0.5, 1);
    expect(plan.voters.filter((v) => v.earlier !== null).length / 4000).toBeCloseTo(0.5, 1);
    // Half of the challengers.
    expect(plan.voters.filter((v) => v.published).length / 4000).toBeCloseTo(0.25, 1);
  });
});
