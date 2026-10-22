import { I18nProvider, useTranslate } from "@abolishus/ui";
import { renderToStaticMarkup } from "react-dom/server";

import { Offline, SiteLayout } from "../components/site-layout.tsx";
import { catalogs, LOCALE } from "../messages.ts";
import { ICON_SVG_PATH } from "./install.ts";

function OfflineDocument({ stylesheet }: { stylesheet: string }) {
  const t = useTranslate(catalogs);
  return (
    <html lang={LOCALE}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* Shown in place of a page that couldn't load, never a page to find. */}
        <meta name="robots" content="noindex" />
        <title>{t("offlineTitle")}</title>
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
 * The offline page's HTML (src/app/offline.ts): the site's frame, without
 * its links, and the notice, with no script, the same bytes for every visitor
 * and every request so the worker's cache can be named by its hash.
 */
export const offlinePage = (stylesheet: string): string =>
  `<!doctype html>${renderToStaticMarkup(
    <I18nProvider locale={LOCALE}>
      <OfflineDocument stylesheet={stylesheet} />
    </I18nProvider>,
  )}`;
