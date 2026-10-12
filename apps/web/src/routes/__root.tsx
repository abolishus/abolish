import { I18nProvider } from "@abolishus/ui";
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { Failed, NotFound, SiteLayout } from "../components/site-layout.tsx";
import { LOCALE } from "../messages.ts";
import stylesheet from "../styles.css?url";

function Document({ children }: { children: ReactNode }) {
  return (
    <html lang={LOCALE}>
      <head>
        <HeadContent />
      </head>
      <body>
        <I18nProvider locale={LOCALE}>
          <SiteLayout>{children}</SiteLayout>
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
      { title: "Abolish" },
    ],
    links: [{ rel: "stylesheet", href: stylesheet }],
  }),
  shellComponent: Document,
  component: Outlet,
  notFoundComponent: NotFound,
  errorComponent: Failed,
});
