import { buttonVariants, cn, Fingerprint, groupHex } from "@abolishus/ui";
import { ArrowRight } from "lucide-react";
import { type ReactNode, useId } from "react";

import type { EverydayPoll, EverydayQuestion, LiveBatch } from "./everyday-fixtures.ts";
import {
  EVIDENCE_HREF,
  headline,
  num,
  pct,
  PEOPLE,
  picksSeveral,
  ranked,
  ruleText,
  launchKeyStatement,
} from "./everyday-data.ts";
import { CLIENT_RELEASE } from "./fixtures.ts";
import { Frame } from "./shell.tsx";

export { Frame };
export { StepScene } from "../components/step-scene.tsx";

/** Everyday buttons and answer targets: the kit's buttons, with the register's rounder corners. */
export const ROUND = "";

const NAV = [
  { href: "/discover", label: "Discover" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/polls", label: "Civic record" },
] as const;

export type EverydayNav = (typeof NAV)[number]["href"] | "/";

/**
 * The everyday frame: the same wordmark, grid and footer facts as `MockShell`,
 * with a lighter masthead (a hairline, no mono tagline) and the record one
 * link away.
 */
export function EverydayShell({
  current,
  signedIn = false,
  children,
}: {
  current?: EverydayNav;
  signedIn?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen overflow-x-clip bg-background font-sans text-foreground">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:bg-background focus:p-3"
      >
        Skip to content
      </a>
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-8 gap-y-1 px-4 py-3">
          <a
            href="/"
            className="flex items-baseline gap-3"
            aria-current={current === "/" ? "page" : undefined}
          >
            <span className="font-heading text-2xl font-semibold tracking-tight">Abolish</span>
            <span className="hidden text-sm text-muted-foreground md:inline">
              Ask anything. Check everything.
            </span>
          </a>
          <nav aria-label="Site" className="order-last w-full md:order-none md:ms-auto md:w-auto">
            <ul className="m-0 flex list-none flex-wrap gap-x-6 gap-y-1 p-0 text-base">
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
          <div className="ms-auto flex items-center gap-2 md:ms-0">
            <a
              href="/polls/new"
              className={cn(buttonVariants({ variant: "outline" }), ROUND, "text-base")}
            >
              Ask a question
            </a>
            <a
              href="/account"
              className="inline-flex h-12 items-center px-2 text-base underline-offset-8 hover:underline"
            >
              {signedIn ? "Account" : "Sign in"}
            </a>
          </div>
        </div>
      </header>
      <main id="main">{children}</main>
      <footer className="mt-24 border-t border-border bg-background">
        <Frame className="grid gap-10 py-12 md:grid-cols-12 md:gap-x-6">
          <div className="grid content-start gap-3 md:col-span-5">
            <p className="m-0 font-heading text-xl font-semibold">
              Non-binding, run by citizens, and every count can be checked.
            </p>
            <p className="m-0 text-sm text-muted-foreground">
              Every poll here also lives on the civic record: the public board, the trustees and the
              recount, in full detail.
            </p>
          </div>
          <nav aria-label="The record" className="md:col-span-4">
            <ul className="m-0 grid list-none gap-1 p-0 text-sm">
              {[
                ["/verify", "Verify a result yourself"],
                ["/board", "The public board"],
                ["/trustees", "Who holds the keys"],
                ["/moderation", "Moderation log"],
                ["https://github.com/abolishus/abolish", "Source code"],
              ].map(([href, label]) => (
                <li key={href}>
                  <a
                    className="inline-flex min-h-8 items-center underline underline-offset-4"
                    href={href}
                  >
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <div className="flex items-start gap-3 md:col-span-3">
            <Fingerprint
              value={CLIENT_RELEASE.hash}
              label={`Fingerprint of ballot app ${CLIENT_RELEASE.hash.slice(0, 4)} ${CLIENT_RELEASE.hash.slice(4, 8)}`}
              size={32}
            />
            <p className="m-0 text-sm text-muted-foreground">
              Ballot app {CLIENT_RELEASE.version}. Signed and reproducible; the verifier checks the
              copy you were served.
            </p>
          </div>
        </Frame>
      </footer>
    </div>
  );
}

/** Who asked and when it closes: the only thing above an everyday question. */
export function Byline({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("m-0 flex flex-wrap gap-x-2 text-base text-muted-foreground", className)}>
      {children}
    </p>
  );
}

/**
 * Friendly result bars: label and plain percentage above a bar, the
 * count beside it. Widths ease when a new real total arrives, and stand still
 * under reduced motion.
 */
export function ResultBars({
  question,
  batch,
  caption,
  showCounts = true,
  className,
}: {
  question: EverydayQuestion;
  batch: LiveBatch;
  /** The audience in words, and when: "Among 2,418 people with an account". */
  caption: ReactNode;
  showCounts?: boolean;
  className?: string;
}) {
  const captionId = useId();
  const rows = ranked(question, batch);
  const top = rows[0]?.key;
  const order = question.options.map((o) => rows.find((r) => r.key === o.key)!);
  return (
    <figure aria-labelledby={captionId} className={cn("m-0 grid gap-4", className)}>
      <figcaption id={captionId} className="text-sm text-muted-foreground">
        {caption}
      </figcaption>
      <ol className="m-0 grid list-none gap-4 p-0">
        {order.map((row) => {
          const lead = row.key === top;
          return (
            <li key={row.key} className="grid gap-1.5">
              <span className="flex items-baseline justify-between gap-4">
                <span className={cn("text-base text-pretty", lead && "font-semibold")}>
                  {row.label}
                </span>
                <span className="shrink-0 text-end tabular-nums">
                  <span className={cn("text-base", lead && "font-semibold")}>{pct(row.share)}</span>
                  {showCounts ? (
                    <span className="ms-2 text-sm text-muted-foreground">{num(row.count)}</span>
                  ) : null}
                </span>
              </span>
              <span aria-hidden="true" className="block h-2.5 overflow-hidden bg-muted">
                <span
                  className={cn(
                    "block h-full transition-[width] duration-500 ease-out motion-reduce:transition-none",
                    lead ? "bg-primary" : "bg-foreground/55",
                  )}
                  style={{ width: `${row.share * 100}%` }}
                />
              </span>
            </li>
          );
        })}
      </ol>
    </figure>
  );
}

/** One question's result: sentence first, then bars, then the multi-pick note. */
export function QuestionResult({
  question,
  number,
  batch,
  caption,
}: {
  question: EverydayQuestion;
  number: number;
  batch: LiveBatch;
  caption: ReactNode;
}) {
  const titleId = useId();
  return (
    <article
      aria-labelledby={titleId}
      className="reveal grid gap-6 border border-border p-5 sm:p-8 lg:grid-cols-12 lg:gap-x-10"
    >
      <div className="grid content-start gap-3 lg:col-span-5">
        <p className="m-0 text-sm text-muted-foreground">
          Question {number} · {ruleText(question.rule)}
        </p>
        <h3 id={titleId} className="m-0 text-xl leading-snug font-medium text-pretty">
          {question.text}
        </h3>
        <p
          className="m-0 font-heading text-2xl leading-tight font-semibold text-balance sm:text-3xl"
          data-testid={`headline-${question.key}`}
        >
          {headline(question, batch)}
        </p>
      </div>
      <div className="grid content-start gap-4 lg:col-span-7">
        <ResultBars question={question} batch={batch} caption={caption} />
        {picksSeveral(question) ? (
          <p className="m-0 text-sm text-muted-foreground">
            People could pick more than one, so these add up to more than 100%.
          </p>
        ) : null}
      </div>
    </article>
  );
}

/** "Among 2,418 people with an account · updated 7 Nov, 12:00 UTC" */
export function audienceCaption(ballots: number, when: string) {
  return (
    <>
      Among <span className="text-foreground tabular-nums">{num(ballots)}</span> {PEOPLE} · {when}
    </>
  );
}

/** The fingerprint as a small seal: the only evidence on an everyday surface. */
export function Seal({
  hash,
  subject,
  children,
}: {
  hash: string;
  subject: string;
  children: ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-3">
      <Fingerprint
        value={hash}
        label={`Fingerprint of ${subject} ${hash.slice(0, 4)} ${hash.slice(4, 8)}`}
        size={44}
      />
      <span className="text-sm">{children}</span>
    </span>
  );
}

/**
 * What sits behind "How do we know this is real?": the evidence for an
 * everyday poll, in plain words, with the civic record one link further.
 */
export function EvidenceDetails({
  poll,
  headingLevel = 3,
}: {
  poll: EverydayPoll;
  headingLevel?: 2 | 3;
}) {
  const H = headingLevel === 2 ? "h2" : "h3";
  const head = "m-0 font-heading text-lg font-semibold";
  return (
    <div className="grid gap-8 text-base">
      <section className="grid gap-3">
        <H className={head}>This poll’s fingerprint</H>
        <p className="m-0 text-sm text-muted-foreground">
          The questions, answers and rules were fixed before the first answer. Anything changed
          would draw a different shape.
        </p>
        <div className="flex items-start gap-4">
          <Fingerprint
            value={poll.id}
            label={`Fingerprint of poll ${poll.id.slice(0, 4)} ${poll.id.slice(4, 8)}`}
            size={64}
          />
          <code translate="no" className="min-w-0 font-mono text-xs/relaxed break-all">
            {groupHex(poll.id).join(" ")}
          </code>
        </div>
      </section>
      <section className="grid gap-3">
        <H className={head}>Every answer is on a public list</H>
        <p className="m-0 text-sm">
          Each answer is sealed on the answerer’s own device and added to the public board, where
          anyone can see it was counted. What it says stays sealed, and it is never linked to who
          sent it.
        </p>
        <a
          href="/board"
          className="inline-flex min-h-12 items-center gap-1 underline underline-offset-4"
        >
          See this poll on the board
          <ArrowRight aria-hidden="true" className="size-4" />
        </a>
      </section>
      <section className="grid gap-3">
        <H className={head}>Who holds the keys</H>
        <p className="m-0 text-sm" data-testid="trustee-statement">
          {launchKeyStatement(poll)}
        </p>
        <ul className="m-0 grid list-none gap-2 p-0 text-sm">
          <li className="border border-border px-3 py-2">
            <span className="font-medium">Abolish</span>
            <span className="block text-muted-foreground">
              Holds the key during launch; destroys it after the final count
            </span>
          </li>
          {poll.trustees.added.map((name) => (
            <li key={name} className="border border-border px-3 py-2">
              <span className="font-medium">{name}</span>
              <span className="block text-muted-foreground">Added by {poll.askedBy}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="grid gap-3">
        <H className={head}>Check it yourself</H>
        <p className="m-0 text-sm">
          The civic record shows this same poll the long way: every board entry, every release, and
          how to recount it without our servers.
        </p>
        <div className="flex flex-wrap gap-2">
          <a href={EVIDENCE_HREF} className={cn(buttonVariants(), ROUND)}>
            Open the civic record
            <ArrowRight aria-hidden="true" />
          </a>
          <a href="/verify" className={cn(buttonVariants({ variant: "outline" }), ROUND)}>
            Recount it
            <ArrowRight aria-hidden="true" />
          </a>
        </div>
      </section>
    </div>
  );
}
