import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import {
  DEFAULT_LOCALE,
  isLocale,
  keepChosenLocale,
  LOCALE_KEY,
  LOCALES,
  pickLocale,
  pollLanguages,
  readChosenLocale,
} from "../src/locales.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

// A Storage over a Map, as much of the API as the client uses.
function memoryStorage(seed: Record<string, string> = {}): Storage {
  const items = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, String(value)),
  } as unknown as Storage;
}
const blocked = (): Storage => {
  throw new DOMException("The operation is insecure.", "SecurityError");
};

describe("pickLocale", () => {
  test("takes the browser's first language we have, by locale or primary language", () => {
    expect(pickLocale(undefined, ["es-US"])).toBe("es-US");
    for (const spanish of ["es", "es-MX", "ES-419", "es-es"])
      expect(pickLocale(undefined, [spanish, "en-US"])).toBe("es-US");
    expect(pickLocale(undefined, ["en-GB", "es"])).toBe("en-US");
    expect(pickLocale(undefined, ["fr-FR", "pt-BR", "es-MX"])).toBe("es-US");
  });

  test("falls back to English for a browser asking for none of ours, or nothing", () => {
    expect(pickLocale(undefined, [])).toBe(DEFAULT_LOCALE);
    expect(pickLocale(undefined, ["fr", "de-DE", "", "*"])).toBe(DEFAULT_LOCALE);
  });

  test("lets the voter's own choice win over the browser's", () => {
    expect(pickLocale("es-US", ["en-US"])).toBe("es-US");
    expect(pickLocale("en-US", ["es-MX"])).toBe("en-US");
  });

  test("ignores a kept value that isn't exactly one of ours", () => {
    for (const odd of ["es", "ES-US", "es-US ", "fr-FR", 1, null, {}])
      expect(pickLocale(odd, ["en-US"])).toBe("en-US");
  });

  test("always gives one of ours, whatever the browser and storage hold", () => {
    fc.assert(
      fc.property(fc.anything(), fc.array(fc.string()), (chosen, languages) =>
        isLocale(pickLocale(chosen, languages)),
      ),
      { numRuns },
    );
  });

  test("gives a kept choice whatever the browser asks for", () => {
    fc.assert(
      fc.property(fc.constantFrom(...LOCALES), fc.array(fc.string()), (chosen, languages) => {
        expect(pickLocale(chosen, languages)).toBe(chosen);
      }),
      { numRuns },
    );
  });
});

describe("pollLanguages", () => {
  test("leaves the browser's own order alone until the voter chooses", () => {
    const browser = ["es-MX", "es-US", "en-US"];
    expect(pollLanguages(undefined, browser)).toBe(browser);
    expect(pollLanguages("en-US", browser)).toEqual(["en-US", ...browser]);
  });
});

describe("the kept choice", () => {
  test("round-trips through storage under its one key, holding only the locale", () => {
    const storage = memoryStorage();
    expect(readChosenLocale(() => storage)).toBeUndefined();
    keepChosenLocale(() => storage, "es-US");
    expect(storage.getItem(LOCALE_KEY)).toBe("es-US");
    expect(readChosenLocale(() => storage)).toBe("es-US");
  });

  test("reads anything else stored there as no choice", () => {
    for (const value of ["es", "fr-FR", "", "en-US;", '"es-US"'])
      expect(readChosenLocale(() => memoryStorage({ [LOCALE_KEY]: value }))).toBeUndefined();
  });

  test("survives a browser that blocks storage: no choice read, nothing thrown on keeping", () => {
    expect(readChosenLocale(blocked)).toBeUndefined();
    expect(() => keepChosenLocale(blocked, "es-US")).not.toThrow();
  });
});
