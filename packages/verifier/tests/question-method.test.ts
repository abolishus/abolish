import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import { questionMethod } from "../src/index.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

// election-definition.md, Questions, Methods are limits: the method a result
// names is rendered from the limits the validity proof enforces (8.1).
describe("questionMethod", () => {
  test("names the owner's four methods by their limits", () => {
    expect(questionMethod(0, 1, 4)).toBe("pick one");
    expect(questionMethod(0, 4, 4)).toBe("pick any");
    expect(questionMethod(0, 2, 4)).toBe("pick up to 2");
    expect(questionMethod(2, 2, 4)).toBe("pick exactly 2");
  });

  test("says any other range the rules allow as at least N or N to M", () => {
    expect(questionMethod(1, 1, 3)).toBe("pick exactly 1");
    expect(questionMethod(2, 5, 5)).toBe("pick at least 2");
    expect(questionMethod(2, 4, 6)).toBe("pick 2 to 4");
  });

  test("gives different limits over the same options different methods", () => {
    const limits = fc
      .integer({ min: 2, max: 64 })
      .chain((m) =>
        fc
          .integer({ min: 1, max: m })
          .chain((max) => fc.tuple(fc.integer({ min: 0, max }), fc.constant(max), fc.constant(m))),
      );
    fc.assert(
      fc.property(limits, limits, ([a, b, m], [c, d]) => {
        if (d > m) return;
        fc.pre(a !== c || b !== d);
        expect(questionMethod(a, b, m)).not.toBe(questionMethod(c, d, m));
      }),
      { numRuns },
    );
  });
});
