import { buttonVariants, cn, useTranslate } from "@abolishus/ui";
import { ArrowRight } from "lucide-react";
import { Fragment } from "react";

import { catalogs } from "../messages.ts";
import { type StreamCard as Card, streamHref } from "../stream.ts";
import { StreamCard } from "./stream.tsx";
import { TrustScene } from "./trust-scene.tsx";

export interface Newest {
  readonly cards: readonly Card[];
  /** The ballot client's address the cards' answers open, or `null` if none is set. */
  readonly ballot: string | null;
  /** Whether Tier 0 asks for a phone here, which names it on each card's count. */
  readonly phoneVerification: boolean;
}

/**
 * The front page, in the everyday register ([[language]]): the promise, a
 * way to ask and a way to browse, the newest questions answerable from their
 * cards, and why an answer can be trusted. `newest` is `undefined` when the
 * API didn't answer, so the page stays up without it and says nothing of
 * why (T-67). `featured` is the question beside the promise, the most
 * answered this week of those not among the newest, answerable from its
 * card as they are; with none, the promise has the row to itself.
 */
export function HomePage({
  newest,
  featured,
}: {
  newest: Newest | undefined;
  featured?: Card | undefined;
}) {
  const t = useTranslate(catalogs);
  const listed = newest !== undefined && newest.cards.length > 0;
  const answerable =
    listed && newest.ballot !== null && newest.cards.some((c) => c.kind === "poll");
  return (
    <div className="grid gap-16">
      <section className="grid gap-4 sm:gap-8 sm:pt-2 md:pt-10 lg:grid-cols-12 lg:gap-x-10">
        {/* 36px on a phone: at 48px the title took six lines and pushed both
            actions below a 640px screen. From 640px each promise starts its
            own line: run together, the lines broke after "Anyone" twice and
            split every promise but the first. The whole row from 1024px,
            where the longest promise fits on one line; below, it wraps once,
            between "Anyone can" and "check the count", as on a phone. */}
        <h1 className="m-0 font-heading text-4xl leading-none font-semibold tracking-tight text-balance sm:text-7xl lg:col-span-12">
          {t("homeTitle")
            .split(/(?<=[.!?])\s+/)
            .map((sentence, i) => (
              <Fragment key={sentence}>
                {i > 0 ? " " : null}
                <span className="sm:block">{sentence}</span>
              </Fragment>
            ))}
        </h1>
        <div className="grid content-start gap-4 sm:gap-8 lg:col-span-7">
          <p className="m-0 max-w-prose text-lg text-pretty sm:text-xl">{t("homeLede")}</p>
          <div className="flex flex-wrap gap-3">
            {/* A new poll's form can't save without an account, so asking
                starts on the account page, which asks a visitor to sign in
                for it and then opens the form. */}
            <a href="/account?next=new-poll" className={buttonVariants({ size: "lg" })}>
              {t("homeAsk")}
            </a>
            <a href="/discover" className={buttonVariants({ size: "lg", variant: "outline" })}>
              {t("homeBrowse")}
            </a>
          </div>
          <p className="m-0 text-base text-muted-foreground">{t("homeNonBinding")}</p>
        </div>
        {/* After the ways in, so on a phone both stay on the first screen;
            beside them from 1024px, in the columns the lede leaves. Its
            card says what choosing an answer does, since the newest
            questions' lede, which says it for theirs, comes below it. */}
        {newest === undefined || featured === undefined ? null : (
          <section
            aria-labelledby="featured-title"
            className="grid content-start gap-3 lg:col-span-5"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h2 id="featured-title" className="m-0 text-lg font-medium">
                {t("sort_answered")}
              </h2>
              <a
                href={streamHref("answered")}
                className="inline-flex min-h-12 items-center text-base underline underline-offset-4"
              >
                {t("homeFeaturedAll")}
              </a>
            </div>
            <StreamCard
              card={featured}
              ballot={newest.ballot}
              phoneVerification={newest.phoneVerification}
            />
          </section>
        )}
      </section>
      <section aria-labelledby="newest-title" className="grid gap-8 border-t border-border pt-16">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="grid gap-3">
            <h2
              id="newest-title"
              className="m-0 font-heading text-3xl leading-tight font-semibold sm:text-5xl"
            >
              {t("homeStreamTitle")}
            </h2>
            {/* Said once here rather than on each card, which on a phone
                read the same two sentences three times down the page. Only
                over cards: above the empty or unavailable note it promised
                the questions that note then says aren't there. */}
            {listed ? (
              <p className="m-0 max-w-prose text-lg text-pretty">
                {t("homeStreamLede")}
                {answerable ? <> {t("homeStreamPick")}</> : null}
              </p>
            ) : null}
          </div>
          {/* Beside the title only where the cards share a row: where they
              stack, it follows them, so the first card comes straight after
              the lede and the way on is where the list ends. Only over
              cards: Discover lists the same open polls, so with none open it
              only says so again, and when the API didn't answer it is the
              error page. */}
          {listed ? (
            <a
              href="/discover"
              className={cn(buttonVariants({ variant: "outline" }), "hidden gap-2 lg:inline-flex")}
            >
              {t("homeStreamAll")}
              <ArrowRight aria-hidden="true" />
            </a>
          ) : null}
        </div>
        {newest === undefined ? (
          <p className="m-0 text-lg">{t("homeListUnavailable")}</p>
        ) : newest.cards.length === 0 ? (
          <p className="m-0 border border-dashed border-border p-8 text-lg">
            {t("homeStreamEmpty")}
          </p>
        ) : (
          <ol
            aria-label={t("homeStreamTitle")}
            className="m-0 grid list-none gap-6 p-0 lg:grid-cols-3"
          >
            {newest.cards.map((card) => (
              <li
                key={card.kind === "poll" ? card.poll.electionId : card.electionId}
                className="grid"
              >
                <StreamCard
                  card={card}
                  ballot={newest.ballot}
                  phoneVerification={newest.phoneVerification}
                  explained
                />
              </li>
            ))}
          </ol>
        )}
        {listed ? (
          <a
            href="/discover"
            className={cn(
              buttonVariants({ variant: "outline" }),
              "gap-2 justify-self-start lg:hidden",
            )}
          >
            {t("homeStreamAll")}
            <ArrowRight aria-hidden="true" />
          </a>
        ) : null}
      </section>
      <TrustScene />
    </div>
  );
}
