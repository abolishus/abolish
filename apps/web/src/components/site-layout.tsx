import { Button, buttonVariants, cn, useTranslate } from "@abolishus/ui";
import { ArrowRight, RotateCw } from "lucide-react";
import { type ReactNode, useEffect } from "react";

import { reportCaught } from "../error-reports.ts";

import { catalogs, type Messages } from "../messages.ts";

type Key = keyof Messages;

// Only routes this server has. The mockups' Verify, Board and Trustees join
// as their pages land (docs/status/P2-19.md).
const NAV = [
  { href: "/discover", label: "navDiscover" },
  { href: "/polls", label: "navPolls" },
  { href: "/how-it-works", label: "navHowItWorks" },
  { href: "/moderation", label: "navModeration" },
] as const satisfies readonly { href: string; label: Key }[];

// A phone's header keeps only the first two, the everyday ways in: all four
// don't fit one row at 320px, and wrapped they made the header 177px tall.
// The footer lists every one at every width.
const PHONE_NAV = 2;

/** The 12-column content frame every section sits in. */
function Frame({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mx-auto max-w-6xl px-4", className)}>{children}</div>;
}

/**
 * Every page's frame, in the everyday register ([[language]]): wordmark,
 * the site's links and the footer's claim. `current` is the page's path, for
 * `aria-current`. `links={false}` leaves out every link to another page, for
 * the offline page, where each of them would fail the same way.
 */
export function SiteLayout({
  current,
  links = true,
  children,
}: {
  current?: string;
  links?: boolean;
  children: ReactNode;
}) {
  const t = useTranslate(catalogs);
  const here = (href: string) => (current === href ? "page" : undefined);
  const wordmark = (
    <>
      <span className="font-heading text-2xl font-semibold tracking-tight">{t("siteName")}</span>
      {/* From lg: at md it pushed Account onto a second row. */}
      <span className="hidden text-sm text-muted-foreground lg:inline">{t("siteTagline")}</span>
    </>
  );
  return (
    <div className="min-h-screen overflow-x-clip bg-background font-sans text-foreground">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:bg-background focus:p-3"
      >
        {t("skipToContent")}
      </a>
      <header className="border-b border-border">
        {/* One row at every width from 320px; it wraps only when the text is
            enlarged. */}
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-2 px-4 py-3 min-[360px]:gap-x-4 md:gap-x-8">
          {links ? (
            <a href="/" className="flex items-baseline gap-3" aria-current={here("/")}>
              {wordmark}
            </a>
          ) : (
            // The same height as the site's links would give the header.
            <div className="flex min-h-12 items-center">
              <p className="m-0 flex items-baseline gap-3">{wordmark}</p>
            </div>
          )}
          {links && (
            <>
              <nav aria-label={t("navSite")} className="ms-auto">
                <ul className="m-0 flex list-none flex-wrap gap-x-2 p-0 text-base min-[360px]:gap-x-4 md:gap-x-6">
                  {NAV.map((item, i) => (
                    <li
                      key={item.href}
                      className={i < PHONE_NAV ? undefined : "hidden md:list-item"}
                    >
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
                className="inline-flex h-12 items-center px-2 text-base underline-offset-8 hover:underline aria-[current=page]:underline aria-[current=page]:decoration-primary aria-[current=page]:decoration-2"
              >
                {t("navAccount")}
              </a>
            </>
          )}
        </div>
      </header>
      <main id="main">
        <Frame className="py-10">{children}</Frame>
      </main>
      <footer className="mt-12 border-t border-border bg-background sm:mt-24">
        <Frame className="grid gap-10 py-12 md:grid-cols-12 md:gap-x-6">
          <div className="grid content-start gap-3 md:col-span-7">
            <p className="m-0 font-heading text-xl font-semibold">{t("footerClaim")}</p>
            <p className="m-0 text-sm text-muted-foreground">{t("footerRecord")}</p>
          </div>
          {/* The entry points and the ballot app's release fingerprint join
              here once the server has them to show (P4-4); until then the
              footer leaves them out rather than showing samples. */}
          {links && (
            <nav aria-label={t("footerNav")} className="md:col-span-5">
              <ul className="m-0 grid list-none gap-1 p-0 text-sm">
                {NAV.map((item) => (
                  <li key={item.href}>
                    {/* Marked here too: below 768px How it works and the
                        moderation log are only in the footer, so this is
                        the one place a phone shows which page it is on. */}
                    <a
                      className="inline-flex min-h-8 items-center underline underline-offset-4 aria-[current=page]:font-semibold aria-[current=page]:decoration-primary aria-[current=page]:decoration-2"
                      href={item.href}
                      aria-current={here(item.href)}
                    >
                      {t(item.label)}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          )}
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

// Four, so the two-column grid closes with no empty cell. Discover first:
// it's where an everyday visitor finds a poll again by searching.
const WAYS = [
  { href: "/discover", label: "navDiscover", note: "navDiscoverNote" },
  { href: "/polls", label: "navPolls", note: "navPollsNote" },
  { href: "/moderation", label: "navModeration", note: "navModerationNote" },
  { href: "/", label: "navHome", note: "navHomeNote" },
] as const satisfies readonly { href: string; label: Key; note: Key }[];

/**
 * A system page: what happened, in words, then other places to go, unless
 * there are none (`ways={false}`, offline, where every other page fails too).
 * `code` is only for not found's familiar 404: elsewhere a label above the
 * title would only repeat it.
 */
function SystemPage({
  code,
  title,
  ways = true,
  children,
}: {
  code?: string;
  title: string;
  ways?: boolean;
  children: ReactNode;
}) {
  const t = useTranslate(catalogs);
  return (
    <div className="grid gap-8 sm:gap-12">
      {/* Smaller and tighter on a phone, so the page's one action, or the
          first place to go, is on the first screen at 360 by 640. */}
      <div className="grid gap-5 sm:gap-8 sm:pt-6 md:pt-18 lg:grid-cols-12">
        {code && (
          <p className="m-0 font-mono text-xs tracking-widest text-muted-foreground uppercase lg:col-span-12">
            {code}
          </p>
        )}
        <h1 className="m-0 font-heading text-4xl leading-[1.02] font-semibold tracking-tight text-balance sm:text-6xl lg:col-span-9 lg:text-7xl">
          {title}
        </h1>
        <div className="grid max-w-prose gap-4 text-lg text-pretty lg:col-span-7">{children}</div>
      </div>
      {ways && (
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
      )}
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

/**
 * What the offline shell shows when a page can't be fetched (P2-28 part 1b,
 * src/app/offline.ts). It is served in place of whatever page was asked for,
 * with no script, so "Try again" is a plain link to the address in the
 * browser's bar: the empty `retry` the server renders is this document's own
 * URL. (React's browser renderer drops an empty `href`, so a story passes
 * an address of its own.)
 */
export function Offline({ retry = "" }: { retry?: string }) {
  const t = useTranslate(catalogs);
  return (
    <SystemPage title={t("offlineTitle")} ways={false}>
      <p className="m-0">{t("offline")}</p>
      <p className="m-0 text-base">{t("offlineKept")}</p>
      <div>
        <a href={retry} className={buttonVariants({ size: "lg" })}>
          <RotateCw aria-hidden="true" data-icon="inline-start" />
          {t("offlineRetry")}
        </a>
      </div>
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
    <SystemPage title={t("errorTitle")}>
      <p className="m-0">{t("error")}</p>
      <p className="m-0 text-base">{t("errorBallot")}</p>
      <div>
        <Button size="lg" onClick={() => window.location.reload()}>
          <RotateCw aria-hidden="true" data-icon="inline-start" />
          {t("errorRetry")}
        </Button>
      </div>
    </SystemPage>
  );
}
