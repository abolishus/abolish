// The rolling tier tree, the root clock and the reported counts of
// docs/spec/membership.md (Rolling tier tree; Root clock and steps; Reported
// counts), for definition version 7's rolling tiers ([[0028-rolling-electorates]],
// option B). A rolling tier's ballots prove against a step of the root clock,
// never a root a definition states, so every verifier derives each step from
// the listed groups' events alone (T-34, T-16). The tree is built in chain
// order and updated in place, so every step of a poll costs one pass over its
// groups' events rather than a rebuild per step (T-36, T-52).

import { isForbiddenCommitment } from "./group-registry.ts";
import { PARAMETERS } from "./parameters.ts";
import { TIER_TREE_MAX_LEAVES, TierTreeBuilder } from "./tier-tree.ts";

const MAX_U32 = 0xffff_ffffn;
const MAX_U64 = (1n << 64n) - 1n;
const PERIOD = BigInt(PARAMETERS.ROOT_PERIOD);
const OFFSET = BigInt(PARAMETERS.ROOT_OFFSET);
const WINDOW = BigInt(PARAMETERS.ROOT_WINDOW);

function uintArg(v: unknown, max: bigint, what: string): bigint {
  if (typeof v !== "bigint" || v < 0n || v > max)
    throw new RangeError(`${what}: expected a bigint from 0 to ${max}`);
  return v;
}

/** Boundary `n` of the root clock, `τ_n = n · ROOT_PERIOD + ROOT_OFFSET` in UNIX seconds, for `n` a `u32`. */
export function rootClockBoundary(step: bigint): bigint {
  return uintArg(step, MAX_U32, "step") * PERIOD + OFFSET;
}

/** The newest boundary at or before `timestamp`, or `undefined` before `τ_0`. */
export function rootClockStepAtOrBefore(timestamp: bigint): bigint | undefined {
  const ts = uintArg(timestamp, MAX_U64, "timestamp");
  if (ts < OFFSET) return undefined;
  const n = (ts - OFFSET) / PERIOD;
  return n > MAX_U32 ? MAX_U32 : n;
}

/** The oldest boundary at or after `timestamp`, or `undefined` after `τ_{2^32−1}`. */
function stepAtOrAfter(ts: bigint): bigint | undefined {
  const n = ts <= OFFSET ? 0n : (ts - OFFSET + PERIOD - 1n) / PERIOD;
  return n > MAX_U32 ? undefined : n;
}

/** Where step `n` falls against a ballot's L1 reference (docs/spec/membership.md, The window). */
export type RootStepWindow = "in" | "stale" | "future";

/**
 * A ballot whose L1 reference has timestamp `t` may name step `n` only if
 * `t − ROOT_WINDOW < τ_n ≤ t`: `future` past it (`root-step-future`), `stale`
 * before it (`root-step-stale`). It reads only the ballot and finalized L1, so
 * every verifier agrees (T-13: a client's choice of step reveals at most the
 * window).
 */
export function rootStepWindow(step: bigint, l1Timestamp: bigint): RootStepWindow {
  const tau = rootClockBoundary(step);
  const t = uintArg(l1Timestamp, MAX_U64, "l1Timestamp");
  if (tau > t) return "future";
  return tau + WINDOW <= t ? "stale" : "in";
}

/**
 * One event of the group registry, in chain order (L2 block number, then log
 * index; the scans check the block numbers and timestamps, and the order
 * within a block is the caller's, from the event accumulator), after its group's strict replay ([[contracts]], Group registry,
 * Verification): a `MembersAdded` or `SelfPaidMemberAdded` with its
 * commitments in record order, or a `MembersRemoved` with the member indices
 * it names. A listed Tier 1 group's events are the additions [[vouching]]
 * counts, and nothing else. `timestamp` is the L2 block's, as the event
 * accumulator binds it.
 */
export type RollingTierEvent = {
  readonly blockNumber: bigint;
  readonly timestamp: bigint;
  readonly groupId: bigint;
} & (
  | { readonly kind: "add"; readonly commitments: readonly bigint[] }
  | { readonly kind: "remove"; readonly indices: readonly bigint[] }
);

/** The leaves one event appended and the leaves it set to 0. */
export interface RollingTierChange {
  readonly appended: readonly number[];
  readonly zeroed: readonly number[];
}

const NO_CHANGE: RollingTierChange = Object.freeze({ appended: [], zeroed: [] });

/**
 * A rolling tier's tree, kept across events: the tier tree whose leaves are
 * its listed groups' additions in chain order, with a removal setting to 0 the
 * leaf its group's named member appended. No first-occurrence rule: a repeat
 * keeps a leaf per occurrence, all of one secret, so one nullifier. The member
 * count is the number of distinct live commitments, so a repeat never
 * inflates a reported anonymity set (T-16).
 */
export class RollingTierTree {
  readonly #groups: ReadonlySet<bigint>;
  readonly #tree = new TierTreeBuilder();
  // The leaves, 0 where removed; the tier tree's own nodes are the builder's.
  readonly #leaves: bigint[] = [];
  // Each group's member i is the leaf at position #members.get(group)[i].
  readonly #members = new Map<bigint, number[]>();
  // How many live leaves hold each commitment.
  readonly #live = new Map<bigint, number>();

  constructor(groups: readonly bigint[]) {
    if (!Array.isArray(groups)) throw new TypeError("groups: expected an array");
    this.#groups = new Set(groups.map((g, i) => uintArg(g, MAX_U64, `groups[${i}]`)));
  }

  /** The number of leaves, removed ones included. */
  get size(): number {
    return this.#leaves.length;
  }

  /** The member count: distinct commitments among the nonzero leaves. */
  get memberCount(): number {
    return this.#live.size;
  }

  /** Leaf `index`: a commitment, or 0 once its member was removed. */
  leaf(index: number): bigint {
    const v = this.#leaves[index];
    if (!Number.isSafeInteger(index) || v === undefined)
      throw new RangeError("leaf: index must name a leaf");
    return v;
  }

  /** The leaves in order, `0n` where a member was removed. */
  get leaves(): readonly bigint[] {
    return this.#leaves.slice();
  }

  /** The tree's root; `Z_32` while it has no leaf. */
  root(): bigint {
    return this.#tree.root();
  }

  /**
   * Applies one event; a group the tier doesn't list changes nothing. The
   * strict replay refuses forbidden commitments and removals of a member not
   * yet added or already removed, so either here is a replay bug and throws
   * rather than guess (`group-history` belongs to the replay).
   */
  apply(event: RollingTierEvent): RollingTierChange {
    if (event === null || typeof event !== "object")
      throw new TypeError("event: expected an object");
    const groupId = uintArg(event.groupId, MAX_U64, "event.groupId");
    if (!this.#groups.has(groupId)) return NO_CHANGE;
    let members = this.#members.get(groupId);
    if (members === undefined) this.#members.set(groupId, (members = []));
    // Each field read once, so a getter can't show one check one value and the update another.
    const kind = event.kind;
    if (kind === "add") {
      const raw = event.commitments;
      if (!Array.isArray(raw)) throw new TypeError("event.commitments: expected an array");
      const commitments = raw.slice();
      for (const c of commitments)
        if (typeof c !== "bigint" || isForbiddenCommitment(c))
          throw new RangeError("event.commitments: expected commitments that aren't forbidden");
      if (this.size + commitments.length > TIER_TREE_MAX_LEAVES)
        throw new RangeError("event: a rolling tier with more than 2^32 leaves has no tree");
      const appended: number[] = [];
      for (const c of commitments) {
        const at = this.#leaves.length;
        this.#tree.append(c);
        this.#leaves.push(c);
        members.push(at);
        this.#live.set(c, (this.#live.get(c) ?? 0) + 1);
        appended.push(at);
      }
      return { appended, zeroed: [] };
    }
    if (kind === "remove") {
      const raw = event.indices;
      if (!Array.isArray(raw)) throw new TypeError("event.indices: expected an array");
      const indices = raw.slice();
      const zeroed = new Set<number>();
      for (const i of indices) {
        const at = typeof i === "bigint" && i >= 0n ? members[Number(i)] : undefined;
        if (at === undefined || this.#leaves[at] === 0n || zeroed.has(at))
          throw new RangeError("event.indices: a removal the strict replay refuses");
        zeroed.add(at);
      }
      for (const at of zeroed) {
        const c = this.#leaves[at] as bigint; // checked nonzero above
        const n = (this.#live.get(c) ?? 0) - 1;
        if (n === 0) this.#live.delete(c);
        else this.#live.set(c, n);
        this.#leaves[at] = 0n;
        this.#tree.remove(at);
      }
      return { appended: [], zeroed: [...zeroed] };
    }
    throw new TypeError('event.kind: expected "add" or "remove"');
  }
}

/** What a rolling tier's steps are read against: its definition and registration. */
export interface RollingTierContext {
  /** The tier's listed groups. */
  readonly groups: readonly bigint[];
  /** The definition's `root_l2_block`: the opening state is the tree through it. */
  readonly rootL2Block: bigint;
  /** The timestamp of the L2 block holding the definition's `DefinitionRegistered`. */
  readonly registeredAt: bigint;
  /** The definition's `closes_at`. */
  readonly closesAt: bigint;
}

/** A tree's root and member count. */
export interface RollingTierState {
  readonly root: bigint;
  readonly memberCount: number;
}

/** Step `n`'s tree: over the events in L2 blocks whose timestamp is at most `τ_n`. */
export interface RollingStep extends RollingTierState {
  readonly step: bigint;
  /** The tree's leaves, removed ones included. */
  readonly size: number;
  /**
   * `τ_n` later than `registeredAt` and at most `closesAt`, with a nonzero
   * leaf (a root other than `Z_32`, which no one can prove against).
   */
  readonly accepted: boolean;
}

/** An anchoring period's clock ([[board]], Timing): period `s` starts at `epoch + s · period`. */
export interface AnchoringClock {
  readonly epoch: bigint;
  readonly period: bigint;
}

interface ScanQueries {
  /** Steps whose trees to snapshot. */
  readonly steps: readonly bigint[];
  /** Steps `n` at which to count `E(n)`. */
  readonly eligible: readonly bigint[];
  /** For growth rows. */
  readonly clock?: AnchoringClock;
  /** Whether to hash the trees: the counts need only their leaves. */
  readonly roots: boolean;
}

interface Row {
  period: bigint;
  end: bigint;
  added: number;
  removed: number;
  members: number;
}

/** A state or step as the scan saw it: its root only if the queries asked for roots. */
type Scanned<T extends RollingTierState> = Omit<T, "root"> & { readonly root: bigint | undefined };

interface ScanResult {
  readonly opening: Scanned<RollingTierState>;
  readonly steps: ReadonlyMap<bigint, Scanned<RollingStep>>;
  readonly eligible: ReadonlyMap<bigint, number>;
  readonly growth: readonly Row[];
}

function checkedContext(ctx: RollingTierContext): RollingTierContext {
  if (ctx === null || typeof ctx !== "object") throw new TypeError("ctx: expected an object");
  // Each field read once, so a getter can't show one check one value and the scan another.
  const { groups, rootL2Block, registeredAt, closesAt } = ctx;
  if (!Array.isArray(groups)) throw new TypeError("ctx.groups: expected an array");
  return {
    groups: groups.slice(),
    rootL2Block: uintArg(rootL2Block, MAX_U64, "ctx.rootL2Block"),
    registeredAt: uintArg(registeredAt, MAX_U64, "ctx.registeredAt"),
    closesAt: uintArg(closesAt, MAX_U64, "ctx.closesAt"),
  };
}

const ascending = (xs: Iterable<bigint>) => [...new Set(xs)].sort((a, b) => (a < b ? -1 : 1));

const floorDiv = (a: bigint, b: bigint) => (a >= 0n ? a / b : -((-a + b - 1n) / b));

/**
 * The one pass over a tier's events behind every step and count: the tree is
 * updated in chain order, and each query is answered as the scan passes its
 * time. Events are grouped by timestamp, since a step holds every event at or
 * before its boundary; between two timestamps the tree is fixed, so a span of
 * steps is accepted or not as a whole, and `E(n)` costs one pass over the
 * leaves, never a pass per step (docs/spec/membership.md, Reported counts).
 */
function scan(
  events: readonly RollingTierEvent[],
  ctx: RollingTierContext,
  queries: ScanQueries,
): ScanResult {
  if (!Array.isArray(events)) throw new TypeError("events: expected an array");
  const { rootL2Block, registeredAt, closesAt } = ctx;
  const tree = new RollingTierTree(ctx.groups);
  const pendingSteps = ascending(queries.steps.map((n) => uintArg(n, MAX_U32, "step")));
  const pendingEligible = ascending(queries.eligible.map((n) => uintArg(n, MAX_U32, "step")));
  const steps = new Map<bigint, Scanned<RollingStep>>();
  const eligibleAt = new Map<bigint, number>();
  // Live leaves no accepted step has held yet, and the commitments one has.
  const fresh = new Set<number>();
  const eligible = new Set<bigint>();
  const growth: Row[] = [];
  let row: Row | undefined;
  let opening: Scanned<RollingTierState> | undefined;
  const state = () => ({
    root: queries.roots ? tree.root() : undefined,
    memberCount: tree.memberCount,
  });

  // The tree is the steps' with boundaries in [lo, hi) (lo undefined: from the start).
  const span = (lo: bigint | undefined, hi: bigint | undefined) => {
    while (pendingSteps.length > 0) {
      const n = pendingSteps[0] as bigint;
      const tau = rootClockBoundary(n);
      if (hi !== undefined && tau >= hi) break;
      pendingSteps.shift();
      steps.set(n, {
        step: n,
        ...state(),
        size: tree.size,
        accepted: tau > registeredAt && tau <= closesAt && tree.memberCount > 0,
      });
    }
    const from = lo === undefined || lo <= registeredAt ? registeredAt + 1n : lo;
    const to = hi === undefined || hi - 1n > closesAt ? closesAt : hi - 1n;
    if (tree.memberCount === 0 || to < from) return;
    const first = stepAtOrAfter(from);
    const last = rootClockStepAtOrBefore(to);
    if (first === undefined || last === undefined || first > last) return;
    while (pendingEligible.length > 0 && (pendingEligible[0] as bigint) < first)
      eligibleAt.set(pendingEligible.shift() as bigint, eligible.size);
    for (const at of fresh) eligible.add(tree.leaf(at));
    fresh.clear();
    while (pendingEligible.length > 0 && (pendingEligible[0] as bigint) <= last)
      eligibleAt.set(pendingEligible.shift() as bigint, eligible.size);
  };

  let previous: { blockNumber: bigint; timestamp: bigint } | undefined;
  for (const [at, event] of events.slice().entries()) {
    if (event === null || typeof event !== "object")
      throw new TypeError(`events[${at}]: expected an object`);
    const blockNumber = uintArg(event.blockNumber, MAX_U64, `events[${at}].blockNumber`);
    const timestamp = uintArg(event.timestamp, MAX_U64, `events[${at}].timestamp`);
    if (previous !== undefined) {
      // L2 timestamps never decrease along the chain, and one block has one.
      const sameBlock = blockNumber === previous.blockNumber;
      if (
        blockNumber < previous.blockNumber ||
        timestamp < previous.timestamp ||
        (sameBlock && timestamp !== previous.timestamp)
      )
        throw new RangeError(`events[${at}]: not in chain order`);
      if (timestamp > previous.timestamp) span(previous.timestamp, timestamp);
    } else span(undefined, timestamp);
    previous = { blockNumber, timestamp };
    if (opening === undefined && blockNumber > rootL2Block) opening = state();
    if (row !== undefined && timestamp > row.end) {
      row.members = tree.memberCount;
      row = undefined;
    }
    const change = tree.apply({ ...event, blockNumber, timestamp });
    for (const i of change.appended) fresh.add(i);
    for (const i of change.zeroed) fresh.delete(i);
    const touched = change.appended.length + change.zeroed.length;
    const clock = queries.clock;
    if (clock !== undefined && touched > 0 && blockNumber > rootL2Block && timestamp <= closesAt) {
      const period = floorDiv(timestamp - clock.epoch, clock.period);
      if (row === undefined) {
        const periodEnd = clock.epoch + (period + 1n) * clock.period - 1n;
        row = {
          period,
          end: periodEnd < closesAt ? periodEnd : closesAt,
          added: 0,
          removed: 0,
          members: 0,
        };
        growth.push(row);
      }
      row.added += change.appended.length;
      row.removed += change.zeroed.length;
    }
  }
  span(previous?.timestamp, undefined);
  if (row !== undefined) row.members = tree.memberCount;
  for (const n of pendingEligible) eligibleAt.set(n, eligible.size);
  return { opening: opening ?? state(), steps, eligible: eligibleAt, growth };
}

/**
 * The opening state and the trees of `steps`, from the tier's events in chain
 * order. The opening state is the tree through `root_l2_block`, whose root and
 * member count verifier 2.4 checks against the definition's `root` and
 * `group_size`; no ballot proves against it. Each step is computed only if
 * asked for, so a verifier computes only the steps ballots use.
 */
export function rollingTierSteps(
  events: readonly RollingTierEvent[],
  ctx: RollingTierContext,
  steps: readonly bigint[],
): { readonly opening: RollingTierState; readonly steps: readonly RollingStep[] } {
  if (!Array.isArray(steps)) throw new TypeError("steps: expected an array");
  const got = scan(events, checkedContext(ctx), {
    steps: steps.slice(),
    eligible: [],
    roots: true,
  });
  // Every root is set: the scan was asked for roots.
  const rooted = <T extends RollingTierState>(x: Scanned<T>) => ({ ...x, root: x.root as bigint });
  return { opening: rooted(got.opening), steps: [...got.steps.values()].map(rooted) };
}

/** A live release's snapshot: the board through anchoring period `segment`. */
export interface RollingReleaseInput {
  readonly segment: bigint;
  /** The steps named by the snapshot's ballot entries whose membership proofs verify. */
  readonly snapshotSteps: readonly bigint[];
}

/** What a rolling tier's result says about its electorate (docs/spec/membership.md, Reported counts). */
export interface RollingTierReport {
  readonly opening: { readonly members: number };
  /** `E(n_c)`: distinct commitments live at some accepted step; 0 with no close. */
  readonly eligible: number;
  /** Step `n_c`, the last boundary at or before `closes_at`, if later than `registeredAt`. */
  readonly close: {
    readonly step: bigint;
    readonly members: number;
    readonly accepted: boolean;
  } | null;
  /** The ballots' step with the fewest members, the lowest on a tie. */
  readonly smallestStep: { readonly step: bigint; readonly members: number } | null;
  /** One row per anchoring period with an event after the opening block, up to the close. */
  readonly growth: readonly {
    readonly period: bigint;
    readonly added: number;
    readonly removed: number;
    readonly members: number;
  }[];
  /** Per release: `E(n_r)` with `n_r`, or the opening count with no step. */
  readonly releases: readonly { readonly step: bigint | null; readonly count: number }[];
}

/**
 * Every count a rolling tier reports, each computed from the listed groups'
 * events and never taken from a definition, a release or a submitter (T-16,
 * T-13, T-01, T-06). `ballotSteps` are the steps named by the tier's ballot
 * entries whose membership proofs verify against their step's root (verifier
 * 5.1 to 5.3), admitted or not; such a step is one the poll accepts, so one
 * that isn't is the caller's error and throws.
 */
export function rollingTierReport(
  events: readonly RollingTierEvent[],
  ctx: RollingTierContext,
  input: {
    readonly clock: AnchoringClock;
    readonly ballotSteps: readonly bigint[];
    readonly releases: readonly RollingReleaseInput[];
  },
): RollingTierReport {
  const c = checkedContext(ctx);
  if (input === null || typeof input !== "object") throw new TypeError("input: expected an object");
  const { clock: rawClock, ballotSteps, releases } = input;
  if (rawClock === null || typeof rawClock !== "object")
    throw new TypeError("input.clock: expected an object");
  const clock = {
    epoch: uintArg(rawClock.epoch, MAX_U64, "input.clock.epoch"),
    period: uintArg(rawClock.period, MAX_U64, "input.clock.period"),
  };
  if (clock.period === 0n) throw new RangeError("input.clock.period: expected a positive period");
  if (!Array.isArray(ballotSteps)) throw new TypeError("input.ballotSteps: expected an array");
  if (!Array.isArray(releases)) throw new TypeError("input.releases: expected an array");
  const used = ballotSteps.map((n, i) => uintArg(n, MAX_U32, `input.ballotSteps[${i}]`));
  const snapshots = releases.slice().map((r, i) => {
    if (r === null || typeof r !== "object")
      throw new TypeError(`input.releases[${i}]: expected an object`);
    const { segment, snapshotSteps } = r;
    if (!Array.isArray(snapshotSteps))
      throw new TypeError(`input.releases[${i}].snapshotSteps: expected an array`);
    return {
      segment: uintArg(segment, MAX_U32, `input.releases[${i}].segment`),
      snapshotSteps: snapshotSteps.map((n, j) =>
        uintArg(n, MAX_U32, `input.releases[${i}].snapshotSteps[${j}]`),
      ),
    };
  });

  // The newest boundary in the poll at or before `ts`, if any.
  const boundaryIn = (ts: bigint) => {
    const n = rootClockStepAtOrBefore(ts < c.closesAt ? ts : c.closesAt);
    return n !== undefined && rootClockBoundary(n) > c.registeredAt ? n : undefined;
  };
  const nc = boundaryIn(c.closesAt);
  const releaseSteps = snapshots.map((r) => {
    const end = clock.epoch + (r.segment + 1n) * clock.period - 1n;
    const terms = [
      ...(boundaryIn(end) === undefined ? [] : [boundaryIn(end) as bigint]),
      ...r.snapshotSteps,
    ];
    return terms.length === 0 ? undefined : terms.reduce((a, b) => (a > b ? a : b));
  });
  const got = scan(events, c, {
    steps: [
      ...used,
      ...snapshots.flatMap((r) => r.snapshotSteps),
      ...(nc === undefined ? [] : [nc]),
    ],
    eligible: [...releaseSteps.filter((n) => n !== undefined), ...(nc === undefined ? [] : [nc])],
    clock,
    roots: false,
  });
  const stepAt = (n: bigint) => got.steps.get(n) as Scanned<RollingStep>; // every queried step is snapshotted
  for (const n of [...used, ...snapshots.flatMap((r) => r.snapshotSteps)])
    if (!stepAt(n).accepted)
      throw new RangeError(`step ${n}: a verifying ballot's step is one the poll accepts`);
  let smallest: Scanned<RollingStep> | undefined;
  for (const n of ascending(used)) {
    const s = stepAt(n);
    if (smallest === undefined || s.memberCount < smallest.memberCount) smallest = s;
  }
  const eligibleAt = (n: bigint) => got.eligible.get(n) as number; // every queried step is counted
  return {
    opening: { members: got.opening.memberCount },
    eligible: nc === undefined ? 0 : eligibleAt(nc),
    close:
      nc === undefined
        ? null
        : { step: nc, members: stepAt(nc).memberCount, accepted: stepAt(nc).accepted },
    smallestStep:
      smallest === undefined ? null : { step: smallest.step, members: smallest.memberCount },
    growth: got.growth.map(({ period, added, removed, members }) => ({
      period,
      added,
      removed,
      members,
    })),
    releases: releaseSteps.map((n) =>
      n === undefined
        ? { step: null, count: got.opening.memberCount }
        : { step: n, count: eligibleAt(n) },
    ),
  };
}
