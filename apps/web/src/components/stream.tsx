import { Button, buttonVariants, cn, useTranslate } from "@abolishus/ui";
import { Input } from "@abolishus/ui/ui/input";
import { Label } from "@abolishus/ui/ui/label";
import { POLL_TOPICS } from "@abolishus/core/poll-topics";
import { ArrowRight, ChevronDown, Search } from "lucide-react";
import { useId } from "react";

import { catalogs, type Messages, POLL_TOPIC_MESSAGES } from "../messages.ts";
import type { Tier } from "../poll.ts";
import type { Stream, StreamFilter } from "../server/load.ts";
import {
  type CardAnswered,
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
      {/* Below `sm` the three share one row, each label wrapping in its own
          box and the longest narrowing most: wrapped as whole links, the
          third took a row alone. */}
      <ul className="m-0 flex list-none gap-2 p-0 sm:flex-wrap">
        {STREAM_SORTS.map((option) => (
          <li key={option} className="flex flex-auto sm:flex-none">
            <a
              href={streamHref(option, filter)}
              aria-current={option === sort ? "page" : undefined}
              className={cn(
                LINK,
                "w-full justify-center px-2 py-1 text-center text-pretty sm:w-auto sm:justify-start sm:px-4 sm:text-left",
              )}
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

/** The hidden fields that keep what a form doesn't ask for, as the links keep it. */
function Keep({
  sort,
  filter,
  asks,
}: {
  sort: StreamSort;
  filter: StreamFilter;
  asks: "q" | "place";
}) {
  return (
    <>
      {sort === "new" ? null : <input type="hidden" name="sort" value={sort} />}
      {asks === "q" || filter.q === undefined ? null : (
        <input type="hidden" name="q" value={filter.q} />
      )}
      {filter.topic === undefined ? null : (
        <input type="hidden" name="topic" value={filter.topic} />
      )}
      {asks === "place" || filter.place === undefined ? null : (
        <input type="hidden" name="place" value={filter.place} />
      )}
    </>
  );
}

/**
 * The line under a box. Unnarrowed, the hint on what to type; narrowed,
 * what the page now holds, in our words and never the visitor's (T-67), and
 * the way to drop it alone. Said in a block of its own below the orders and
 * the fold, each "Clear" link stood apart from the box it empties, and a
 * place's page put two hints and two such lines above its first question
 * (P2-29, the stream's iteration 14). Each note is short enough for one line
 * on a 320px phone, with its link the line under it (the stream's iteration
 * 15).
 */
function BoxNote({
  id,
  hint,
  narrowed,
}: {
  id: string;
  hint: string;
  narrowed?: { note: string; clear: string; href: string } | undefined;
}) {
  if (narrowed === undefined)
    return (
      <p id={id} className="m-0 text-sm text-muted-foreground">
        {hint}
      </p>
    );
  return (
    <p className="m-0 flex flex-wrap items-center gap-x-3 text-sm">
      <span id={id}>{narrowed.note}</span>
      {/* A 24px tap (WCAG 2.5.8; P2-29, the stream's iteration 12). */}
      <a
        className="inline-flex min-h-6 items-center underline underline-offset-4"
        href={narrowed.href}
      >
        {narrowed.clear}
      </a>
    </p>
  );
}

/**
 * The search box: a plain GET form, so it works before the page's script
 * loads, keeping the order, the topic and the place. What was typed is
 * shown back only in the box, never in the page's text, so a link can't put
 * words in our voice (T-67).
 */
function SearchForm({
  sort,
  filter,
  typed,
  narrowed,
}: {
  sort: StreamSort;
  filter: StreamFilter;
  typed: string;
  /** Whether the page is narrowed by the search, so the box says so and offers to drop it. */
  narrowed: boolean;
}) {
  const t = useTranslate(catalogs);
  const inputId = useId();
  const hintId = useId();
  return (
    <form
      role="search"
      aria-label={t("streamSearchLabel")}
      method="get"
      action="/discover"
      className="grid max-w-2xl gap-2"
    >
      <Label htmlFor={inputId} className="text-base font-semibold">
        {t("streamSearchLabel")}
      </Label>
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
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
        <Button type="submit" variant="outline" className="h-12 shrink-0 px-5">
          {t("streamSearchSubmit")}
        </Button>
      </div>
      <BoxNote
        id={hintId}
        hint={t("streamSearchHint", { words: MAX_STREAM_TERMS })}
        narrowed={
          narrowed
            ? {
                note: t("streamSearching"),
                clear: t("streamSearchClear"),
                href: streamHref(sort, { topic: filter.topic, place: filter.place }),
              }
            : undefined
        }
      />
      <Keep sort={sort} filter={filter} asks="q" />
    </form>
  );
}

/**
 * The place: a GET form of its own like the search, keeping the order, the
 * topic and the search. What was typed is shown back only in its box (T-67).
 */
function PlaceForm({
  sort,
  filter,
  typedPlace,
  narrowed = false,
}: {
  sort: StreamSort;
  filter: StreamFilter;
  typedPlace: string;
  /** Whether the page is narrowed by the place, as `SearchForm`'s. */
  narrowed?: boolean;
}) {
  const t = useTranslate(catalogs);
  const placeId = useId();
  const placeHintId = useId();
  return (
    <form
      role="search"
      aria-label={t("streamPlaceLabel")}
      method="get"
      action="/discover"
      className="grid max-w-2xl gap-2"
    >
      <Label htmlFor={placeId} className="text-base font-semibold">
        {t("streamPlaceLabel")}
      </Label>
      <div className="flex gap-2">
        <Input
          id={placeId}
          type="text"
          name="place"
          defaultValue={typedPlace}
          // UTF-16 units, at most two to each of the place's code points.
          maxLength={MAX_STREAM_PLACE * 2}
          autoComplete="off"
          aria-describedby={placeHintId}
          className="h-12 min-w-0 flex-1 text-base md:text-base"
        />
        <Button type="submit" variant="outline" className="h-12 shrink-0 px-5">
          {t("streamPlaceSubmit")}
        </Button>
      </div>
      <BoxNote
        id={placeHintId}
        hint={t("streamPlaceHint")}
        narrowed={
          narrowed
            ? {
                note: t("streamPlaceFiltering"),
                clear: t("streamPlaceClear"),
                href: streamHref(sort, { q: filter.q, topic: filter.topic }),
              }
            : undefined
        }
      />
      <Keep sort={sort} filter={filter} asks="place" />
    </form>
  );
}

/**
 * The topics, and the place unless the page already shows its box, folded
 * under one line until a visitor opens it: fifteen topics and a second box
 * put a phone's first question two screens down. A native disclosure, so it
 * opens before the page's script loads.
 */
function Narrowing({
  sort,
  filter,
  typedPlace,
  withPlace,
}: {
  sort: StreamSort;
  filter: StreamFilter;
  typedPlace: string;
  withPlace: boolean;
}) {
  const t = useTranslate(catalogs);
  return (
    <details className="group">
      {/* Padded, and pulled back by as much, so its focus ring clears the
          chevron and the last word while the chevron keeps the column's edge. */}
      <summary className="-mx-2 inline-flex min-h-12 cursor-pointer items-center gap-2 px-2 text-base font-semibold focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none">
        <ChevronDown
          aria-hidden="true"
          className="size-4 -rotate-90 transition-transform group-open:rotate-0 motion-reduce:transition-none"
        />
        {t(withPlace ? "streamNarrow" : "discoverTopics")}
      </summary>
      <div className="mt-4 grid gap-6">
        <Topics sort={sort} filter={filter} />
        {withPlace ? <PlaceForm sort={sort} filter={filter} typedPlace={typedPlace} /> : null}
      </div>
    </details>
  );
}

/**
 * A tier's count as a phrase, the tier in words ([[language]]: never a code
 * such as "Tier 0"). Tier 0 is named by what this deployment checks before an
 * account takes a token, as `tierMessage` names it, so a card never claims a
 * phone check the issuer doesn't make (T-01).
 */
function answeredMessage(tier: Tier, phoneVerification: boolean) {
  if (tier === 0) return phoneVerification ? "streamAnswered_phone" : "streamAnswered_email";
  return tier === 1 ? "streamAnswered_vouched" : "streamAnswered_document";
}

/**
 * How many have answered so far, one line per tier: the board's count of
 * distinct voters, never a result and never one figure across tiers (T-01).
 */
function Answered({
  answered,
  phoneVerification,
}: {
  answered: CardAnswered;
  phoneVerification: boolean;
}) {
  const t = useTranslate(catalogs);
  const titleId = useId();
  return (
    // On a phone the band reaches the card's borders and its words start
    // where the question's do: inset in the card's own padding, a count at
    // 320px had 166px of the screen and wrapped "e-mail" alone at 360px
    // (P2-29, the stream's iteration 10).
    <div className="-mx-5 grid max-w-xl gap-1 bg-muted/60 px-5 py-3 text-sm sm:mx-0 sm:px-4">
      <p id={titleId} className="m-0 font-medium">
        {t("streamAnsweredSoFar")}
      </p>
      <ul aria-labelledby={titleId} className="m-0 grid list-none gap-1 p-0">
        {answered.map(({ tier, answered: count }) => (
          <li key={tier} className="text-balance tabular-nums">
            {t(answeredMessage(tier, phoneVerification), { count: BigInt(count) })}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One question in the stream: who asked it, where its author chose to say,
 * its words, when it closes, where it's listed,
 * and its first question's answers, each a way into the ballot client, which
 * opens the poll with that answer chosen from the link's fragment. Text an
 * asker wrote carries its own language and direction. `explained` is for a
 * page that says once, above its cards, what choosing an answer does: the
 * card then says only which question a poll of several answers. How many
 * have answered so far is shown tier by tier, each named as the poll page
 * names it (`phoneVerification`), never summed (T-01). `narrowed` is the
 * page's narrowing: a card leaves out the topic or place every card on the
 * page shares.
 */
export function StreamCard({
  card,
  ballot,
  phoneVerification = false,
  explained = false,
  narrowed = {},
}: {
  card: Card;
  ballot: string | null;
  phoneVerification?: boolean;
  explained?: boolean;
  narrowed?: StreamFilter;
}) {
  const t = useTranslate(catalogs);
  const titleId = useId();
  const questionId = useId();
  if (card.kind === "unavailable") {
    return (
      <article
        aria-labelledby={titleId}
        className="grid gap-3 border border-dashed border-border p-5 sm:p-6"
      >
        {/* Everyday words, not the register's ID and "server": a visitor
            here came for questions, and the poll's page has the detail. The
            ID's start, small below, is all that tells two such cards apart,
            so it describes the link. */}
        {/* Balanced: at 360px "here" wrapped alone under the rest. */}
        <h3 id={titleId} className="m-0 text-lg font-medium text-balance">
          <a
            className="underline underline-offset-4"
            href={`/polls/${card.electionId}`}
            aria-describedby={questionId}
          >
            {t("streamUnreadable")}
          </a>
        </h3>
        <p className="m-0 text-sm text-pretty text-muted-foreground">
          {t(
            card.problem === "undecodable"
              ? "streamUndecodable"
              : card.problem === "another-election"
                ? "streamMismatch"
                : "streamText",
          )}
        </p>
        <p id={questionId} className="m-0 font-mono text-xs text-muted-foreground" translate="no">
          {t("streamUnreadableId", { prefix: card.electionId.slice(0, 16) })}
        </p>
      </article>
    );
  }
  const { poll, text } = card;
  const questions = poll.questions.length;
  // Every card on a topic's page is filed under it, and on a place's page at
  // it (the place matches whole, ignoring capitals and spacing): said on each
  // card, the same chip repeated down the page under a title or a line that
  // already says it (P2-29, the stream's iteration 7).
  const tags = {
    topic: card.tags.topic === narrowed.topic ? undefined : card.tags.topic,
    place: narrowed.place === undefined ? card.tags.place : undefined,
  };
  return (
    <article
      aria-labelledby={titleId}
      className="grid content-start gap-5 border border-border p-5 sm:p-6"
    >
      <p className="m-0 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
        {card.askedBy === undefined ? null : <AskedBy askedBy={card.askedBy} />}
        <span>
          {t("streamCloses")} <When instant={poll.closesAt} short />
        </span>
        {/* Where answers are offered, the note above them already says
            "question 1 of 3": said here too, it took a phone's fourth line
            above the question (P2-29, the stream's iteration 6). */}
        {questions > 1 && ballot === null ? (
          <span>{t("questionCount", { count: questions })}</span>
        ) : null}
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
      <ListedUnder tags={tags} linked />
      {card.answered === undefined ? null : (
        <Answered answered={card.answered} phoneVerification={phoneVerification} />
      )}
      {ballot === null ? (
        <p className="m-0 text-sm text-muted-foreground">{t("streamNoBallot")}</p>
      ) : (
        <div className="grid max-w-xl gap-3">
          {explained && questions === 1 ? null : (
            <p className="m-0 text-sm text-pretty text-muted-foreground">
              {explained
                ? t("streamPickFirst", { count: questions })
                : t("streamPick", { count: questions })}
            </p>
          )}
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
 * A topic's way back to every topic, keeping the rest. A topic needs no
 * words, as the page's title names it, and its page needn't open the
 * fifteen topics to offer one. The search and the place say themselves
 * under their own boxes (`BoxNote`).
 */
function TopicClear({ sort, filter }: { sort: StreamSort; filter: StreamFilter }) {
  const t = useTranslate(catalogs);
  const { q, place, topic } = filter;
  if (topic === undefined) return null;
  return (
    <p className="m-0 text-sm">
      <a
        className="inline-flex min-h-6 items-center underline underline-offset-4"
        href={streamHref(sort, { q, place })}
      >
        {t("streamTopicClear")}
      </a>
    </p>
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
  /** Whether Tier 0 asks for a phone here, which names it on each card's count. */
  phoneVerification: boolean;
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
export function StreamPage({
  stream,
  sort,
  typed,
  typedPlace,
  filter,
  ballot,
  phoneVerification,
}: StreamPageProps) {
  const t = useTranslate(catalogs);
  const { q, topic, place } = filter;
  const placeShown = place !== undefined || stream.kind === "place-refused";
  // A refused page says why in place of the cards, with its own way to drop
  // what was refused, and narrows by nothing.
  const refused = stream.kind === "search-refused" || stream.kind === "place-refused";
  return (
    <div className="grid gap-10">
      <PageHeader
        eyebrow={t("navDiscover")}
        title={topic === undefined ? t("discoverTitle") : t(POLL_TOPIC_MESSAGES[topic])}
        lede={topic === undefined ? t("discoverLede") : t("discoverTopicLede")}
      />
      <div className="grid gap-6">
        <SearchForm
          sort={sort}
          filter={filter}
          typed={typed}
          narrowed={q !== undefined && !refused}
        />
        {/* A place's page shows its box beside the search's, as only its box
            says the place (T-67), and keeps the topics folded as a topic's
            page does (P2-29, the stream's iteration 3): opening the whole
            fold for the box put fifteen topics above a phone's first
            question, 1,686px down at 360px (the stream's iteration 13). */}
        {placeShown ? (
          <PlaceForm
            sort={sort}
            filter={filter}
            typedPlace={typedPlace}
            narrowed={place !== undefined && !refused}
          />
        ) : null}
        <Sorts sort={sort} filter={filter} />
        <Narrowing sort={sort} filter={filter} typedPlace={typedPlace} withPlace={!placeShown} />
        {refused ? null : <TopicClear sort={sort} filter={filter} />}
      </div>
      {/* A reading width: at desktop width a card the page's whole width
          held its question and answers in its left half, beside an empty one. */}
      <section aria-labelledby="stream-title" className="grid max-w-3xl content-start gap-6">
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
          <>
            {/* Said once here rather than on every card (`explained`), and
                only over a card that offers answers: over unreadable cards
                alone it promised answers none of them has, as home already
                knew (P2-29, the stream's iteration 11). */}
            {ballot === null || !stream.cards.some((c) => c.kind === "poll") ? null : (
              <p className="m-0 text-base text-pretty text-muted-foreground">
                {t("homeStreamPick")}
              </p>
            )}
            <ol aria-label={t("streamQuestions")} className="m-0 grid list-none gap-6 p-0">
              {stream.cards.map((card) => (
                <li key={card.kind === "poll" ? card.poll.electionId : card.electionId}>
                  <StreamCard
                    card={card}
                    ballot={ballot}
                    phoneVerification={phoneVerification}
                    explained
                    narrowed={filter}
                  />
                </li>
              ))}
            </ol>
          </>
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
