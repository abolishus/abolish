import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  PARAMETERS,
  POSEIDON2_ZERO_ONE,
  rollingTierReport,
  rollingTierSteps,
  type RollingTierEvent,
  RollingTierTree,
  rootClockBoundary,
  rootClockStepAtOrBefore,
  rootStepFinal,
  rootStepWindow,
  tierTreeRoot,
} from "../src/index.ts";
import { memberCount, type RollingEvent, rollingLeaves, tau, tierEvent } from "./rolling-tree.ts";

// packages/crypto's rolling tier tree and root clock (P2-17 part 3b) against
// docs/spec/membership.md read as a full rebuild per step (rolling-tree.ts):
// the tree updated in chain order is the rebuild's, a step's tree doesn't
// depend on anything after its boundary, and the strict replay's refusals
// are refused here too rather than guessed at.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
// Every root rebuilt from scratch hashes at least 32 Poseidon2 nodes, so the
// properties comparing roots take a fifth of the runs.
const hashedRuns = Math.max(10, Math.floor(numRuns / 5));
const PERIOD = BigInt(PARAMETERS.ROOT_PERIOD);
const START = 1_779_800_000n;

const historyEvent = fc.record({
  gap: fc.integer({ min: 0, max: 900 }),
  group: fc.constantFrom("1", "2", "9"),
  add: fc.array(fc.integer({ min: 1, max: 5 }), { maxLength: 3 }),
  remove: fc.nat(),
  removing: fc.boolean(),
});

/**
 * A strictly replayable history of two listed groups and an unlisted one,
 * with repeats within and across groups, removals of any live member and
 * re-additions of removed commitments; several events may share a block.
 */
function history(
  raw: readonly { gap: number; group: string; add: number[]; remove: number; removing: boolean }[],
): RollingEvent[] {
  const events: RollingEvent[] = [];
  const live = new Map<string, number[]>();
  const size = new Map<string, number>();
  let ts = START;
  let block = 0;
  for (const r of raw) {
    if (r.gap > 0) block++;
    ts += BigInt(r.gap);
    const members = live.get(r.group) ?? [];
    const base = { block: String(block), timestamp: String(ts), group: r.group };
    if (r.removing && members.length > 0) {
      const [i] = members.splice(r.remove % members.length, 1);
      events.push({ ...base, remove: [String(i)] });
    } else if (r.add.length > 0) {
      const n = size.get(r.group) ?? 0;
      members.push(...r.add.map((_, i) => n + i));
      size.set(r.group, n + r.add.length);
      events.push({ ...base, add: r.add.map((v) => String(10n ** 12n + BigInt(v))) });
    }
    live.set(r.group, members);
  }
  return events;
}

const GROUPS = ["1", "2"];
const ctxOf = (events: readonly RollingEvent[], openAt: number, registerAfter: number) => ({
  groups: GROUPS.map(BigInt),
  rootL2Block: BigInt(openAt),
  registeredAt: START + BigInt(registerAfter),
  closesAt: BigInt(events.at(-1)?.timestamp ?? START) + 2n * PERIOD,
});

describe("the rolling tier tree (docs/spec/membership.md, Rolling tier tree)", () => {
  test("the tree updated in chain order is the rebuild of its leaves after every event", () => {
    fc.assert(
      fc.property(
        fc.array(historyEvent, { maxLength: 12 }),
        fc.array(fc.boolean(), { maxLength: 12 }),
        (raw, peeks) => {
          // Roots are hashed where `peeks` says and at the end, so the tree's
          // pending changes are flushed after one event or after many.
          const events = history(raw);
          const tree = new RollingTierTree(GROUPS.map(BigInt));
          for (const [i, e] of events.entries()) {
            tree.apply(tierEvent(e));
            const leaves = rollingLeaves(events.slice(0, i + 1), GROUPS, () => true);
            expect(tree.leaves).toEqual(leaves);
            expect(tree.size).toBe(leaves.length);
            expect(tree.memberCount).toBe(memberCount(leaves));
            if (peeks[i] === true || i === events.length - 1)
              expect(tree.root()).toBe(tierTreeRoot(leaves));
          }
        },
      ),
      { numRuns: hashedRuns },
    );
  }, 120_000);

  test("a step's tree depends on no event after its boundary, and matches the rebuild", () => {
    fc.assert(
      fc.property(
        fc.array(historyEvent, { maxLength: 10 }),
        fc.integer({ min: 0, max: 10 }),
        fc.integer({ min: 0, max: 6000 }),
        fc.array(fc.integer({ min: -2, max: 16 }), { minLength: 1, maxLength: 3 }),
        (raw, openAt, registerAfter, offsets) => {
          const events = history(raw);
          const ctx = ctxOf(events, openAt, registerAfter);
          const base = rootClockStepAtOrBefore(START)!;
          const steps = offsets.map((o) => base + BigInt(o));
          const got = rollingTierSteps(events.map(tierEvent), ctx, steps);
          const opening = rollingLeaves(events, GROUPS, (e) => BigInt(e.block) <= ctx.rootL2Block);
          expect(got.opening).toEqual({
            root: tierTreeRoot(opening),
            memberCount: memberCount(opening),
          });
          expect(got.steps.map((s) => s.step)).toEqual(
            [...new Set(steps)].sort((a, b) => (a < b ? -1 : 1)),
          );
          for (const s of got.steps) {
            const boundary = rootClockBoundary(s.step);
            const leaves = rollingLeaves(events, GROUPS, (e) => BigInt(e.timestamp) <= boundary);
            expect(s.root).toBe(tierTreeRoot(leaves));
            expect(s.memberCount).toBe(memberCount(leaves));
            expect(s.size).toBe(leaves.length);
            expect(s.accepted).toBe(
              boundary > ctx.registeredAt && boundary <= ctx.closesAt && memberCount(leaves) > 0,
            );
            // Dropping every later event leaves the step as it was.
            const before = events.filter((e) => BigInt(e.timestamp) <= boundary);
            const alone = rollingTierSteps(before.map(tierEvent), ctx, [s.step]);
            expect(alone.steps[0]).toEqual(s);
          }
        },
      ),
      { numRuns: hashedRuns },
    );
  }, 120_000);

  test("one secret's repeats, across groups and re-additions, count once", () => {
    const c = 10n ** 12n + 7n;
    const at = (block: number) => ({
      blockNumber: BigInt(block),
      timestamp: START + BigInt(block),
    });
    const tree = new RollingTierTree([1n, 2n]);
    tree.apply({ ...at(0), groupId: 1n, kind: "add", commitments: [c, c] });
    tree.apply({ ...at(1), groupId: 2n, kind: "add", commitments: [c] });
    tree.apply({ ...at(2), groupId: 1n, kind: "remove", indices: [0n] });
    tree.apply({ ...at(3), groupId: 1n, kind: "add", commitments: [c] });
    expect(tree.leaves).toEqual([0n, c, c, c]);
    expect(tree.memberCount).toBe(1);
    // Member 1 of group 1 is leaf 1, never another occurrence of its value.
    tree.apply({ ...at(4), groupId: 1n, kind: "remove", indices: [1n, 2n] });
    expect(tree.leaves).toEqual([0n, 0n, c, 0n]);
    expect(tree.memberCount).toBe(1);
    tree.apply({ ...at(5), groupId: 2n, kind: "remove", indices: [0n] });
    expect(tree.memberCount).toBe(0);
    expect(tree.root()).toBe(tierTreeRoot([0n, 0n, 0n, 0n]));
  });

  test("refuses what the strict replay refuses, and events out of chain order", () => {
    const at = { blockNumber: 1n, timestamp: START };
    const fresh = () => {
      const tree = new RollingTierTree([1n]);
      tree.apply({ ...at, groupId: 1n, kind: "add", commitments: [10n ** 12n] });
      return tree;
    };
    // A group the tier doesn't list changes nothing, whatever it names.
    expect(fresh().apply({ ...at, groupId: 2n, kind: "remove", indices: [5n] })).toEqual({
      appended: [],
      zeroed: [],
    });
    for (const commitment of [0n, 1n, POSEIDON2_ZERO_ONE, 2n ** 254n])
      expect(() =>
        fresh().apply({ ...at, groupId: 1n, kind: "add", commitments: [commitment] }),
      ).toThrow(RangeError);
    const removed = fresh();
    removed.apply({ ...at, groupId: 1n, kind: "remove", indices: [0n] });
    for (const [tree, indices] of [
      [fresh(), [1n]],
      [fresh(), [0n, 0n]],
      [removed, [0n]],
    ] as const)
      expect(() => tree.apply({ ...at, groupId: 1n, kind: "remove", indices })).toThrow(RangeError);
    // A refused removal changes nothing.
    const tree = fresh();
    expect(() => tree.apply({ ...at, groupId: 1n, kind: "remove", indices: [0n, 1n] })).toThrow();
    expect(tree.leaves).toEqual([10n ** 12n]);

    const ctx = { groups: [1n], rootL2Block: 0n, registeredAt: START, closesAt: START + 9000n };
    const add = (blockNumber: bigint, timestamp: bigint): RollingTierEvent => ({
      blockNumber,
      timestamp,
      groupId: 1n,
      kind: "add",
      commitments: [10n ** 12n + blockNumber],
    });
    for (const events of [
      [add(2n, START), add(1n, START)],
      [add(1n, START + 2n), add(2n, START + 1n)],
      [add(1n, START), add(1n, START + 1n)],
    ])
      expect(() => rollingTierSteps(events, ctx, [])).toThrow(RangeError);
    expect(() => rollingTierSteps([add(1n, START), add(1n, START)], ctx, [])).not.toThrow();
  });

  test("refuses a ballot step the poll doesn't accept", () => {
    const ctx = { groups: [1n], rootL2Block: 0n, registeredAt: START, closesAt: START + 9000n };
    const events: RollingTierEvent[] = [
      { blockNumber: 1n, timestamp: START, groupId: 1n, kind: "add", commitments: [10n ** 12n] },
    ];
    const first = rootClockStepAtOrBefore(START)! + 1n;
    const input = (n: bigint) => ({
      clock: { epoch: START, period: 3600n },
      ballotSteps: [n],
      releases: [],
    });
    expect(rollingTierReport(events, ctx, input(first)).smallestStep).toEqual({
      step: first,
      members: 1,
    });
    // Before the registration, and after the close.
    for (const n of [first - 1n, rootClockStepAtOrBefore(START + 9000n)! + 1n])
      expect(() => rollingTierReport(events, ctx, input(n))).toThrow(RangeError);
  });
});

describe("the root clock and the window (docs/spec/membership.md, Root clock and steps)", () => {
  const u32 = fc.bigInt({ min: 0n, max: 0xffff_ffffn });
  const u64 = fc.bigInt({ min: 0n, max: (1n << 64n) - 1n });

  test("boundary n is n · ROOT_PERIOD + ROOT_OFFSET, for n a u32", () => {
    fc.assert(
      fc.property(u32, (n) => {
        expect(rootClockBoundary(n)).toBe(tau(n));
      }),
      { numRuns },
    );
    for (const n of [-1n, 1n << 32n]) expect(() => rootClockBoundary(n)).toThrow(RangeError);
  });

  test("the step at or before a time is the newest boundary not after it", () => {
    fc.assert(
      fc.property(u64, (ts) => {
        const n = rootClockStepAtOrBefore(ts);
        if (n === undefined) {
          expect(ts).toBeLessThan(tau(0n));
          return;
        }
        expect(tau(n)).toBeLessThanOrEqual(ts);
        if (n < 0xffff_ffffn) expect(tau(n + 1n)).toBeGreaterThan(ts);
      }),
      { numRuns },
    );
  });

  test("a step is in the window exactly when t − ROOT_WINDOW < τ_n ≤ t", () => {
    const window = BigInt(PARAMETERS.ROOT_WINDOW);
    fc.assert(
      fc.property(u32, fc.bigInt({ min: -2n * window, max: 2n * window }), (n, d) => {
        const t = tau(n) + d;
        fc.pre(t >= 0n);
        const want = tau(n) > t ? "future" : tau(n) <= t - window ? "stale" : "in";
        expect(rootStepWindow(n, t)).toBe(want);
      }),
      { numRuns },
    );
    // The edges themselves.
    expect(rootStepWindow(1n, tau(1n))).toBe("in");
    expect(rootStepWindow(1n, tau(1n) - 1n)).toBe("future");
    expect(rootStepWindow(1n, tau(1n) + window - 1n)).toBe("in");
    expect(rootStepWindow(1n, tau(1n) + window)).toBe("stale");
  });

  test("a live poll reads a step as final exactly from τ_n + ROOT_FINALITY", () => {
    // Forty minutes, the spec's figure (docs/spec/parameters.md).
    const finality = 2400n;
    expect(BigInt(PARAMETERS.ROOT_FINALITY)).toBe(finality);
    fc.assert(
      fc.property(u32, fc.bigInt({ min: -2n * finality, max: 2n * finality }), (n, d) => {
        const t = tau(n) + d;
        fc.pre(t >= 0n);
        expect(rootStepFinal(n, t)).toBe(d >= finality);
      }),
      { numRuns },
    );
    // The edge, and the step at the head's own time, which never is.
    expect(rootStepFinal(1n, tau(1n) + finality - 1n)).toBe(false);
    expect(rootStepFinal(1n, tau(1n) + finality)).toBe(true);
    expect(rootStepFinal(1n, tau(1n))).toBe(false);
    for (const [n, t] of [
      [-1n, 0n],
      [1n << 32n, 0n],
      [0n, -1n],
      [0n, 1n << 64n],
    ] as const)
      expect(() => rootStepFinal(n, t)).toThrow(RangeError);
  });
});
