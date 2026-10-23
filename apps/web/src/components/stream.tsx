import { Button, buttonVariants, cn, useTranslate } from "@abolishus/ui";
import { Input } from "@abolishus/ui/ui/input";
import { Label } from "@abolishus/ui/ui/label";
import { POLL_TOPICS } from "@abolishus/core/poll-topics";
import { ArrowRight, Search } from "lucide-react";
import { useId } from "react";

import { catalogs, type Messages, POLL_TOPIC_MESSAGES } from "../messages.ts";
import type { Stream, StreamFilter } from "../server/load.ts";
import {
  type StreamCard as Card,
  MAX_STREAM_PLACE,
  MAX_STREAM_QUERY,
  MAX_STREAM_TERMS,
  STREAM_SORTS,
  streamHref,
  type StreamSort,
} from "../stream.ts";
import { ballotLink } from "../values.ts";
import { AskedBy } from "./asked-by.tsx";
import { ListedUnder } from "./listed-under.tsx";
import { PageHeader } from "./page-parts.tsx";
import { When } from "./when.tsx";

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

const LINK =
  "inline-flex min-h-12 items-center border border-input px-4 text-sm hover:border-foreground focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none aria-[current=page]:border-foreground aria-[current=page]:bg-foreground aria-[current=page]:text-background";

/** The orders, as links: each one a plain GET, so they work before the page's script loads. */
function Sorts({ sort, filter }: { sort: StreamSort; filter: StreamFilter }) {
  const t = useTranslate(catalogs);
  return (
    <nav aria-label={t("discoverSorts")} className="grid gap-3">
      <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
        {STREAM_SORTS.map((option) => (
          <li key={option}>
            <a
              href={streamHref(option, filter)}
              aria-current={option === sort ? "page" : undefined}
              className={LINK}
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
 * The topics, as links like the orders, each keeping the order, the search
 * and the place. Topics are a fixed list, so naming one quotes nobody.
 */
function Topics({ sort, filter }: { sort: StreamSort; filter: StreamFilter }) {
  const t = useTranslate(catalogs);
  const { topic, ...rest } = filter;
  return (
    <nav aria-label={t("discoverTopics")} className="grid gap-3">
      <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
        <li>
          <a
            href={streamHref(sort, rest)}
            aria-current={topic === undefined ? "page" : undefined}
            className={LINK}
          >
            {t("topicAll")}
          </a>
        </li>
        {POLL_TOPICS.map((option) => (
          <li key={option}>
            <a
              href={streamHref(sort, { ...rest, topic: option })}
              aria-current={option === topic ? "page" : undefined}
              className={LINK}
            >
              {t(POLL_TOPIC_MESSAGES[option])}
            </a>
          </li>
        ))}
      </ul>
      {/* The tags are the author's, kept by our server and refiled by
          moderation, not part of the poll (T-68). */}
      <p className="m-0 text-sm text-muted-foreground">{t("streamTagsNote")}</p>
    </nav>
  );
}

/**
 * The search box and the place: a plain GET form, so it works before the
 * page's script loads, keeping the order and the topic. What was typed is
 * shown back only in the boxes, never in the page's text, so a link can't
 * put words in our voice (T-67).
 */
function SearchForm({
  sort,
  topic,
  typed,
  typedPlace,
}: {
  sort: StreamSort;
  topic: StreamFilter["topic"];
  typed: string;
  typedPlace: string;
}) {
  const t = useTranslate(catalogs);
  const inputId = useId();
  const hintId = useId();
  const placeId = useId();
  const placeHintId = useId();
  return (
    <form role="search" method="get" action="/discover" className="grid max-w-2xl gap-4">
      <div className="grid gap-2">
        <Label htmlFor={inputId} className="text-base font-semibold">
          {t("streamSearchLabel")}
        </Label>
        <div className="relative min-w-0">
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
        <p id={hintId} className="m-0 text-sm text-muted-foreground">
          {t("streamSearchHint", { words: MAX_STREAM_TERMS })}
        </p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={placeId} className="text-base font-semibold">
          {t("streamPlaceLabel")}
        </Label>
        <Input
          id={placeId}
          type="text"
          name="place"
          defaultValue={typedPlace}
          // UTF-16 units, at most two to each of the place's code points.
          maxLength={MAX_STREAM_PLACE * 2}
          autoComplete="off"
          aria-describedby={placeHintId}
          className="h-12 text-base md:text-base"
        />
        <p id={placeHintId} className="m-0 text-sm text-muted-foreground">
          {t("streamPlaceHint")}
        </p>
      </div>
      {sort === "new" ? null : <input type="hidden" name="sort" value={sort} />}
      {topic === undefined ? null : <input type="hidden" name="topic" value={topic} />}
      <Button type="submit" variant="outline" className="h-12 justify-self-start px-5">
        {t("streamSearchSubmit")}
      </Button>
    </form>
  );
}

/**
 * One question in the stream: who asked it, where its author chose to say,
 * its words, when it closes, where it's listed,
 * and its first question's answers, each a way into the ballot client, which
 * opens the poll with that answer chosen from the link's fragment. Text an
 * asker wrote carries its own language and direction.
 */
export function StreamCard({ card, ballot }: { card: Card; ballot: string | null }) {
  const t = useTranslate(catalogs);
  const titleId = useId();
  const questionId = useId();
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
        {card.askedBy === undefined ? null : <AskedBy askedBy={card.askedBy} />}
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
          <p
            id={questionId}
            lang={text.language}
            dir="auto"
            className="m-0 text-lg text-pretty break-words"
          >
            {text.question}
          </p>
        )}
      </div>
      {/* The stream lists only polls that aren't delisted or hidden (T-68). */}
      <ListedUnder tags={card.tags} linked />
      {ballot === null ? (
        <p className="m-0 text-sm text-muted-foreground">{t("streamNoBallot")}</p>
      ) : (
        <div className="grid gap-3">
          <p className="m-0 text-sm text-pretty text-muted-foreground">
            {t("streamPick", { count: questions })}
          </p>
          {/* Each answer is a plain link: the ballot client opens with it
              chosen, and sends nothing until the voter does ([[first-answer]]).
              The list is named by the question it answers, so a screen
              reader entering it hears what it is choosing for, rather than
              the line above read a second time. */}
          <ul
            aria-labelledby={text.question === undefined ? titleId : questionId}
            className="m-0 grid list-none gap-2 p-0"
          >
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

/**
 * What a narrowed page is narrowed by, each with a way to drop it alone:
 * the search and the place in words of our own, quoting neither (T-67).
 */
function Narrowed({ sort, filter }: { sort: StreamSort; filter: StreamFilter }) {
  const t = useTranslate(catalogs);
  const { q, place, ...rest } = filter;
  const lines = [
    ...(q === undefined
      ? []
      : [
          {
            key: "q",
            note: t("streamSearching"),
            clear: t("streamSearchClear"),
            href: streamHref(sort, { ...rest, place }),
          },
        ]),
    ...(place === undefined
      ? []
      : [
          {
            key: "place",
            note: t("streamPlaceFiltering"),
            clear: t("streamPlaceClear"),
            href: streamHref(sort, { ...rest, q }),
          },
        ]),
  ];
  if (lines.length === 0) return null;
  return (
    <ul className="m-0 grid list-none gap-1 p-0">
      {lines.map(({ key, note, clear, href }) => (
        <li key={key} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
          <span>{note}</span>
          <a className="underline underline-offset-4" href={href}>
            {clear}
          </a>
        </li>
      ))}
    </ul>
  );
}

export interface StreamPageProps {
  stream: Stream;
  sort: StreamSort;
  /** What the search box holds: the visitor's query as it came, or `""`. */
  typed: string;
  /** What the place box holds: the visitor's place as it came, or `""`. */
  typedPlace: string;
  /**
   * What the page narrows to: the query searched for, trimmed, the topic,
   * and the place single-spaced, each `undefined` when the page doesn't ask
   * for it (or asks for one refused).
   */
  filter: StreamFilter;
  /** The ballot client's address, or `null` where this site has none. */
  ballot: string | null;
}

/**
 * The stream (`/discover`): the polls open now, a page at a time, in one of
 * the API's orders, each the same for every visitor and moved by no
 * engagement signal; the listing leaves out delisted and hidden polls
 * (T-68). A search narrows the order to the polls whose question holds
 * every word, a topic or place to the polls their authors filed there, and
 * none of them ranks. A topic's page is titled with the topic; a place,
 * which a link's author writes, is never quoted but in its box (T-67). More
 * comes only when asked for, by a link.
 */
export function StreamPage({ stream, sort, typed, typedPlace, filter, ballot }: StreamPageProps) {
  const t = useTranslate(catalogs);
  const { q, topic, place } = filter;
  return (
    <div className="grid gap-10">
      <PageHeader
        eyebrow={t("navDiscover")}
        title={topic === undefined ? t("discoverTitle") : t(POLL_TOPIC_MESSAGES[topic])}
        lede={topic === undefined ? t("discoverLede") : t("discoverTopicLede")}
      />
      <div className="grid gap-6">
        <SearchForm sort={sort} topic={topic} typed={typed} typedPlace={typedPlace} />
        <Sorts sort={sort} filter={filter} />
        <Topics sort={sort} filter={filter} />
        {stream.kind === "search-refused" || stream.kind === "place-refused" ? null : (
          <Narrowed sort={sort} filter={filter} />
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
            href={streamHref(sort, { topic, place })}
            action={t("streamSearchClear")}
          >
            {t("streamSearchRefused", {
              words: MAX_STREAM_TERMS,
              characters: MAX_STREAM_QUERY,
            })}
          </Empty>
        ) : stream.kind === "place-refused" ? (
          <Empty
            title={t("streamPlaceRefusedTitle")}
            href={streamHref(sort, { q, topic })}
            action={t("streamPlaceClear")}
          >
            {t("streamPlaceRefused", { characters: MAX_STREAM_PLACE })}
          </Empty>
        ) : stream.kind === "cursor-not-found" ? (
          <Empty title={t("streamCursorLostTitle")} href={streamHref(sort, filter)}>
            {t("streamCursorLost")}
          </Empty>
        ) : stream.cards.length === 0 && q !== undefined ? (
          <Empty
            title={t("streamSearchEmpty")}
            href={streamHref(sort, { topic, place })}
            action={t("streamSearchClear")}
          >
            {t("streamSearchEmptyLede")}
          </Empty>
        ) : stream.cards.length === 0 && (topic !== undefined || place !== undefined) ? (
          <Empty
            title={t("streamFilterEmpty")}
            href={streamHref(sort)}
            action={t("streamShowEverything")}
          >
            {t("streamFilterEmptyLede")}
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
            href={streamHref(sort, filter, stream.next)}
          >
            {t("streamMore")}
            <ArrowRight aria-hidden="true" />
          </a>
        ) : null}
      </section>
    </div>
  );
}
