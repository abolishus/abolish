import { cn, useI18n, useTranslate } from "@abolishus/ui";
import { ArrowRight } from "lucide-react";

import { catalogs, tierMessage } from "../messages.ts";
import type { PollStatus, PollView } from "../poll.ts";
import { leadersOf, type PollResults as Results, shareOf, type TierResults } from "../results.ts";
import type { PollWords } from "../stream.ts";
import { isolated } from "../titles.ts";
import { useWhenWords } from "./when.tsx";

export interface PollResultsProps {
  poll: Pick<PollView, "electionId" | "questions" | "closesAt">;
  results: Results;
  /** Where the poll stands: a scheduled poll has nothing to count yet. */
  status: Exclude<PollStatus, "scheduled">;
  /** Every question's words; without them, questions and options go by number. */
  words: PollWords | undefined;
  /** Whether this deployment verifies a phone before an account votes, which names Tier 0. */
  phoneVerification: boolean;
}

/**
 * One option's share as a bar, drawn as SVG geometry rather than an inline
 * width, since the CSP's style-src 'self' blocks `style` attributes. The bar
 * is decoration: its figures are in the text beside it.
 */
export function Bar({ share, lead }: { share: number; lead: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 100 4"
      preserveAspectRatio="none"
      className="col-span-full h-3 w-full"
    >
      <rect x="0" y="0" width="100" height="4" className="fill-muted" />
      <rect
        x="0"
        y="0"
        width={Math.min(1, share) * 100}
        height="4"
        className={lead ? "fill-primary" : "fill-foreground/70"}
      />
    </svg>
  );
}

/**
 * How a question's results are worded: each share as a percentage, each
 * option by its label or by number without one, and the result in a
 * sentence (the option picked most, or each tied for it, with its share of
 * those who answered), the author's labels in their own direction inside
 * our sentence (T-75).
 */
export function useResultsWords() {
  const t = useTranslate(catalogs);
  const { locale } = useI18n();
  const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
  const list = new Intl.ListFormat(locale, { type: "conjunction" });
  const label = (options: readonly string[] | undefined, i: number) =>
    options?.[i] ?? t("resultsOption", { number: i + 1 });
  const lead = (counts: readonly string[], counted: number, options?: readonly string[]) => {
    const leaders = leadersOf(counts);
    const top = leaders[0];
    return top === undefined
      ? t("resultsNothingPicked")
      : t(leaders.length === 1 ? "resultsLeader" : "resultsTied", {
          option: list.format(leaders.map((i) => isolated(label(options, i)))),
          share: percent.format(shareOf(counts[top] ?? "0", counted)),
        });
  };
  return { percent, label, lead };
}

/** One question's results: its sentence, then each option's share, count and bar. */
export function ResultsQuestion({
  number,
  heading,
  options,
  counts,
  counted,
  level = 4,
}: {
  /** From 1; `undefined` for a poll of one question. */
  number: number | undefined;
  heading: string | undefined;
  /** The options' labels, or `undefined` to name them by number. */
  options: readonly string[] | undefined;
  counts: readonly string[];
  counted: number;
  /** The question heading's level: under a tier's `h3` on the poll page, under an `h2` on the results page. */
  level?: 3 | 4;
}) {
  const t = useTranslate(catalogs);
  const { percent, label, lead } = useResultsWords();
  const Heading = level === 3 ? "h3" : "h4";
  const leaders = leadersOf(counts);
  return (
    <div className="grid gap-3">
      {heading === undefined && number === undefined ? null : (
        <Heading className="m-0 text-lg font-semibold text-pretty">
          {heading === undefined ? (
            t("questionNumber", { number: number ?? 1 })
          ) : (
            <bdi>{heading}</bdi>
          )}
        </Heading>
      )}
      <p className="m-0 font-heading text-xl leading-snug font-semibold text-pretty">
        {lead(counts, counted, options)}
      </p>
      <ol className="m-0 grid list-none border-t border-foreground p-0">
        {counts.map((count, i) => {
          const share = shareOf(count, counted);
          const lead = leaders.includes(i);
          return (
            <li
              key={i}
              className="grid grid-cols-[1fr_auto_auto] items-baseline gap-x-4 gap-y-2 border-b border-border py-3"
            >
              <span className={cn("text-base text-pretty", lead && "font-semibold")}>
                {options?.[i] === undefined ? label(options, i) : <bdi>{options[i]}</bdi>}
              </span>
              <span className="text-end font-mono text-base tabular-nums">
                {percent.format(share)}
              </span>
              <span className="text-end text-sm text-muted-foreground">
                {t("resultsPeople", { count: BigInt(count) })}
              </span>
              <Bar share={share} lead={lead} />
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Tier({
  result,
  poll,
  words,
  phoneVerification,
}: {
  result: TierResults;
  poll: PollResultsProps["poll"];
  words: PollWords | undefined;
  phoneVerification: boolean;
}) {
  const t = useTranslate(catalogs);
  const several = poll.questions.length > 1;
  return (
    <section
      aria-labelledby={`results-tier-${result.tier}`}
      className="grid gap-6 border-t-2 border-foreground pt-4"
    >
      <div className="grid gap-1">
        <h3 id={`results-tier-${result.tier}`} className="m-0 font-heading text-xl font-semibold">
          {t(tierMessage(result.tier, phoneVerification))}
        </h3>
        <p className="m-0 text-base text-muted-foreground">
          {result.counted === 0
            ? t("resultsNoneAnswered")
            : t("resultsAnswered", { count: result.counted })}
        </p>
        {/* A rolling tier's count at the close, beside who answered: more
            than its members at the opening could answer
            ([[0028-rolling-electorates]]). */}
        {result.couldAnswer === undefined ? null : (
          <p className="m-0 text-base text-muted-foreground">
            {t("resultsCouldAnswer", { count: result.couldAnswer })}
          </p>
        )}
        {/* The verifier's small-count flag on that count: the results stand,
            and say what so few can reveal (8.2, T-16). */}
        {result.fewCouldAnswer === true ? (
          <p className="m-0 max-w-prose text-base">{t("resultsFewCouldAnswer")}</p>
        ) : null}
      </div>
      {result.questions === undefined ? (
        <p role="status" className="m-0 max-w-prose text-base">
          {t("resultsTierPending")}
        </p>
      ) : result.counted === 0 ? null : (
        // Each question on its own: no figure joins two (ADR 0026; T-16).
        result.questions.map((counts, i) => (
          <ResultsQuestion
            key={i}
            number={several ? i + 1 : undefined}
            heading={words?.questions[i]?.question}
            options={words?.questions[i]?.options}
            counts={counts}
            counted={result.counted}
          />
        ))
      )}
    </section>
  );
}

const STATE_TEXT = {
  "not-counted": "resultsNotCounted",
  "not-ready": "resultsUnavailable",
  unavailable: "resultsUnavailable",
} as const;

/**
 * A poll's results on its page, server-rendered: in sentences first, then
 * each option's share and count, tier by tier and question by question, the
 * tier in words. They are the results our server reads from the openings on
 * the board, not the verifier's verdict, so the section says so and links
 * to the board to check them (T-34).
 */
export function PollResults({ poll, results, status, words, phoneVerification }: PollResultsProps) {
  const t = useTranslate(catalogs);
  // Definitions of versions 1 and 5 fix no live results, so an open poll's
  // answers are sealed until it closes and is counted: the section says when,
  // in the open poll's mockup's words, rather than a bare "Results".
  const sealed = status === "open" && results.kind === "unopened";
  const closes = useWhenWords(poll.closesAt);
  return (
    <section aria-labelledby="results-title" className="grid max-w-3xl gap-8">
      <h2 id="results-title" className="m-0 font-heading text-3xl font-semibold">
        {t(sealed ? "resultsSealedTitle" : "resultsTitle")}
      </h2>
      {/* Said wherever the poll asks several, as the closed poll's mockup
          says it: only per-question sums are ever opened (ADR 0026, No
          cross-tabulation), which a single question has nothing to say about. */}
      {poll.questions.length > 1 ? (
        <p className="m-0 max-w-prose text-lg text-pretty">{t("resultsEachQuestion")}</p>
      ) : null}
      {results.kind === "read" ? (
        <>
          {results.tiers.map((result) => (
            <Tier
              key={result.tier}
              result={result}
              poll={poll}
              words={words}
              phoneVerification={phoneVerification}
            />
          ))}
          <p className="m-0 max-w-prose border-l-2 border-foreground ps-4 text-pretty text-muted-foreground">
            {t("resultsClaim")}
          </p>
          <a
            className="inline-flex min-h-12 items-center gap-2 justify-self-start underline underline-offset-4"
            href={`/polls/${poll.electionId}/results`}
          >
            {t("resultsSeeAll")}
            <ArrowRight aria-hidden="true" className="size-4" />
          </a>
        </>
      ) : sealed ? (
        <div className="grid gap-4">
          {/* Served in UTC and redrawn on the visitor's clock, as the facts'
              close is; the server's and the browser's ICU versions may word
              it apart. */}
          <p role="status" className="m-0 max-w-prose text-lg text-pretty" suppressHydrationWarning>
            {closes === undefined
              ? t("resultsSealedUntilClose")
              : t("resultsSealedUntil", { when: closes })}
          </p>
          {/* T-14: the asker holds no seat, but the launch panel's seats are
              all ours, so the page doesn't claim that no one could open them. */}
          <p className="m-0 max-w-prose text-base text-pretty">{t("resultsSealedAsker")}</p>
          <p className="m-0 max-w-prose text-base text-pretty text-muted-foreground">
            {t("resultsSealedBoard")}
          </p>
        </div>
      ) : (
        <p role="status" className="m-0 max-w-prose text-lg text-pretty">
          {t(results.kind === "unopened" ? "resultsCounting" : STATE_TEXT[results.kind])}
        </p>
      )}
      <a
        className="inline-flex min-h-12 items-center gap-2 justify-self-start underline underline-offset-4"
        href={`/polls/${poll.electionId}/board`}
      >
        {t("resultsCheck")}
        <ArrowRight aria-hidden="true" className="size-4" />
      </a>
    </section>
  );
}
