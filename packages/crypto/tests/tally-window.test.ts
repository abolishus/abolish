import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  COMPLAINT_WINDOW,
  CONTRACT_EVENT_WINDOW,
  countedExtent,
  type DeadlineClock,
  deliverySegments,
  PARAMETERS,
} from "../src/index.ts";

// docs/spec/vectors/tally-window.json comes from an independent Python
// implementation of docs/spec/tally.md, Tally window
// (scripts/tally-window-vectors.py, which finds each moment's period by
// walking the clock rather than dividing), so these segments and times never
// come from the code under test.

interface Vectors {
  readonly format: string;
  readonly windows: Readonly<
    Record<"complaint" | "contractEvent" | "boarding" | "counted", string>
  >;
  readonly cases: readonly {
    readonly id: string;
    readonly clock: Readonly<Record<keyof DeadlineClock, string>>;
    readonly closesAt: string;
    readonly l1InclusionBound: string;
    readonly segment: string;
    readonly due: string;
  }[];
}

const V = JSON.parse(
  readFileSync(new URL("../../../docs/spec/vectors/tally-window.json", import.meta.url), "utf8"),
) as Vectors;

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const W_S = COMPLAINT_WINDOW + CONTRACT_EVENT_WINDOW;

const clockOf = (c: Readonly<Record<keyof DeadlineClock, string>>): DeadlineClock => ({
  epoch: BigInt(c.epoch),
  period: BigInt(c.period),
  deadline: BigInt(c.deadline),
});

describe("tally-window vectors", () => {
  test("file format and windows", () => {
    expect(V.format).toBe("abolish-tally-window-vectors/1");
    expect(BigInt(V.windows.complaint)).toBe(COMPLAINT_WINDOW);
    expect(BigInt(V.windows.contractEvent)).toBe(CONTRACT_EVENT_WINDOW);
    expect(Number(V.windows.boarding)).toBe(PARAMETERS.BOARDING_WINDOW);
    expect(BigInt(V.windows.counted)).toBe(W_S);
  });

  test("s_S and t_S are the file's", () => {
    for (const c of V.cases)
      expect(
        countedExtent(clockOf(c.clock), BigInt(c.closesAt), BigInt(c.l1InclusionBound)),
        c.id,
      ).toEqual({ segment: BigInt(c.segment), due: BigInt(c.due) });
  });
});

describe("countedExtent", () => {
  test("the contract-event window is the sum tally.md names", () => {
    // Forced inclusion at the sequencing ceiling's 12-second L1 blocks, an hour
    // of missed slots, half an hour of L1 finality, then the boarding window
    // (docs/spec/parameters.md; T-50, T-53).
    expect(CONTRACT_EVENT_WINDOW).toBe(
      BigInt(PARAMETERS.MAX_SEQUENCING_WINDOW * 12 + 3600 + 1800 + PARAMETERS.BOARDING_WINDOW),
    );
    expect(CONTRACT_EVENT_WINDOW).toBe(14n * 3600n);
  });

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
  const periodOf = (c: DeadlineClock, t: bigint) => (t - c.epoch) / c.period;

  test("the extent holds every record in time and boarded within W_C, and no more segments", () => {
    fc.assert(
      fc.property(timings, ([clock, sinceEpoch, bound]) => {
        const closesAt = clock.epoch + sinceEpoch;
        const { segment, due } = countedExtent(clock, closesAt, bound);
        const end = clock.epoch + (segment + 1n) * clock.period;
        // A complaint sent at t_K and boarded within W_C, and so every earlier
        // record, is in a segment at or before s_S, as is a ballot cast in
        // close's period that carries the next segment (board.md, client rule 1).
        expect(end).toBeGreaterThan(closesAt + bound + W_S);
        expect(segment).toBeGreaterThanOrEqual(periodOf(clock, closesAt) + 1n);
        expect(segment).toBeGreaterThanOrEqual(deliverySegments(clock, closesAt, bound).complaint);
        // The least such segment: either the floor, or one whose start is at
        // or before the window's end.
        expect(
          segment === periodOf(clock, closesAt) + 1n ||
            clock.epoch + segment * clock.period <= closesAt + bound + W_S,
        ).toBe(true);
        expect(due).toBe(end + clock.deadline);
      }),
      { numRuns },
    );
  });

  test("a later close or a longer bound never moves the extent earlier", () => {
    fc.assert(
      fc.property(timings, fc.bigInt({ min: 0n, max: 1n << 20n }), ([clock, since, bound], d) => {
        const closesAt = clock.epoch + since;
        const at = countedExtent(clock, closesAt, bound);
        const later = countedExtent(clock, closesAt + d, bound);
        const longer = countedExtent(clock, closesAt, bound + d);
        expect(later.segment).toBeGreaterThanOrEqual(at.segment);
        expect(longer.segment).toBeGreaterThanOrEqual(at.segment);
        expect(later.due).toBeGreaterThanOrEqual(at.due);
      }),
      { numRuns },
    );
  });

  test("refuses a clock, close or bound out of range", () => {
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
      expect(() => countedExtent(c as DeadlineClock, closesAt as bigint, bound as bigint)).toThrow(
        RangeError,
      );
    // The close at the epoch itself is the earliest accepted.
    expect(countedExtent(clock, 1000n, 0n).segment).toBe(W_S / 3600n);
  });
});
