// The website's languages (P2-28 part 4) and how a request picks one. Pure,
// so the server's middleware (src/start.ts), the router (src/router.tsx) and
// the footer's switch (src/components/language-switch.tsx) agree.

/** Every locale the website has a catalog for; the first is the source catalog's. */
export const LOCALES = ["en-US", "es-US"] as const;

export type Locale = (typeof LOCALES)[number];

/** What a visitor who asks for none of ours reads. */
export const DEFAULT_LOCALE: Locale = "en-US";

/**
 * The cookie that keeps a visitor's own choice from the footer's switch. It
 * holds a locale and nothing else: no identifier, never read with an
 * account, never sent to analytics (T-67).
 */
export const LOCALE_COOKIE = "lang";

export const isLocale = (value: unknown): value is Locale =>
  LOCALES.some((locale) => locale === value);

// An `Accept-Language` longer than this isn't a preference to parse: a
// browser sends a few dozen bytes.
const MAX_HEADER = 1024;

const primaryOf = (tag: string) => (tag.split("-")[0] ?? "").toLowerCase();

/** The value of the `name` cookie in a `Cookie` header, if it is there exactly once. */
function cookie(header: string, name: string): string | undefined {
  const found = header
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair.startsWith(`${name}=`))
    .map((pair) => pair.slice(name.length + 1));
  return found.length === 1 ? found[0] : undefined;
}

/**
 * The first of our locales an `Accept-Language` header accepts, in its
 * order of preference (RFC 9110 §12.5.4): by `q`, then by position. A range
 * matches a locale when it is the locale or its primary language (`es`,
 * `es-MX` and `es-419` all take `es-US`, since it is our only Spanish); `*`
 * and anything unparsed match nothing, so the default stands.
 */
function accepted(header: string): Locale | undefined {
  if (header.length > MAX_HEADER) return undefined;
  const ranges = header
    .split(",")
    .map((part, index) => {
      const [range = "", ...params] = part.split(";").map((s) => s.trim());
      let q = 1;
      for (const param of params) {
        const m = /^q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/i.exec(param);
        if (m === null) return undefined;
        q = Number(m[1]);
      }
      if (!/^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/.test(range) || q === 0) return undefined;
      return { range: range.toLowerCase(), q, index };
    })
    .filter((r) => r !== undefined)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const { range } of ranges) {
    const exact = LOCALES.find((l) => l.toLowerCase() === range);
    if (exact !== undefined) return exact;
    const same = LOCALES.find((l) => primaryOf(l) === primaryOf(range));
    if (same !== undefined) return same;
  }
  return undefined;
}

/**
 * The locale for a request: the visitor's own choice from the footer if the
 * cookie names one of ours, else the first of ours their browser accepts,
 * else the default. Never throws: either header is whatever a client sent.
 */
export function negotiateLocale(
  cookieHeader: string | null | undefined,
  acceptLanguage: string | null | undefined,
): Locale {
  const chosen = cookie(cookieHeader ?? "", LOCALE_COOKIE);
  if (isLocale(chosen)) return chosen;
  return accepted(acceptLanguage ?? "") ?? DEFAULT_LOCALE;
}

/**
 * The `Cookie` the footer's switch writes: a year, the whole site, sent on
 * top-level navigations only (`SameSite=Lax`), and `Secure` over HTTPS.
 */
export const localeCookie = (locale: Locale, secure: boolean) =>
  `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? "; Secure" : ""}`;
