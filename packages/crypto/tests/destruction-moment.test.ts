import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  COMPLAINT_WINDOW,
  CONTRACT_EVENT_WINDOW,
  countedExtent,
  type DeadlineClock,
  destructionMoment,
  PARAMETERS,
  TALLY_WINDOW,
} from "../src/index.ts";

// docs/spec/vectors/destruction-moment.json comes from an independent Python
// implementation of docs/spec/tally.md, Destruction, When
// (scripts/destruction-moment-vectors.py, which finds each moment's period by
// walking the clock rather than dividing), so these segments and times never
// come from the code under test.

interface Vectors {
  readonly format: string;
  readonly windows: Readonly<Record<"counted" | "tally", string>>;
  readonly cases: readonly {
    readonly id: string;
    readonly clock: Readonly<Record<keyof DeadlineClock, string>>;
    readonly closesAt: string;
    readonly l1InclusionBound: string;
    readonly countedSegment: string;
    readonly countedDue: string;
    readonly segment: string;
    readonly due: string;
  }[];
}

const V = JSON.parse(
  readFileSync(
    new URL("../../../docs/spec/vectors/destruction-moment.json", import.meta.url),
    "utf8",
  ),
) as Vectors;

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const clockOf = (c: Readonly<Record<keyof DeadlineClock, string>>): DeadlineClock => ({
  epoch: BigInt(c.epoch),
  period: BigInt(c.period),
  deadline: BigInt(c.deadline),
});

describe("destruction-moment vectors", () => {
  test("file format and windows", () => {
    expect(V.format).toBe("abolish-destruction-moment-vectors/1");
    expect(BigInt(V.windows.counted)).toBe(COMPLAINT_WINDOW + CONTRACT_EVENT_WINDOW);
    expect(BigInt(V.windows.tally)).toBe(TALLY_WINDOW);
    expect(TALLY_WINDOW).toBe(BigInt(PARAMETERS.TALLY_WINDOW));
  });

  test("s_S, t_S, s_T and t_D are the file's", () => {
    for (const c of V.cases) {
      const clock = clockOf(c.clock);
      const closesAt = BigInt(c.closesAt);
      const bound = BigInt(c.l1InclusionBound);
      expect(countedExtent(clock, closesAt, bound), c.id).toEqual({
        segment: BigInt(c.countedSegment),
        due: BigInt(c.countedDue),
      });
      expect(destructionMoment(clock, closesAt, bound), c.id).toEqual({
        segment: BigInt(c.segment),
        due: BigInt(c.due),
      });
    }
  });

  test("the file has a case where each side of t_D's maximum is strictly the later, and a tie", () => {
    const sides = V.cases.map((c) => {
      const clock = clockOf(c.clock);
      const end = BigInt(c.countedDue) + TALLY_WINDOW;
      const anchored = clock.epoch + BigInt(c.segment) * clock.period + clock.deadline;
      return end > anchored ? "window" : anchored > end ? "anchoring" : "tie";
    });
    expect(new Set(sides)).toEqual(new Set(["window", "anchoring", "tie"]));
  });
});

describe("destructionMoment", () => {
  const clocks = fc.record({
    epoch: fc.bigInt({ min: 0n, max: 1n << 40n }),
    period: fc.oneof(fc.bigInt({ min: 1n, max: 7200n }), fc.bigInt({ min: 1n, max: 1n << 21n })),
    deadline: fc.bigInt({ min: 0n, max: 1n << 20n }),
  });
  const timings = fc.tuple(
    clocks,
    fc.bigInt({ min: 0n, max: 1n << 36n }),
    fc.bigInt({ min: 0n, max: 7200n }),
  );

  test("s_T holds the tally window's end, and t_D is the later of it and segment s_T − 1's anchoring deadline", () => {
    fc.assert(
      fc.property(timings, ([clock, since, bound]) => {
        const closesAt = clock.epoch + since;
        const counted = countedExtent(clock, closesAt, bound);
        const end = counted.due + TALLY_WINDOW;
        const { segment, due } = destructionMoment(clock, closesAt, bound);
        const start = clock.epoch + segment * clock.period;
        expect(start).toBeLessThanOrEqual(end);
        expect(start + clock.period).toBeGreaterThan(end);
        // s_T is past the counted extent, so segment s_T − 1 exists.
        expect(segment).toBeGreaterThan(counted.segment);
        expect(due).toBeGreaterThanOrEqual(end);
        expect(due).toBeGreaterThanOrEqual(start + clock.deadline);
        expect(due === end || due === start + clock.deadline).toBe(true);
      }),
      { numRuns },
    );
  });

  test("a later close or a longer bound never moves s_T or t_D earlier", () => {
    fc.assert(
      fc.property(timings, fc.bigInt({ min: 0n, max: 1n << 20n }), ([clock, since, bound], d) => {
        const closesAt = clock.epoch + since;
        const at = destructionMoment(clock, closesAt, bound);
        for (const later of [
          destructionMoment(clock, closesAt + d, bound),
          destructionMoment(clock, closesAt, bound + d),
        ]) {
          expect(later.segment).toBeGreaterThanOrEqual(at.segment);
          expect(later.due).toBeGreaterThanOrEqual(at.due);
        }
      }),
      { numRuns },
    );
  });

  test("refuses what countedExtent refuses", () => {
    const clock = { epoch: 1000n, period: 3600n, deadline: 43_200n };
    for (const [c, closesAt, bound] of [
      [{ ...clock, period: 0n }, 2000n, 600n],
      [{ ...clock, epoch: -1n }, 2000n, 600n],
      [{ ...clock, deadline: -1n }, 2000n, 600n],
      [clock, 999n, 600n],
      [clock, 2000n, -1n],
      [{ ...clock, period: 3600 }, 2000n, 600n],
      [clock, 2000, 600n],
    ] as const)
      expect(() =>
        destructionMoment(c as DeadlineClock, closesAt as bigint, bound as bigint),
      ).toThrow(RangeError);
  });
});
