import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  chooseReleases,
  type CommittedVote,
  decideRelease,
  enteringBallot,
  leastDirectedCut,
  liveReleases,
  nextRunningSets,
  PARAMETERS,
  type ReleaseDecision,
  type ReleaseGraph,
  releaseGraph,
  runningChange,
  runningEntries,
  type RunningSet,
  runningSets,
  scheduledSnapshots,
  type SnapshotBallot,
} from "../src/index.ts";
import { SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/live-release.json comes from an independent Python
// implementation of docs/spec/tally.md, Live results
// (scripts/live-release-vectors.py), which computes every cut by maximum flow
// and by trying every vertex set, so these values never come from the code
// under test. Its nullifiers are a model: each ballot's admission, receipts
// and membership are given per snapshot, read here as Running set's
// conditions read them.

interface ModelBallot {
  readonly id: string;
  readonly cell: number;
  readonly ref: number;
  readonly admitted: number | null;
  readonly receipted: number | null;
  readonly delivered: boolean;
  readonly boarded?: number;
  readonly rejected?: number;
  readonly member?: boolean;
}

type Nullifiers = Readonly<Record<string, readonly ModelBallot[]>>;
type Sets = readonly Readonly<Record<string, string>>[];

interface Vectors {
  readonly format: string;
  readonly minLiveBatch: string;
  readonly schedules: readonly {
    readonly id: string;
    readonly epoch: string;
    readonly period: string;
    readonly opensAt: string;
    readonly closesAt: string;
    readonly liveEvery: number;
    readonly snapshotSegments: readonly number[];
  }[];
  readonly running: {
    readonly nullifiers: Nullifiers;
    readonly cells: readonly {
      readonly cell: number;
      readonly runningSets: Sets;
      readonly finalBallots: Readonly<Record<string, string>>;
    }[];
  };
  readonly graphs: readonly {
    readonly id: string;
    readonly runningSets: Sets;
    readonly edges: readonly (readonly [number, number, string])[];
    readonly changes: Readonly<Record<string, number>>;
    readonly minPairwiseChange: number;
    readonly directedCut: number | null;
    readonly cutWitness: { readonly set: readonly number[]; readonly side: string } | null;
    readonly combination: readonly number[] | null;
    readonly isolated: { readonly sign: number; readonly nullifiers: readonly string[] } | null;
  }[];
  readonly releases: readonly {
    readonly id: string;
    readonly batch: number;
    readonly cells: number;
    readonly snapshots: number;
    readonly nullifiers: Nullifiers;
    readonly runningSets: readonly Sets[];
    readonly decisions: readonly {
      readonly at: number;
      readonly release: number | null;
      readonly refused: Readonly<Record<string, string>>;
    }[];
    readonly releases: readonly number[];
    readonly finalBallots: Sets;
    readonly final: readonly {
      readonly cell: number;
      readonly finalCut: number | null;
      readonly witness: {
        readonly set: readonly number[];
        readonly side: string;
        readonly ballots: readonly string[];
      } | null;
    }[];
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("live-release.json", SPEC_VECTORS), "utf8"),
) as Vectors;

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const run = <T>(p: fc.IProperty<T>) => fc.assert(p, { numRuns });

// --- The model's ballots at a snapshot, as Running set reads them -----------

/** A ballot's admission at snapshot r, or absent before it is boarded. */
function status(b: ModelBallot, r: number): "absent" | SnapshotBallot<string>["admission"] {
  const boarded = b.boarded ?? b.admitted;
  if (boarded === null || boarded > r) return "absent";
  if (b.admitted !== null && b.admitted <= r) return "admitted";
  if (b.rejected !== undefined && b.rejected <= r) return "rejected";
  return "pending";
}

/** S_r's ballots per nullifier whose membership proof passes. */
function snapshotOf(nullifiers: Nullifiers, r: number): Map<string, SnapshotBallot<string>[]> {
  const out = new Map<string, SnapshotBallot<string>[]>();
  for (const [n, ballots] of Object.entries(nullifiers)) {
    const live: SnapshotBallot<string>[] = [];
    for (const b of ballots) {
      const admission = status(b, r);
      if (admission === "absent" || b.member === false) continue;
      live.push({
        ballot: b.id,
        cell: b.cell,
        admission,
        fullyReceipted: b.receipted !== null && b.receipted <= r,
      });
    }
    if (live.length > 0) out.set(n, live);
  }
  return out;
}

function setsOf(nullifiers: Nullifiers, cells: number, snapshots: number) {
  return runningSets(
    cells,
    Array.from({ length: snapshots }, (_, i) => snapshotOf(nullifiers, i + 1)),
  );
}

const plain = (s: RunningSet<string, string>) =>
  Object.fromEntries([...s].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

const mapOf = (o: Readonly<Record<string, string>>): RunningSet<string, string> =>
  new Map(Object.entries(o));

const asVector = (d: ReleaseDecision) => ({
  at: d.at,
  release: d.release,
  refused: Object.fromEntries([...d.refused].map(([q, why]) => [String(q), why])),
});

/** Every vertex set without vertex 0, both sides: the least positive cut, by search. */
function bruteCut<B>(g: ReleaseGraph<B>): number | null {
  let best: number | null = null;
  for (let mask = 1; mask < 1 << (g.vertices - 1); mask++) {
    const inU = (v: number) => v > 0 && ((mask >> (v - 1)) & 1) === 1;
    const enter = g.edges.filter((e) => !inU(e.from) && inU(e.to)).length;
    const leave = g.edges.filter((e) => inU(e.from) && !inU(e.to)).length;
    for (const x of [enter, leave]) if (x > 0 && (best === null || x < best)) best = x;
  }
  return best;
}

/** The edges a vertex set's side holds. */
function sideOf<B>(g: ReleaseGraph<B>, set: readonly number[], side: string): B[] {
  const inU = new Set(set);
  return g.edges
    .filter((e) =>
      side === "entering" ? !inU.has(e.from) && inU.has(e.to) : inU.has(e.from) && !inU.has(e.to),
    )
    .map((e) => e.ballot);
}

const sorted = (xs: readonly unknown[]) =>
  xs.map(String).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

describe("live-release.json", () => {
  test("is the file this suite reads", () => {
    expect(vectors.format).toBe("abolish-live-release-vectors/1");
    expect(BigInt(vectors.minLiveBatch)).toBe(BigInt(PARAMETERS.MIN_LIVE_BATCH));
  });

  test.each(vectors.schedules)("schedule $id", (v) => {
    const got = scheduledSnapshots(
      { epoch: BigInt(v.epoch), period: BigInt(v.period) },
      BigInt(v.opensAt),
      BigInt(v.closesAt),
      v.liveEvery,
    );
    expect(got.map(Number)).toEqual(v.snapshotSegments);
  });

  test("running sets: one nullifier per rule", () => {
    const { nullifiers, cells } = vectors.running;
    const sets = setsOf(nullifiers, cells.length, 4);
    for (const c of cells) {
      expect((sets[c.cell] as RunningSet<string, string>[]).slice(1).map(plain)).toEqual(
        c.runningSets,
      );
    }
  });

  test.each(vectors.graphs)("graph $id", (v) => {
    const sets = v.runningSets.map(mapOf);
    const g = releaseGraph(sets);
    expect(g.vertices).toBe(sets.length + 1);
    expect(sorted(g.edges.map((e) => `${e.from}-${e.to}-${String(e.ballot)}`))).toEqual(
      sorted(v.edges.map(([u, w, b]) => `${u}-${w}-${b}`)),
    );
    const full = [new Map<string, string>(), ...sets];
    for (const [pair, n] of Object.entries(v.changes)) {
      const [i, j] = pair.split("-").map(Number) as [number, number];
      expect(
        runningChange(full[i] as RunningSet<string, string>, full[j] as RunningSet<string, string>),
      ).toBe(n);
    }
    const cut = leastDirectedCut(g);
    expect(cut?.cut ?? null).toBe(v.directedCut);
    if (cut === null || v.cutWitness === null || v.isolated === null) return;
    // Ties may pick another witness; ours must reach the cut, and so must the vector's.
    expect(sideOf(g, cut.set, cut.side)).toHaveLength(cut.cut);
    expect(sorted(cut.ballots)).toEqual(sorted(sideOf(g, cut.set, cut.side)));
    expect(cut.set).not.toContain(0);
    expect(sorted(sideOf(g, v.cutWitness.set, v.cutWitness.side))).toEqual(
      sorted(v.isolated.nullifiers),
    );
  });

  test.each(vectors.releases)("releases $id", (v) => {
    const sets = setsOf(v.nullifiers, v.cells, v.snapshots);
    expect(sets.map((c) => c.slice(1).map(plain))).toEqual(v.runningSets);
    const choice = chooseReleases(sets, v.batch);
    expect(choice.decisions.map(asVector)).toEqual(v.decisions);
    expect(choice.releases).toEqual(v.releases);
    for (const f of v.final) {
      const cell = sets[f.cell] as RunningSet<string, string>[];
      const graph = releaseGraph([
        ...v.releases.map((q) => cell[q] as RunningSet<string, string>),
        mapOf(v.finalBallots[f.cell] as Readonly<Record<string, string>>),
      ]);
      const cut = leastDirectedCut(graph);
      expect(cut?.cut ?? null).toBe(f.finalCut);
      if (cut !== null && f.witness !== null) {
        expect(cut.ballots).toHaveLength(cut.cut);
        expect(sorted(sideOf(graph, f.witness.set, f.witness.side))).toEqual(
          sorted(f.witness.ballots),
        );
      }
    }
  });

  test.each(vectors.releases)("liveReleases chooses $id's releases for the schedule", (v) => {
    const sets = setsOf(v.nullifiers, v.cells, v.snapshots);
    // Two tiers: the vector's cells, then the same cells again as tier 1.
    const asked: string[] = [];
    const { schedule, choices } = liveReleases({
      cellTiers: [...sets.map(() => 0), ...sets.map(() => 1)],
      runningSets: [...sets, ...sets],
      batch: v.batch,
      vss: (b) => {
        asked.push(b);
        return [] as unknown as CommittedVote["vss"];
      },
    });
    expect(schedule.chosen.get(0)).toEqual(v.releases);
    expect(schedule.chosen.get(1)).toEqual(v.releases);
    expect(choices.get(0)?.decisions.map(asVector)).toEqual(v.decisions);
    const q = v.releases[0];
    if (q === undefined) return;
    const released = (sets[0] as RunningSet<string, string>[])[q] as RunningSet<string, string>;
    expect(schedule.runningSet(0, q)).toHaveLength(released.size);
    expect(sorted(asked)).toEqual(sorted([...released.values()]));
  });
});

// --- Properties ---------------------------------------------------------------

/** Random runs over m sets: each ballot's run from a to e, as running sets need not give them. */
const arbGraph = (maxSets: number, maxBallots: number) =>
  fc.integer({ min: 1, max: maxSets }).chain((m) =>
    fc
      .array(
        fc
          .tuple(fc.integer({ min: 1, max: m }), fc.integer({ min: 1, max: m }))
          .map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as const),
        { maxLength: maxBallots },
      )
      .map((runs) => {
        const sets = Array.from({ length: m }, () => new Map<string, string>());
        runs.forEach(([a, e], i) => {
          for (let s = a; s <= e; s++) (sets[s - 1] as Map<string, string>).set(`n${i}`, `b${i}`);
        });
        return sets;
      }),
  );

/** The smallest non-empty side of any combination with coefficients from −2 to 2. */
function smallestSide<B>(g: ReleaseGraph<B>): number | null {
  let best: number | null = null;
  const m = g.vertices - 1;
  for (let code = 0; code < 5 ** m; code++) {
    const prefix = [0];
    let x = code;
    for (let i = 0; i < m; i++) {
      prefix.push((prefix.at(-1) as number) + ((x % 5) - 2));
      x = Math.floor(x / 5);
    }
    const w = (e: { from: number; to: number }) =>
      (prefix[e.to] as number) - (prefix[e.from] as number);
    const pos = g.edges.filter((e) => w(e) > 0).length;
    const neg = g.edges.filter((e) => w(e) < 0).length;
    for (const s of [pos, neg]) if (s > 0 && (best === null || s < best)) best = s;
  }
  return best;
}

/**
 * A tier's nullifiers over `snapshots`: each has one or two ballots, each
 * boarded at some snapshot, admitted or pending or rejected from then, and
 * receipted at some later snapshot or never.
 */
const arbTier = (cells: number, snapshots: number, maxVoters: number) =>
  fc.array(
    fc.array(
      fc.record({
        cell: fc.integer({ min: 0, max: cells - 1 }),
        boarded: fc.integer({ min: 1, max: snapshots }),
        admittedAfter: fc.option(fc.integer({ min: 0, max: snapshots }), { nil: null }),
        receiptedAfter: fc.option(fc.integer({ min: 0, max: snapshots }), { nil: null }),
        rejected: fc.boolean(),
      }),
      { minLength: 1, maxLength: 2 },
    ),
    { maxLength: maxVoters },
  );

type Tier = readonly (readonly {
  cell: number;
  boarded: number;
  admittedAfter: number | null;
  receiptedAfter: number | null;
  rejected: boolean;
}[])[];

function tierSnapshots(tier: Tier, snapshots: number) {
  return Array.from({ length: snapshots }, (_, i) => {
    const r = i + 1;
    const out = new Map<string, SnapshotBallot<string>[]>();
    tier.forEach((ballots, n) => {
      const live: SnapshotBallot<string>[] = [];
      ballots.forEach((b, k) => {
        if (b.boarded > r) return;
        const admitted = b.admittedAfter !== null && b.boarded + b.admittedAfter <= r;
        live.push({
          ballot: `n${n}/${k}`,
          cell: b.cell,
          admission: admitted ? "admitted" : b.rejected ? "rejected" : "pending",
          fullyReceipted: b.receiptedAfter !== null && b.boarded + b.receiptedAfter <= r,
        });
      });
      if (live.length > 0) out.set(`n${n}`, live);
    });
    return out;
  });
}

/** The same map with its entries in another order. */
const reordered = <K, V>(m: ReadonlyMap<K, V>, seed: number) => {
  const xs = [...m];
  for (let i = xs.length - 1; i > 0; i--) {
    const j = (seed * (i + 7)) % (i + 1);
    [xs[i], xs[j]] = [xs[j] as [K, V], xs[i] as [K, V]];
  }
  return new Map(xs);
};

describe("properties", { timeout: 120_000 }, () => {
  test("the least directed cut is the least over every vertex set, and its witness reaches it", () => {
    run(
      fc.property(arbGraph(6, 14), (sets) => {
        const g = releaseGraph(sets);
        const cut = leastDirectedCut(g);
        expect(cut?.cut ?? null).toBe(bruteCut(g));
        if (cut === null) return;
        expect(cut.set).not.toContain(0);
        expect(sorted(cut.ballots)).toEqual(sorted(sideOf(g, cut.set, cut.side)));
      }),
    );
  });

  test("the theorem: the least non-empty side of a combination is the least directed cut", () => {
    run(
      fc.property(arbGraph(4, 10), (sets) => {
        const g = releaseGraph(sets);
        expect(smallestSide(g)).toBe(leastDirectedCut(g)?.cut ?? null);
      }),
    );
  });

  test("running sets only grow, each nullifier in one cell with one ballot, and don't depend on order", () => {
    run(
      fc.property(arbTier(3, 5, 16), fc.nat(), (tier, seed) => {
        const snaps = tierSnapshots(tier, 5);
        const sets = runningSets(3, snaps);
        const shuffled = runningSets(
          3,
          snaps.map((s) =>
            reordered(
              new Map(
                [...s].map(([n, bs]) => [n, [...reordered(new Map(bs.entries()), seed).values()]]),
              ),
              seed,
            ),
          ),
        );
        expect(shuffled.map((c) => c.map(plain))).toEqual(sets.map((c) => c.map(plain)));
        for (let r = 1; r <= 5; r++) {
          const seen = new Set<string>();
          for (const c of sets) {
            const prev = c[r - 1] as RunningSet<string, string>;
            const now = c[r] as RunningSet<string, string>;
            for (const [n, b] of prev) expect(now.get(n)).toBe(b);
            expect(runningChange(prev, now)).toBe(runningEntries(prev, now));
            for (const n of now.keys()) {
              expect(seen.has(n)).toBe(false);
              seen.add(n);
            }
          }
          // Each entrant has exactly one ballot in S_r, admitted and fully receipted.
          for (const c of sets)
            for (const [n, b] of c[r] as RunningSet<string, string>)
              if (!(c[r - 1] as RunningSet<string, string>).has(n)) {
                const live = snaps[r - 1]?.get(n) ?? [];
                expect(live.map((x) => x.ballot)).toEqual([b]);
                expect(live[0]).toMatchObject({ admission: "admitted", fullyReceipted: true });
              }
        }
      }),
    );
  });

  test("chosen releases differ by B pairwise, have a directed cut of at least B, and keep the lag", () => {
    const batch = PARAMETERS.MIN_LIVE_BATCH;
    // Steady arrivals per cell and snapshot, so releases happen and are skipped.
    const arb = fc.tuple(
      fc.integer({ min: 1, max: 3 }),
      fc.array(fc.array(fc.integer({ min: 0, max: 35 }), { minLength: 3, maxLength: 3 }), {
        minLength: 2,
        maxLength: 7,
      }),
    );
    run(
      fc.property(arb, fc.nat(), ([cells, arrivals], seed) => {
        const snaps: Map<string, SnapshotBallot<string>[]>[] = [];
        const all = new Map<string, SnapshotBallot<string>[]>();
        arrivals.forEach((perCell, r) => {
          for (let c = 0; c < cells; c++)
            for (let i = 0; i < (perCell[c] as number); i++)
              all.set(`s${r}c${c}v${i}`, [
                { ballot: `s${r}c${c}v${i}`, cell: c, admission: "admitted", fullyReceipted: true },
              ]);
          snaps.push(reordered(all, seed + r));
        });
        const sets = runningSets(cells, snaps);
        const { releases, decisions } = chooseReleases(sets, batch);
        expect(decisions.map((d) => d.at)).toEqual(arrivals.slice(1).map((_, i) => i + 2));
        for (const c of sets) {
          const vertices = [0, ...releases];
          for (const [x, i] of vertices.entries())
            for (const j of vertices.slice(x + 1))
              expect(
                runningChange(
                  c[i] as RunningSet<string, string>,
                  c[j] as RunningSet<string, string>,
                ),
              ).toBeGreaterThanOrEqual(batch);
          const cut = leastDirectedCut(
            releaseGraph(releases.map((q) => c[q] as RunningSet<string, string>)),
          );
          expect(cut === null || cut.cut >= batch).toBe(true);
        }
        for (const d of decisions)
          if (d.release !== null)
            for (const c of sets)
              expect(
                runningEntries(
                  c[d.release] as RunningSet<string, string>,
                  c[d.at] as RunningSet<string, string>,
                ),
              ).toBeGreaterThanOrEqual(batch);
      }),
    );
  });
});

describe("rules and arguments", () => {
  const voter = (
    ballot: string,
    admission: SnapshotBallot<string>["admission"] = "admitted",
    fullyReceipted = true,
  ): SnapshotBallot<string> => ({ ballot, cell: 0, admission, fullyReceipted });

  test("a nullifier enters only with one distinct ballot, admitted and fully receipted", () => {
    expect(enteringBallot([voter("a")])?.ballot).toBe("a");
    // Repeats are one ballot.
    expect(enteringBallot([voter("a"), voter("a")])?.ballot).toBe("a");
    expect(enteringBallot([voter("a"), voter("b")])).toBeNull();
    // A pending or later rejected ballot beside it holds the nullifier out (T-45).
    expect(enteringBallot([voter("a"), voter("b", "pending")])).toBeNull();
    expect(enteringBallot([voter("a"), voter("b", "rejected", false)])).toBeNull();
    expect(enteringBallot([voter("a", "pending")])).toBeNull();
    expect(enteringBallot([voter("a", "admitted", false)])).toBeNull();
    expect(enteringBallot([])).toBeNull();
    expect(() => enteringBallot([voter("a"), voter("a", "pending")])).toThrow(RangeError);
  });

  test("a nullifier already in a cell's running set stays with its ballot, whatever its later ballots", () => {
    const before = [new Map([["n", "a"]]), new Map<string, string>()];
    const next = nextRunningSets(before, new Map([["n", [{ ...voter("b"), cell: 1 }]]]));
    expect(next.map(plain)).toEqual([{ n: "a" }, {}]);
    expect(() => nextRunningSets(before, new Map([["m", [{ ...voter("b"), cell: 2 }]]]))).toThrow(
      RangeError,
    );
  });

  test("a candidate at or before the last release is never tried", () => {
    const set = (n: number) => new Map(Array.from({ length: n }, (_, i) => [`v${i}`, `v${i}`]));
    const b = PARAMETERS.MIN_LIVE_BATCH;
    const cell = [new Map<string, string>(), set(b), set(2 * b), set(3 * b), set(4 * b)];
    expect(decideRelease([cell], [1, 2], 4, b)).toMatchObject({ release: 3 });
    // Release 3 is chosen at 4, so a decision at 4 after it has no candidate.
    expect(decideRelease([cell], [3], 4, b)).toMatchObject({ release: null, refused: new Map() });
    expect(decideRelease([cell], [1], 3, b)).toMatchObject({ release: 2 });
  });

  test("a batch below MIN_LIVE_BATCH, a broken run or malformed arguments throw", () => {
    const empty = [new Map<string, string>(), new Map<string, string>(), new Map<string, string>()];
    expect(() => chooseReleases([empty], PARAMETERS.MIN_LIVE_BATCH - 1)).toThrow(RangeError);
    expect(() => decideRelease([empty], [], 1, 20)).toThrow(RangeError);
    expect(() => decideRelease([empty], [], 3, 20)).toThrow(RangeError);
    expect(() => decideRelease([empty], [2, 1], 2, 20)).toThrow(RangeError);
    expect(() => decideRelease([empty, empty.slice(1)], [], 2, 20)).toThrow(RangeError);
    expect(() => decideRelease([[new Map([["n", "a"]]), ...empty]], [], 2, 20)).toThrow(RangeError);
    expect(() =>
      releaseGraph([new Map([["n", "a"]]), new Map<string, string>(), new Map([["n", "a"]])]),
    ).toThrow(RangeError);
    expect(() => runningSets(0, [])).toThrow(RangeError);
    const clock = { epoch: 0n, period: 3600n };
    expect(() => scheduledSnapshots(clock, 10n, 10n, 1)).toThrow(RangeError);
    expect(() => scheduledSnapshots(clock, 0n, 7200n, 0)).toThrow(RangeError);
    expect(() => scheduledSnapshots({ epoch: 0n, period: 0n }, 0n, 1n, 1)).toThrow(RangeError);
    expect(() => scheduledSnapshots(clock, 0n, 3600n * 2n ** 33n, 1)).toThrow(RangeError);
    expect(leastDirectedCut({ vertices: 3, edges: [] })).toBeNull();
    expect(() =>
      leastDirectedCut({ vertices: 2, edges: [{ from: 1, to: 1, ballot: "x" }] }),
    ).toThrow(RangeError);
  });
});
