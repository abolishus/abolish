// Each page's title (WCAG 2.4.2 Page Titled; P2-28 part 3b-2): what the page
// is, most specific first, then the site's name. It is the first thing a
// screen reader says on arriving, and what a tab, a bookmark and the history
// list show. A title never quotes a search, a place or anything else typed
// into the address (T-67): only the site's own words, and a poll's ID or
// words and a profile's name where the page's own heading shows them.

import { formatMessage, type Params } from "@abolishus/ui";

import type { Locale } from "./locales.ts";
import { catalogFor, type Messages } from "./messages.ts";

/**
 * A head's words in the page's locale (the router's context), since a head
 * renders outside the I18nProvider: `text` for a message, `pageTitle` for
 * the title of a page named by `parts`, most specific first (none names the
 * home page).
 */
export function titles(locale: Locale) {
  const text = (key: keyof Messages, params?: Params) =>
    formatMessage(locale, catalogFor(locale)[key], params);
  const pageTitle = (...parts: string[]) => ({
    title: [...parts, text("siteName")].join(" · "),
  });
  return { text, pageTitle };
}

/**
 * Text an author wrote, isolated (U+2068 … U+2069) so a right-to-left name
 * can't reorder the title's other words, as `<bdi>` does on the page (T-75).
 */
export const isolated = (s: string) => `⁨${s}⁩`;
