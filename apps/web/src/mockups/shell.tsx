import { cn, Fingerprint } from "@abolishus/ui";
import type { ReactNode } from "react";

import { CLIENT_RELEASE, ENTRY_POINTS } from "./fixtures.ts";

const NAV = [
  { href: "/polls", label: "Polls" },
  { href: "/board", label: "The board" },
  { href: "/verify", label: "Verify" },
  { href: "/trustees", label: "Trustees" },
  { href: "/how-it-works", label: "How it works" },
] as const;

export type NavKey =
  | (typeof NAV)[number]["href"]
  | "/"
  | "/polls/new"
  | "/account"
  | "/moderation"
  | "/receipt";

/** The site's frame for the page mockups: masthead, page, and the record's colophon. */
export function MockShell({
  current,
  signedIn = false,
  children,
}: {
  current?: NavKey;
  signedIn?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background font-sans text-foreground">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:bg-background focus:p-3"
      >
        Skip to content
      </a>
      <header className="border-b border-foreground">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-8 gap-y-2 px-4 py-4">
          <a
            href="/"
            className="flex items-baseline gap-3"
            aria-current={current === "/" ? "page" : undefined}
          >
            <span className="font-heading text-2xl font-semibold tracking-tight">Abolish</span>
            <span className="hidden font-mono text-xs tracking-wide text-muted-foreground uppercase md:inline">
              A public record of public will
            </span>
          </a>
          <nav aria-label="Site" className="order-last w-full md:order-none md:ms-auto md:w-auto">
            <ul className="m-0 flex list-none flex-wrap gap-x-6 gap-y-1 p-0 text-sm">
              {NAV.map((item) => (
                <li key={item.href}>
                  <a
                    href={item.href}
                    aria-current={current === item.href ? "page" : undefined}
                    className="inline-flex min-h-12 items-center underline-offset-8 hover:underline aria-[current=page]:underline aria-[current=page]:decoration-primary aria-[current=page]:decoration-2"
                  >
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <div className="ms-auto flex items-center gap-3 md:ms-0">
            <a
              href="/polls/new"
              aria-current={current === "/polls/new" ? "page" : undefined}
              className="inline-flex h-12 items-center border border-foreground px-4 text-sm font-medium hover:bg-muted"
            >
              Create a poll
            </a>
            <a
              href="/account"
              aria-current={current === "/account" ? "page" : undefined}
              className="inline-flex h-12 items-center px-2 text-sm underline-offset-8 hover:underline"
            >
              {signedIn ? "Account" : "Sign in"}
            </a>
          </div>
        </div>
      </header>
      <main id="main">{children}</main>
      <footer className="mt-24 border-t border-foreground">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 md:grid-cols-3">
          <section aria-labelledby="footer-entry" className="grid content-start gap-3">
            <h2
              id="footer-entry"
              className="m-0 font-mono text-xs tracking-wide text-muted-foreground uppercase"
            >
              Entry points
            </h2>
            <ul className="m-0 grid list-none gap-2 p-0 text-sm">
              {ENTRY_POINTS.map((e) => (
                <li key={e.name}>
                  <span className="font-mono">{e.name}</span>
                  <span className="block text-muted-foreground">{e.note}</span>
                </li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="footer-client" className="grid content-start gap-3">
            <h2
              id="footer-client"
              className="m-0 font-mono text-xs tracking-wide text-muted-foreground uppercase"
            >
              Ballot client {CLIENT_RELEASE.version}
            </h2>
            <div className="flex items-center gap-3">
              <Fingerprint
                value={CLIENT_RELEASE.hash}
                label={`Fingerprint of ballot client ${CLIENT_RELEASE.hash.slice(0, 8)}`}
                size={40}
              />
              <code className="font-mono text-xs break-all">{CLIENT_RELEASE.hash}</code>
            </div>
            <p className="m-0 text-sm text-muted-foreground">
              Signed, reproducible and pinned to IPFS. The verifier checks the copy you were served.
            </p>
          </section>
          <section aria-labelledby="footer-about" className="grid content-start gap-3">
            <h2
              id="footer-about"
              className="m-0 font-mono text-xs tracking-wide text-muted-foreground uppercase"
            >
              About this record
            </h2>
            <p className="m-0 text-sm">
              Non-binding. Run by citizens. Every result can be recounted from Ethereum and IPFS
              without our servers.
            </p>
            <ul className="m-0 flex list-none flex-wrap gap-x-4 p-0 text-sm">
              <li>
                <a className="underline underline-offset-4" href="/verify">
                  Verify it yourself
                </a>
              </li>
              <li>
                <a className="underline underline-offset-4" href="/moderation">
                  Moderation log
                </a>
              </li>
              <li>
                <a
                  className="underline underline-offset-4"
                  href="https://github.com/abolishus/abolish"
                >
                  Source code
                </a>
              </li>
            </ul>
          </section>
        </div>
      </footer>
    </div>
  );
}

/** A page's top matter: section mark, title and lede, on the 12-column grid. */
export function PageHead({
  eyebrow,
  title,
  lede,
  children,
  className,
}: {
  eyebrow?: string;
  title: string;
  lede?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mx-auto grid max-w-6xl gap-6 px-4 pt-12 pb-10 md:pt-20", className)}>
      {eyebrow === undefined ? null : (
        <p className="m-0 font-mono text-xs tracking-widest text-muted-foreground uppercase">
          {eyebrow}
        </p>
      )}
      <h1 className="m-0 max-w-4xl font-heading text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-6xl">
        {title}
      </h1>
      {lede === undefined ? null : <p className="m-0 max-w-prose text-lg text-pretty">{lede}</p>}
      {children}
    </div>
  );
}

/** The 12-column content frame every section sits in. */
export function Frame({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mx-auto max-w-6xl px-4", className)}>{children}</div>;
}
