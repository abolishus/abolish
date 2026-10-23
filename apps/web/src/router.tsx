import { getGlobalStartContext } from "@tanstack/react-start";
import { createRouter, parseSearchWith, stringifySearchWith } from "@tanstack/react-router";

import { Failed, NotFound } from "./components/site-layout.tsx";
import { DEFAULT_LOCALE, isLocale, type Locale } from "./locales.ts";
import { loadCatalog } from "./messages.ts";
import { routeTree } from "./routeTree.gen.ts";

// Search parameters stay the text they were: the router's default reads them
// as JSON and writes strings back quoted, so `?after=7` would come back as
// `?after=%227%22`. Each route's validateSearch reads what it needs.
const keepText = () => {
  throw new SyntaxError("search parameters are text");
};

/** What every route's loader and head can read. */
export interface RouterContext {
  /** The page's language, as the server chose it for this request (src/start.ts). */
  readonly locale: Locale;
}

// On the server, the request's choice; in the browser, the one the server
// rendered the document in, so hydration and every later page match it
// until the visitor changes it (src/components/language-switch.tsx), which
// reloads the page.
function pageLocale(): Locale {
  const chosen =
    typeof document === "undefined"
      ? getGlobalStartContext()?.locale
      : document.documentElement.lang;
  return isLocale(chosen) ? chosen : DEFAULT_LOCALE;
}

export function getRouter() {
  const nonce = getGlobalStartContext()?.nonce;
  const locale = pageLocale();
  return createRouter({
    routeTree,
    context: { locale } satisfies RouterContext,
    // The browser waits for the page's catalog before hydrating, which the
    // server loaded before rendering it (src/messages.ts).
    hydrate: async () => {
      await loadCatalog(locale);
    },
    // On the server, the inline scripts the router renders carry this
    // response's nonce, the only one its CSP allows (src/start.ts).
    ...(nonce === undefined ? {} : { ssr: { nonce } }),
    parseSearch: parseSearchWith(keepText),
    stringifySearch: stringifySearchWith(JSON.stringify),
    defaultNotFoundComponent: NotFound,
    defaultErrorComponent: Failed,
    scrollRestoration: true,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
