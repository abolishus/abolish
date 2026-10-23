import { useI18n, useTranslate } from "@abolishus/ui";

import { type Locale, LOCALES, localeCookie } from "../locales.ts";
import { catalogs, LOCALE_NAMES } from "../messages.ts";

/**
 * Keeps `locale` as the visitor's choice and reloads the page in it: the
 * server picks a page's language per request (src/start.ts), so the whole
 * page, its head included, changes at once. The cookie holds the locale and
 * nothing else (src/locales.ts; T-67).
 */
export function chooseLocale(locale: Locale) {
  document.cookie = localeCookie(locale, location.protocol === "https:");
  location.reload();
}

/**
 * The footer's languages: each named in its own language and marked with
 * its own `lang` (WCAG 3.1.2), the page's own one marked current, every
 * other a button. `choose` is `chooseLocale` but in a story.
 */
export function LanguageSwitch({ choose = chooseLocale }: { choose?: (locale: Locale) => void }) {
  const t = useTranslate(catalogs);
  const { locale } = useI18n();
  return (
    <nav aria-label={t("footerLanguage")}>
      <ul className="m-0 flex list-none flex-wrap gap-x-4 p-0 text-sm">
        {LOCALES.map((option) => (
          <li key={option}>
            {option === locale ? (
              <span
                lang={option}
                aria-current="true"
                className="inline-flex min-h-8 items-center font-semibold"
              >
                {LOCALE_NAMES[option]}
              </span>
            ) : (
              <button
                type="button"
                lang={option}
                onClick={() => choose(option)}
                className="inline-flex min-h-8 cursor-pointer items-center underline underline-offset-4"
              >
                {LOCALE_NAMES[option]}
              </button>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
