import { placeholders, templates, type Message } from "@abolishus/ui";
import { describe, expect, test } from "vite-plus/test";

import { LOCALES } from "../src/locales.ts";
import { catalogs, LOCALE_NAMES } from "../src/messages.ts";

// The second language (P2-28 part 4b), held as the website's catalogs are
// (apps/web/tests/messages.test.ts): every catalog says what the source
// says, with the same blanks to fill, so a screen in any language shows
// every value it was given and never a raw `{name}` or a crash; and every
// catalog is in the voice ([[language]], Voice).

const source = catalogs["en-US"];
type Key = keyof typeof source;
const blanks = (message: Message) => [...new Set(templates(message).flatMap(placeholders))].sort();
const words = (message: Message): string[] => templates(message);
const all = () =>
  Object.entries(catalogs).flatMap(([locale, catalog]) =>
    Object.entries(catalog).flatMap(([key, message]) =>
      words(message).map((text) => ({ at: `${locale} ${key}`, text })),
    ),
  );

describe("every catalog against the source", () => {
  test("has every key the source has, and no other", () => {
    for (const locale of LOCALES)
      expect(Object.keys(catalogs[locale]).sort()).toEqual(Object.keys(source).sort());
  });

  test("fills the same placeholders in every message, a plural in each of its forms", () => {
    const differ: string[] = [];
    for (const locale of LOCALES)
      for (const [key, message] of Object.entries(catalogs[locale])) {
        const want = blanks(source[key as Key]);
        if (typeof message === "string") {
          if (JSON.stringify(blanks(message)) !== JSON.stringify(want))
            differ.push(`${locale} ${key}`);
        } else
          for (const form of templates(message))
            // A plural's form may leave `{count}` out ("one" can say it in words).
            if (
              JSON.stringify(
                placeholders(form)
                  .filter((p) => p !== "count")
                  .sort(),
              ) !== JSON.stringify(want.filter((p) => p !== "count"))
            )
              differ.push(`${locale} ${key}`);
      }
    expect(differ).toEqual([]);
  });

  test("keeps a plural a plural, in forms its language has", () => {
    for (const locale of LOCALES) {
      const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
      for (const [key, message] of Object.entries(catalogs[locale])) {
        expect(typeof message, `${locale} ${key}`).toBe(typeof source[key as Key]);
        if (typeof message !== "string")
          for (const form of Object.keys(message))
            expect(categories, `${locale} ${key}`).toContain(form);
      }
    }
  });

  test("names each language in itself, each its own name", () => {
    expect(Object.keys(LOCALE_NAMES).sort()).toEqual([...LOCALES].sort());
    expect(new Set(Object.values(LOCALE_NAMES)).size).toBe(LOCALES.length);
  });

  test("isn't the source again: a translated catalog translates", () => {
    for (const locale of LOCALES.filter((l) => l !== "en-US")) {
      const same = Object.entries(catalogs[locale]).filter(
        ([key, message]) => JSON.stringify(message) === JSON.stringify(source[key as Key]),
      );
      // Words both languages share ("{step}: {name}") stay; almost nothing else does.
      expect(same.map(([key]) => key)).toEqual(["stepNamed"]);
    }
  });

  test("keeps the addresses a voter is sent to, letter for letter", () => {
    for (const locale of LOCALES)
      for (const [key, message] of Object.entries(catalogs[locale]))
        expect(words(message).join(" ").includes("abolishus.eth"), `${locale} ${key}`).toBe(
          words(source[key as Key])
            .join(" ")
            .includes("abolishus.eth"),
        );
  });
});

describe("every catalog's words", () => {
  test("hold no exclamation mark and no emoji", () => {
    const loud = all().filter(({ text }) => /[!¡]|\p{Extended_Pictographic}/u.test(text));
    expect(loud.map((w) => w.at)).toEqual([]);
  });

  test("hold no stray spacing and no three dots for an ellipsis, which a screen reader reads as dots", () => {
    const untidy = all().filter(({ text }) => /^\s|\s$| {2}|\.\.\./.test(text));
    expect(untidy.map((w) => w.at)).toEqual([]);
  });

  test("hold braces only as whole placeholders", () => {
    const stray = all().filter(({ text }) =>
      /[{}]/.test(text.replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, "")),
    );
    expect(stray.map((w) => w.at)).toEqual([]);
  });
});
