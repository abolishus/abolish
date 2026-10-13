import { formatMessage, I18nProvider } from "@abolishus/ui";
import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
  useRouterState,
} from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";

import { Failed, NotFound, SiteLayout } from "../components/site-layout.tsx";
import { reportErrors } from "../error-reports.ts";
import { catalogs, LOCALE } from "../messages.ts";
import stylesheet from "../styles.css?url";

// LOCALE's catalog is always present: it is the source catalog.
const siteName = catalogs[LOCALE]!.siteName;

function Document({ children }: { children: ReactNode }) {
  // Error tracking, in the browser only (src/error-reports.ts).
  useEffect(() => reportErrors(window), []);
  const path = useRouterState({ select: (s) => s.location.pathname });
  return (
    <html lang={LOCALE}>
      <head>
        <HeadContent />
      </head>
      <body>
        <I18nProvider locale={LOCALE}>
          <SiteLayout current={path}>{children}</SiteLayout>
        </I18nProvider>
        <Scripts />
      </body>
    </html>
  );
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: formatMessage(LOCALE, siteName) },
    ],
    links: [{ rel: "stylesheet", href: stylesheet }],
  }),
  shellComponent: Document,
  component: Outlet,
  notFoundComponent: NotFound,
  errorComponent: Failed,
});
