import { describe, expect, it } from "vite-plus/test";

// Each ballot costs about 0.1 s per online seat (intake checks its proofs).
const timeout = 60_000;
import { runSimulation, type Scenario, SIMULATION_STUBS } from "../src/index.ts";

const base: Scenario = {
  voters: 9,
  election: "plurality",
  options: 3,
  trustees: { panel: 4, threshold: 2, offline: [2], faulty: [] },
  tiers: { "0": 2, "1": 1, "2": 1 },
  outage: { from: 0.5, to: 1 },
  seed: 3,
};

describe("runSimulation", { timeout }, () => {
  it("opens every cell to the plan's counts with offline seats below the margin, and verifies each opening", () => {
    const progress: string[] = [];
    const r = runSimulation(base, { onProgress: (p) => progress.push(p.stage) });
    expect(r.ok).toBe(true);
    expect(r.ballots.cast).toBe(9);
    expect(r.ballots.server + r.ballots.direct).toBe(9);
    expect(r.ballots.direct).toBeGreaterThan(0);
    expect(r.trustees).toEqual({ online: [1, 3, 4], offline: [2], faulty: [] });
    expect(r.cells.map((c) => c.tier)).toEqual([0, 1, 2]);
    for (const c of r.cells) {
      expect(c.outcome).toBe("opened");
      expect(c.counts).toEqual(c.expected);
      expect(c.combined).toEqual([1, 3]);
      expect(c.verified).toBe(true);
    }
    expect(r.cells.reduce((a, c) => a + c.ballots, 0)).toBe(9);
    expect(r.total?.reduce((a, x) => a + x, 0)).toBe(9);
    expect(r.stubs).toEqual(SIMULATION_STUBS);
    expect(progress.filter((s) => s === "cast")).toHaveLength(9);
    expect(progress.filter((s) => s === "tally")).toHaveLength(3);
  });

  it("excludes faulty seats' summed shares and still opens from k honest seats", () => {
    const r = runSimulation({
      ...base,
      election: "approval",
      trustees: { panel: 4, threshold: 2, offline: [4], faulty: [1] },
    });
    expect(r.ok).toBe(true);
    for (const c of r.cells) {
      expect(c.excluded).toEqual([1]);
      expect(c.combined).toEqual([2, 3]);
      expect(c.counts).toEqual(c.expected);
    }
    expect(r.trustees.online).toEqual([2, 3]);
  });

  it("reports tally-quorum, as expected, when fewer than k honest seats remain", () => {
    const r = runSimulation({
      ...base,
      trustees: { panel: 4, threshold: 2, offline: [1, 2], faulty: [3] },
    });
    expect(r.ok).toBe(true);
    for (const c of r.cells) {
      expect(c.expectedOutcome).toBe("tally-quorum");
      expect(c.outcome).toBe("tally-quorum");
      expect(c.excluded).toEqual([3]);
      expect(c.counts).toBeUndefined();
    }
    expect(r.total).toBeUndefined();
  });

  it("opens an empty cell to zero", () => {
    const r = runSimulation({ ...base, voters: 1, tiers: { "0": 1, "1": 0, "2": 1 }, seed: 0 });
    expect(r.ok).toBe(true);
    const empty = r.cells.find((c) => c.ballots === 0);
    expect(empty?.counts).toEqual([0, 0, 0]);
  });
});
