import { useI18n, useTranslate } from "@abolishus/ui";
import { createContext, useContext, useEffect, useRef } from "react";

import { type Locale, LOCALES } from "./locales.ts";
import { catalogs, LOCALE_NAMES } from "./messages.ts";

/**
 * How the frame's switch changes the language: main.tsx's, which keeps the
 * choice and re-renders in place, so a voter mid-ballot loses nothing. With
 * none (a story of a screen alone), the frame shows no switch.
 */
export const LocaleChoice = createContext<((locale: Locale) => void) | undefined>(undefined);

/**
 * The frame's languages: each named in itself and marked with its own `lang`
 * (WCAG 3.1.2), the screen's own one marked current, every other a button.
 */
export function LanguageSwitch() {
  const t = useTranslate(catalogs);
  const { locale } = useI18n();
  const choose = useContext(LocaleChoice);
  // The button pressed becomes the current language's marker, which can't
  // keep focus as a button could; focus moves to it, so a keyboard or screen
  // reader stays where it was rather than at the page's top (WCAG 2.4.3).
  const current = useRef<HTMLSpanElement>(null);
  const chose = useRef(false);
  useEffect(() => {
    if (!chose.current) return;
    chose.current = false;
    current.current?.focus();
  }, [locale]);
  if (choose === undefined) return null;
  return (
    <nav aria-label={t("languageLabel")} className="mx-auto w-full max-w-xl px-4 pb-6">
      <ul className="m-0 flex list-none flex-wrap gap-x-4 p-0 text-sm">
        {LOCALES.map((option) => (
          <li key={option}>
            {option === locale ? (
              <span
                ref={current}
                tabIndex={-1}
                lang={option}
                aria-current="true"
                className="inline-flex min-h-8 items-center font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring"
              >
                {LOCALE_NAMES[option]}
              </span>
            ) : (
              <button
                type="button"
                lang={option}
                onClick={() => {
                  chose.current = true;
                  choose(option);
                }}
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
