import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import {
  MAX_SIMULATED_OPENING_LOOKUPS,
  MAX_SIMULATED_VOTERS,
  MAX_SIMULATED_WORK,
  parseScenario,
  type Scenario,
} from "../src/index.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const seatsOf = (panel: number) =>
  fc
    .subarray(Array.from({ length: panel }, (_, i) => i + 1))
    .chain((offline) =>
      fc
        .subarray(
          Array.from({ length: panel }, (_, i) => i + 1).filter((s) => !offline.includes(s)),
        )
        .map((faulty) => ({ offline, faulty })),
    );

const scenario: fc.Arbitrary<Scenario> = fc.integer({ min: 2, max: 16 }).chain((panel) =>
  fc
    .record({
      // Halved, so a positive re-vote share's doubled bound holds too.
      voters: fc.integer({ min: 1, max: Math.floor(MAX_SIMULATED_WORK / (128 * panel)) }),
      election: fc.constantFrom("plurality" as const, "approval" as const),
      options: fc.integer({ min: 2, max: 64 }),
      trustees: fc
        .tuple(fc.integer({ min: 2, max: panel }), seatsOf(panel))
        .map(([threshold, s]) => ({ panel, threshold, ...s })),
      tiers: fc.record({
        "0": fc.integer({ min: 0, max: 1_000_000 }),
        "1": fc.integer({ min: 0, max: 1_000_000 }),
        "2": fc.integer({ min: 1, max: 1_000_000 }),
      }),
      outage: fc.option(
        fc
          .tuple(
            fc.double({ min: 0, max: 1, noNaN: true }),
            fc.double({ min: 0, max: 1, noNaN: true }),
          )
          .filter(([a, b]) => a < b)
          .map(([from, to]) => ({ from, to })),
        { nil: null },
      ),
      challenges: fc.double({ min: 0, max: 1, noNaN: true }),
      revotes: fc.double({ min: 0, max: 1, noNaN: true }),
      publications: fc.double({ min: 0, max: 1, noNaN: true }),
      postings: fc.double({ min: 0, max: 1, noNaN: true }),
      seed: fc.integer({ min: 0, max: 0xffff_ffff }),
    })
    // Published openings only where their own bound holds, at either re-vote share.
    .map((s) =>
      2 * s.voters * s.voters * s.options <= MAX_SIMULATED_OPENING_LOOKUPS
        ? s
        : { ...s, publications: 0 },
    ),
);

const valid: Scenario = {
  voters: 100,
  election: "plurality",
  options: 3,
  trustees: { panel: 7, threshold: 4, offline: [2, 5], faulty: [] },
  tiers: { "0": 50, "1": 30, "2": 20 },
  outage: { from: 0.5, to: 1 },
  challenges: 0.1,
  revotes: 0.2,
  publications: 0.5,
  postings: 0.5,
  seed: 1,
};

const refusal = (input: unknown) => {
  const r = parseScenario(input);
  return r.ok ? undefined : r.path;
};

describe("parseScenario", () => {
  it("accepts every well-formed scenario unchanged, through a JSON round trip", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const r = parseScenario(JSON.parse(JSON.stringify(s)));
        expect(r).toEqual({ ok: true, scenario: s });
      }),
      { numRuns },
    );
  });

  it("defaults only the optional fields: no outage, challenges, re-votes, publications or postings, no offline or faulty seats, missing tiers at 0", () => {
    const r = parseScenario({
      voters: 1,
      election: "approval",
      options: 2,
      trustees: { panel: 2, threshold: 2 },
      tiers: { "1": 1 },
      seed: 0,
    });
    expect(r).toEqual({
      ok: true,
      scenario: {
        voters: 1,
        election: "approval",
        options: 2,
        trustees: { panel: 2, threshold: 2, offline: [], faulty: [] },
        tiers: { "0": 0, "1": 1, "2": 0 },
        outage: null,
        challenges: 0,
        revotes: 0,
        publications: 0,
        postings: 0,
        seed: 0,
      },
    });
  });

  it("refuses unknown fields at every level, naming the field", () => {
    expect(refusal({ ...valid, voter: 1 })).toBe("$.voter");
    expect(refusal({ ...valid, trustees: { ...valid.trustees, quorum: 5 } })).toBe(
      "$.trustees.quorum",
    );
    expect(refusal({ ...valid, tiers: { "3": 1 } })).toBe("$.tiers.3");
    expect(refusal({ ...valid, outage: { from: 0, to: 1, at: 0 } })).toBe("$.outage.at");
  });

  it("reads only the object's own fields, never inherited ones", () => {
    expect(refusal(Object.create(valid))).toBe("$.voters");
    const t = Object.create({ offline: [9] });
    Object.assign(t, { panel: 5, threshold: 3 });
    expect(parseScenario({ ...valid, trustees: t })).toMatchObject({ ok: true });
    expect(refusal({ ...valid, tiers: Object.create({ "0": 1 }) })).toBe("$.tiers");
    const { outage: _, ...noOutage } = valid;
    const inherited = Object.assign(Object.create({ outage: { from: 0, to: 1 } }), noOutage);
    expect(parseScenario(inherited)).toMatchObject({ ok: true, scenario: { outage: null } });
    const { challenges: __, ...noChallenges } = valid;
    const inheritedShare = Object.assign(Object.create({ challenges: 1 }), noChallenges);
    expect(parseScenario(inheritedShare)).toMatchObject({ ok: true, scenario: { challenges: 0 } });
    const { revotes: ___, ...noRevotes } = valid;
    const inheritedRevotes = Object.assign(Object.create({ revotes: 1 }), noRevotes);
    expect(parseScenario(inheritedRevotes)).toMatchObject({ ok: true, scenario: { revotes: 0 } });
    const { publications: ____, ...noPublications } = valid;
    const inheritedPublications = Object.assign(Object.create({ publications: 1 }), noPublications);
    expect(parseScenario(inheritedPublications)).toMatchObject({
      ok: true,
      scenario: { publications: 0 },
    });
    const { postings: _____, ...noPostings } = valid;
    const inheritedPostings = Object.assign(Object.create({ postings: 1 }), noPostings);
    expect(parseScenario(inheritedPostings)).toMatchObject({ ok: true, scenario: { postings: 0 } });
  });

  it("refuses missing required fields", () => {
    for (const k of ["voters", "election", "options", "trustees", "tiers", "seed"]) {
      const o: Record<string, unknown> = { ...valid };
      delete o[k];
      expect(refusal(o)).toBe(`$.${k}`);
    }
  });

  it("refuses values out of range, non-integers and wrong types", () => {
    expect(refusal({ ...valid, voters: 0 })).toBe("$.voters");
    expect(refusal({ ...valid, voters: MAX_SIMULATED_VOTERS + 1 })).toBe("$.voters");
    expect(refusal({ ...valid, voters: 1.5 })).toBe("$.voters");
    expect(refusal({ ...valid, voters: "100" })).toBe("$.voters");
    expect(refusal({ ...valid, election: "ranked" })).toBe("$.election");
    expect(refusal({ ...valid, options: 1 })).toBe("$.options");
    expect(refusal({ ...valid, options: 65 })).toBe("$.options");
    expect(refusal({ ...valid, trustees: { panel: 17, threshold: 2 } })).toBe("$.trustees.panel");
    expect(refusal({ ...valid, trustees: { panel: 5, threshold: 6 } })).toBe(
      "$.trustees.threshold",
    );
    expect(refusal({ ...valid, trustees: { panel: 5, threshold: 1 } })).toBe(
      "$.trustees.threshold",
    );
    expect(refusal({ ...valid, seed: -1 })).toBe("$.seed");
    expect(refusal({ ...valid, seed: 2 ** 32 })).toBe("$.seed");
    expect(refusal({ ...valid, tiers: { "0": -1, "1": 1 } })).toBe("$.tiers.0");
    expect(refusal({ ...valid, outage: { from: -0.1, to: 1 } })).toBe("$.outage.from");
    expect(refusal({ ...valid, challenges: -0.1 })).toBe("$.challenges");
    expect(refusal({ ...valid, challenges: 1.1 })).toBe("$.challenges");
    expect(refusal({ ...valid, challenges: "0.5" })).toBe("$.challenges");
    expect(refusal({ ...valid, challenges: null })).toBe("$.challenges");
    expect(refusal({ ...valid, revotes: -0.1 })).toBe("$.revotes");
    expect(refusal({ ...valid, revotes: 1.1 })).toBe("$.revotes");
    expect(refusal({ ...valid, revotes: "0.5" })).toBe("$.revotes");
    expect(refusal({ ...valid, revotes: null })).toBe("$.revotes");
    expect(refusal({ ...valid, publications: -0.1 })).toBe("$.publications");
    expect(refusal({ ...valid, publications: 1.1 })).toBe("$.publications");
    expect(refusal({ ...valid, publications: "0.5" })).toBe("$.publications");
    expect(refusal({ ...valid, publications: null })).toBe("$.publications");
    expect(refusal({ ...valid, postings: -0.1 })).toBe("$.postings");
    expect(refusal({ ...valid, postings: 1.1 })).toBe("$.postings");
    expect(refusal({ ...valid, postings: "1" })).toBe("$.postings");
    expect(refusal({ ...valid, postings: null })).toBe("$.postings");
    expect(refusal({ ...valid, outage: { from: 0, to: 1.1 } })).toBe("$.outage.to");
    expect(refusal({ ...valid, outage: { from: 0, to: Number.NaN } })).toBe("$.outage.to");
    expect(refusal([])).toBe("$");
    expect(refusal(null)).toBe("$");
  });

  it("refuses seats outside the panel, repeated or out of order, and a seat both offline and faulty", () => {
    const t = (trustees: object) =>
      refusal({ ...valid, trustees: { panel: 5, threshold: 3, ...trustees } });
    expect(t({ offline: [6] })).toBe("$.trustees.offline[0]");
    expect(t({ offline: [0] })).toBe("$.trustees.offline[0]");
    expect(t({ offline: [2, 2] })).toBe("$.trustees.offline");
    expect(t({ offline: [3, 2] })).toBe("$.trustees.offline");
    expect(t({ faulty: [1], offline: [1] })).toBe("$.trustees.faulty");
    expect(t({ offline: 2 })).toBe("$.trustees.offline");
    expect(t({ offline: null })).toBe("$.trustees.offline");
    // oxlint-disable-next-line no-sparse-arrays -- the hole is the input under test
    expect(t({ offline: [1, , 3] })).toBe("$.trustees.offline[1]");
    expect(t({ faulty: null })).toBe("$.trustees.faulty");
  });

  it("refuses a scenario whose voters × options × panel, doubled with re-votes, exceeds the work bound", () => {
    const at = {
      ...valid,
      revotes: 0,
      publications: 0,
      voters: MAX_SIMULATED_WORK / 50,
      options: 5,
      trustees: { panel: 10, threshold: 2 },
    };
    expect(parseScenario(at).ok).toBe(true);
    expect(refusal({ ...at, voters: at.voters + 1 })).toBe("$");
    // Any positive re-vote share counts two ballots per voter.
    expect(refusal({ ...at, revotes: Number.MIN_VALUE })).toBe("$");
    expect(parseScenario({ ...at, voters: at.voters / 2, revotes: 1 }).ok).toBe(true);
    expect(refusal({ ...at, voters: at.voters / 2 + 1, revotes: 1 })).toBe("$");
    expect(
      refusal({
        ...valid,
        voters: MAX_SIMULATED_VOTERS,
        options: 2,
        trustees: { panel: 16, threshold: 2 },
      }),
    ).toBe("$");
  });

  it("refuses published openings whose voters × ballots × options exceeds the opening bound", () => {
    // 1,000 voters casting once at 10 options: exactly the bound.
    const at = { ...valid, voters: 1000, options: 10, revotes: 0, challenges: 0.1 };
    expect(MAX_SIMULATED_OPENING_LOOKUPS).toBe(1000 * 1000 * 10);
    expect(parseScenario(at).ok).toBe(true);
    expect(refusal({ ...at, voters: 1001 })).toBe("$");
    // Re-votes double the ballots each opening is compared with.
    expect(refusal({ ...at, revotes: Number.MIN_VALUE })).toBe("$");
    // Without publishing, or without challenges, nothing is published: no bound.
    expect(parseScenario({ ...at, voters: 1001, publications: 0 }).ok).toBe(true);
    expect(parseScenario({ ...at, voters: 1001, challenges: 0 }).ok).toBe(true);
  });

  it("refuses an empty electorate and an empty or reversed outage", () => {
    expect(refusal({ ...valid, tiers: { "0": 0 } })).toBe("$.tiers");
    expect(refusal({ ...valid, tiers: {} })).toBe("$.tiers");
    expect(refusal({ ...valid, outage: { from: 0.5, to: 0.5 } })).toBe("$.outage");
    expect(refusal({ ...valid, outage: { from: 0.6, to: 0.5 } })).toBe("$.outage");
  });
});
