import { describe, expect, it } from "vite-plus/test";
import { planElection, runSimulation, type Scenario, SIMULATION_STUBS } from "../src/index.ts";
import { type CellExpectation, expectCells, judgeCell } from "../src/simulation/run.ts";

// Each ballot costs about 0.1 s per online seat (intake checks its proofs).
const timeout = 60_000;

const base: Scenario = {
  voters: 9,
  election: "plurality",
  options: 3,
  trustees: { panel: 4, threshold: 2, offline: [2], faulty: [] },
  tiers: { "0": 2, "1": 1, "2": 1 },
  outage: { from: 0.5, to: 1 },
  challenges: 0,
  revotes: 0,
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
    expect(r.ballots.challenged).toBe(0);
    expect(r.ballots.superseded).toBe(0);
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
    expect(r.trustees).toEqual({ online: [1, 2, 3], offline: [4], faulty: [1] });
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

  it("checks every challenged attempt's opening, then casts a fresh one that still opens to the plan", () => {
    const r = runSimulation({ ...base, challenges: 1 });
    expect(r.ok).toBe(true);
    expect(r.ballots.challenged).toBe(9);
    expect(r.cells.reduce((a, c) => a + c.ballots, 0)).toBe(9);
    for (const c of r.cells) expect(c.counts).toEqual(c.expected);
  });

  it("counts only each re-voter's last ballot, whatever it voted before", () => {
    const s = { ...base, revotes: 1, challenges: 0.5 };
    // Counting the earlier ballots instead would change some cell's counts.
    const plan = planElection(s);
    expect(
      plan.tiers.some((tier) => {
        const earlier = Array.from({ length: s.options }, (_, j) =>
          plan.voters
            .filter((v) => v.tier === tier)
            .reduce((a, v) => a + ((v.earlier ?? v).votes[j] as number), 0),
        );
        return earlier.join() !== plan.expected.get(tier)?.join();
      }),
    ).toBe(true);
    const progress: string[] = [];
    const r = runSimulation(s, { onProgress: (p) => progress.push(p.stage) });
    expect(r.ok).toBe(true);
    expect(r.ballots.cast).toBe(18);
    expect(r.ballots.superseded).toBe(9);
    expect(r.ballots.server + r.ballots.direct).toBe(18);
    expect(progress.filter((s) => s === "cast")).toHaveLength(18);
    expect(r.cells.reduce((a, c) => a + c.ballots, 0)).toBe(9);
    for (const c of r.cells) expect(c.counts).toEqual(c.expected);
  });

  it("opens an empty cell to zero", () => {
    const r = runSimulation({ ...base, voters: 1, tiers: { "0": 1, "1": 0, "2": 1 }, seed: 0 });
    expect(r.ok).toBe(true);
    const empty = r.cells.find((c) => c.ballots === 0);
    expect(empty?.counts).toEqual([0, 0, 0]);
  });
});

describe("judgeCell", () => {
  const cell = { tier: 0 as const, ballots: 5, expected: [2, 3] };
  const want: CellExpectation = { outcome: "opened", excluded: [4], combined: [1, 2] };
  const opened = {
    ok: true as const,
    counts: [2n, 3n],
    randomness: [0n, 0n],
    combined: [1, 2],
    excluded: [4],
  };

  it("matches only the expected opening, verified, with the expected seats", () => {
    expect(judgeCell(cell, want, opened, true).matches).toBe(true);
    expect(judgeCell(cell, want, opened, false).matches).toBe(false);
    expect(judgeCell(cell, want, { ...opened, counts: [3n, 2n] }, true).matches).toBe(false);
    // A lie the check let through, or an honest seat it refused.
    expect(judgeCell(cell, want, { ...opened, excluded: [] }, true).matches).toBe(false);
    expect(judgeCell(cell, want, { ...opened, excluded: [3, 4] }, true).matches).toBe(false);
    expect(judgeCell(cell, want, { ...opened, combined: [1, 4] }, true).matches).toBe(false);
    expect(judgeCell(cell, { ...want, outcome: "tally-quorum" }, opened, true).matches).toBe(false);
  });

  it("matches a failure only with the expected code and excluded seats", () => {
    const quorum = { ...want, outcome: "tally-quorum" as const };
    const failed = { ok: false as const, code: "tally-quorum" as const, excluded: [4] };
    expect(judgeCell(cell, quorum, failed, false)).toMatchObject({
      outcome: "tally-quorum",
      matches: true,
    });
    expect(judgeCell(cell, quorum, { ...failed, excluded: [] }, false).matches).toBe(false);
    expect(judgeCell(cell, quorum, { ...failed, code: "tally-opening" }, false).matches).toBe(
      false,
    );
    expect(judgeCell(cell, want, failed, false).matches).toBe(false);
  });

  it("expects the faulty seats excluded and the k lowest honest seats combined", () => {
    expect(
      expectCells({
        ...base,
        trustees: { panel: 7, threshold: 3, offline: [1, 4], faulty: [2, 7] },
      }),
    ).toEqual({ outcome: "opened", excluded: [2, 7], combined: [3, 5, 6] });
    expect(
      expectCells({ ...base, trustees: { panel: 4, threshold: 3, offline: [1], faulty: [2] } }),
    ).toEqual({ outcome: "tally-quorum", excluded: [2], combined: [3, 4] });
  });
});
