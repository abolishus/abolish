import { I18nProvider, useTranslate } from "@abolishus/ui";
import { renderToStaticMarkup } from "react-dom/server";

import { Offline, SiteLayout } from "../components/site-layout.tsx";
import type { Locale } from "../locales.ts";
import { catalogs } from "../messages.ts";
import { titles } from "../titles.ts";
import { ICON_PNGS, ICON_SVG_PATH } from "./install.ts";
import type { PushNotice } from "./offline.ts";

// One page per language, the same bytes for everyone who reads it, so the
// worker's cache can be named by its hash; the worker's push notice is fixed
// in its text. Each needs its locale's catalog loaded (`loadCatalog`).

function OfflineDocument({ locale, stylesheet }: { locale: Locale; stylesheet: string }) {
  const t = useTranslate(catalogs);
  const { pageTitle } = titles(locale);
  return (
    <html lang={locale}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* Shown in place of a page that couldn't load, never a page to find. */}
        <meta name="robots" content="noindex" />
        <title>{pageTitle(t("offlineTitle")).title}</title>
        <link rel="stylesheet" href={stylesheet} />
        <link rel="icon" href={ICON_SVG_PATH} type="image/svg+xml" />
      </head>
      <body>
        <SiteLayout links={false}>
          <Offline />
        </SiteLayout>
      </body>
    </html>
  );
}

/**
 * `locale`'s offline page's HTML (src/app/offline.ts): the site's frame,
 * without its links, and the notice, with no script, the same bytes for
 * every visitor and every request so the worker's cache can be named by its
 * hash.
 */
export const offlinePage = (locale: Locale, stylesheet: string): string =>
  `<!doctype html>${renderToStaticMarkup(
    <I18nProvider locale={locale}>
      <OfflineDocument locale={locale} stylesheet={stylesheet} />
    </I18nProvider>,
  )}`;

/**
 * Web push's one notice in `locale`, as that locale's worker shows it (P2-27 part 4b): it says
 * only that a moderator decided something, as the e-mail does, and opens the
 * account page, which says what (T-73, T-76). A lock screen shows it to
 * anyone near the device, so it names no poll, profile or decision.
 */
export function pushNotice(locale: Locale): PushNotice {
  const { text } = titles(locale);
  return {
    title: text("pushNoticeTitle"),
    body: text("pushNoticeBody"),
    // The 192-pixel PNG, the list's first (so present): every browser's
    // notifications take a PNG, not all an SVG.
    icon: ICON_PNGS[0]!.path,
    open: "/account",
  };
}
