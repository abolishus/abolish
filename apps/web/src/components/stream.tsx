import { Button, buttonVariants, cn, useTranslate } from "@abolishus/ui";
import { Input } from "@abolishus/ui/ui/input";
import { Label } from "@abolishus/ui/ui/label";
import { ArrowRight, Search } from "lucide-react";
import { useId } from "react";

import { catalogs, type Messages } from "../messages.ts";
import type { Stream } from "../server/load.ts";
import {
  type StreamCard as Card,
  MAX_STREAM_QUERY,
  MAX_STREAM_TERMS,
  STREAM_SORTS,
  type StreamSort,
} from "../stream.ts";
import { ballotLink } from "../values.ts";
import { PageHeader } from "./page-parts.tsx";
import { When } from "./poll-summary.tsx";

/**
 * The stream's address for `sort` from just after `after`, searching for
 * `q` if given. `new` is the default, so its first page is plain
 * `/discover`. Orders are from a fixed list and `after` is canonical hex, so
 * only the query needs escaping.
 */
export function streamHref(sort: StreamSort, after?: string, q?: string): string {
  const search = [
    ...(sort === "new" ? [] : [`sort=${sort}`]),
    ...(q === undefined ? [] : [`q=${encodeURIComponent(q)}`]),
    ...(after === undefined ? [] : [`after=${after}`]),
  ];
  return search.length === 0 ? "/discover" : `/discover?${search.join("&")}`;
}

const SORT_LABEL = {
  new: "sort_new",
  closing: "sort_closing",
  answered: "sort_answered",
} as const satisfies Record<StreamSort, keyof Messages>;

const SORT_NOTE = {
  new: "sortNote_new",
  closing: "sortNote_closing",
  answered: "sortNote_answered",
} as const satisfies Record<StreamSort, keyof Messages>;

/** The orders, as links: each one a plain GET, so they work before the page's script loads. */
function Sorts({ sort, q }: { sort: StreamSort; q: string | undefined }) {
  const t = useTranslate(catalogs);
  return (
    <nav aria-label={t("discoverSorts")} className="grid gap-3">
      <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
        {STREAM_SORTS.map((option) => (
          <li key={option}>
            <a
              href={streamHref(option, undefined, q)}
              aria-current={option === sort ? "page" : undefined}
              className="inline-flex min-h-12 items-center border border-input px-4 text-sm hover:border-foreground focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none aria-[current=page]:border-foreground aria-[current=page]:bg-foreground aria-[current=page]:text-background"
            >
              {t(SORT_LABEL[option])}
            </a>
          </li>
        ))}
      </ul>
      <p className="m-0 text-sm text-muted-foreground">{t(SORT_NOTE[sort])}</p>
    </nav>
  );
}

/**
 * The search box: a plain GET form, so it works before the page's script
 * loads, keeping the order. What was typed is shown back only in the box,
 * never in the page's text, so a link can't put words in our voice.
 */
function SearchForm({ sort, typed }: { sort: StreamSort; typed: string }) {
  const t = useTranslate(catalogs);
  const inputId = useId();
  const hintId = useId();
  return (
    <form role="search" method="get" action="/discover" className="grid max-w-2xl gap-2">
      <Label htmlFor={inputId} className="text-base font-semibold">
        {t("streamSearchLabel")}
      </Label>
      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-0 flex-1 basis-64">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id={inputId}
            type="search"
            name="q"
            defaultValue={typed}
            maxLength={MAX_STREAM_QUERY}
            autoComplete="off"
            aria-describedby={hintId}
            className="h-12 ps-11 text-base md:text-base"
          />
        </div>
        {sort === "new" ? null : <input type="hidden" name="sort" value={sort} />}
        <Button type="submit" variant="outline" className="h-12 px-5">
          {t("streamSearchSubmit")}
        </Button>
      </div>
      <p id={hintId} className="m-0 text-sm text-muted-foreground">
        {t("streamSearchHint", { words: MAX_STREAM_TERMS })}
      </p>
    </form>
  );
}

/**
 * One question in the stream: its words, when it closes, and its first
 * question's answers, each a way into the ballot client, which opens the
 * poll with that answer chosen from the link's fragment. Text an
 * asker wrote carries its own language and direction.
 */
export function StreamCard({ card, ballot }: { card: Card; ballot: string | null }) {
  const t = useTranslate(catalogs);
  const titleId = useId();
  const answersId = useId();
  if (card.kind === "unavailable") {
    return (
      <article
        aria-labelledby={titleId}
        className="grid gap-3 border border-dashed border-border p-5"
      >
        <h3 id={titleId} className="m-0 text-lg font-medium">
          <a
            className="font-mono underline underline-offset-4"
            translate="no"
            href={`/polls/${card.electionId}`}
          >
            {t("shortId", { prefix: card.electionId.slice(0, 16) })}
          </a>
        </h3>
        <p className="m-0 text-sm text-muted-foreground">
          {t(
            card.problem === "undecodable"
              ? "listUndecodable"
              : card.problem === "another-election"
                ? "listMismatch"
                : "streamText",
          )}
        </p>
      </article>
    );
  }
  const { poll, text } = card;
  const questions = poll.questions.length;
  return (
    <article
      aria-labelledby={titleId}
      className="grid content-start gap-5 border border-border p-5 sm:p-6"
    >
      <p className="m-0 flex flex-wrap justify-between gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span>
          {t("streamCloses")} <When instant={poll.closesAt} />
        </span>
        {questions > 1 ? <span>{t("questionCount", { count: questions })}</span> : null}
      </p>
      <div className="grid gap-2">
        <h3
          id={titleId}
          lang={text.language}
          dir="auto"
          className="m-0 font-heading text-2xl leading-tight font-semibold text-balance break-words sm:text-3xl"
        >
          <a href={`/polls/${poll.electionId}`} className="underline-offset-4 hover:underline">
            {text.heading}
          </a>
        </h3>
        {text.question === undefined ? null : (
          <p lang={text.language} dir="auto" className="m-0 text-lg text-pretty break-words">
            {text.question}
          </p>
        )}
      </div>
      {ballot === null ? (
        <p className="m-0 text-sm text-muted-foreground">{t("streamNoBallot")}</p>
      ) : (
        <div className="grid gap-3">
          <p id={answersId} className="m-0 text-sm text-pretty text-muted-foreground">
            {t("streamPick", { count: questions })}
          </p>
          {/* Each answer is a plain link: the ballot client opens with it
              chosen, and sends nothing until the voter does ([[first-answer]]). */}
          <ul aria-labelledby={answersId} className="m-0 grid list-none gap-2 p-0">
            {text.options.map((label, option) => (
              <li key={option}>
                <a
                  href={ballotLink(ballot, poll.electionId, option)}
                  aria-describedby={titleId}
                  className="flex min-h-12 items-center justify-between gap-3 border border-input px-4 py-2 text-base font-medium hover:border-foreground focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <span lang={text.language} dir="auto" className="min-w-0 break-words">
                    {label}
                  </span>
                  <ArrowRight aria-hidden="true" className="size-4 shrink-0" />
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

/** A page with no cards: what happened, and a way on. */
function Empty({
  title,
  children,
  href,
  action,
}: {
  title: string;
  children: string;
  href?: string;
  action?: string;
}) {
  const t = useTranslate(catalogs);
  return (
    <div className="grid justify-items-start gap-3 border border-dashed border-border p-8">
      <h3 className="m-0 font-heading text-xl font-semibold">{title}</h3>
      <p className="m-0 text-base text-muted-foreground">{children}</p>
      {href === undefined ? null : (
        <a className={buttonVariants({ variant: "outline" })} href={href}>
          {action ?? t("streamStart")}
        </a>
      )}
    </div>
  );
}

export interface StreamPageProps {
  stream: Stream;
  sort: StreamSort;
  /** What the search box holds: the visitor's query as it came, or `""`. */
  typed: string;
  /** The query searched for, trimmed, or `undefined` when the page isn't a search. */
  q: string | undefined;
  /** The ballot client's address, or `null` where this site has none. */
  ballot: string | null;
}

/**
 * The stream (`/discover`): the polls open now, a page at a time, in one of
 * the API's orders, each the same for every visitor and moved by no
 * engagement signal; the listing leaves out delisted and hidden polls
 * (T-68). A search narrows the order to the polls whose question holds
 * every word, and never ranks them. More comes only when asked for, by a
 * link.
 */
export function StreamPage({ stream, sort, typed, q, ballot }: StreamPageProps) {
  const t = useTranslate(catalogs);
  return (
    <div className="grid gap-10">
      <PageHeader eyebrow={t("navDiscover")} title={t("discoverTitle")} lede={t("discoverLede")} />
      <div className="grid gap-6">
        <SearchForm sort={sort} typed={typed} />
        <Sorts sort={sort} q={q} />
        {q === undefined || stream.kind === "search-refused" ? null : (
          <p className="m-0 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
            <span>{t("streamSearching")}</span>
            <a className="underline underline-offset-4" href={streamHref(sort)}>
              {t("streamSearchClear")}
            </a>
          </p>
        )}
      </div>
      <section aria-labelledby="stream-title" className="grid content-start gap-6">
        <h2 id="stream-title" className="sr-only">
          {t("streamQuestions")}
        </h2>
        {stream.kind === "sort-unavailable" ? (
          <Empty title={t("streamSortUnavailableTitle")}>{t("streamSortUnavailable")}</Empty>
        ) : stream.kind === "search-refused" ? (
          <Empty
            title={t("streamSearchRefusedTitle")}
            href={streamHref(sort)}
            action={t("streamSearchClear")}
          >
            {t("streamSearchRefused", {
              words: MAX_STREAM_TERMS,
              characters: MAX_STREAM_QUERY,
            })}
          </Empty>
        ) : stream.kind === "cursor-not-found" ? (
          <Empty title={t("streamCursorLostTitle")} href={streamHref(sort, undefined, q)}>
            {t("streamCursorLost")}
          </Empty>
        ) : stream.cards.length === 0 && q !== undefined ? (
          <Empty
            title={t("streamSearchEmpty")}
            href={streamHref(sort)}
            action={t("streamSearchClear")}
          >
            {t("streamSearchEmptyLede")}
          </Empty>
        ) : stream.cards.length === 0 ? (
          <Empty title={t("streamEmpty")}>{t("streamEmptyLede")}</Empty>
        ) : (
          <ol aria-label={t("streamQuestions")} className="m-0 grid list-none gap-6 p-0">
            {stream.cards.map((card) => (
              <li key={card.kind === "poll" ? card.poll.electionId : card.electionId}>
                <StreamCard card={card} ballot={ballot} />
              </li>
            ))}
          </ol>
        )}
        {stream.kind === "stream" && stream.next !== undefined ? (
          <a
            className={cn(buttonVariants({ variant: "outline" }), "justify-self-start")}
            href={streamHref(sort, stream.next, q)}
          >
            {t("streamMore")}
            <ArrowRight aria-hidden="true" />
          </a>
        ) : null}
      </section>
    </div>
  );
}
