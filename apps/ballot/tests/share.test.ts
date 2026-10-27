// The short link "Ask others" offers (src/share.ts): a served code is taken
// only as a prefix of the registered definition hash, in its one canonical
// spelling, so it is at least this poll's (T-34). The expected codes come
// from a BigInt reading of the hash, not from the code under test, and from
// `packages/core`'s published examples.

import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import { isCodeOf, shortLink } from "../src/share.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** All 52 characters of `hash`'s code, read as one 260-bit number (256 bits and 4 of padding). */
function oracle(hash: Uint8Array): string {
  let n = 0n;
  for (const byte of hash) n = (n << 8n) | BigInt(byte);
  n <<= 4n;
  let code = "";
  for (let i = 51; i >= 0; i--) code += ALPHABET[Number((n >> BigInt(5 * i)) & 31n)];
  return code;
}

const hash = fc.uint8Array({ minLength: 32, maxLength: 32 });

describe("isCodeOf", () => {
  test("takes packages/core's examples", () => {
    expect(isCodeOf("0000000", new Uint8Array(32))).toBe(true);
    expect(isCodeOf("zzzzzzz", new Uint8Array(32).fill(0xff))).toBe(true);
    expect(isCodeOf(`${"z".repeat(51)}g`, new Uint8Array(32).fill(0xff))).toBe(true);
    const h = new Uint8Array(32);
    h.set([0x8c, 0xa5, 0x2b, 0x77, 0x02]);
    expect(isCodeOf("hjjjpxr", h)).toBe(true);
    expect(isCodeOf("hjjjpxs", h)).toBe(false);
  });

  test("takes every prefix of 7 to 52 characters of the hash's code", () => {
    fc.assert(
      fc.property(hash, fc.integer({ min: 7, max: 52 }), (h, n) => {
        expect(isCodeOf(oracle(h).slice(0, n), h)).toBe(true);
      }),
      { numRuns },
    );
  });

  test("refuses a code too short, too long or of another hash", () => {
    fc.assert(
      fc.property(hash, hash, fc.integer({ min: 7, max: 52 }), (h, other, n) => {
        const code = oracle(h);
        expect(isCodeOf(code.slice(0, 6), h)).toBe(false);
        expect(isCodeOf(`${code}0`, h)).toBe(false);
        expect(isCodeOf(oracle(other).slice(0, n), h)).toBe(
          oracle(other).startsWith(code.slice(0, n)),
        );
      }),
      { numRuns },
    );
  });

  test("refuses any changed character: case, lookalikes and characters outside the alphabet", () => {
    fc.assert(
      fc.property(
        hash,
        fc.integer({ min: 7, max: 52 }),
        fc.nat(),
        fc.string({ minLength: 1, maxLength: 1, unit: "binary" }),
        (h, n, at, c) => {
          const code = oracle(h).slice(0, n);
          const i = at % n;
          fc.pre(c !== code[i]);
          expect(isCodeOf(code.slice(0, i) + c + code.slice(i + 1), h)).toBe(false);
          expect(isCodeOf(code.toUpperCase(), h)).toBe(!/[a-z]/.test(code));
        },
      ),
      { numRuns },
    );
  });

  test("refuses a hash that isn't 32 bytes", () => {
    expect(isCodeOf("0000000", new Uint8Array(31))).toBe(false);
    expect(isCodeOf("0000000", new Uint8Array(33))).toBe(false);
  });
});

test("the short link is the website's /p/<code>", () => {
  expect(shortLink("https://abolish.us", "3j55dw1")).toBe("https://abolish.us/p/3j55dw1");
});
