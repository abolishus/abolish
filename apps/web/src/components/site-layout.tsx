import { useTranslate } from "@abolishus/ui";
import { type ReactNode, useEffect } from "react";

import { reportCaught } from "../error-reports.ts";

import { catalogs } from "../messages.ts";

/** Every page's frame: a header with the site's links, then the page. */
export function SiteLayout({ children }: { children: ReactNode }) {
  const t = useTranslate(catalogs);
  return (
    <div className="min-h-screen bg-background font-sans text-foreground">
      <header className="border-b border-border">
        <nav
          aria-label={t("siteName")}
          className="mx-auto flex max-w-4xl flex-wrap items-center gap-6 px-4 py-4"
        >
          <a href="/" className="text-xl font-semibold">
            {t("siteName")}
          </a>
          <a href="/moderation" className="underline-offset-4 hover:underline">
            {t("navModeration")}
          </a>
          <a href="/account" className="underline-offset-4 hover:underline">
            {t("navAccount")}
          </a>
        </nav>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-10">{children}</main>
    </div>
  );
}

/** A page that says only what went wrong. */
export function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid max-w-prose gap-4">
      <h1 className="text-3xl font-semibold">{title}</h1>
      <p>{children}</p>
    </section>
  );
}

export function NotFound() {
  const t = useTranslate(catalogs);
  return <Notice title={t("notFoundTitle")}>{t("notFound")}</Notice>;
}

// Says nothing about the error itself: its message could quote an answer
// from the API or the visitor's input, and the page is public. Error
// tracking gets its name and frames only (src/error-reports.ts).
export function Failed({ error }: { error?: unknown }) {
  const t = useTranslate(catalogs);
  useEffect(() => reportCaught(error), [error]);
  return <Notice title={t("errorTitle")}>{t("error")}</Notice>;
}
