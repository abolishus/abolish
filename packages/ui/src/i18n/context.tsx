import { createContext, useContext, useMemo, type ReactNode } from "react";

import { formatMessage, type Catalog, type Params } from "./format.ts";

export type Translate<C extends Catalog> = (key: keyof C & string, params?: Params) => string;

export interface I18n {
  /** A BCP 47 tag, passed to `Intl` and set as `lang` by the app. */
  readonly locale: string;
}

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ locale, children }: { locale: string; children: ReactNode }) {
  const value = useMemo(() => ({ locale }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** The current locale. Components that format numbers or dates read it here. */
export function useI18n(): I18n {
  const i18n = useContext(I18nContext);
  // No silent default locale: a screen rendered outside a provider would
  // format numbers for whatever the default happened to be.
  if (i18n === null) throw new Error("useI18n needs an <I18nProvider>");
  return i18n;
}

/**
 * A translator over the current locale's catalog. Every locale's catalog has
 * the source catalog's type, so a missing key fails type-checking.
 */
export function useTranslate<C extends Catalog>(
  catalogs: Readonly<Record<string, C>>,
): Translate<C> {
  const { locale } = useI18n();
  const catalog = catalogs[locale];
  if (catalog === undefined) throw new Error(`no catalog for locale "${locale}"`);
  return useMemo(
    () => (key, params) => {
      const message = catalog[key];
      if (message === undefined) throw new Error(`no message "${key}" for locale "${locale}"`);
      return formatMessage(locale, message, params);
    },
    [locale, catalog],
  );
}
