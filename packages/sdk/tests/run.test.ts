import { describe, expect, it } from "vite-plus/test";
import {
  downAt,
  MAX_INTAKE_WORKERS,
  planElection,
  runSimulation,
  type Scenario,
  SIMULATION_STUBS,
  type SimulationReport,
} from "../src/index.ts";
import { type CellExpectation, expectCells, judgeCell } from "../src/simulation/run.ts";

// Each ballot costs about 0.1 s per online seat (intake checks its proofs).
const timeout = 60_000;

const base: Scenario = {
  voters: 9,
  election: "plurality",
  options: 3,
  trustees: { panel: 4, threshold: 2, offline: [2], faulty: [], departures: [] },
  tiers: { "0": 2, "1": 1, "2": 1 },
  outage: { from: 0.5, to: 1 },
  challenges: 0,
  revotes: 0,
  publications: 0,
  postings: 1,
  reorgs: 0,
  seed: 3,
};

describe("runSimulation", { timeout }, () => {
  it("opens every cell to the plan's counts with offline seats below the margin, and verifies each opening", async () => {
    const progress: string[] = [];
    const r = await runSimulation(base, { onProgress: (p) => progress.push(p.stage) });
    expect(r.ok).toBe(true);
    expect(r.ballots.cast).toBe(9);
    expect(r.ballots.server + r.ballots.direct).toBe(9);
    expect(r.ballots.direct).toBeGreaterThan(0);
    expect(r.ballots.challenged).toBe(0);
    expect(r.ballots.published).toBe(0);
    expect(r.ballots.superseded).toBe(0);
    // The ceremony transcript first, then every ballot, direct ones when the
    // servers return, each followed by each online seat's share receipt;
    // then an opening per cell and a destruction statement per online seat.
    expect(r.board.shareReceipts).toBe(9 * 3);
    expect(r.board.counted).toBe(1 + 9 + 9 * 3);
    expect(r.board.openings).toBe(3);
    expect(r.board.spoiled).toBe(0);
    expect(r.board.entries).toBe(1 + 9 + 9 * 3 + 3 + 3);
    // Every voter posts the offline seat, so every ballot is delivered.
    expect(r.ballots.postings).toBe(9);
    expect(r.ballots.undelivered).toBe(0);
    expect(r.board.head).toMatch(/^[0-9a-f]{64}$/);
    expect(r.board.receiptKey).toMatch(/^0[23][0-9a-f]{64}$/);
    // Anchored: each period that added entries once, in order, the last
    // before the seal's being the destruction statements', then the seal's,
    // which holds the whole board; each in the first block after its period.
    const { anchors, seal } = r.board;
    expect(anchors.at(-1)).toMatchObject({ segment: seal, size: r.board.entries });
    expect(anchors.at(-2)?.size).toBe(r.board.entries);
    for (const [i, a] of anchors.entries()) {
      expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(a.anchoredAt).toBe((a.segment + 1) * 3600 + 12);
      if (i > 0) {
        const before = anchors[i - 1] as (typeof anchors)[number];
        expect(a.segment).toBeGreaterThan(before.segment);
        expect(a.size > before.size || a.segment === seal).toBe(true);
      }
    }
    // The counted extent's last anchor holds every ballot and share receipt.
    expect(anchors.filter((a) => a.size === r.board.counted)).toHaveLength(1);
    // Each online seat seals its sums for each cell to each other online seat.
    expect(r.trustees).toEqual({
      online: [1, 3, 4],
      offline: [2],
      departed: [],
      faulty: [],
      summedShareMessages: 3 * 2 * 3,
    });
    expect(r.cells.map((c) => c.tier)).toEqual([0, 1, 2]);
    for (const c of r.cells) {
      expect(c.outcome).toBe("opened");
      expect(c.counts).toEqual(c.expected);
      expect(c.combined).toEqual([1, 3]);
      expect(c.verified).toBe(true);
    }
    expect(r.cells.reduce((a, c) => a + c.ballots, 0)).toBe(9);
    expect(r.total?.reduce((a, x) => a + x, 0)).toBe(9);
    // Every cell opened, so the destruction segment follows the openings'.
    expect(r.destruction.seats).toEqual([
      { seat: 1, code: "destroyed", at: 0 },
      { seat: 2, code: "destruction-missing" },
      { seat: 3, code: "destroyed", at: 1 },
      { seat: 4, code: "destroyed", at: 2 },
    ]);
    expect(r.stubs).toEqual(SIMULATION_STUBS);
    expect(progress.filter((s) => s === "cast")).toHaveLength(9);
    expect(progress.filter((s) => s === "tally")).toHaveLength(3);
  });

  it("excludes faulty seats' summed shares and still opens from k honest seats", async () => {
    const r = await runSimulation({
      ...base,
      election: "approval",
      trustees: { panel: 4, threshold: 2, offline: [4], faulty: [1], departures: [] },
    });
    expect(r.ok).toBe(true);
    for (const c of r.cells) {
      expect(c.excluded).toEqual([1]);
      expect(c.combined).toEqual([2, 3]);
      expect(c.counts).toEqual(c.expected);
    }
    // The faulty seat's own check refuses to seal its lie, so only the two
    // honest seats send, each to the two other online seats.
    expect(r.trustees).toEqual({
      online: [1, 2, 3],
      offline: [4],
      departed: [],
      faulty: [1],
      summedShareMessages: 2 * 2 * 3,
    });
    // A faulty seat still states destruction: it lies only in its summed shares.
    expect(r.destruction.seats.map((d) => d.code)).toEqual([
      "destroyed",
      "destroyed",
      "destroyed",
      "destruction-missing",
    ]);
  });

  it("reports tally-quorum, as expected, when fewer than k honest seats remain", async () => {
    // Published openings still land after the counted extent, with no tally
    // opening in their segment, and before destruction at t_D.
    const r = await runSimulation({
      ...base,
      challenges: 1,
      publications: 1,
      trustees: { panel: 4, threshold: 2, offline: [1, 2], faulty: [3], departures: [] },
    });
    expect(r.ok).toBe(true);
    for (const c of r.cells) {
      expect(c.expectedOutcome).toBe("tally-quorum");
      expect(c.outcome).toBe("tally-quorum");
      expect(c.excluded).toEqual([3]);
      expect(c.counts).toBeUndefined();
    }
    // Seat 4 alone sends, to seat 3, which is faulty and never combines.
    expect(r.trustees.summedShareMessages).toBe(3);
    expect(r.total).toBeUndefined();
    // No opening reaches the board, so the online seats destroy at t_D, in s_T.
    expect(r.board.openings).toBe(0);
    expect(r.board.spoiled).toBe(9);
    expect(r.board.entries).toBe(1 + 9 + 9 * 2 + 9 + 2);
    expect(r.ballots.postings).toBe(9 * 2);
    const ran = await runSimulation(base);
    expect(r.destruction.from).toBeGreaterThan(ran.destruction.from + 100);
    expect(r.destruction.seats.map((d) => d.code)).toEqual([
      "destruction-missing",
      "destruction-missing",
      "destroyed",
      "destroyed",
    ]);
  });

  it("reports tally-quorum with every online seat excluded when every online seat is faulty", async () => {
    const r = await runSimulation({
      ...base,
      trustees: { panel: 4, threshold: 2, offline: [4], faulty: [1, 2, 3], departures: [] },
    });
    expect(r.ok).toBe(true);
    expect(r.trustees.summedShareMessages).toBe(0);
    expect(r.board.openings).toBe(0);
    for (const c of r.cells) {
      expect(c.outcome).toBe("tally-quorum");
      expect(c.excluded).toEqual([1, 2, 3]);
    }
  });

  it("checks every challenged attempt's opening, then casts a fresh one that still opens to the plan", async () => {
    const r = await runSimulation({ ...base, challenges: 1 });
    expect(r.ok).toBe(true);
    expect(r.ballots.challenged).toBe(9);
    expect(r.cells.reduce((a, c) => a + c.ballots, 0)).toBe(9);
    for (const c of r.cells) expect(c.counts).toEqual(c.expected);
  });

  it("boards every opening its voter publishes after the counted extent, and still opens to the plan", async () => {
    // Re-votes put superseded ballots in the counted extent, which every
    // opening is compared with too.
    const r = await runSimulation({ ...base, challenges: 1, publications: 1, revotes: 1 });
    expect(r.ok).toBe(true);
    expect(r.ballots.challenged).toBe(9);
    expect(r.ballots.published).toBe(9);
    expect(r.board.spoiled).toBe(9);
    expect(r.board.counted).toBe(1 + 18 + 18 * 3);
    expect(r.board.entries).toBe(1 + 18 + 18 * 3 + 3 + 9 + 3);
    for (const c of r.cells) expect(c.counts).toEqual(c.expected);
    // Publishing is the voter's choice: only those who asked.
    const some = await runSimulation({ ...base, challenges: 1, publications: 0.5 });
    const asked = planElection({ ...base, challenges: 1, publications: 0.5 }).voters.filter(
      (v) => v.published,
    ).length;
    expect(asked).toBeGreaterThan(0);
    expect(asked).toBeLessThan(9);
    expect(some.ballots.published).toBe(asked);
    expect(some.board.spoiled).toBe(asked);
  });

  it("counts only each re-voter's last ballot, whatever it voted before", async () => {
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
    const r = await runSimulation(s, { onProgress: (p) => progress.push(p.stage) });
    expect(r.ok).toBe(true);
    expect(r.ballots.cast).toBe(18);
    expect(r.ballots.superseded).toBe(9);
    expect(r.board.counted).toBe(1 + 18 + 18 * 3);
    // Every ballot is posted, superseded ones included.
    expect(r.ballots.postings).toBe(18);
    expect(r.ballots.server + r.ballots.direct).toBe(18);
    expect(progress.filter((s) => s === "cast")).toHaveLength(18);
    expect(r.cells.reduce((a, c) => a + c.ballots, 0)).toBe(9);
    for (const c of r.cells) expect(c.counts).toEqual(c.expected);
  });

  it("counts nothing from a voter who declines to post an offline seat, and opens the rest to the plan", async () => {
    // Every voter declines: every ballot lacks the offline seat, so none counts.
    const none = await runSimulation({ ...base, postings: 0 });
    expect(none.ok).toBe(true);
    expect(none.ballots.postings).toBe(0);
    expect(none.ballots.undelivered).toBe(9);
    for (const c of none.cells) {
      expect(c.ballots).toBe(0);
      expect(c.counts).toEqual([0, 0, 0]);
    }
    // Some decline: only those who posted count.
    const s = { ...base, postings: 0.5 };
    const declined = planElection(s).voters.filter((v) => !v.delivered).length;
    expect(declined).toBeGreaterThan(0);
    expect(declined).toBeLessThan(9);
    const some = await runSimulation(s);
    expect(some.ok).toBe(true);
    expect(some.ballots.postings).toBe(9 - declined);
    expect(some.ballots.undelivered).toBe(declined);
    expect(some.cells.reduce((a, c) => a + c.ballots, 0)).toBe(9 - declined);
    for (const c of some.cells) expect(c.counts).toEqual(c.expected);
  });

  it("counts nothing for a re-voter whose last ballot is undelivered, though its earlier one was posted", async () => {
    const s = { ...base, revotes: 1, postings: 0.5 };
    const voters = planElection(s).voters;
    const stranded = voters.filter((v) => v.earlier?.posts === true && !v.posts).length;
    expect(stranded).toBeGreaterThan(0);
    const r = await runSimulation(s);
    expect(r.ok).toBe(true);
    expect(r.ballots.undelivered).toBe(voters.filter((v) => !v.delivered).length);
    expect(r.cells.reduce((a, c) => a + c.ballots, 0)).toBe(9 - r.ballots.undelivered);
    for (const c of r.cells) expect(c.counts).toEqual(c.expected);
  });

  it("needs no posting when every seat is online, whatever the voters would choose", async () => {
    const r = await runSimulation({
      ...base,
      voters: 4,
      postings: 0,
      trustees: { panel: 3, threshold: 2, offline: [], faulty: [], departures: [] },
    });
    expect(r.ok).toBe(true);
    expect(r.ballots.postings).toBe(0);
    expect(r.ballots.undelivered).toBe(0);
    expect(r.board.shareReceipts).toBe(4 * 3);
    expect(r.cells.reduce((a, c) => a + c.ballots, 0)).toBe(4);
  });

  it("takes a departing seat's receipts until it goes down, counts later ballots only when posted, and leaves it out of the tally", async () => {
    // Seat 3 goes down during the outage, so it takes some direct ballots,
    // whose receipts are boarded when the servers return, and misses the rest.
    const s: Scenario = {
      ...base,
      outage: { from: 0.2, to: 0.6 },
      postings: 0.5,
      trustees: {
        panel: 4,
        threshold: 2,
        offline: [],
        faulty: [],
        departures: [{ seat: 3, at: 0.3 }],
      },
    };
    const plan = planElection(s);
    const before = plan.voters.filter((v) => v.at < 0.3);
    const after = plan.voters.filter((v) => v.at >= 0.3);
    expect(before.some((v) => v.path === "direct")).toBe(true);
    expect(after.some((v) => v.path === "direct" && !v.posts)).toBe(true);
    expect(after.some((v) => v.path === "server" && v.posts)).toBe(true);
    const r = await runSimulation(s);
    expect(r.ok).toBe(true);
    expect(r.board.shareReceipts).toBe(before.length * 4 + after.length * 3);
    expect(r.ballots.postings).toBe(after.filter((v) => v.posts).length);
    expect(r.ballots.undelivered).toBe(after.filter((v) => !v.posts).length);
    expect(r.trustees).toMatchObject({ online: [1, 2, 4], offline: [], departed: [3] });
    for (const c of r.cells) {
      expect(c.outcome).toBe("opened");
      expect(c.counts).toEqual(c.expected);
      expect(c.combined).toEqual([1, 2]);
    }
    expect(r.cells.reduce((a, c) => a + c.ballots, 0)).toBe(
      before.length + after.filter((v) => v.posts).length,
    );
    expect(r.destruction.seats.map((d) => d.code)).toEqual([
      "destroyed",
      "destroyed",
      "destruction-missing",
      "destroyed",
    ]);
  });

  it("judges each ballot by the seats down at its own cast when a re-voter crosses a departure", async () => {
    const s: Scenario = {
      ...base,
      revotes: 1,
      postings: 0.5,
      trustees: {
        panel: 4,
        threshold: 2,
        offline: [2],
        faulty: [],
        departures: [{ seat: 3, at: 0.5 }],
      },
    };
    const voters = planElection(s).voters;
    const casts = voters.flatMap((v) => (v.earlier === null ? [v] : [v.earlier, v]));
    // A voter whose earlier ballot went to seat 3 and whose last, unposted, didn't.
    expect(
      voters.some((v) => v.earlier !== null && v.earlier.at < 0.5 && v.at >= 0.5 && !v.posts),
    ).toBe(true);
    const r = await runSimulation(s);
    expect(r.ok).toBe(true);
    expect(r.board.shareReceipts).toBe(casts.reduce((a, b) => a + 4 - downAt(s, b.at).length, 0));
    expect(r.ballots.postings).toBe(
      casts.filter((b) => b.posts).reduce((a, b) => a + downAt(s, b.at).length, 0),
    );
    expect(r.ballots.undelivered).toBe(voters.filter((v) => !v.delivered).length);
    for (const c of r.cells) expect(c.counts).toEqual(c.expected);
  });

  it("needs no posting from a seat that departs at close, which still misses the tally and destruction", async () => {
    const s: Scenario = {
      ...base,
      postings: 0,
      revotes: 1,
      trustees: {
        panel: 3,
        threshold: 2,
        offline: [],
        faulty: [],
        departures: [{ seat: 1, at: 1 }],
      },
    };
    const r = await runSimulation(s);
    expect(r.ok).toBe(true);
    expect(r.ballots.cast).toBe(18);
    expect(r.board.shareReceipts).toBe(18 * 3);
    expect(r.ballots.postings).toBe(0);
    expect(r.ballots.undelivered).toBe(0);
    for (const c of r.cells) {
      expect(c.counts).toEqual(c.expected);
      expect(c.combined).toEqual([2, 3]);
    }
    expect(r.cells.reduce((a, c) => a + c.ballots, 0)).toBe(9);
    expect(r.destruction.seats.map((d) => d.code)).toEqual([
      "destruction-missing",
      "destroyed",
      "destroyed",
    ]);
  });

  it("reports tally-quorum, as expected, when departures leave fewer than k seats", async () => {
    const s: Scenario = {
      ...base,
      voters: 4,
      trustees: {
        panel: 3,
        threshold: 2,
        offline: [],
        faulty: [],
        departures: [
          { seat: 1, at: 0.3 },
          { seat: 3, at: 0.6 },
        ],
      },
    };
    const plan = planElection(s);
    const r = await runSimulation(s);
    expect(r.ok).toBe(true);
    expect(r.ballots.postings).toBe(
      plan.voters.filter((v) => v.posts).reduce((a, v) => a + downAt(s, v.at).length, 0),
    );
    expect(r.trustees.summedShareMessages).toBe(0);
    for (const c of r.cells) {
      expect(c.expectedOutcome).toBe("tally-quorum");
      expect(c.outcome).toBe("tally-quorum");
    }
  });

  it("opens an empty cell to zero", async () => {
    const r = await runSimulation({
      ...base,
      voters: 1,
      tiers: { "0": 1, "1": 0, "2": 1 },
      seed: 0,
    });
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
        trustees: { panel: 7, threshold: 3, offline: [1, 4], faulty: [2, 7], departures: [] },
      }),
    ).toEqual({ outcome: "opened", excluded: [2, 7], combined: [3, 5, 6] });
    expect(
      expectCells({
        ...base,
        trustees: { panel: 4, threshold: 3, offline: [1], faulty: [2], departures: [] },
      }),
    ).toEqual({ outcome: "tally-quorum", excluded: [2], combined: [3, 4] });
    // A departed seat sums nothing, however late it went down.
    expect(
      expectCells({
        ...base,
        trustees: {
          panel: 5,
          threshold: 2,
          offline: [1],
          faulty: [],
          departures: [{ seat: 2, at: 1 }],
        },
      }),
    ).toEqual({ outcome: "opened", excluded: [], combined: [3, 4] });
  });
});

describe("runSimulation under L1 reorganisations", { timeout }, () => {
  // The first seed whose plan has a voter whose block is finalized after
  // close, so it can't cast again (docs/spec/revoting.md, Residuals).
  const lostSeed = (s: Scenario) => {
    for (let seed = 0; ; seed++)
      if (planElection({ ...s, seed }).voters.some((v) => v.reorg?.recast === null)) return seed;
  };

  it("rejects each ballot naming a reorganised block, counts its recast with the first cast's receipts, and opens to the plan", async () => {
    const s = { ...base, reorgs: 1 };
    const plan = planElection(s);
    const recast = plan.voters.filter((v) => v.reorg?.recast != null);
    expect(recast.length).toBe(9);
    // Some recasts go through our servers, some directly during the outage.
    expect(recast.some((v) => v.reorg?.recast?.path === "direct")).toBe(true);
    expect(recast.some((v) => v.reorg?.recast?.path === "server")).toBe(true);
    const r = await runSimulation(s);
    expect(r.ok).toBe(true);
    expect(r.ballots).toMatchObject({
      cast: 18,
      reorged: 9,
      recast: 9,
      superseded: 0,
      postings: 9,
      undelivered: 0,
    });
    expect(r.ballots.server + r.ballots.direct).toBe(18);
    // Nothing goes to the trustees again: one share receipt per online seat per first cast.
    expect(r.board.shareReceipts).toBe(9 * 3);
    expect(r.board.counted).toBe(1 + 18 + 9 * 3);
    expect(r.cells.reduce((a, c) => a + c.ballots, 0)).toBe(9);
    for (const c of r.cells) expect(c.counts).toEqual(c.expected);
  });

  it("selects a re-voter's earlier ballot when its last is lost to a reorganisation near close", async () => {
    const s = {
      ...base,
      revotes: 1,
      reorgs: 1,
      seed: lostSeed({ ...base, revotes: 1, reorgs: 1 }),
    };
    const plan = planElection(s);
    const lost = plan.voters.filter((v) => v.reorg?.recast === null);
    expect(lost.length).toBeGreaterThan(0);
    expect(lost.every((v) => v.selected === "earlier")).toBe(true);
    const r = await runSimulation(s);
    expect(r.ok).toBe(true);
    expect(r.ballots.reorged).toBe(9);
    expect(r.ballots.recast).toBe(9 - lost.length);
    // Every earlier ballot but the lost voters' is superseded.
    expect(r.ballots.superseded).toBe(9 - lost.length);
    expect(r.ballots.cast).toBe(9 * 2 + 9 - lost.length);
    expect(r.cells.reduce((a, c) => a + c.ballots, 0)).toBe(9);
    for (const c of r.cells) expect(c.counts).toEqual(c.expected);
  });

  it("counts nothing for a voter casting once whose ballot is lost to a reorganisation near close", async () => {
    const s = { ...base, reorgs: 1, seed: lostSeed({ ...base, reorgs: 1 }) };
    const lost = planElection(s).voters.filter((v) => v.reorg?.recast === null);
    expect(lost.length).toBeGreaterThan(0);
    expect(lost.every((v) => v.selected === null)).toBe(true);
    const r = await runSimulation(s);
    expect(r.ok).toBe(true);
    expect(r.ballots.reorged).toBe(9);
    expect(r.ballots.recast).toBe(9 - lost.length);
    expect(r.ballots.superseded).toBe(0);
    expect(r.cells.reduce((a, c) => a + c.ballots, 0)).toBe(9 - lost.length);
    for (const c of r.cells) expect(c.counts).toEqual(c.expected);
  });

  it("keeps a recast undelivered when its first cast was: the receipts and postings are the first cast's", async () => {
    const s = { ...base, reorgs: 1, postings: 0.5 };
    const voters = planElection(s).voters;
    expect(voters.some((v) => v.reorg?.recast != null && !v.delivered)).toBe(true);
    const r = await runSimulation(s);
    expect(r.ok).toBe(true);
    expect(r.ballots.undelivered).toBe(
      voters.filter((v) => v.selected === "last" && !v.delivered).length,
    );
    for (const c of r.cells) expect(c.counts).toEqual(c.expected);
  });
});

describe("runSimulation with intake in worker threads", { timeout }, () => {
  // What a run reports apart from its fresh keys and hashes.
  const outcome = (r: SimulationReport) => ({
    ok: r.ok,
    ballots: r.ballots,
    board: {
      ...r.board,
      head: undefined,
      receiptKey: undefined,
      anchors: r.board.anchors.map((a) => ({ ...a, hash: undefined })),
    },
    trustees: r.trustees,
    cells: r.cells,
    destruction: r.destruction,
    total: r.total,
  });

  it("reports what the same scenario reports in the calling thread, with every stage in play", async () => {
    // Challenges, publications, re-votes, reorganisations, an offline seat,
    // a departure, a faulty seat, an outage and partial postings: each cast
    // finished in its order while later ballots' intake runs ahead.
    const s: Scenario = {
      ...base,
      voters: 12,
      trustees: {
        panel: 5,
        threshold: 2,
        offline: [2],
        faulty: [5],
        departures: [{ seat: 4, at: 0.6 }],
      },
      challenges: 0.5,
      publications: 1,
      revotes: 0.5,
      reorgs: 0.5,
      postings: 0.7,
    };
    const progress: number[] = [];
    const inWorkers = await runSimulation(s, {
      workers: 3,
      onProgress: (p) => {
        if (p.stage === "cast") progress.push(p.done);
      },
    });
    const inThread = await runSimulation(s);
    expect(inWorkers.ok).toBe(true);
    expect(outcome(inWorkers)).toEqual(outcome(inThread));
    // The comparison covers each of them.
    const { challenged, published, superseded, reorged, direct, postings, undelivered } =
      inThread.ballots;
    for (const n of [challenged, published, superseded, reorged, direct, postings, undelivered])
      expect(n).toBeGreaterThan(0);
    // One progress line per cast, in cast order.
    expect(progress).toEqual(Array.from({ length: inThread.ballots.cast }, (_, i) => i + 1));
  });

  it("refuses a worker count that isn't an integer from 0 to the maximum, before running", async () => {
    for (const workers of [-1, 1.5, Number.NaN, MAX_INTAKE_WORKERS + 1])
      await expect(runSimulation(base, { workers })).rejects.toThrow(RangeError);
  });
});
