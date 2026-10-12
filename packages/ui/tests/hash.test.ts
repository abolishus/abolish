import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import { groupHex } from "../src/components/hash.tsx";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

describe("groupHex", () => {
  it("loses and adds nothing: the groups join back to the value", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[0-9a-f]*$/),
        fc.integer({ min: 1, max: 70 }),
        (value, size) => {
          const groups = groupHex(value, size);
          expect(groups.join("")).toBe(value);
          expect(groups.slice(0, -1).every((g) => g.length === size)).toBe(true);
          expect(groups.every((g) => g.length >= 1 && g.length <= size)).toBe(true);
        },
      ),
      { numRuns },
    );
  });

  it("rejects a group size that isn't a positive integer", () => {
    for (const size of [0, -1, 1.5, Number.NaN])
      expect(() => groupHex("ab", size)).toThrow(RangeError);
  });
});
