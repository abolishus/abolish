import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { PARAMETERS } from "../src/index.ts";
import { memberCount, type RollingEvent, rollingLeaves, tau } from "./rolling-tree.ts";
import { SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/rolling-report.json, printed by
// scripts/rolling-report-vectors.py (P2-17 part 2b-1). packages/crypto has no
// rolling tree yet (part 3), so these tests compute each reported count from
// docs/spec/membership.md (Reported counts) directly, over the spec's own
// chain-order leaves (rolling-tree.ts), and compare them with the file's.

interface Report {
  readonly opening: { readonly members: string };
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
  readonly step: string | null;
  readonly members: string;
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

function release(c: Case, segment: string, opening: string): Release {
  const n = boundaryAtOrBefore(min(periodEnd(BigInt(segment)), BigInt(c.closesAt)));
  return tau(n) > BigInt(c.registeredAt)
    ? { segment, step: String(n), members: String(countThrough(c.events, c.groups, tau(n))) }
    : { segment, step: null, members: opening };
}

describe("rolling reports (docs/spec/membership.md, Reported counts)", () => {
  test("carries the root clock's parameters", () => {
    expect(file.format).toBe("abolish-rolling-report-vectors/1");
    expect(file.rootPeriod).toBe(String(PARAMETERS.ROOT_PERIOD));
    expect(file.rootOffset).toBe(String(PARAMETERS.ROOT_OFFSET));
  });

  test.each(file.cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    // Every step an admitted ballot names is one the poll accepts (5.1).
    for (const n of c.ballotSteps) expect(accepted(c, BigInt(n))).toBe(true);
    const got = report(c);
    expect(got).toEqual(c.report);
    expect(c.releases.map((r) => release(c, r.segment, got.opening.members))).toEqual(c.releases);
  });

  test("covers a missing close, an unaccepted close step, a tie, repeats and a release before any step", () => {
    const reports = file.cases.map((c) => c.report);
    expect(reports.some((r) => r.close === null)).toBe(true);
    expect(reports.some((r) => r.close?.accepted === false && r.close.members === "0")).toBe(true);
    expect(reports.some((r) => r.smallestStep === null)).toBe(true);
    expect(file.cases.flatMap((c) => c.releases).some((r) => r.step === null)).toBe(true);
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
    const event = fc.record({
      gap: fc.integer({ min: 0, max: 5000 }),
      group: fc.constantFrom("1", "2", "9"),
      add: fc.array(fc.integer({ min: 1, max: 6 }), { maxLength: 3 }),
      remove: fc.boolean(),
    });
    fc.assert(
      fc.property(
        fc.array(event, { maxLength: 30 }),
        fc.integer({ min: 0, max: 30 }),
        fc.integer({ min: 0, max: 150_000 }),
        (raw, openAt, closeAfter) => {
          const start = epoch - 4000n;
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
});
