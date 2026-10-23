import { I18nProvider } from "@abolishus/ui";
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
  useRouterState,
} from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";

import { ICON_SVG_PATH, MANIFEST_PATH } from "../app/install.ts";
import { registerOfflineShell } from "../app/offline.ts";
import { Failed, NotFound, SiteLayout } from "../components/site-layout.tsx";
import { reportErrors } from "../error-reports.ts";
import type { RouterContext } from "../router.tsx";
import stylesheet from "../styles.css?url";
import { titles } from "../titles.ts";

function Document({ children }: { children: ReactNode }) {
  // Error tracking, in the browser only (src/error-reports.ts).
  useEffect(() => reportErrors(window), []);
  // The offline shell (P2-28 part 1b): a page that can't load shows /offline.
  useEffect(() => registerOfflineShell(navigator), []);
  const path = useRouterState({ select: (s) => s.location.pathname });
  const { locale } = Route.useRouteContext();
  return (
    <html lang={locale}>
      <head>
        <HeadContent />
      </head>
      <body>
        <I18nProvider locale={locale}>
          <SiteLayout current={path}>{children}</SiteLayout>
        </I18nProvider>
        <Scripts />
      </body>
    </html>
  );
}

export const Route = createRootRouteWithContext<RouterContext>()({
  // The site's name, which the home page keeps and every other page's own
  // head replaces (src/titles.ts). A page that isn't there or failed has no
  // head of its own to run, so the not-found and error pages are named here.
  head: ({ match, matches }) => {
    const { pageTitle, text } = titles(match.context.locale);
    return {
      meta: [
        { charSet: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        matches.some((m) => m.status === "notFound" || m._notFound === true)
          ? pageTitle(text("notFoundPageTitle"))
          : matches.some((m) => m.status === "error")
            ? pageTitle(text("errorPageTitle"))
            : pageTitle(),
      ],
      links: [
        { rel: "stylesheet", href: stylesheet },
        // Installable (P2-28 part 1a): src/app/install.ts.
        { rel: "manifest", href: MANIFEST_PATH },
        { rel: "icon", href: ICON_SVG_PATH, type: "image/svg+xml" },
        { rel: "apple-touch-icon", href: "/icons/apple-touch-icon.png" },
      ],
    };
  },
  shellComponent: Document,
  component: Outlet,
  notFoundComponent: NotFound,
  errorComponent: Failed,
});
