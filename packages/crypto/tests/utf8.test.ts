import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import { isWellFormedUtf8 } from "../src/index.ts";

const opts = { numRuns: Number(process.env["FC_NUM_RUNS"] ?? 100) };

// A second, independent definition of well-formed UTF-8: the WHATWG decoder in
// fatal mode accepts exactly RFC 3629's sequences. ignoreBOM keeps a leading
// U+FEFF as text, which matters only to the decoded string, not to validity.
const fatal = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const reference = (b: Uint8Array) => {
  try {
    fatal.decode(b);
    return true;
  } catch {
    return false;
  }
};

describe("isWellFormedUtf8 (RFC 3629)", () => {
  test("accepts every encoded Unicode scalar value string", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (s) => {
        expect(isWellFormedUtf8(new TextEncoder().encode(s))).toBe(true);
      }),
      opts,
    );
  });

  test("agrees with the platform's fatal decoder on random bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 16 }), (b) => {
        expect(isWellFormedUtf8(b)).toBe(reference(b));
      }),
      opts,
    );
  });

  test("agrees with the platform's fatal decoder on every 1- and 2-byte sequence and the 3-byte boundaries", () => {
    // Exhaustive over 1 and 2 bytes. Over 3 bytes, every lead from C0 up and
    // every second byte, with the third byte on either side of the
    // continuation range (80 to BF), where RFC 3629's boundaries are.
    const mismatches: string[] = [];
    const check = (b: Uint8Array) => {
      if (isWellFormedUtf8(b) !== reference(b)) mismatches.push(Buffer.from(b).toString("hex"));
    };
    for (let a = 0; a < 256; a++) {
      check(Uint8Array.of(a));
      for (let b = 0; b < 256; b++) {
        check(Uint8Array.of(a, b));
        if (a < 0xc0) continue;
        for (const c of [0x7f, 0x80, 0xbf, 0xc0]) check(Uint8Array.of(a, b, c));
      }
    }
    expect(mismatches).toEqual([]);
  });

  test.each([
    ["U+10FFFF, the last code point", [0xf4, 0x8f, 0xbf, 0xbf], true],
    ["U+FFFF, a noncharacter but a scalar value", [0xef, 0xbf, 0xbf], true],
    ["U+D7FF, just below the surrogates", [0xed, 0x9f, 0xbf], true],
    ["U+E000, just above the surrogates", [0xee, 0x80, 0x80], true],
    ["U+DFFF, the last surrogate", [0xed, 0xbf, 0xbf], false],
    ["overlong 3-byte U+07FF", [0xe0, 0x9f, 0xbf], false],
    ["overlong 4-byte U+FFFF", [0xf0, 0x8f, 0xbf, 0xbf], false],
    ["4-byte sequence cut short", [0xf0, 0x9f, 0x97], false],
    ["NUL is a character", [0x00], true],
  ])("%s", (_name, bytes, ok) => {
    expect(isWellFormedUtf8(Uint8Array.from(bytes))).toBe(ok);
    expect(reference(Uint8Array.from(bytes))).toBe(ok);
  });
});
