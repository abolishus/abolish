import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import {
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
  fc.record({
    voters: fc.integer({ min: 1, max: Math.floor(MAX_SIMULATED_WORK / (64 * panel)) }),
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
    seed: fc.integer({ min: 0, max: 0xffff_ffff }),
  }),
);

const valid: Scenario = {
  voters: 100,
  election: "plurality",
  options: 3,
  trustees: { panel: 7, threshold: 4, offline: [2, 5], faulty: [] },
  tiers: { "0": 50, "1": 30, "2": 20 },
  outage: { from: 0.5, to: 1 },
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

  it("defaults only the optional fields: no outage, no offline or faulty seats, missing tiers at 0", () => {
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
    const inherited = Object.assign(Object.create({ outage: { from: 0, to: 1 } }), valid, {
      outage: undefined,
    });
    delete inherited.outage;
    expect(parseScenario(inherited)).toMatchObject({ ok: true, scenario: { outage: null } });
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
    expect(t({ faulty: null })).toBe("$.trustees.faulty");
  });

  it("refuses a scenario whose voters × options × panel exceeds the work bound", () => {
    const at = {
      ...valid,
      voters: MAX_SIMULATED_WORK / 50,
      options: 5,
      trustees: { panel: 10, threshold: 2 },
    };
    expect(parseScenario(at).ok).toBe(true);
    expect(refusal({ ...at, voters: at.voters + 1 })).toBe("$");
    expect(
      refusal({
        ...valid,
        voters: MAX_SIMULATED_VOTERS,
        options: 2,
        trustees: { panel: 16, threshold: 2 },
      }),
    ).toBe("$");
  });

  it("refuses an empty electorate and an empty or reversed outage", () => {
    expect(refusal({ ...valid, tiers: { "0": 0 } })).toBe("$.tiers");
    expect(refusal({ ...valid, tiers: {} })).toBe("$.tiers");
    expect(refusal({ ...valid, outage: { from: 0.5, to: 0.5 } })).toBe("$.outage");
    expect(refusal({ ...valid, outage: { from: 0.6, to: 0.5 } })).toBe("$.outage");
  });
});
