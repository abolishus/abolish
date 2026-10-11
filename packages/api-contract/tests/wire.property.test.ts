import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import * as z from "zod/mini";

import { Hash32, hexBytes, MAX_PAGE, PageSize, U64 } from "../src/index.ts";

// fast-check prints the seed and the shrunk counterexample on failure.
const opts = { numRuns: Number(process.env["FC_NUM_RUNS"] ?? 100) };
const U64_MAX = (1n << 64n) - 1n;

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const ok = (schema: z.ZodMiniType, value: unknown) => z.safeParse(schema, value).success;

describe("hex byte strings (T-31: one encoding per byte string)", () => {
  const Small = hexBytes(64);

  test("accepts every byte string up to the bound as lowercase hex", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (b) => ok(Small, toHex(b))),
      opts,
    );
  });

  test("rejects byte strings over the bound", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 65, maxLength: 200 }), (b) => !ok(Small, toHex(b))),
      opts,
    );
  });

  test("rejects uppercase digits, so no byte string has two encodings", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 64 }).filter((b) => /[a-f]/.test(toHex(b))),
        (b) => !ok(Small, toHex(b).toUpperCase()),
      ),
      opts,
    );
  });

  test("rejects odd lengths, prefixes, separators and non-hex characters", () => {
    for (const bad of ["0", "abc", "0x00", "00 ", " 00", "00\n", "0g", "00-11", "٠٠"]) {
      expect(ok(Small, bad), JSON.stringify(bad)).toBe(false);
    }
    expect(ok(Small, 0)).toBe(false);
    expect(ok(Small, "")).toBe(true);
  });

  test("Hash32 takes exactly 32 bytes", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 40 }),
        (b) => ok(Hash32, toHex(b)) === (b.length === 32),
      ),
      opts,
    );
  });
});

describe("u64 decimal strings", () => {
  test("accepts every u64 in canonical decimal", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: U64_MAX }), (n) => ok(U64, n.toString())),
      opts,
    );
    expect(ok(U64, U64_MAX.toString())).toBe(true);
  });

  test("rejects values above 2^64 - 1", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: U64_MAX + 1n, max: 10n ** 20n - 1n }),
        (n) => !ok(U64, n.toString()),
      ),
      opts,
    );
    expect(ok(U64, "1".padEnd(21, "0"))).toBe(false);
  });

  test("rejects non-canonical spellings of a valid value", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: U64_MAX }), (n) =>
        ["0" + n, "+" + n, " " + n, n + " ", n + ".0", "-" + n].every((s) => !ok(U64, s)),
      ),
      opts,
    );
    expect(ok(U64, "")).toBe(false);
    expect(ok(U64, 1)).toBe(false);
  });

  test("page sizes run from 1 to MAX_PAGE", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10, max: 20_000 }),
        (n) => ok(PageSize, String(n)) === (n >= 1 && n <= MAX_PAGE),
      ),
      opts,
    );
    expect(ok(PageSize, "01")).toBe(false);
  });
});
