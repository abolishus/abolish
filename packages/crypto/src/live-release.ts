// Live results (docs/spec/tally.md, Live results): the release schedule, the
// running sets of a tier's cells at its scheduled snapshots, the change and
// the entries between two of them, the release graph and its least positive
// directed cut, and the release choice with its lag. Every node computes the
// choice itself from the fixed snapshots and every verifier recomputes it, so
// nothing here takes a coordinator's or the operator's word for a release
// (T-16, T-34, T-45).

import type { CommittedVote } from "./ballot-validity.ts";
import type { PeriodClock } from "./delivery.ts";
import { PARAMETERS } from "./parameters.ts";
import type { ReleaseSchedule } from "./running-opening.ts";

const U32_MAX = 0xffff_ffff;

/**
 * The scheduled snapshots' segments, `σ_r = s_open + r · live_every − 1` for
 * `r = 1, 2, …` while `σ_r < s_close` (docs/spec/tally.md, Schedule), with
 * `s = period(t)`. Snapshot `r` is the board's entries with `segment ≤ σ_r`;
 * every one ends at or before `closes_at`, and a poll shorter than
 * `live_every` periods has none. The schedule is fixed by the definition, so
 * no one can trigger or move a release (T-16, T-34).
 */
export function scheduledSnapshots(
  clock: PeriodClock,
  opensAt: bigint,
  closesAt: bigint,
  liveEvery: number,
): bigint[] {
  if (typeof clock.epoch !== "bigint" || clock.epoch < 0n)
    throw new RangeError("scheduledSnapshots: epoch must be a bigint ≥ 0");
  if (typeof clock.period !== "bigint" || clock.period < 1n)
    throw new RangeError("scheduledSnapshots: period must be a bigint ≥ 1");
  if (typeof opensAt !== "bigint" || typeof closesAt !== "bigint")
    throw new TypeError("scheduledSnapshots: opensAt and closesAt must be bigints");
  if (opensAt < clock.epoch || closesAt <= opensAt)
    throw new RangeError("scheduledSnapshots: needs epoch ≤ opensAt < closesAt");
  if (!Number.isInteger(liveEvery) || liveEvery < 1 || liveEvery > U32_MAX)
    throw new RangeError("scheduledSnapshots: liveEvery must be a u32 ≥ 1");
  const sOpen = (opensAt - clock.epoch) / clock.period;
  const sClose = (closesAt - clock.epoch) / clock.period;
  const every = BigInt(liveEvery);
  // σ_r < s_close exactly when r · live_every ≤ s_close − s_open.
  const count = (sClose - sOpen) / every;
  if (sOpen + count * every - 1n > BigInt(U32_MAX))
    throw new RangeError("scheduledSnapshots: a snapshot's segment is beyond a u32");
  const out: bigint[] = [];
  for (let r = 1n; r <= count; r++) out.push(sOpen + r * every - 1n);
  return out;
}

/** A ballot's admission with the snapshot's L1 head `h_r` ([[revoting]], Admission). */
export type SnapshotAdmission = "admitted" | "pending" | "rejected";

/**
 * One of a nullifier's distinct ballots in snapshot `S_r` whose membership
 * proof passes (verifier 5.1 to 5.3), as Running set, condition 1 reads it.
 * `ballot` identifies it; use a primitive compared by `===`, such as its hash
 * in hex, since repeats are one ballot and a running set's change compares
 * ballots. Give one per distinct ballot, never one per board entry, with its
 * verdict before repeats are removed: a copy verifier 5.7 rejects as a
 * repeat is the same ballot, and the same ballot given two verdicts throws.
 */
export interface SnapshotBallot<B> {
  readonly ballot: B;
  /** The cell it names, by its position in the registered partition. */
  readonly cell: number;
  /**
   * `admitted` if it is admitted with `h_r` as the L1 head; `pending` if its
   * L1 reference is above `h_r` or the rolling step it names isn't final
   * from L1 blocks at or before `h_r`; `rejected` otherwise. A pending or
   * rejected ballot still counts as one of the nullifier's ballots.
   */
  readonly admission: SnapshotAdmission;
  /** Whether `S_r` holds a passing share receipt for it from every qualified seat of every panel. */
  readonly fullyReceipted: boolean;
}

/**
 * The ballot a nullifier enters a running set with at a snapshot, or `null`
 * (docs/spec/tally.md, Running set): it has exactly one distinct ballot in
 * the snapshot whose membership proof passes, whatever any other check later
 * decides about it (condition 1), and that ballot is admitted and fully
 * receipted (condition 2). Counting pending and later rejected ballots keeps
 * a coercer's first ballot, or one bound to fail, from letting a re-vote
 * enter alone; a posting never lets a ballot enter (T-45). The caller must
 * pass every such ballot of the nullifier and only those.
 */
export function enteringBallot<B>(ballots: readonly SnapshotBallot<B>[]): SnapshotBallot<B> | null {
  const distinct = new Set(ballots.map((b) => b.ballot));
  if (distinct.size !== 1) return null;
  const b = ballots[0] as SnapshotBallot<B>;
  // The same ballot judged two ways is a caller's error, never one ballot.
  for (const other of ballots)
    if (
      other.cell !== b.cell ||
      other.admission !== b.admission ||
      other.fullyReceipted !== b.fullyReceipted
    )
      throw new RangeError("enteringBallot: one ballot given with two verdicts");
  return b.admission === "admitted" && b.fullyReceipted ? b : null;
}

/** A cell's running set: each nullifier in it, with the ballot it entered with. */
export type RunningSet<N, B> = ReadonlyMap<N, B>;

function checkCell(cell: number, cells: number, caller: string): void {
  if (!Number.isInteger(cell) || cell < 0 || cell >= cells)
    throw new RangeError(
      `${caller}: a ballot names cell ${String(cell)}, outside 0 to ${cells - 1}`,
    );
}

/**
 * The running sets of a tier's cells at snapshot `r`, from those at `r − 1`
 * and `S_r`'s ballots per nullifier (only nullifiers with at least one ballot
 * whose membership proof passes need be given). `previous` is indexed by
 * cell position in the registered partition, the position each ballot names;
 * since nullifiers are scoped per tier, one call can serve every tier.
 * Nullifiers and ballots must be primitives (hex strings, say): they are
 * compared by `===`. A nullifier in a running set
 * of any of the tier's cells stays with the ballot it entered with, whatever
 * follows: a re-vote, a tie or a posting never removes it, so running sets
 * only grow (Running set, Staying; T-16, T-45). Any other enters the cell its
 * entering ballot names, if it has one.
 */
export function nextRunningSets<N, B>(
  previous: readonly RunningSet<N, B>[],
  snapshot: ReadonlyMap<N, readonly SnapshotBallot<B>[]>,
): Map<N, B>[] {
  const cells = previous.length;
  if (cells < 1) throw new RangeError("nextRunningSets: a tier has at least one cell");
  const next = previous.map((s) => new Map(s));
  const held = (n: N) => previous.some((s) => s.has(n));
  for (const [n, ballots] of snapshot) {
    checkPrimitive(n, "nextRunningSets");
    for (const b of ballots) {
      checkCell(b.cell, cells, "nextRunningSets");
      checkPrimitive(b.ballot, "nextRunningSets");
    }
    if (held(n)) continue;
    const b = enteringBallot(ballots);
    if (b !== null) (next[b.cell] as Map<N, B>).set(n, b.ballot);
  }
  return next;
}

/**
 * Per cell of the registered partition (`cells` of them), the running sets
 * `R_0, R_1, …, R_m` over the first `m` scheduled snapshots, `snapshots[r − 1]` being `S_r`'s ballots per
 * nullifier; `R_0` is the empty set, which stands for a release at opening.
 */
export function runningSets<N, B>(
  cells: number,
  snapshots: readonly ReadonlyMap<N, readonly SnapshotBallot<B>[]>[],
): Map<N, B>[][] {
  if (!Number.isInteger(cells) || cells < 1 || cells > 256)
    throw new RangeError("runningSets: from 1 to 256 cells");
  const out: Map<N, B>[][] = Array.from({ length: cells }, () => [new Map<N, B>()]);
  let current: Map<N, B>[] = out.map((c) => c[0] as Map<N, B>);
  for (const s of snapshots) {
    current = nextRunningSets(current, s);
    for (const [c, set] of current.entries()) (out[c] as Map<N, B>[]).push(set);
  }
  return out;
}

/** The number of nullifiers whose entry differs between two running sets of a cell (Change and the release graph). */
export function runningChange<N, B>(a: RunningSet<N, B>, b: RunningSet<N, B>): number {
  let n = 0;
  for (const [k, v] of a) if (!b.has(k) || b.get(k) !== v) n++;
  for (const k of b.keys()) if (!a.has(k)) n++;
  return n;
}

/** The entries from an earlier running set to a later one: the nullifiers in the later and not the earlier. */
export function runningEntries<N, B>(earlier: RunningSet<N, B>, later: RunningSet<N, B>): number {
  let n = 0;
  for (const k of later.keys()) if (!earlier.has(k)) n++;
  return n;
}

/** One ballot's edge in a release graph: from the vertex before its run to its last. */
export interface ReleaseEdge<B> {
  readonly from: number;
  readonly to: number;
  readonly ballot: B;
}

/** A release graph: vertices `0, …, m`, vertex 0 the empty set, and one edge per ballot. */
export interface ReleaseGraph<B> {
  readonly vertices: number;
  readonly edges: readonly ReleaseEdge<B>[];
}

/**
 * The graph of a sequence of sets `1, …, m` (docs/spec/tally.md, Change and
 * the release graph): for each ballot in any of them, an edge from `a − 1`
 * to `e`, where `a` and `e` are the first and last sets holding it. Throws
 * if a ballot's sets aren't an unbroken run, which running sets and the
 * final tally after them never give, so the theorem doesn't apply.
 */
export function releaseGraph<B>(sets: readonly ReadonlyMap<unknown, B>[]): ReleaseGraph<B> {
  const runs = new Map<B, { first: number; last: number }>();
  for (const [i, set] of sets.entries()) {
    const at = i + 1;
    for (const ballot of set.values()) {
      const run = runs.get(ballot);
      if (run === undefined) runs.set(ballot, { first: at, last: at });
      else if (run.last === at - 1) run.last = at;
      else throw new RangeError("releaseGraph: a ballot's sets are not an unbroken run");
    }
  }
  const edges = [...runs].map(([ballot, { first, last }]) => ({
    from: first - 1,
    to: last,
    ballot,
  }));
  return { vertices: sets.length + 1, edges };
}

/** The least positive directed cut and one vertex set that reaches it. */
export interface DirectedCut<B> {
  readonly cut: number;
  /** The vertex set, never holding vertex 0, in ascending order. */
  readonly set: readonly number[];
  /** Whether the cut's edges are those entering `set` or those leaving it. */
  readonly side: "entering" | "leaving";
  /** The ballots of the cut's edges: the least non-empty side of a combination. */
  readonly ballots: readonly B[];
}

/**
 * The least positive number of edges entering any vertex set, and a set that
 * reaches it, or `null` if the graph has no edge (docs/spec/tally.md, Change
 * and the release graph). By the theorem there, it is the least number of
 * ballots on a non-empty side of any combination of the sets' totals (T-16).
 * Computed exactly, in integers, as the least maximum flow along an edge
 * with unit capacities (Ford and Fulkerson), each flow by Edmonds and Karp's
 * shortest augmenting paths; the value never depends on how ties are
 * broken, though the witness may.
 */
export function leastDirectedCut<B>(graph: ReleaseGraph<B>): DirectedCut<B> | null {
  const n = graph.vertices;
  if (!Number.isInteger(n) || n < 1) throw new RangeError("leastDirectedCut: at least one vertex");
  const capacity = Array.from({ length: n }, () => Array.from({ length: n }, () => 0));
  for (const e of graph.edges) {
    if (
      !Number.isInteger(e.from) ||
      !Number.isInteger(e.to) ||
      e.from < 0 ||
      e.to >= n ||
      e.from >= e.to
    )
      throw new RangeError("leastDirectedCut: every edge goes forward between vertices");
    (capacity[e.from] as number[])[e.to] = ((capacity[e.from] as number[])[e.to] as number) + 1;
  }
  let best: { flow: number; source: number; residual: number[][] } | null = null;
  for (let u = 0; u < n; u++)
    for (let v = u + 1; v < n; v++) {
      if ((capacity[u] as number[])[v] === 0) continue;
      const { flow, residual } = maxFlow(capacity, u, v);
      if (best === null || flow < best.flow) best = { flow, source: u, residual };
    }
  if (best === null) return null;
  // The vertices the source can't reach in the residual graph form a set
  // holding the sink and not the source; the edges entering it are exactly
  // the saturated ones, the flow's value.
  const reached = reachable(best.residual, best.source);
  let set = [...Array(n).keys()].filter((i) => !reached[i]);
  let side: DirectedCut<B>["side"] = "entering";
  if (set.includes(0)) {
    // Its complement, which holds the source and not vertex 0, has the same
    // edges leaving it.
    set = [...Array(n).keys()].filter((i) => reached[i]);
    side = "leaving";
  }
  const inSet = new Set(set);
  const crosses = (e: ReleaseEdge<B>) =>
    side === "entering"
      ? !inSet.has(e.from) && inSet.has(e.to)
      : inSet.has(e.from) && !inSet.has(e.to);
  const ballots = graph.edges.filter(crosses).map((e) => e.ballot);
  if (ballots.length !== best.flow) throw new Error("leastDirectedCut: cut and flow disagree");
  return { cut: best.flow, set, side, ballots };
}

function maxFlow(capacity: readonly (readonly number[])[], s: number, t: number) {
  const n = capacity.length;
  const residual = capacity.map((row) => [...row]);
  let flow = 0;
  for (;;) {
    const prev = Array.from({ length: n }, () => -1);
    prev[s] = s;
    const queue = [s];
    for (let head = 0; head < queue.length && prev[t] === -1; head++) {
      const u = queue[head] as number;
      for (let v = 0; v < n; v++)
        if (prev[v] === -1 && ((residual[u] as number[])[v] as number) > 0) {
          prev[v] = u;
          queue.push(v);
        }
    }
    if (prev[t] === -1) return { flow, residual };
    let push = Infinity;
    for (let v = t; v !== s; v = prev[v] as number)
      push = Math.min(push, (residual[prev[v] as number] as number[])[v] as number);
    for (let v = t; v !== s; v = prev[v] as number) {
      const u = prev[v] as number;
      (residual[u] as number[])[v] = ((residual[u] as number[])[v] as number) - push;
      (residual[v] as number[])[u] = ((residual[v] as number[])[u] as number) + push;
    }
    flow += push;
  }
}

function reachable(residual: readonly (readonly number[])[], s: number): boolean[] {
  const seen = Array.from({ length: residual.length }, () => false);
  seen[s] = true;
  const queue = [s];
  for (let head = 0; head < queue.length; head++) {
    const u = queue[head] as number;
    for (const [v, c] of (residual[u] as readonly number[]).entries())
      if (!seen[v] && c > 0) {
        seen[v] = true;
        queue.push(v);
      }
  }
  return seen;
}

/** Why a candidate snapshot isn't released: rule 1, the batch, or rule 2, the lag. */
export type ReleaseRefusal = "batch" | "lag";

/** One decision of a tier (docs/spec/tally.md, Release choice). */
export interface ReleaseDecision {
  /** `r`, the fixed snapshot the decision is made at. */
  readonly at: number;
  /** The snapshot released, or `null` if none qualified. */
  readonly release: number | null;
  /** Each candidate tried before the release, from `r − 1` down, with the first rule it failed. */
  readonly refused: ReadonlyMap<number, ReleaseRefusal>;
}

function checkBatch(batch: number, caller: string): void {
  // A definition with a smaller batch fails 2.x before any release; one
  // reaching here anyway is never released in smaller batches (T-16).
  if (!Number.isInteger(batch) || batch < PARAMETERS.MIN_LIVE_BATCH || batch > U32_MAX)
    throw new RangeError(`${caller}: the batch must be a u32 of at least MIN_LIVE_BATCH`);
}

function checkTier<N, B>(cells: readonly (readonly RunningSet<N, B>[])[], caller: string): number {
  if (cells.length < 1) throw new RangeError(`${caller}: a tier has at least one cell`);
  const length = (cells[0] as readonly RunningSet<N, B>[]).length;
  if (length < 1 || cells.some((c) => c.length !== length))
    throw new RangeError(`${caller}: every cell needs R_0 to R_m, the same m`);
  if (cells.some((c) => (c[0] as RunningSet<N, B>).size !== 0))
    throw new RangeError(`${caller}: R_0 is the empty set`);
  // The batch bound on every combination of releases holds only for sets
  // that grow, each nullifier with one ballot in one cell (Change and the
  // release graph, Releases), so sets that don't are refused rather than
  // trusted (T-16).
  for (const sets of cells)
    for (let i = 1; i < length; i++) {
      const earlier = sets[i - 1] as RunningSet<N, B>;
      const later = sets[i] as RunningSet<N, B>;
      for (const [n, b] of earlier)
        if (!later.has(n) || later.get(n) !== b)
          throw new RangeError(
            `${caller}: running sets only grow, each nullifier keeping its ballot`,
          );
    }
  const nullifiers = new Set<N>();
  const ballots = new Set<B>();
  for (const sets of cells)
    for (const [n, b] of sets[length - 1] as RunningSet<N, B>) {
      checkPrimitive(n, caller);
      checkPrimitive(b, caller);
      if (nullifiers.has(n) || ballots.has(b))
        throw new RangeError(`${caller}: a nullifier or ballot is in two cells or twice in a set`);
      nullifiers.add(n);
      ballots.add(b);
    }
  return length - 1;
}

// Nullifiers and ballots are compared by `===` and as Map keys, so an object
// (a fresh Uint8Array, say) would never match itself: a voter already in a
// running set would enter again as new (T-16).
function checkPrimitive(x: unknown, caller: string): void {
  if ((typeof x === "object" && x !== null) || typeof x === "function")
    throw new TypeError(
      `${caller}: nullifiers and ballots must be primitives, such as hex strings`,
    );
}

function refusal<N, B>(
  cells: readonly (readonly RunningSet<N, B>[])[],
  chosen: readonly number[],
  q: number,
  r: number,
  batch: number,
): ReleaseRefusal | null {
  for (const sets of cells) {
    const at = (i: number) => sets[i] as RunningSet<N, B>;
    // Rule 1: at least B changes against every release so far and the empty set.
    for (const i of [0, ...chosen]) if (runningChange(at(q), at(i)) < batch) return "batch";
    // Rule 2, the lag: at least B entries after the released snapshot.
    if (runningEntries(at(q), at(r)) < batch) return "lag";
  }
  return null;
}

/**
 * A tier's decision at fixed snapshot `r ≥ 2` (docs/spec/tally.md, Release
 * choice): the latest candidate `q` from `r − 1` down to just after its last
 * release such that in every cell, in order, `R_q` changed by at least
 * `batch` against every chosen release and the empty set (rule 1), and at
 * least `batch` nullifiers entered from `R_q` to `R_r` (rule 2, the lag).
 * With running sets that only grow, rule 1 bounds every combination of the
 * releases, not only pairs (T-16). `cells[c]` holds cell `c`'s running sets
 * from `R_0` to at least `R_r`; `chosen` the tier's releases so far,
 * ascending, each counted whether or not its openings were ever boarded.
 */
export function decideRelease<N, B>(
  cells: readonly (readonly RunningSet<N, B>[])[],
  chosen: readonly number[],
  r: number,
  batch: number,
): ReleaseDecision {
  const m = checkTier(cells, "decideRelease");
  checkBatch(batch, "decideRelease");
  if (!Number.isInteger(r) || r < 2 || r > m)
    throw new RangeError("decideRelease: r must be a snapshot from 2 to the last given");
  for (const [i, q] of chosen.entries())
    if (!Number.isInteger(q) || q < 1 || q >= r || (i > 0 && q <= (chosen[i - 1] as number)))
      throw new RangeError("decideRelease: chosen must ascend, each before r");
  const last = chosen.at(-1) ?? 0;
  const refused = new Map<number, ReleaseRefusal>();
  for (let q = r - 1; q > last; q--) {
    const why = refusal(cells, chosen, q, r, batch);
    if (why === null) return { at: r, release: q, refused };
    refused.set(q, why);
  }
  return { at: r, release: null, refused };
}

/** A tier's decisions at snapshots `2, …, m` and the releases they chose. */
export interface ReleaseChoice {
  readonly releases: readonly number[];
  readonly decisions: readonly ReleaseDecision[];
}

/**
 * Every decision of a tier over its fixed snapshots `1, …, m`, given each
 * cell's running sets `R_0, …, R_m`. A function of the fixed snapshots and
 * the definition alone, so every node computes the same choice and a
 * verifier recomputes it (T-16, T-34).
 */
export function chooseReleases<N, B>(
  cells: readonly (readonly RunningSet<N, B>[])[],
  batch: number,
): ReleaseChoice {
  const m = checkTier(cells, "chooseReleases");
  checkBatch(batch, "chooseReleases");
  const releases: number[] = [];
  const decisions: ReleaseDecision[] = [];
  for (let r = 2; r <= m; r++) {
    const d = decideRelease(cells, releases, r, batch);
    decisions.push(d);
    if (d.release !== null) releases.push(d.release);
  }
  return { releases, decisions };
}

/** What `liveReleases` reads: every cell's running sets, ballots by `B`, and how to find a ballot's VSS. */
export interface LiveReleasesInput<N, B> {
  /** Each cell's tier, by its position in the registered partition. */
  readonly cellTiers: readonly number[];
  /** Per cell, its running sets `R_0, …, R_m` over the fixed snapshots so far. */
  readonly runningSets: readonly (readonly RunningSet<N, B>[])[];
  /** The definition's `live_batch`. */
  readonly batch: number;
  /** The VSS of the ballot a nullifier entered with. */
  readonly vss: (ballot: B) => CommittedVote["vss"];
}

/**
 * Each tier's release choice over its cells, as the `ReleaseSchedule` that
 * reading and boarding running openings take, so the chosen releases come
 * from the fixed snapshots and never from a caller's list: a release named
 * early or by hand is the disclosure the boarding rule stops (T-16).
 */
export function liveReleases<N, B>(
  input: LiveReleasesInput<N, B>,
): { readonly schedule: ReleaseSchedule; readonly choices: ReadonlyMap<number, ReleaseChoice> } {
  const { cellTiers, runningSets: sets, batch } = input;
  if (cellTiers.length < 1 || cellTiers.length > 256 || sets.length !== cellTiers.length)
    throw new RangeError("liveReleases: from 1 to 256 cells, each with its tier and running sets");
  if (cellTiers.some((t) => !Number.isInteger(t) || t < 0))
    throw new RangeError("liveReleases: a cell's tier must be a non-negative integer");
  const choices = new Map<number, ReleaseChoice>();
  for (const tier of [...new Set(cellTiers)].sort((a, b) => a - b)) {
    const cells = sets.filter((_, c) => cellTiers[c] === tier);
    choices.set(tier, chooseReleases(cells, batch));
  }
  const chosen = new Map([...choices].map(([tier, c]) => [tier, c.releases] as const));
  const schedule: ReleaseSchedule = {
    cellTiers,
    chosen,
    runningSet: (cell, snapshot) => {
      const set = sets[cell]?.[snapshot];
      if (set === undefined) throw new RangeError("liveReleases: no such cell or snapshot");
      return [...set.values()].map(input.vss);
    },
  };
  return { schedule, choices };
}
