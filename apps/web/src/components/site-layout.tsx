import { Button, cn, useTranslate } from "@abolishus/ui";
import { ArrowRight, RotateCw } from "lucide-react";
import { type ReactNode, useEffect } from "react";

import { reportCaught } from "../error-reports.ts";

import { catalogs, type Messages } from "../messages.ts";

type Key = keyof Messages;

// Only routes this server has. The mockups' Discover, How it works, Verify,
// Board and Trustees join as their pages land (docs/status/P2-19.md).
const NAV = [
  { href: "/polls", label: "navPolls" },
  { href: "/moderation", label: "navModeration" },
] as const satisfies readonly { href: string; label: Key }[];

/** The 12-column content frame every section sits in. */
export function Frame({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mx-auto max-w-6xl px-4", className)}>{children}</div>;
}

/**
 * Every page's frame, in the everyday register ([[language]]): wordmark,
 * the site's links and the footer's claim. `current` is the page's path, for
 * `aria-current`.
 */
export function SiteLayout({ current, children }: { current?: string; children: ReactNode }) {
  const t = useTranslate(catalogs);
  const here = (href: string) => (current === href ? "page" : undefined);
  return (
    <div className="min-h-screen overflow-x-clip bg-background font-sans text-foreground">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:bg-background focus:p-3"
      >
        {t("skipToContent")}
      </a>
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-8 gap-y-1 px-4 py-3">
          <a href="/" className="flex items-baseline gap-3" aria-current={here("/")}>
            <span className="font-heading text-2xl font-semibold tracking-tight">
              {t("siteName")}
            </span>
            <span className="hidden text-sm text-muted-foreground md:inline">
              {t("siteTagline")}
            </span>
          </a>
          <nav
            aria-label={t("navSite")}
            className="order-last w-full md:order-none md:ms-auto md:w-auto"
          >
            <ul className="m-0 flex list-none flex-wrap gap-x-6 gap-y-1 p-0 text-base">
              {NAV.map((item) => (
                <li key={item.href}>
                  <a
                    href={item.href}
                    aria-current={here(item.href)}
                    className="inline-flex min-h-12 items-center underline-offset-8 hover:underline aria-[current=page]:underline aria-[current=page]:decoration-primary aria-[current=page]:decoration-2"
                  >
                    {t(item.label)}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <a
            href="/account"
            aria-current={here("/account")}
            className="ms-auto inline-flex h-12 items-center px-2 text-base underline-offset-8 hover:underline aria-[current=page]:underline aria-[current=page]:decoration-primary aria-[current=page]:decoration-2 md:ms-0"
          >
            {t("navAccount")}
          </a>
        </div>
      </header>
      <main id="main">
        <Frame className="py-10">{children}</Frame>
      </main>
      <footer className="mt-24 border-t border-border bg-background">
        <Frame className="grid gap-10 py-12 md:grid-cols-12 md:gap-x-6">
          <div className="grid content-start gap-3 md:col-span-7">
            <p className="m-0 font-heading text-xl font-semibold">{t("footerClaim")}</p>
            <p className="m-0 text-sm text-muted-foreground">{t("footerRecord")}</p>
          </div>
          {/* The entry points and the ballot app's release fingerprint join
              here once the server has them to show (P4-4); until then the
              footer leaves them out rather than showing samples. */}
          <nav aria-label={t("footerNav")} className="md:col-span-5">
            <ul className="m-0 grid list-none gap-1 p-0 text-sm">
              {NAV.map((item) => (
                <li key={item.href}>
                  <a
                    className="inline-flex min-h-8 items-center underline underline-offset-4"
                    href={item.href}
                  >
                    {t(item.label)}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </Frame>
      </footer>
    </div>
  );
}

/** A page that says only what went wrong. */
export function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid max-w-prose gap-4">
      <h1 className="m-0 font-heading text-4xl leading-[1.05] font-semibold tracking-tight text-balance">
        {title}
      </h1>
      <p className="m-0 text-lg text-pretty">{children}</p>
    </section>
  );
}

const WAYS = [
  { href: "/polls", label: "navPolls", note: "navPollsNote" },
  { href: "/moderation", label: "navModeration", note: "navModerationNote" },
  { href: "/", label: "navHome", note: "navHomeNote" },
] as const satisfies readonly { href: string; label: Key; note: Key }[];

/** A system page: what happened, in words, then other places to go. */
function SystemPage({
  code,
  title,
  children,
}: {
  code: string;
  title: string;
  children: ReactNode;
}) {
  const t = useTranslate(catalogs);
  return (
    <div className="grid gap-12">
      <div className="grid gap-8 pt-6 md:pt-18 lg:grid-cols-12">
        <p className="m-0 font-mono text-xs tracking-widest text-muted-foreground uppercase lg:col-span-12">
          {code}
        </p>
        <h1 className="m-0 font-heading text-5xl leading-[1.02] font-semibold tracking-tight text-balance sm:text-7xl lg:col-span-9">
          {title}
        </h1>
        <div className="grid max-w-prose gap-4 text-lg text-pretty lg:col-span-7">{children}</div>
      </div>
      <nav aria-label={t("otherPlaces")}>
        <ul className="m-0 grid list-none border-t border-border p-0 sm:grid-cols-2">
          {WAYS.map((w) => (
            <li key={w.href} className="border-b border-border sm:odd:border-e">
              <a
                href={w.href}
                className="group grid min-h-12 grid-cols-[1fr_auto] items-center gap-x-4 px-1 py-5 hover:bg-muted sm:px-5"
              >
                <span className="grid gap-0.5">
                  <span className="text-lg font-semibold">{t(w.label)}</span>
                  <span className="text-sm text-muted-foreground group-hover:text-foreground">
                    {t(w.note)}
                  </span>
                </span>
                <ArrowRight aria-hidden="true" className="size-5" />
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}

export function NotFound() {
  const t = useTranslate(catalogs);
  return (
    <SystemPage code={t("notFoundCode")} title={t("notFoundTitle")}>
      <p className="m-0">{t("notFound")}</p>
      <p className="m-0 text-base">{t("notFoundPoll")}</p>
    </SystemPage>
  );
}

// Says nothing about the error itself: its message could quote an answer
// from the API or the visitor's input, and the page is public. Error
// tracking gets its name and frames only (src/error-reports.ts).
export function Failed({ error }: { error?: unknown }) {
  const t = useTranslate(catalogs);
  useEffect(() => reportCaught(error), [error]);
  return (
    <SystemPage code={t("errorCode")} title={t("errorTitle")}>
      <p className="m-0">{t("error")}</p>
      <div>
        <Button size="lg" onClick={() => window.location.reload()}>
          <RotateCw aria-hidden="true" data-icon="inline-start" />
          {t("errorRetry")}
        </Button>
      </div>
    </SystemPage>
  );
}
