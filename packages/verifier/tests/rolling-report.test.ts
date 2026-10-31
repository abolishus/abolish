import { PARAMETERS } from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import { smallCount } from "../src/rolling-report.ts";

// 8.2's small count (docs/spec/verifier.md, 8.2; parameters.md, SMALL_COUNT).
describe("smallCount", () => {
  test("flags 1 to SMALL_COUNT − 1 and never 0, which opens no vote, nor SMALL_COUNT", () => {
    expect(PARAMETERS.SMALL_COUNT).toBe(20);
    expect([0, 1, 19, 20, 21].map(smallCount)).toEqual([false, true, true, false, false]);
  });

  test("is exactly 1 ≤ count < SMALL_COUNT", () => {
    fc.assert(
      fc.property(fc.nat({ max: 10_000 }), (n) => {
        expect(smallCount(n)).toBe(n >= 1 && n < PARAMETERS.SMALL_COUNT);
      }),
      { numRuns: Number(process.env.FC_NUM_RUNS ?? 100) },
    );
  });
});
