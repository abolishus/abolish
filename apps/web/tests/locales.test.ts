import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import {
  DEFAULT_LOCALE,
  isLocale,
  LOCALE_COOKIE,
  LOCALES,
  localeCookie,
  localeCookieOnly,
  negotiateLocale,
} from "../src/locales.ts";

// How a request picks the page's language (P2-28 part 4): the footer's
// cookie when it names one of ours, else the browser's Accept-Language in
// its order of preference, else English. Both headers are whatever a client
// sent, so nothing in them may throw or pick a language we don't have.

const runs = { numRuns: Number(process.env["FC_NUM_RUNS"] ?? 100) };

describe("negotiateLocale", () => {
  test("is the default with nothing to go on", () => {
    expect(negotiateLocale(undefined, undefined)).toBe(DEFAULT_LOCALE);
    expect(negotiateLocale(null, null)).toBe(DEFAULT_LOCALE);
    expect(negotiateLocale("", "")).toBe(DEFAULT_LOCALE);
  });

  test("takes a range by its locale or its primary language, in the header's order of preference", () => {
    expect(negotiateLocale(null, "es")).toBe("es-US");
    expect(negotiateLocale(null, "es-MX")).toBe("es-US");
    expect(negotiateLocale(null, "es-419,en;q=0.9")).toBe("es-US");
    expect(negotiateLocale(null, "en-GB,es;q=0.9")).toBe("en-US");
    expect(negotiateLocale(null, "EN-us")).toBe("en-US");
    // By q, then by position.
    expect(negotiateLocale(null, "en;q=0.5,es;q=0.8")).toBe("es-US");
    expect(negotiateLocale(null, "fr-CA, es;q=0.4, en;q=0.4")).toBe("es-US");
    // A language we don't have is passed over, not matched.
    expect(negotiateLocale(null, "fr-FR,de;q=0.9,es;q=0.1")).toBe("es-US");
    expect(negotiateLocale(null, "fr-FR,de;q=0.9")).toBe(DEFAULT_LOCALE);
  });

  test("never takes `*`, a refused range (q=0) or one it can't read", () => {
    expect(negotiateLocale(null, "*")).toBe(DEFAULT_LOCALE);
    expect(negotiateLocale(null, "es;q=0")).toBe(DEFAULT_LOCALE);
    expect(negotiateLocale(null, "es;q=2")).toBe(DEFAULT_LOCALE);
    expect(negotiateLocale(null, "es;q=0.1234")).toBe(DEFAULT_LOCALE);
    expect(negotiateLocale(null, "es;level=1")).toBe(DEFAULT_LOCALE);
    expect(negotiateLocale(null, "e s,es_US")).toBe(DEFAULT_LOCALE);
    expect(negotiateLocale(null, `${"x,".repeat(600)}es`)).toBe(DEFAULT_LOCALE);
  });

  test("puts the footer's choice first, exactly as written and named once", () => {
    expect(negotiateLocale("lang=es-US", "en")).toBe("es-US");
    expect(negotiateLocale("a=1; lang=en-US; b=2", "es")).toBe("en-US");
    // Anything else is no choice: the browser's stands.
    for (const cookie of [
      "lang=es-us",
      "lang=fr-FR",
      "lang=",
      "xlang=en-US",
      "lang=en-US; lang=es-US",
    ])
      expect(negotiateLocale(cookie, "es")).toBe("es-US");
  });

  test("always answers one of ours, whatever either header holds", () => {
    fc.assert(
      fc.property(fc.option(fc.string()), fc.option(fc.string()), (cookie, accept) => {
        expect(isLocale(negotiateLocale(cookie, accept))).toBe(true);
      }),
      runs,
    );
  });

  test("keeps any locale the switch writes, whatever the browser asks for", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...LOCALES),
        fc.boolean(),
        fc.string(),
        (locale, secure, accept) => {
          const cookie = localeCookie(locale, secure).split(";")[0]!; // what a browser sends back
          expect(negotiateLocale(`other=1; ${cookie}`, accept)).toBe(locale);
        },
      ),
      runs,
    );
  });
});

describe("localeCookie", () => {
  test("is the locale alone, site-wide, a year, Lax, and Secure over HTTPS", () => {
    expect(localeCookie("es-US", true)).toBe(
      `${LOCALE_COOKIE}=es-US; Path=/; Max-Age=31536000; SameSite=Lax; Secure`,
    );
    expect(localeCookie("en-US", false)).toBe(
      `${LOCALE_COOKIE}=en-US; Path=/; Max-Age=31536000; SameSite=Lax`,
    );
  });
});

describe("localeCookieOnly", () => {
  test("keeps the footer's choice from a Cookie header and nothing else of it", () => {
    expect(localeCookieOnly("session=secret; lang=es-US; x=1")).toBe("lang=es-US");
    for (const header of [undefined, null, "", "session=s", "lang=fr", "lang=en-US; lang=es-US"])
      expect(localeCookieOnly(header)).toBeUndefined();
  });

  test("passes on exactly what negotiateLocale takes from the header, for any header", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (header, accept) => {
        const kept = localeCookieOnly(header);
        expect(negotiateLocale(kept, accept)).toBe(negotiateLocale(header, accept));
        if (kept !== undefined) expect(LOCALES.map((l) => `${LOCALE_COOKIE}=${l}`)).toContain(kept);
      }),
      runs,
    );
  });
});
