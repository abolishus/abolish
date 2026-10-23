import { POLL_FAILURES } from "@abolishus/core/poll-failures";
import { beforeAll, describe, expect, test } from "vite-plus/test";
import { placeholders, templates, type Message } from "@abolishus/ui";

import { LOCALES } from "../src/locales.ts";
import {
  catalogFor,
  catalogs,
  loadCatalog,
  LOCALE_NAMES,
  POLL_FAILURE_MESSAGES,
  tierMessage,
} from "../src/messages.ts";

// Every test here reads every catalog, which a page loads only in its language.
beforeAll(() => Promise.all(LOCALES.map(loadCatalog)));

// A failed poll's reason in plain words (ADR 0032, rule 14; P2-22 part
// 5d-2): every code core writes has its own message in every catalog, and
// no message shows the code, a hash or an identifier.

describe("POLL_FAILURE_MESSAGES", () => {
  test("words every failure code with its own message, in every catalog", () => {
    expect(Object.keys(POLL_FAILURE_MESSAGES).sort()).toEqual([...POLL_FAILURES].sort());
    const keys = Object.values(POLL_FAILURE_MESSAGES);
    expect(new Set(keys).size).toBe(keys.length);
    for (const catalog of Object.values(catalogs)) {
      const words = keys.map((k) => catalog[k]);
      expect(new Set(words).size).toBe(words.length);
      for (const w of words) expect(typeof w === "string" && w.length > 0).toBe(true);
    }
    // Nothing else claims to word a failure.
    expect(
      Object.keys(catalogs["en-US"]!)
        .filter((k) => k.startsWith("pollFailure_"))
        .sort(),
    ).toEqual([...keys].sort());
  });

  test("never shows a code, a hash or an identifier", () => {
    for (const catalog of Object.values(catalogs))
      for (const key of Object.values(POLL_FAILURE_MESSAGES)) {
        const words = catalog[key];
        if (typeof words !== "string") throw new Error(`${key} isn't plain text`);
        for (const failure of POLL_FAILURES) expect(words).not.toContain(failure);
        expect(words).not.toMatch(/0x|[0-9a-f]{8}|hash|\{/i);
      }
  });
});

// "Setting up your poll" (P2-22 part 6d) words each step for the author,
// never as the worker names its states (ADR 0032, rule 14; T-34).
describe("setup's steps", () => {
  test("never name a worker state, a code or a hash", () => {
    for (const catalog of Object.values(catalogs))
      for (const [key, words] of Object.entries(catalog))
        if (key.startsWith("setupStep_") || key === "setupNow") {
          if (typeof words !== "string") throw new Error(`${key} isn't plain text`);
          expect(words).not.toMatch(
            /rooted|ceremony|registered|stub|electorate|0x|[0-9a-f]{8}|hash/i,
          );
        }
  });
});

// Tier 0's name follows what the token issuer checks (P2-31 part 6b-2a;
// [[0038-verified-accounts]], Owner decision (2026-10-22)): a poll never
// claims a phone check this deployment doesn't make (T-01).
describe("tierMessage", () => {
  test("names Tier 0 by the phone setting, and the other tiers alike under both", () => {
    const en = catalogs["en-US"]!;
    expect(en[tierMessage(0, false)]).toBe("Tier 0 (verified e-mail)");
    expect(en[tierMessage(0, true)]).toBe("Tier 0 (verified e-mail and phone)");
    for (const tier of [1, 2] as const)
      expect(tierMessage(tier, true)).toBe(tierMessage(tier, false));
    expect(en[tierMessage(2, false)]).toBe("Tier 2 (document-verified)");
  });

  test("names no tier a definition can't hold", () => {
    for (const tier of [-1, 3, 255, 0.5]) expect(tierMessage(tier, true)).toBeUndefined();
  });
});

// The words in the voice the design sets ([[language]], Voice; P2-28 part
// 3b-3): plain and calm, so no exclamation marks, hype or emoji, and text
// that reads aloud as it shows.
describe("every catalog's words", () => {
  const words = (message: Message): string[] =>
    typeof message === "string"
      ? [message]
      : Object.values(message).filter((form): form is string => typeof form === "string");
  // Read when each test runs, once every catalog is loaded.
  const all = () =>
    Object.entries(catalogs).flatMap(([locale, catalog]) =>
      Object.entries(catalog).flatMap(([key, message]) =>
        words(message).map((text) => ({ at: `${locale} ${key}`, text })),
      ),
    );

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

// The second language (P2-28 part 4): every catalog says what the source
// says, with the same blanks to fill, so a page in any language shows every
// value it was given and never a raw `{name}` or a crash.
describe("every catalog against the source", () => {
  const source = () => catalogFor("en-US");
  const blanks = (message: Message) => templates(message).flatMap(placeholders).sort();

  test("has every key the source has, and no other", () => {
    for (const locale of LOCALES)
      expect(Object.keys(catalogFor(locale)).sort()).toEqual(Object.keys(source()).sort());
  });

  test("fills the same placeholders in every message, a plural in each of its forms", () => {
    const differ: string[] = [];
    for (const locale of LOCALES)
      for (const [key, message] of Object.entries(catalogFor(locale))) {
        const want = blanks(source()[key as keyof ReturnType<typeof source>]);
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
              ) !== JSON.stringify([...new Set(want)].filter((p) => p !== "count").sort())
            )
              differ.push(`${locale} ${key}`);
      }
    expect(differ).toEqual([]);
  });

  test("keeps a plural a plural, in forms its language has", () => {
    for (const locale of LOCALES) {
      const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
      for (const [key, message] of Object.entries(catalogFor(locale))) {
        const was = source()[key as keyof ReturnType<typeof source>];
        expect(typeof message, `${locale} ${key}`).toBe(typeof was);
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
      const same = Object.entries(catalogFor(locale)).filter(
        ([key, message]) =>
          JSON.stringify(message) ===
          JSON.stringify(source()[key as keyof ReturnType<typeof source>]),
      );
      // Names, codes and words both languages share ("No", "Spam", "UTC") stay; most don't.
      expect(same.length / Object.keys(source()).length).toBeLessThan(0.05);
    }
  });
});
