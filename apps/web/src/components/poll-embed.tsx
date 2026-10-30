import { buttonVariants, cn, Fingerprint, useI18n, useTranslate } from "@abolishus/ui";
import { ExternalLink } from "lucide-react";
import { useId } from "react";

import { catalogs } from "../messages.ts";
import type { FinalCount } from "../og/poll.ts";
import { type Instant, pollStatus, type PollView } from "../poll.ts";
import { leadersOf, shareOf } from "../results.ts";
import type { CardText } from "../stream.ts";
import { isolated } from "../titles.ts";
import { ballotLink } from "../values.ts";
import { Bar } from "./poll-results.tsx";
import { When } from "./when.tsx";

export type EmbedTheme = "auto" | "light" | "dark";

export const EMBED_THEMES = ["auto", "light", "dark"] as const satisfies readonly EmbedTheme[];

export interface EmbedCardProps {
  poll: Pick<PollView, "electionId" | "definitionHash" | "questions" | "opensAt" | "closesAt">;
  /** When the page was loaded: the poll's status is read at this time. */
  asOf: Instant;
  /** Its short link, `<origin>/p/<code>`, the same for everyone. */
  url: string;
  /** The link preview's headline, shown while the poll's own words can't be. */
  title: string;
  /** The poll's words, checked against its definition; `undefined` if none can be shown. */
  text: CardText | undefined;
  /** The ballot client's address (`BALLOT_URL`), or `null` where none is set. */
  ballot: string | null;
  /** Its results as a card may show them, `finalCount`; drawn only once it has closed. */
  results: FinalCount;
}

/** Read out after every link that leaves the frame: each opens a new tab. */
function NewTab() {
  const t = useTranslate(catalogs);
  return <span className="sr-only"> {t("embedNewTab")}</span>;
}

/**
 * The embedded poll (docs/design/sharing.md, Embed): what `/embed/p/<code>`
 * draws for another site's iframe, as plain HTML with no script. Every
 * answer is a link that opens the ballot client in a new tab with the poll
 * and the pick in the fragment, which no server sees ([[first-answer]];
 * T-10, T-11). The card has no form, input or button, so it can never take
 * an answer itself, and it says so. Nothing about answers shows before the
 * close, whatever the results say; once closed, the first question's final
 * count where one tier's is published (P2-24 part 4b).
 */
export function EmbedCard({ poll, asOf, url, title, text, ballot, results }: EmbedCardProps) {
  const t = useTranslate(catalogs);
  const titleId = useId();
  const answersId = useId();
  const status = pollStatus(poll, asOf);
  const link = url.replace(/^https?:\/\//, "");
  const host = link.slice(0, link.indexOf("/"));
  const questions = poll.questions.length;
  // Answers are offered only where the client can take them: an open poll
  // whose words we can show, on a deployment that names its ballot client.
  const answering = status === "open" && text !== undefined && ballot !== null ? ballot : null;
  return (
    <article
      aria-labelledby={titleId}
      data-testid="embed-card"
      className="@container grid gap-4 border border-border bg-background p-5 font-sans text-foreground"
    >
      <header className="flex items-center gap-3">
        <span className="block size-10 shrink-0 [&>svg]:size-full">
          <Fingerprint
            value={poll.definitionHash}
            label={t("fingerprintDefinition", { prefix: poll.definitionHash.slice(0, 8) })}
          />
        </span>
        <p className="m-0 min-w-0 flex-1 text-sm text-muted-foreground">
          {t("flyerKicker", { host })}
          {questions > 1 ? ` · ${t("questionCount", { count: questions })}` : null}
        </p>
      </header>
      <div className="grid gap-2">
        <h1
          id={titleId}
          lang={text?.language}
          dir={text === undefined ? undefined : "auto"}
          className="m-0 font-heading text-xl leading-snug font-semibold text-pretty break-words @lg:text-2xl"
        >
          {text?.heading ?? title}
        </h1>
        {text?.question === undefined ? null : (
          <p lang={text.language} dir="auto" className="m-0 text-base text-pretty break-words">
            {text.question}
          </p>
        )}
      </div>
      {answering === null || text === undefined ? null : (
        <div className="grid gap-2">
          <p id={answersId} className="m-0 text-sm text-pretty text-muted-foreground">
            {t("embedPick", { count: questions })}
          </p>
          <ul aria-labelledby={answersId} className="m-0 grid list-none gap-2 p-0 @xl:grid-cols-2">
            {text.options.map((label, option) => (
              <li key={option}>
                <a
                  href={ballotLink(answering, poll.electionId, option)}
                  target="_blank"
                  rel="noopener"
                  className="flex min-h-12 items-center justify-between gap-3 border border-input px-4 py-2 text-base hover:border-foreground focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <span lang={text.language} dir="auto" className="min-w-0 break-words">
                    {label}
                  </span>
                  <ExternalLink aria-hidden="true" className="size-4 shrink-0" />
                  <NewTab />
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
      {status !== "closed" ? null : results.state === "counted" ? (
        <FinalResults
          counted={results.counted}
          counts={results.counts}
          questions={questions}
          text={text}
        />
      ) : (
        <p className="m-0 text-base text-pretty" data-testid="embed-results">
          {t(results.state === "by-tier" ? "ogTiers" : "ogCountingNote")}
        </p>
      )}
      <p className="m-0 text-sm text-muted-foreground" data-testid="embed-status">
        {status === "scheduled" ? (
          <>
            {t("embedOpens")} <When instant={poll.opensAt} />
          </>
        ) : (
          <>
            {t(status === "closed" ? "embedClosed" : "embedCloses")}{" "}
            <When instant={poll.closesAt} />
          </>
        )}
      </p>
      <a
        href={answering === null ? url : ballotLink(answering, poll.electionId)}
        target="_blank"
        rel="noopener"
        className={cn(
          buttonVariants({ size: "lg", variant: answering === null ? "outline" : "default" }),
          "h-auto min-h-12 justify-between py-3 text-start whitespace-normal",
        )}
      >
        {answering === null ? t("embedSeePoll", { host }) : t("embedAnswer", { count: questions })}
        <ExternalLink aria-hidden="true" />
        <NewTab />
      </a>
      <footer className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border pt-3 text-sm text-muted-foreground">
        <span>{t("embedNeverHere")}</span>
        <a
          href={url}
          target="_blank"
          rel="noopener"
          className="inline-flex min-h-6 items-center text-foreground underline underline-offset-4"
        >
          {link}
          <NewTab />
        </a>
      </footer>
    </article>
  );
}

/**
 * A closed poll's final count on its embed: the first question's lead in a
 * sentence, as the poll page says it, then each answer's share with a bar.
 * One tier's count only, never a figure across tiers or questions (ADR 0026;
 * T-16). An answer goes by number where its words can't be shown.
 */
function FinalResults({
  counted,
  counts,
  questions,
  text,
}: {
  counted: number;
  counts: readonly string[];
  /** How many questions the poll has: the count is the first's. */
  questions: number;
  text: CardText | undefined;
}) {
  const t = useTranslate(catalogs);
  const { locale } = useI18n();
  const headingId = useId();
  const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
  const list = new Intl.ListFormat(locale, { type: "conjunction" });
  const label = (i: number) => text?.options[i] ?? t("resultsOption", { number: i + 1 });
  const leaders = leadersOf(counts);
  const top = leaders[0];
  return (
    <section aria-labelledby={headingId} className="grid gap-2" data-testid="embed-results">
      <h2 id={headingId} className="m-0 text-sm font-normal text-muted-foreground">
        {t("ogFinalCount", { answers: t("ogAnswersCounted", { count: counted }) })}
        {questions > 1 ? ` · ${t("ogQuestionOne", { count: questions })}` : null}
      </h2>
      <p className="m-0 text-base font-semibold text-pretty">
        {top === undefined
          ? t("resultsNothingPicked")
          : t(leaders.length === 1 ? "resultsLeader" : "resultsTied", {
              // The author's words, in their own direction inside our sentence (T-75).
              option: list.format(leaders.map((i) => isolated(label(i)))),
              share: percent.format(shareOf(counts[top] ?? "0", counted)),
            })}
      </p>
      <ol className="m-0 grid list-none p-0">
        {counts.map((count, i) => {
          const share = shareOf(count, counted);
          const lead = leaders.includes(i);
          return (
            <li
              key={i}
              className="grid grid-cols-[1fr_auto] items-baseline gap-x-3 gap-y-1 border-b border-border py-2"
            >
              <span
                lang={text?.language}
                dir={text === undefined ? undefined : "auto"}
                className={cn("min-w-0 text-base break-words", lead && "font-semibold")}
              >
                {label(i)}
              </span>
              <span className="text-end font-mono text-base tabular-nums">
                {percent.format(share)}
              </span>
              <Bar share={share} lead={lead} />
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Why an embed draws no poll: moderation hid its text, or there's no poll at the link. */
export function EmbedNotice({ kind, url }: { kind: "hidden" | "not-found"; url?: string }) {
  const t = useTranslate(catalogs);
  return (
    <div className="grid gap-3 border border-dashed border-border bg-background p-5 text-base text-foreground">
      <h1 className="m-0 font-heading text-xl font-semibold">
        {t(kind === "hidden" ? "embedHiddenTitle" : "embedNotFoundTitle")}
      </h1>
      <p className="m-0 text-pretty text-muted-foreground">
        {t(kind === "hidden" ? "embedHidden" : "embedNotFound")}
      </p>
      {url === undefined ? null : (
        <a
          href={url}
          target="_blank"
          rel="noopener"
          className="justify-self-start underline underline-offset-4"
        >
          {t("embedHiddenLink")}
          <NewTab />
        </a>
      )}
    </div>
  );
}

/** The embed's address (`<origin>/embed/p/<code>`) in `theme`; the reader's own setting is the default. */
export function embedSrc(page: string, theme: EmbedTheme): string {
  return theme === "auto" ? page : `${page}?theme=${theme}`;
}

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

export type EmbedKind = "card" | "link";

export interface EmbedSnippetProps {
  /** The embed's address, `embedSrc`. */
  src: string;
  /** The poll's short link. */
  url: string;
  /** What the poll is called. */
  title: string;
  /** The frame's height, `embedHeight`. */
  height: number;
}

/**
 * The code a site pastes (docs/design/sharing.md, The embed decision): a
 * sandboxed, script-free iframe that asks for no referrer, or a plain link
 * that loads nothing from us until a reader follows it (T-11). The sandbox
 * matches the page's own (src/security.ts), so a host gets the same frame
 * whether or not it keeps the attribute.
 */
export function embedSnippet(
  kind: EmbedKind,
  { src, url, title, height }: EmbedSnippetProps,
  line: string,
): string {
  const name = escapeHtml(title);
  if (kind === "link")
    return `<p><a href="${escapeHtml(url)}">${name}</a><br>\n${escapeHtml(line)}</p>`;
  return [
    `<iframe src="${escapeHtml(src)}"`,
    `  title="${name}"`,
    `  width="100%" height="${height}" style="max-width:640px;border:0"`,
    `  loading="lazy" referrerpolicy="no-referrer"`,
    `  sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"></iframe>`,
  ].join("\n");
}
