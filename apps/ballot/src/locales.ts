// The ballot client's languages (P2-28 part 4b) and how a visit picks one.
// The client is static and served by hash, so no server negotiates: it reads
// the browser's preferred languages, and the voter's own choice from the
// frame's switch, kept on this device under one key that holds the locale
// and nothing else. Neither is ever sent anywhere (T-43, T-67).

/** Every locale the ballot has a catalog for; the first is the source catalog's. */
export const LOCALES = ["en-US", "es-US"] as const;

export type Locale = (typeof LOCALES)[number];

/** What a voter whose browser asks for none of ours reads. */
export const DEFAULT_LOCALE: Locale = "en-US";

/** The `localStorage` key that keeps the voter's choice from the switch. */
export const LOCALE_KEY = "lang";

export const isLocale = (value: unknown): value is Locale =>
  LOCALES.some((locale) => locale === value);

const primaryOf = (tag: string) => (tag.split("-")[0] ?? "").toLowerCase();

/**
 * The locale for this visit: the voter's own choice if it names one of ours,
 * else the first of ours the browser's languages (`navigator.languages`,
 * most preferred first) ask for, else the default. A language matches a
 * locale when it is the locale or shares its primary language (`es`,
 * `es-MX` and `es-419` all take `es-US`, our only Spanish), as the website's
 * negotiation does (apps/web/src/locales.ts). Never throws: both are
 * whatever the browser or storage held.
 */
export function pickLocale(chosen: unknown, languages: readonly string[]): Locale {
  if (isLocale(chosen)) return chosen;
  for (const language of languages) {
    if (typeof language !== "string") continue;
    const exact = LOCALES.find((l) => l.toLowerCase() === language.toLowerCase());
    if (exact !== undefined) return exact;
    const same = LOCALES.find((l) => primaryOf(l) === primaryOf(language));
    if (same !== undefined) return same;
  }
  return DEFAULT_LOCALE;
}

/**
 * The languages to pick a poll's own text by: the voter's choice first, when
 * they made one, so a poll with that translation reads in the frame's
 * language; otherwise the browser's alone, so its exact preferences (`es-MX`
 * before `es-US`) still decide among a poll's translations.
 */
export const pollLanguages = (
  chosen: Locale | undefined,
  languages: readonly string[],
): readonly string[] => (chosen === undefined ? languages : [chosen, ...languages]);

/** The voter's kept choice, or `undefined`: storage may be blocked, or hold anything. */
export function readChosenLocale(storage: () => Storage): Locale | undefined {
  try {
    const value = storage().getItem(LOCALE_KEY);
    return isLocale(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Keeps the voter's choice for later visits, where the browser allows. A
 * browser that refuses (a private window, site data blocked) still shows
 * this visit in the chosen language; only the next one forgets it.
 */
export function keepChosenLocale(storage: () => Storage, locale: Locale): void {
  try {
    storage().setItem(LOCALE_KEY, locale);
  } catch {
    // Not kept: nothing else depends on it.
  }
}
