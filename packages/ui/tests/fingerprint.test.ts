import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import {
  FINGERPRINT_BITS,
  FINGERPRINT_SIZE,
  fingerprintCells,
  type FingerprintCell,
} from "../src/components/fingerprint.tsx";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const hash = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map((bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(""));
const CODES: Record<FingerprintCell, number> = { empty: 0, square: 1, dot: 2, corner: 3 };

/** Reads the 64 bits back out of the left half, the way the glyph drew them. */
function bitsOf(rows: FingerprintCell[][]): string {
  let bits = "";
  for (const row of rows) {
    for (const cell of row.slice(0, FINGERPRINT_SIZE / 2)) {
      bits += CODES[cell].toString(2).padStart(2, "0");
    }
  }
  return bits;
}

const prefixBits = (value: string) =>
  Array.from(value.slice(0, FINGERPRINT_BITS / 4), (d) => d)
    .map((d) => Number.parseInt(d, 16).toString(2).padStart(4, "0"))
    .join("");

describe("fingerprintCells", () => {
  it("is an 8 by 8 grid, mirrored left to right", () => {
    fc.assert(
      fc.property(hash, (value) => {
        const rows = fingerprintCells(value);
        expect(rows).toHaveLength(FINGERPRINT_SIZE);
        for (const row of rows) {
          expect(row).toHaveLength(FINGERPRINT_SIZE);
          expect(row).toEqual(row.toReversed());
        }
      }),
      { numRuns },
    );
  });

  // Every one of the first 64 bits is drawn, so two hashes that differ there
  // always draw differently (T-24).
  it("shows exactly the hash's first 64 bits", () => {
    fc.assert(
      fc.property(hash, (value) => {
        expect(bitsOf(fingerprintCells(value))).toBe(prefixBits(value));
      }),
      { numRuns },
    );
  });

  it("draws hashes that differ in their first 8 bytes differently", () => {
    fc.assert(
      fc.property(hash, fc.integer({ min: 0, max: FINGERPRINT_BITS - 1 }), (value, bit) => {
        const digit = bit >> 2;
        const flipped = (Number.parseInt(value[digit] ?? "0", 16) ^ (8 >> (bit & 3))).toString(16);
        const other = value.slice(0, digit) + flipped + value.slice(digit + 1);
        expect(fingerprintCells(other)).not.toEqual(fingerprintCells(value));
      }),
      { numRuns },
    );
  });

  // Pinned, so the glyph a voter saw yesterday is the one the board shows
  // today: changing the mapping must change this test.
  it("keeps its mapping", () => {
    const rows = fingerprintCells(
      "1b00000000000000ffffffffffffffffffffffffffffffffffffffffffffffff",
    );
    expect(rows[0]).toEqual([
      "empty",
      "square",
      "dot",
      "corner",
      "corner",
      "dot",
      "square",
      "empty",
    ]);
    expect(
      rows
        .slice(1)
        .flat()
        .every((cell) => cell === "empty"),
    ).toBe(true);
  });

  it.each([
    ["too short", "9f86"],
    ["too long", "00".repeat(33)],
    ["uppercase", "AB".repeat(32)],
    ["not hex", "zz".repeat(32)],
  ])("rejects a value that is %s", (_, value) => {
    expect(() => fingerprintCells(value)).toThrow(RangeError);
  });
});
