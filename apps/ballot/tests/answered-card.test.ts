// The "I answered" card's words (src/answered-card.ts): the question is
// broken into lines that fit the card, never more than it allows, losing no
// word before the cut; and the saved file is named by the poll's code alone.
// Widths come from a stand-in measure (one unit a character, two for a wide
// one) so the properties hold for any font the browser draws in.

import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import { cardFileName, wrap, type Measure } from "../src/answered-card.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

/** One unit a character, two for a CJK one: a font with uneven widths. */
const measure: Measure = (text) =>
  Array.from(text).reduce((sum, char) => sum + (/[　-鿿]/u.test(char) ? 2 : 1), 0);

const words = fc.array(fc.stringMatching(/^[a-zA-Záñ一-丐?¿,.]{1,30}$/u), {
  minLength: 0,
  maxLength: 40,
});
const width = fc.integer({ min: 2, max: 40 });
const lines = fc.integer({ min: 1, max: 8 });

describe("wrap", () => {
  test("keeps a short question on one line, as written", () => {
    expect(wrap("Which park first?", 40, 6, measure)).toEqual(["Which park first?"]);
  });

  test("breaks at spaces, and inside a word only when the word alone is too wide", () => {
    expect(wrap("Should the library open on Sundays?", 12, 6, measure)).toEqual([
      "Should the",
      "library open",
      "on Sundays?",
    ]);
    expect(wrap("abcdefghij", 4, 6, measure)).toEqual(["abcd", "efgh", "ij"]);
  });

  test("cuts a question that won't fit with an ellipsis on its last line", () => {
    expect(wrap("one two three four five six", 9, 2, measure)).toEqual(["one two", "three…"]);
  });

  test("never draws more lines than allowed, or a line wider than the card", () => {
    fc.assert(
      fc.property(words, width, lines, (ws, w, max) => {
        const out = wrap(ws.join(" "), w, max, measure);
        expect(out.length).toBeLessThanOrEqual(max);
        for (const line of out) {
          expect(measure(line)).toBeLessThanOrEqual(w);
          expect(line).not.toBe("");
          expect(line).toBe(line.trim());
        }
      }),
      { numRuns },
    );
  });

  test("loses nothing when it fits, and only the end when it is cut", () => {
    fc.assert(
      fc.property(words, width, lines, (ws, w, max) => {
        const text = ws.join(" ");
        const out = wrap(text, w, max, measure);
        // Lines break only at spaces or inside words, so with spaces dropped
        // the lines read as the question does.
        const joined = out.join("").replaceAll(" ", "");
        const all = ws.join("");
        if (joined.endsWith("…") && !all.endsWith("…")) {
          // Every character before the ellipsis is the question's own, in order.
          expect(all.startsWith(joined.slice(0, -1))).toBe(true);
        } else {
          expect(joined).toBe(all);
        }
      }),
      { numRuns },
    );
  });

  test("never splits a character a reader sees as one", () => {
    // An accent written as its own code point, and a family emoji of five.
    expect(wrap("ae\u0301b", 2, 6, measure)).toEqual(["a", "e\u0301", "b"]);
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    expect(wrap(`${family}${family}`, 6, 6, measure)).toEqual([family, family]);
  });

  test("treats any run of whitespace as one space, and an empty question as no lines", () => {
    expect(wrap("  a \n\t b  ", 10, 6, measure)).toEqual(["a b"]);
    expect(wrap(" \n ", 10, 6, measure)).toEqual([]);
  });
});

describe("cardFileName", () => {
  test("names the file by the poll's code, lower-cased", () => {
    expect(cardFileName("https://abolish.us/p/3j55dw1")).toBe("answered-3j55dw1.png");
    expect(cardFileName("https://abolish.us/P/3J55DW1")).toBe("answered-3j55dw1.png");
  });

  test("falls back to a plain name for a link that isn't a short link", () => {
    expect(cardFileName("https://abolish.us/")).toBe("answered.png");
    expect(cardFileName("https://abolish.us/p/../x")).toBe("answered.png");
  });
});
