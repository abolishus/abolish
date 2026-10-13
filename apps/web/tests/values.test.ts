import { shortCode } from "@abolishus/core/short-codes";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import {
  fromHex,
  isCanonicalU64,
  isElectionId,
  isShortCode,
  normalizeElectionId,
  searchText,
  toHex,
} from "../src/values.ts";

const runs = { numRuns: Number(process.env["FC_NUM_RUNS"] ?? 100) };
const U64_MAX = (1n << 64n) - 1n;

describe("hex", () => {
  test("round-trips any bytes through lowercase hex", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
        const hex = toHex(bytes);
        expect(hex).toMatch(/^(?:[0-9a-f]{2})*$/);
        expect(fromHex(hex)).toEqual(bytes);
      }),
      runs,
    );
  });

  test.each(["0", "abc", "AB", "0x00", "g0", " 00", "00 "])("rejects %j", (hex) => {
    expect(() => fromHex(hex)).toThrow(RangeError);
  });
});

describe("election IDs", () => {
  const id = fc.uint8Array({ minLength: 32, maxLength: 32 }).map(toHex);

  test("accept exactly 32 bytes of lowercase hex", () => {
    fc.assert(
      fc.property(id, (hex) => {
        expect(isElectionId(hex)).toBe(true);
        expect(isElectionId(hex.toUpperCase())).toBe(/^[0-9]*$/.test(hex));
        expect(isElectionId(hex.slice(2))).toBe(false);
        expect(isElectionId(`${hex}00`)).toBe(false);
        expect(isElectionId(`0x${hex}`)).toBe(false);
      }),
      runs,
    );
  });

  test("a pasted ID normalises to the one spelling that names it", () => {
    fc.assert(
      fc.property(
        id,
        fc.boolean(),
        fc.boolean(),
        fc.constantFrom("", " ", "\t", "\n "),
        (hex, upper, prefix, pad) => {
          const pasted = `${pad}${prefix ? "0x" : ""}${upper ? hex.toUpperCase() : hex}${pad}`;
          expect(normalizeElectionId(pasted)).toBe(hex);
        },
      ),
      runs,
    );
  });

  test("anything else normalises to nothing", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (s) => {
        const normalized = normalizeElectionId(s);
        if (normalized !== undefined) expect(isElectionId(normalized)).toBe(true);
      }),
      runs,
    );
    expect(normalizeElectionId("0x")).toBeUndefined();
    expect(normalizeElectionId("ab".repeat(31))).toBeUndefined();
    expect(normalizeElectionId(`${"ab".repeat(32)}z`)).toBeUndefined();
  });
});

describe("u64", () => {
  test("accepts every u64 in canonical decimal", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: U64_MAX }), (n) => {
        expect(isCanonicalU64(n.toString())).toBe(true);
      }),
      runs,
    );
  });

  test.each(["", "-1", "01", "+1", "1.0", "1e3", " 1", "18446744073709551616", "0x10"])(
    "rejects %j",
    (s) => {
      expect(isCanonicalU64(s)).toBe(false);
    },
  );

  test("rejects anything but a string", () => {
    for (const v of [0, 1n, null, undefined, ["1"]]) expect(isCanonicalU64(v)).toBe(false);
  });
});

describe("searchText", () => {
  test("gives back the text the router parsed a number or boolean from", () => {
    fc.assert(
      fc.property(fc.oneof(fc.integer(), fc.boolean(), fc.string()), (v) => {
        expect(searchText(v)).toBe(String(v));
      }),
      runs,
    );
  });

  test("gives nothing for objects", () => {
    expect(searchText({ a: 1 })).toBeUndefined();
    expect(searchText(["1"])).toBeUndefined();
    expect(searchText(null)).toBeUndefined();
  });
});

describe("short codes", () => {
  const code = fc
    .tuple(fc.uint8Array({ minLength: 32, maxLength: 32 }), fc.integer({ min: 7, max: 52 }))
    .map(([hash, length]) => shortCode(hash, length));

  test("accept every code in its canonical form, and no other spelling of it", () => {
    fc.assert(
      fc.property(code, (c) => {
        expect(isShortCode(c)).toBe(true);
        const upper = c.toUpperCase();
        expect(isShortCode(upper)).toBe(upper === c);
        expect(isShortCode(` ${c}`)).toBe(false);
      }),
      runs,
    );
  });

  test.each(["", "3j55dw", "3j55dwu", "3j55dwo", "3J55DW1", "3".repeat(53), 7, null, undefined])(
    "rejects %j",
    (value) => {
      expect(isShortCode(value)).toBe(false);
    },
  );
});
