import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  assignShortCodes,
  MAX_SHORT_CODE_LENGTH,
  parseShortCode,
  resolveShortCode,
  SHORT_CODE_ALPHABET,
  SHORT_CODE_LENGTH,
  shortCode,
  shortCodeRange,
} from "../src/short-codes.ts";

// Short codes (src/short-codes.ts; docs/design/sharing.md, "Short links and
// entry points"): a code is a prefix of its poll's definition hash, input is
// forgiving but never echoed, and ownership follows registration order alone,
// so a later poll can't take an earlier poll's code (T-53) and anyone holding
// the registered hashes resolves codes without us (T-49).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
// fast-check's report carries the seed and path to replay a failure.
const run = <T>(property: fc.IProperty<T>): void => {
  fc.assert(property, { numRuns });
};

const hash = fc.uint8Array({ minLength: 32, maxLength: 32 });

/** The hash's bits as a string, read independently of the code under test. */
const bits = (h: Uint8Array) => Array.from(h, (b) => b.toString(2).padStart(8, "0")).join("");

/** The bits a code spells, from the alphabet alone. */
const codeBits = (code: string) =>
  Array.from(code, (c) => SHORT_CODE_ALPHABET.indexOf(c).toString(2).padStart(5, "0")).join("");

/**
 * Hashes that collide on purpose: each starts with one of a few shared
 * prefixes, as a poll ground to match an earlier one's code would.
 */
const collidingHashes = fc
  .tuple(
    fc.array(fc.uint8Array({ minLength: 0, maxLength: 12 }), { minLength: 1, maxLength: 4 }),
    fc.array(fc.tuple(fc.nat(), hash), { minLength: 1, maxLength: 40 }),
  )
  .map(([prefixes, picks]) =>
    picks.map(([i, tail]) => {
      const h = tail.slice();
      h.set(prefixes[i % prefixes.length]!); // i % length is in range
      return h;
    }),
  )
  .filter((hs) => new Set(hs.map((h) => bits(h))).size === hs.length);

/** The rule as written, checked against every earlier hash. */
function expectedCode(hs: readonly Uint8Array[], index: number): string {
  const own = shortCode(hs[index]!, MAX_SHORT_CODE_LENGTH); // the caller's index
  for (let length = SHORT_CODE_LENGTH; ; length++) {
    const prefix = own.slice(0, length);
    if (!hs.slice(0, index).some((h) => shortCode(h, MAX_SHORT_CODE_LENGTH).startsWith(prefix)))
      return prefix;
  }
}

describe("shortCode", () => {
  test("spells the hash's leading bits in Crockford base32", () => {
    expect(shortCode(new Uint8Array(32))).toBe("0000000");
    expect(shortCode(new Uint8Array(32).fill(0xff))).toBe("zzzzzzz");
    // 0x8c 0xa5 0x2b 0x77 = 10001 10010 10010 10010 10110 11101 11000 0111…
    const h = new Uint8Array(32);
    h.set([0x8c, 0xa5, 0x2b, 0x77, 0x02]);
    expect(shortCode(h)).toBe("hjjjpxr");
    expect(shortCode(new Uint8Array(32).fill(0xff), MAX_SHORT_CODE_LENGTH)).toBe(
      `${"z".repeat(51)}g`,
    );
    run(
      fc.property(
        hash,
        fc.integer({ min: SHORT_CODE_LENGTH, max: MAX_SHORT_CODE_LENGTH }),
        (h, n) => {
          const code = shortCode(h, n);
          expect(code).toHaveLength(n);
          expect(code).toMatch(/^[0-9a-hjkmnp-tv-z]+$/);
          expect(codeBits(code)).toBe(
            bits(h)
              .padEnd(260, "0")
              .slice(0, 5 * n),
          );
        },
      ),
    );
  });

  test("is the full hash at its greatest length", () => {
    run(
      fc.property(hash, (h) => {
        expect(codeBits(shortCode(h, MAX_SHORT_CODE_LENGTH)).slice(0, 256)).toBe(bits(h));
      }),
    );
  });

  test.each([6, 53, 7.5, Number.NaN])("refuses a length of %s", (n) => {
    expect(() => shortCode(new Uint8Array(32), n)).toThrow(RangeError);
  });

  test("takes only a 32-byte hash", () => {
    expect(() => shortCode(new Uint8Array(31))).toThrow(TypeError);
    expect(() => shortCode("00".repeat(32) as unknown as Uint8Array)).toThrow(TypeError);
  });
});

describe("parseShortCode", () => {
  const anyCode = fc
    .tuple(hash, fc.integer({ min: SHORT_CODE_LENGTH, max: MAX_SHORT_CODE_LENGTH }))
    .map(([h, n]) => shortCode(h, n));

  test("takes every code as it is printed", () => {
    run(
      fc.property(anyCode, (code) => {
        expect(parseShortCode(code)).toBe(code);
      }),
    );
  });

  test("forgives case and the letters that look like digits", () => {
    expect(parseShortCode("3J55DW1")).toBe("3j55dw1");
    expect(parseShortCode("3j55dwl")).toBe("3j55dw1");
    expect(parseShortCode("3J55DWI")).toBe("3j55dw1");
    expect(parseShortCode("O0oOo0O")).toBe("0000000");
    run(
      fc.property(
        anyCode,
        fc.array(fc.boolean(), { minLength: 52, maxLength: 52 }),
        (code, flips) => {
          const typed = Array.from(code, (c, i) => {
            const variant = c === "0" ? "o" : c === "1" ? (i % 2 === 0 ? "i" : "l") : c;
            const chosen = flips[i] ? variant : c;
            return i % 3 === 0 ? chosen.toUpperCase() : chosen;
          }).join("");
          expect(parseShortCode(typed)).toBe(code);
        },
      ),
    );
  });

  test.each([
    ["a u", "3j55duw"],
    ["a space", "3j55 dw"],
    ["a slash", "3j5/5dw"],
    ["a non-ASCII letter", "3j55dwé"],
    ["a dotted capital I", "3J55DWİ"],
    ["the Kelvin sign", "3\u212a55dw1"],
    ["too few characters", "3j55dw"],
    ["too many characters", "0".repeat(53)],
    ["nothing", ""],
    ["padding bits that aren't 0", `${"0".repeat(51)}1`],
  ])("refuses %s", (_, input) => {
    expect(parseShortCode(input)).toBeUndefined();
  });

  test("refuses anything outside the alphabet and its lookalikes", () => {
    const allowed = new Set(`${SHORT_CODE_ALPHABET}oilOILABCDEFGHJKMNPQRSTVWXYZ`.split(""));
    run(
      fc.property(
        fc.string({ minLength: SHORT_CODE_LENGTH, maxLength: MAX_SHORT_CODE_LENGTH - 1 }),
        (input) => {
          const parsed = parseShortCode(input);
          if (input.split("").every((c) => allowed.has(c))) expect(parsed).toBeDefined();
          else expect(parsed).toBeUndefined();
        },
      ),
    );
  });
});

describe("assignShortCodes", () => {
  test("follows the rule: the shortest prefix no earlier poll's hash shares", () => {
    run(
      fc.property(collidingHashes, (hs) => {
        const codes = assignShortCodes(hs);
        expect(codes).toEqual(hs.map((_, i) => expectedCode(hs, i)));
      }),
    );
  });

  test("gives every poll its own code, a prefix of its own hash", () => {
    run(
      fc.property(fc.oneof(collidingHashes, fc.uniqueArray(hash, { selector: bits })), (hs) => {
        const codes = assignShortCodes(hs);
        expect(new Set(codes).size).toBe(hs.length);
        codes.forEach((code, i) =>
          expect(shortCode(hs[i]!, MAX_SHORT_CODE_LENGTH).startsWith(code)).toBe(true),
        );
      }),
    );
  });

  test("never changes an earlier poll's code as later polls arrive", () => {
    run(
      fc.property(collidingHashes, fc.nat(), (hs, cut) => {
        const k = cut % (hs.length + 1);
        expect(assignShortCodes(hs).slice(0, k)).toEqual(assignShortCodes(hs.slice(0, k)));
      }),
    );
  });

  test("grows a code past 7 characters only on a collision", () => {
    run(
      fc.property(collidingHashes, (hs) => {
        assignShortCodes(hs).forEach((code, i) => {
          const seven = shortCode(hs[i]!); // forEach's index
          const collides = hs.slice(0, i).some((h) => shortCode(h) === seven);
          expect(code.length > SHORT_CODE_LENGTH).toBe(collides);
        });
      }),
    );
  });

  test("lengthens a ground collision's code, never takes the earlier one's", () => {
    const first = new Uint8Array(32).fill(0x11);
    const ground = first.slice();
    ground[31] = 0x10; // the first 255 bits shared
    const third = first.slice();
    third[4] = 0x10; // shares the first 35 bits, not the 40th
    expect(assignShortCodes([first, ground, third])).toEqual([
      "248h248",
      shortCode(ground, MAX_SHORT_CODE_LENGTH),
      shortCode(third, 8),
    ]);
    expect(shortCode(ground, MAX_SHORT_CODE_LENGTH)).toHaveLength(52);
  });

  test("refuses a hash registered twice", () => {
    const h = new Uint8Array(32).fill(7);
    expect(() => assignShortCodes([h, new Uint8Array(32), h.slice()])).toThrow(RangeError);
  });
});

describe("resolveShortCode", () => {
  test("finds each poll by its code and nothing by a prefix that isn't one", () => {
    run(
      fc.property(collidingHashes, (hs) => {
        const codes = assignShortCodes(hs);
        codes.forEach((code, i) => expect(resolveShortCode(code, hs)).toBe(i));
        // The prefixes next to each code: 7 characters, one shorter, one longer.
        hs.forEach((h, i) => {
          const length = codes[i]!.length; // forEach's index
          for (const n of [SHORT_CODE_LENGTH, length - 1, length + 1]) {
            if (n < SHORT_CODE_LENGTH || n > MAX_SHORT_CODE_LENGTH) continue;
            const prefix = shortCode(h, n);
            if (!codes.includes(prefix)) expect(resolveShortCode(prefix, hs)).toBeUndefined();
          }
        });
      }),
    );
  });

  test("resolves a 7-character code to the earliest poll, not one ground to match it", () => {
    const first = new Uint8Array(32).fill(0x11);
    const ground = first.slice();
    ground[31] = 0;
    expect(resolveShortCode("248h248", [first, ground])).toBe(0);
    expect(resolveShortCode("248h248", [ground, first])).toBe(0);
    expect(resolveShortCode("zzzzzzz", [first, ground])).toBeUndefined();
  });
});

describe("shortCodeRange", () => {
  const compare = (a: Uint8Array, b: Uint8Array) => Buffer.compare(a, b);

  test("holds exactly the hashes the code is a prefix of", () => {
    run(
      fc.property(
        hash,
        hash,
        fc.integer({ min: SHORT_CODE_LENGTH, max: MAX_SHORT_CODE_LENGTH }),
        fc.boolean(),
        (h, other, n, near) => {
          const code = shortCode(h, n);
          const { from, to } = shortCodeRange(code);
          expect(compare(from, h)).toBeLessThanOrEqual(0);
          if (to !== undefined) expect(compare(h, to)).toBeLessThan(0);
          // Another hash, half the time sharing all but its last bits with h.
          const x = near ? h.map((b, i) => (i < 31 ? b : other[i]!)) : other;
          const inside = compare(from, x) <= 0 && (to === undefined || compare(x, to) < 0);
          expect(inside).toBe(shortCode(x, n) === code);
        },
      ),
    );
  });

  test("runs to the last hash only for a code of all ones", () => {
    expect(shortCodeRange("zzzzzzz").to).toBeUndefined();
    expect(shortCodeRange(`${"z".repeat(51)}g`)).toEqual({ from: new Uint8Array(32).fill(0xff) });
    expect(shortCodeRange("0000000")).toEqual({
      from: new Uint8Array(32),
      // The next code up: the 35th bit, the code's last, set.
      to: Uint8Array.of(0, 0, 0, 0, 0x20, ...new Uint8Array(27)),
    });
  });

  test("refuses anything but a parsed code", () => {
    for (const input of ["000000", "000000O", "000000U", "ABCDEFG", `${"0".repeat(51)}1`])
      expect(() => shortCodeRange(input)).toThrow(RangeError);
  });
});
