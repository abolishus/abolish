import { buttonVariants, cn, useTranslate } from "@abolishus/ui";
import { ArrowRight } from "lucide-react";

import { catalogs } from "../messages.ts";
import type { StreamCard as Card } from "../stream.ts";
import { StreamCard } from "./stream.tsx";
import { TrustScene } from "./trust-scene.tsx";

export interface Newest {
  readonly cards: readonly Card[];
  /** The ballot client's address the cards' answers open, or `null` if none is set. */
  readonly ballot: string | null;
}

/**
 * The front page, in the everyday register ([[language]]): the promise, a
 * way to ask and a way to browse, the newest questions answerable from their
 * cards, and why an answer can be trusted. `newest` is `undefined` when the
 * API didn't answer, so the page stays up without it and says nothing of
 * why (T-67).
 */
export function HomePage({ newest }: { newest: Newest | undefined }) {
  const t = useTranslate(catalogs);
  return (
    <div className="grid gap-16">
      <section className="grid gap-6 pt-2 sm:gap-8 md:pt-10 lg:grid-cols-12 lg:gap-x-10">
        {/* 36px on a phone: at 48px the title took six lines and pushed both
            actions below a 640px screen. */}
        <h1 className="m-0 font-heading text-4xl leading-none font-semibold tracking-tight text-balance sm:text-7xl lg:col-span-9">
          {t("homeTitle")}
        </h1>
        <div className="grid content-start gap-6 sm:gap-8 lg:col-span-7">
          <p className="m-0 max-w-prose text-xl text-pretty">{t("homeLede")}</p>
          <div className="flex flex-wrap gap-3">
            {/* Asking starts on the account page, which signs a visitor in
                first; a new poll's form can't save without an account. */}
            <a href="/account" className={buttonVariants({ size: "lg" })}>
              {t("homeAsk")}
            </a>
            <a href="/discover" className={buttonVariants({ size: "lg", variant: "outline" })}>
              {t("homeBrowse")}
            </a>
          </div>
          <p className="m-0 text-base text-muted-foreground">{t("homeNonBinding")}</p>
        </div>
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
            <p className="m-0 max-w-prose text-lg text-pretty">{t("homeStreamLede")}</p>
          </div>
          <a href="/discover" className={cn(buttonVariants({ variant: "outline" }), "gap-2")}>
            {t("homeStreamAll")}
            <ArrowRight aria-hidden="true" />
          </a>
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
                <StreamCard card={card} ballot={newest.ballot} />
              </li>
            ))}
          </ol>
        )}
      </section>
      <TrustScene />
    </div>
  );
}
