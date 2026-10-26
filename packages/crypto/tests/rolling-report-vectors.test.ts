import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { PARAMETERS, rollingTierReport } from "../src/index.ts";
import { memberCount, type RollingEvent, rollingLeaves, tau, tierEvent } from "./rolling-tree.ts";
import { SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/rolling-report.json, printed by
// scripts/rolling-report-vectors.py (P2-17 part 2b-1). Each reported count is
// computed twice: by packages/crypto's one pass (`rollingTierReport`, part 3b),
// and by `report` below, which reads docs/spec/membership.md (Reported counts)
// directly as a rebuild per step over the spec's own chain-order leaves
// (rolling-tree.ts). Both must give the file's values, and the property test
// holds them equal over arbitrary histories.

interface Report {
  readonly opening: { readonly members: string };
  readonly eligible: string;
  readonly close: {
    readonly step: string;
    readonly members: string;
    readonly accepted: boolean;
  } | null;
  readonly smallestStep: { readonly step: string; readonly members: string } | null;
  readonly growth: readonly {
    readonly period: string;
    readonly added: string;
    readonly removed: string;
    readonly members: string;
  }[];
}

interface Release {
  readonly segment: string;
  readonly snapshotSteps: readonly string[];
  readonly step: string | null;
  readonly count: string;
}

interface Case {
  readonly id: string;
  readonly groups: readonly string[];
  readonly events: readonly RollingEvent[];
  readonly rootL2Block: string;
  readonly registeredAt: string;
  readonly closesAt: string;
  readonly ballotSteps: readonly string[];
  readonly report: Report;
  readonly releases: readonly Release[];
}

interface ReportFile {
  readonly format: string;
  readonly rootPeriod: string;
  readonly rootOffset: string;
  readonly clock: { readonly epoch: string; readonly period: string };
  readonly cases: readonly Case[];
}

const file = JSON.parse(
  readFileSync(new URL("rolling-report.json", SPEC_VECTORS), "utf8"),
) as ReportFile;
const epoch = BigInt(file.clock.epoch);
const period = BigInt(file.clock.period);
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const floorDiv = (a: bigint, b: bigint) => (a >= 0n ? a / b : -((-a + b - 1n) / b));
const periodOf = (ts: bigint) => floorDiv(ts - epoch, period);
const periodEnd = (s: bigint) => epoch + (s + 1n) * period - 1n;
/** The newest boundary at or before `ts`. */
const boundaryAtOrBefore = (ts: bigint) =>
  floorDiv(ts - BigInt(PARAMETERS.ROOT_OFFSET), BigInt(PARAMETERS.ROOT_PERIOD));
const min = (a: bigint, b: bigint) => (a < b ? a : b);

type Events = readonly RollingEvent[];

const countThrough = (events: Events, groups: readonly string[], ts: bigint) =>
  memberCount(rollingLeaves(events, groups, (e) => BigInt(e.timestamp) <= ts));

function accepted(c: Case, n: bigint): boolean {
  const leaves = rollingLeaves(c.events, c.groups, (e) => BigInt(e.timestamp) <= tau(n));
  return (
    tau(n) > BigInt(c.registeredAt) &&
    tau(n) <= BigInt(c.closesAt) &&
    leaves.length <= 2 ** 32 &&
    memberCount(leaves) > 0
  );
}

/** `E(n)`: distinct commitments live at some accepted step `m ≤ n`. */
function eligible(c: Case, n: bigint): number {
  const seen = new Set<bigint>();
  for (let m = boundaryAtOrBefore(BigInt(c.registeredAt)) + 1n; m <= n; m++) {
    if (!accepted(c, m)) continue;
    for (const x of rollingLeaves(c.events, c.groups, (e) => BigInt(e.timestamp) <= tau(m)))
      if (x !== 0n) seen.add(x);
  }
  return seen.size;
}

/** docs/spec/membership.md, Reported counts. */
function report(c: Case): Report {
  const closesAt = BigInt(c.closesAt);
  const registeredAt = BigInt(c.registeredAt);
  const stepCount = (n: bigint) => countThrough(c.events, c.groups, tau(n));
  const nc = boundaryAtOrBefore(closesAt);
  const steps = [...new Set(c.ballotSteps.map(BigInt))].sort((a, b) => (a < b ? -1 : 1));
  const smallest = steps.reduce<bigint | undefined>(
    (best, n) => (best === undefined || stepCount(n) < stepCount(best) ? n : best),
    undefined,
  );
  const rows = new Map<bigint, { added: number; removed: number }>();
  for (const e of c.events) {
    const ts = BigInt(e.timestamp);
    if (!c.groups.includes(e.group) || BigInt(e.block) <= BigInt(c.rootL2Block) || ts > closesAt)
      continue;
    if ((e.add?.length ?? 0) + (e.remove?.length ?? 0) === 0) continue;
    const s = periodOf(ts);
    const row = rows.get(s) ?? { added: 0, removed: 0 };
    row.added += e.add?.length ?? 0;
    row.removed += e.remove?.length ?? 0;
    rows.set(s, row);
  }
  return {
    opening: {
      members: String(
        memberCount(
          rollingLeaves(c.events, c.groups, (e) => BigInt(e.block) <= BigInt(c.rootL2Block)),
        ),
      ),
    },
    eligible: String(tau(nc) > registeredAt ? eligible(c, nc) : 0),
    close:
      tau(nc) > registeredAt
        ? { step: String(nc), members: String(stepCount(nc)), accepted: accepted(c, nc) }
        : null,
    smallestStep:
      smallest === undefined
        ? null
        : { step: String(smallest), members: String(stepCount(smallest)) },
    growth: [...rows.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([s, r]) => ({
        period: String(s),
        added: String(r.added),
        removed: String(r.removed),
        members: String(countThrough(c.events, c.groups, min(periodEnd(s), closesAt))),
      })),
  };
}

/** packages/crypto's report of `c`, in the file's form. */
function production(c: Case): { report: Report; releases: Release[] } {
  const got = rollingTierReport(
    c.events.map(tierEvent),
    {
      groups: c.groups.map(BigInt),
      rootL2Block: BigInt(c.rootL2Block),
      registeredAt: BigInt(c.registeredAt),
      closesAt: BigInt(c.closesAt),
    },
    {
      clock: { epoch, period },
      ballotSteps: c.ballotSteps.map(BigInt),
      releases: c.releases.map((r) => ({
        segment: BigInt(r.segment),
        snapshotSteps: r.snapshotSteps.map(BigInt),
      })),
    },
  );
  return {
    report: {
      opening: { members: String(got.opening.members) },
      eligible: String(got.eligible),
      close:
        got.close === null
          ? null
          : {
              step: String(got.close.step),
              members: String(got.close.members),
              accepted: got.close.accepted,
            },
      smallestStep:
        got.smallestStep === null
          ? null
          : { step: String(got.smallestStep.step), members: String(got.smallestStep.members) },
      growth: got.growth.map((g) => ({
        period: String(g.period),
        added: String(g.added),
        removed: String(g.removed),
        members: String(g.members),
      })),
    },
    releases: c.releases.map((r, i) => ({
      ...r,
      step: got.releases[i]!.step === null ? null : String(got.releases[i]!.step),
      count: String(got.releases[i]!.count),
    })),
  };
}

function release(c: Case, r: Release, opening: string): Release {
  const n = boundaryAtOrBefore(min(periodEnd(BigInt(r.segment)), BigInt(c.closesAt)));
  const terms = [...(tau(n) > BigInt(c.registeredAt) ? [n] : []), ...r.snapshotSteps.map(BigInt)];
  if (terms.length === 0) return { ...r, step: null, count: opening };
  const newest = terms.reduce((a, b) => (a > b ? a : b));
  return { ...r, step: String(newest), count: String(eligible(c, newest)) };
}

const start = epoch - 4000n;
const historyEvent = fc.record({
  gap: fc.integer({ min: 0, max: 5000 }),
  group: fc.constantFrom("1", "2", "9"),
  add: fc.array(fc.integer({ min: 1, max: 6 }), { maxLength: 3 }),
  remove: fc.boolean(),
});

/**
 * A strictly replayable history of two listed groups and one unlisted one
 * from `start`, with commitments that repeat within and across groups, and
 * removals of the oldest live member.
 */
function history(
  raw: readonly { gap: number; group: string; add: number[]; remove: boolean }[],
): RollingEvent[] {
  const events: RollingEvent[] = [];
  const live = new Map<string, number[]>();
  const size = new Map<string, number>();
  let ts = start;
  raw.forEach((r, block) => {
    ts += BigInt(r.gap);
    const members = live.get(r.group) ?? [];
    const base = { block: String(block), timestamp: String(ts), group: r.group };
    if (r.remove && members.length > 0) {
      events.push({ ...base, remove: [String(members.shift())] });
    } else if (r.add.length > 0) {
      const n = size.get(r.group) ?? 0;
      members.push(...r.add.map((_, i) => n + i));
      size.set(r.group, n + r.add.length);
      events.push({ ...base, add: r.add.map((v) => String(10n ** 12n + BigInt(v))) });
    }
    live.set(r.group, members);
  });
  return events;
}

describe("rolling reports (docs/spec/membership.md, Reported counts)", () => {
  test("carries the root clock's parameters", () => {
    expect(file.format).toBe("abolish-rolling-report-vectors/1");
    expect(file.rootPeriod).toBe(String(PARAMETERS.ROOT_PERIOD));
    expect(file.rootOffset).toBe(String(PARAMETERS.ROOT_OFFSET));
  });

  test.each(file.cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    // Every step a ballot with a verifying proof names is one the poll
    // accepts (5.1).
    for (const n of [...c.ballotSteps, ...c.releases.flatMap((r) => r.snapshotSteps)])
      expect(accepted(c, BigInt(n))).toBe(true);
    const got = report(c);
    expect(got).toEqual(c.report);
    expect(c.releases.map((r) => release(c, r, got.opening.members))).toEqual(c.releases);
    expect(production(c)).toEqual({ report: c.report, releases: c.releases });
    // Ballots never outnumber the eligible count, at the end or at a release.
    expect(new Set(c.ballotSteps).size).toBeLessThanOrEqual(Number(got.eligible));
  });

  test("covers a missing close, an unaccepted close step, a tie, repeats and a release before any step", () => {
    const reports = file.cases.map((c) => c.report);
    expect(reports.some((r) => r.close === null)).toBe(true);
    expect(reports.some((r) => r.close?.accepted === false && r.close.members === "0")).toBe(true);
    expect(reports.some((r) => r.smallestStep === null)).toBe(true);
    expect(file.cases.flatMap((c) => c.releases).some((r) => r.step === null)).toBe(true);
    // A tier whose ballots outnumber its close count, never its eligible count.
    expect(
      file.cases.some(
        (c) =>
          c.report.close !== null && new Set(c.ballotSteps).size > Number(c.report.close.members),
      ),
    ).toBe(true);
    // A snapshot holding a ballot that names a step after its period.
    expect(
      file.cases.some((c) =>
        c.releases.some(
          (r) =>
            r.snapshotSteps.length > 0 &&
            tau(BigInt(r.step!)) > min(periodEnd(BigInt(r.segment)), BigInt(c.closesAt)),
        ),
      ),
    ).toBe(true);
    // A tie on the smallest count reports the lower step.
    const tied = file.cases.find((c) => {
      const counts = c.ballotSteps.map((n) => countThrough(c.events, c.groups, tau(BigInt(n))));
      const least = Math.min(...counts);
      return new Set(c.ballotSteps.filter((_, i) => counts[i] === least)).size > 1;
    });
    expect(tied).toBeDefined();
    // A repeated commitment keeps two live leaves at a step a ballot names,
    // and counts once.
    expect(
      file.cases.some((c) =>
        c.ballotSteps.some((n) => {
          const leaves = rollingLeaves(
            c.events,
            c.groups,
            (e) => BigInt(e.timestamp) <= tau(BigInt(n)),
          );
          return leaves.filter((x) => x !== 0n).length > memberCount(leaves);
        }),
      ),
    ).toBe(true);
  });

  test("growth accounts for every leaf appended and zeroed between the opening and the close", () => {
    // Over arbitrary strictly replayable histories of two listed groups and
    // one unlisted one, the rows' totals are exactly the leaves appended and
    // zeroed after the opening block, up to the close, and the last row's
    // members is the count over every event up to the close.
    fc.assert(
      fc.property(
        fc.array(historyEvent, { maxLength: 30 }),
        fc.integer({ min: 0, max: 30 }),
        fc.integer({ min: 0, max: 150_000 }),
        (raw, openAt, closeAfter) => {
          const events = history(raw);
          const closesAt = start + BigInt(closeAfter);
          const c: Case = {
            id: "property",
            groups: ["1", "2"],
            events,
            rootL2Block: String(openAt),
            registeredAt: String(start),
            closesAt: String(closesAt),
            ballotSteps: [],
            report: undefined as never,
            releases: [],
          };
          const got = report(c);
          const after = (e: RollingEvent) =>
            c.groups.includes(e.group) &&
            BigInt(e.block) > BigInt(openAt) &&
            BigInt(e.timestamp) <= closesAt;
          const added = events.filter(after).reduce((n, e) => n + (e.add?.length ?? 0), 0);
          const removed = events.filter(after).reduce((n, e) => n + (e.remove?.length ?? 0), 0);
          expect(got.growth.reduce((n, g) => n + Number(g.added), 0)).toBe(added);
          expect(got.growth.reduce((n, g) => n + Number(g.removed), 0)).toBe(removed);
          const last = got.growth.at(-1);
          if (last !== undefined)
            expect(last.members).toBe(String(countThrough(events, c.groups, closesAt)));
          // No row without an event, and rows in period order.
          expect(got.growth.every((g) => g.added !== "0" || g.removed !== "0")).toBe(true);
          const periods = got.growth.map((g) => BigInt(g.period));
          expect(periods.every((p, i) => i === 0 || p > periods[i - 1]!)).toBe(true);
        },
      ),
      { numRuns },
    );
  });
  test("the one pass gives the spec's per-step report over arbitrary histories", () => {
    // packages/crypto's incremental report against the rebuild per step
    // above, with the registration anywhere in the history, ballots naming
    // accepted steps and releases at any segment.
    fc.assert(
      fc.property(
        fc.array(historyEvent, { maxLength: 30 }),
        fc.integer({ min: 0, max: 30 }),
        fc.integer({ min: 0, max: 40_000 }),
        fc.integer({ min: 0, max: 60_000 }),
        fc.array(fc.nat(), { maxLength: 4 }),
        fc.array(
          fc.record({
            segment: fc.integer({ min: 0, max: 30 }),
            picks: fc.array(fc.nat(), { maxLength: 2 }),
          }),
          { maxLength: 3 },
        ),
        (raw, openAt, registerAfter, openFor, ballotPicks, releasePicks) => {
          const registeredAt = start + BigInt(registerAfter);
          const c: Case = {
            id: "property",
            groups: ["1", "2"],
            events: history(raw),
            rootL2Block: String(openAt),
            registeredAt: String(registeredAt),
            closesAt: String(registeredAt + BigInt(openFor)),
            ballotSteps: [],
            report: undefined as never,
            releases: [],
          };
          const first = boundaryAtOrBefore(registeredAt) + 1n;
          const last = boundaryAtOrBefore(BigInt(c.closesAt));
          const open: string[] = [];
          for (let n = first; n <= last; n++) if (accepted(c, n)) open.push(String(n));
          const pick = (i: number) => open[i % open.length]!;
          const withSteps: Case = {
            ...c,
            ballotSteps: open.length === 0 ? [] : ballotPicks.map(pick),
            releases: releasePicks.map((r) => ({
              segment: String(r.segment),
              snapshotSteps: open.length === 0 ? [] : r.picks.map(pick),
              step: null,
              count: "",
            })),
          };
          const want = report(withSteps);
          expect(production(withSteps)).toEqual({
            report: want,
            releases: withSteps.releases.map((r) => release(withSteps, r, want.opening.members)),
          });
        },
      ),
      { numRuns },
    );
  });
});
