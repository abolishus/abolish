import { buttonVariants, cn, Count, Fingerprint, Hash, useTranslate } from "@abolishus/ui";
import { ArrowRight, ChevronDown, CircleCheck, EyeOff } from "lucide-react";
import { type ReactNode, useRef } from "react";

import type { FollowsClient } from "../account/follows.ts";
import type { ReactionsClient } from "../account/reactions.ts";
import { catalogs, tierMessage } from "../messages.ts";
import type { ReportPoll } from "../poll-report.ts";
import {
  type AskedBy as Asker,
  type Instant,
  instructionOf,
  pollStatus,
  type PollTags,
  type PollView,
} from "../poll.ts";
import { finalOf, type PollResults as Results, type TierResults } from "../results.ts";
import type { BoardHead, ModerationState } from "../server/load.ts";
import type { CardAnswered, CardText, PollWords } from "../stream.ts";
import { ballotLink } from "../values.ts";
import { AskedBy } from "./asked-by.tsx";
import { BoardHeadFacts } from "./board-head.tsx";
import { ListedUnder } from "./listed-under.tsx";
import { PollFacts, RollingTier, StatusMark } from "./poll-facts.tsx";
import { PollFollow } from "./poll-follow.tsx";
import { PollReactions } from "./poll-reactions.tsx";
import { PollResults, useResultsWords } from "./poll-results.tsx";
import { PollShare, type PollShareProps } from "./poll-share.tsx";
import {
  CLASS_LABEL,
  COUNTING_LABEL,
  instructionMessage,
  STATUS_MARK,
  STATUS_TEXT,
} from "./poll-status.ts";
import { ReportSection, type ReportWords } from "./report-section.tsx";
import { When } from "./when.tsx";

export interface PollSummaryProps {
  poll: PollView;
  board: BoardHead;
  moderation: ModerationState;
  /** When the page was loaded: the poll's status is read at this time. */
  asOf: Instant;
  /** The canonical short code, if one is served. */
  code: string | undefined;
  /** Where the poll is listed; none are shown without them, or while it's hidden. */
  tags?: PollTags | undefined;
  /** The share sheet's link and title, for a poll with a short link that isn't hidden. */
  share?: PollShareProps | undefined;
  /** Where the poll's reactions are read and set; without one, none are shown. */
  reactions?: ReactionsClient | undefined;
  /** Where the poll is followed; without one, following isn't offered. */
  follows?: FollowsClient | undefined;
  /** Whether this deployment verifies a phone before an account votes, which names Tier 0. */
  phoneVerification: boolean;
  /** Who asked it, if its author chose to say; never shown while it's hidden. */
  askedBy?: Asker | undefined;
  /** Its results so far; without them, none are shown. */
  results?: Results | undefined;
  /** How many have answered it so far, tier by tier; without it, no count is shown. */
  answered?: CardAnswered | undefined;
  /** Its words in the page's language, checked against its definition; without them, it goes by its ID. */
  text?: CardText | undefined;
  /** Every question's words, which name its questions, their options and the results'. */
  words?: PollWords | undefined;
  /** The ballot client's address (`BALLOT_URL`); without one, answering isn't linked. */
  ballot?: string | null | undefined;
  /** Where a report of the poll goes; without one, it offers none. */
  report?: ReportPoll | undefined;
}

const POLL_WORDS = {
  title: "pollReportTitle",
  help: "pollReportHelp",
  open: "pollReport",
  legend: "pollReportLegend",
  gone: "pollReportGone",
} as const satisfies ReportWords;

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 border-t border-border py-3 sm:grid-cols-[16rem_1fr] sm:gap-4">
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="m-0">{children}</dd>
    </div>
  );
}

/**
 * What the poll asks, in its own words (`everyday-poll-page.tsx`'s Hero):
 * each question with how many answers it takes and its answers, numbered
 * as the ballot is. A poll with no title is headed by its one question, so
 * that question isn't said again, only its answers. The limits are the
 * definition's, as the proof enforces them (T-29, T-34); the words are
 * those the definition commits to (T-41).
 */
function PollQuestions({
  poll,
  words,
  scheduled,
  answering,
}: {
  poll: PollView;
  words: PollWords;
  scheduled: boolean;
  /** The ballot client's address where this page links answering, else null. */
  answering: string | null;
}) {
  const t = useTranslate(catalogs);
  const headed = words.title === "" && words.questions.length === 1;
  return (
    <section aria-labelledby="questions-title" className="grid max-w-3xl gap-6">
      <div className="grid gap-2">
        <h2 id="questions-title" className="m-0 font-heading text-2xl font-semibold">
          {t("pollQuestionsTitle")}
        </h2>
        {/* Before it opens, as the scheduled poll's mockup says it: the words
            are the definition's, which the definition hash in the evidence
            pins, and the ballot app checks against the registry (T-34). */}
        {scheduled ? (
          <p className="m-0 max-w-prose text-base text-pretty text-muted-foreground">
            {t("pollQuestionsFixed")}
          </p>
        ) : null}
      </div>
      <ol className="m-0 grid list-none gap-4 p-0">
        {words.questions.map((q, i) => {
          const limits = poll.questions[i];
          const instruction =
            limits === undefined ? undefined : instructionMessage(instructionOf(limits));
          // The first question's answers open the ballot client with that
          // answer chosen, as a stream card's do ([[first-answer]]): a link
          // carries one pick, for question 1, in its fragment alone, which
          // no server sees (T-10, T-11). The rest are words, drawn without
          // the box the card's links taught a visitor to tap (P2-29, the
          // poll page's iteration 1).
          const picks = i === 0 ? answering : null;
          return (
            <li
              key={i}
              className={cn(
                "grid gap-x-4 border border-border p-5 sm:p-6",
                !headed && "grid-cols-[2.5rem_1fr]",
              )}
            >
              {/* A poll's one question is its heading, so a "1" beside it
                  numbers nothing, and its column took a fifth of a phone's
                  width from the answers (P2-29, the poll page's iteration 2). */}
              {headed ? null : (
                <span
                  aria-hidden="true"
                  className="grid size-10 place-items-center bg-muted font-heading text-lg font-semibold"
                >
                  {i + 1}
                </span>
              )}
              <div className="grid min-w-0 gap-3">
                {headed ? (
                  <h3 id={`question-${i}`} className="sr-only">
                    {t("questionNumber", { number: i + 1 })}
                  </h3>
                ) : (
                  <h3
                    id={`question-${i}`}
                    className="m-0 font-heading text-xl leading-snug font-semibold text-pretty break-words sm:text-2xl"
                  >
                    <span className="sr-only">{t("questionNumber", { number: i + 1 })}: </span>
                    <span lang={words.language} dir="auto">
                      {q.question}
                    </span>
                  </h3>
                )}
                {instruction === undefined ? null : (
                  <p className="m-0 text-sm text-muted-foreground">
                    {t("pollPickFrom", {
                      instruction: t(instruction.key, instruction.values),
                      options: t("optionCount", { count: q.options.length }),
                    })}
                  </p>
                )}
                {picks !== null ? (
                  <>
                    <p className="m-0 text-sm text-pretty text-muted-foreground">
                      {t("streamPick", { count: words.questions.length })}
                    </p>
                    <ul
                      // Named by the question it answers, as a card's list is: on a
                      // poll headed by its one question, the page's heading.
                      aria-labelledby={headed ? "poll-heading" : `question-${i}`}
                      className="m-0 grid list-none gap-2 p-0"
                    >
                      {q.options.map((label, j) => (
                        <li key={j}>
                          <a
                            href={ballotLink(picks, poll.electionId, j)}
                            className="flex min-h-12 items-center justify-between gap-3 border border-input px-4 py-2 text-base font-medium hover:border-foreground focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none"
                          >
                            <span lang={words.language} dir="auto" className="min-w-0 break-words">
                              {label}
                            </span>
                            <ArrowRight aria-hidden="true" className="size-4 shrink-0" />
                          </a>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
                    {q.options.map((label, j) => (
                      <li
                        key={j}
                        lang={words.language}
                        dir="auto"
                        className="min-w-0 bg-muted px-3 py-1 text-sm break-words"
                      >
                        {label}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/**
 * How many have answered so far, one line per tier the definition names, as
 * a stream card and the register say it (`everyday-poll-page.tsx`'s sealed
 * results): the board's count of distinct voters, never a result and never
 * one figure across tiers (T-01).
 */
function PollAnswered({
  answered,
  closed,
  phoneVerification,
}: {
  answered: CardAnswered;
  closed: boolean;
  phoneVerification: boolean;
}) {
  const t = useTranslate(catalogs);
  return (
    <div className="grid gap-1 border-t border-border pt-3">
      <p id="answered-title" className="m-0 font-medium">
        {t(closed ? "pollAnsweredClosed" : "streamAnsweredSoFar")}
      </p>
      <ul aria-labelledby="answered-title" className="m-0 grid list-none gap-1 p-0">
        {answered.map(({ tier, answered: count }) => (
          <li key={tier} className="flex flex-wrap gap-x-2">
            <span className="font-heading text-xl font-semibold tabular-nums">
              {t("resultsPeople", { count: BigInt(count) })}
            </span>{" "}
            <span aria-hidden="true">·</span>{" "}
            <span className="self-center text-foreground/80">
              {t(tierMessage(tier, phoneVerification))}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A closed poll's results in short, under its heading
 * (`everyday-poll-closed-page.tsx`): how many its one tier counted, then
 * each question's lead in a sentence, as the results section words it. The
 * section below has every share and says these are our server's reading of
 * the board, not a check (T-34).
 */
function InShort({
  final,
  words,
}: {
  final: TierResults & { readonly questions: readonly (readonly string[])[] };
  words: PollWords | undefined;
}) {
  const t = useTranslate(catalogs);
  const { lead } = useResultsWords();
  const several = final.questions.length > 1;
  return (
    <div className="grid gap-4">
      <p className="m-0 flex items-center gap-2 text-lg">
        <CircleCheck aria-hidden="true" className="size-5 shrink-0 text-recorded" />
        <span>{t("pollFinal", { count: final.counted })}</span>
      </p>
      <ul aria-label={t("pollInShort")} className="m-0 grid list-none gap-4 p-0 md:grid-cols-3">
        {final.questions.map((counts, i) => {
          const question = words?.questions[i];
          return (
            <li key={i} className="grid content-start gap-2 bg-muted/60 p-5">
              {question === undefined ? (
                several ? (
                  <span className="text-sm text-foreground/80">
                    {t("questionNumber", { number: i + 1 })}
                  </span>
                ) : null
              ) : (
                <bdi className="text-sm text-foreground/80">{question.question}</bdi>
              )}
              <span className="font-heading text-xl leading-snug font-semibold text-pretty">
                {lead(counts, final.counted, question?.options)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * One poll's page, in the everyday register ([[language]]): what it is and
 * where it stands on the surface, and what our server says about it one step
 * down, behind "How do we know this is real?". That part says plainly that
 * these are claims, and shows the hashes a reader needs to check them (T-24,
 * T-34). A native disclosure keeps the evidence in the server's HTML, so it
 * opens without the page's script.
 */
export function PollSummary({
  poll,
  board,
  moderation,
  asOf,
  code,
  tags,
  share,
  reactions,
  follows,
  phoneVerification,
  askedBy,
  results,
  answered,
  text,
  words,
  ballot,
  report,
}: PollSummaryProps) {
  const t = useTranslate(catalogs);
  const latest = moderation.latest;
  const status = pollStatus(poll, asOf);
  const counting = t(COUNTING_LABEL[poll.counting]);
  const pollClass = t(CLASS_LABEL[poll.pollClass]);
  const options = poll.questions.reduce((sum, q) => sum + q.optionCount, 0);
  const illFormed = poll.illFormed;
  const prefix = poll.electionId.slice(0, 16);
  // Answering is linked only where the client can take it: an open poll
  // whose words we can show (none for a hidden one, T-68), on a deployment
  // that names its ballot client, as the embed's is. The link carries the
  // poll in its fragment alone, which no server sees (T-10, T-11).
  const answering = status === "open" && text !== undefined && ballot != null ? ballot : null;
  // Summed up only once closed, and by number while the poll is hidden, as
  // its results are (docs/moderation-policy.md).
  const final = status === "closed" && results !== undefined ? finalOf(poll, results) : undefined;
  const evidence = useRef<HTMLDetailsElement>(null);

  return (
    <article className="grid gap-16">
      <header className="grid gap-6 pt-2 md:pt-10">
        <p className="m-0 font-mono text-xs tracking-widest text-muted-foreground uppercase">
          {text === undefined ? t("pollTitle") : t("pollHeading", { prefix })} · {pollClass} ·{" "}
          {counting}
        </p>
        {/* In the poll's own words where the definition commits to them,
            in their own language and direction (T-34, T-41); by its ID
            otherwise, which wraps anywhere rather than push the page sideways. */}
        {text === undefined ? (
          <h1 className="m-0 max-w-4xl font-heading text-4xl leading-[1.05] font-semibold tracking-tight text-balance break-all sm:text-6xl">
            {t("pollHeading", { prefix })}
          </h1>
        ) : (
          <h1
            id="poll-heading"
            lang={text.language}
            dir="auto"
            className="m-0 max-w-4xl font-heading text-4xl leading-[1.05] font-semibold tracking-tight text-balance break-words sm:text-6xl"
          >
            {text.heading}
          </h1>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <StatusMark icon={STATUS_MARK[status].icon} tone={STATUS_MARK[status].tone}>
            {t(STATUS_TEXT[status])}
          </StatusMark>
          {moderation.state === "visible" ? null : (
            <StatusMark icon={EyeOff} tone="text-pending">
              {t(moderation.state === "hidden" ? "action_hide" : "action_delist")}
            </StatusMark>
          )}
        </div>

        {/* A class on the civic record needs independent trustees, which no
            poll has during launch, so the registry on chain refuses it: the
            class is the definition's claim, never our endorsement (T-14). */}
        {poll.pollClass === "everyday" ? null : (
          <p className="m-0 max-w-prose text-base text-pretty">{t("pollCivicRecord")}</p>
        )}

        {/* The scheduled poll's mockup opens on this: there is nothing to do
            yet, and the facts below say when there will be. */}
        {status === "scheduled" ? (
          <p className="m-0 max-w-prose text-lg text-pretty">{t("pollScheduledLede")}</p>
        ) : null}

        {/* The open poll's mockup opens on how answering works: the set is
            answered together and can be answered again until it closes, the
            last ballot counting (G-11, T-45). Said only where this page links
            answering, so it never promises what a visitor can't do here. */}
        {answering === null ? null : (
          <p className="m-0 max-w-prose text-lg text-pretty">
            {t("pollOpenLede", { count: poll.questions.length })}
          </p>
        )}

        {final === undefined ? null : (
          <>
            <InShort final={final} words={moderation.state === "hidden" ? undefined : words} />
            {/* From the results in short to what they rest on, as the closed
                poll's mockup links it: the evidence says these are our
                server's claims, with the hashes to check them (T-24, T-34). */}
            <a
              href="#evidence"
              onClick={() => {
                // Browsers that reveal a fragment's closed <details> do this
                // without script; this covers those that don't.
                if (evidence.current !== null) evidence.current.open = true;
              }}
              className="inline-flex min-h-12 items-center gap-3 self-start pe-3 underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none"
            >
              {/* A seal only: the evidence names the same fingerprint. */}
              <span aria-hidden="true" className="contents">
                <Fingerprint
                  value={poll.definitionHash}
                  label={t("fingerprintDefinition", { prefix: poll.definitionHash.slice(0, 8) })}
                  size={32}
                />
              </span>
              {t("evidenceSummary")}
            </a>
          </>
        )}

        {/* The loader names no one for a hidden poll; the guard keeps this
            component from naming anyone beside withheld text either way (T-68). */}
        {askedBy === undefined || moderation.state === "hidden" ? null : (
          <div className="grid gap-1">
            <p className="m-0 text-base">
              <AskedBy askedBy={askedBy} />
            </p>
            <p className="m-0 max-w-prose text-sm text-muted-foreground">{t("askedByNote")}</p>
          </div>
        )}

        {moderation.state !== "visible" && latest !== undefined ? (
          <p role="note" className="m-0 max-w-prose border-l-4 border-pending pl-4">
            {t(moderation.state === "hidden" ? "moderationHidden" : "moderationDelisted", {
              reason: t(`reason_${latest.reason}`),
            })}{" "}
            <a className="underline underline-offset-4 focus-text" href="/moderation">
              {t("moderationLogLink")}
            </a>
          </p>
        ) : null}

        {illFormed !== undefined ? (
          <p role="alert" className="m-0 max-w-prose border-l-4 border-destructive pl-4">
            {illFormed.question === undefined
              ? t("illFormed", { rule: t(`rule_${illFormed.rule}`) })
              : t("illFormedQuestion", {
                  rule: t(`rule_${illFormed.rule}`),
                  number: illFormed.question + 1,
                })}
          </p>
        ) : null}
      </header>

      {words === undefined ? null : (
        <PollQuestions
          poll={poll}
          words={words}
          scheduled={status === "scheduled"}
          answering={answering}
        />
      )}

      {/* After what it asks, as the open poll's mockup orders it: the question
          and its answers are the page's hero, and with the facts first a
          phone met its first answer 991px down, past the first screen (P2-29,
          the poll page's iteration 2). */}
      <section aria-labelledby="facts-title" className="grid gap-6">
        <h2 id="facts-title" className="m-0 font-heading text-2xl font-semibold">
          {t("pollFactsTitle")}
        </h2>
        <PollFacts poll={poll} phoneVerification={phoneVerification} />

        {/* A hidden poll's tags are withheld with its text (T-68); a delisted
            one's stand, but the stream they'd link to doesn't list it. */}
        {tags === undefined ||
        moderation.state === "hidden" ||
        (tags.topic === undefined && tags.place === undefined) ? null : (
          <div className="grid gap-2">
            <ListedUnder tags={tags} linked={moderation.state === "visible"} />
            <p className="m-0 max-w-prose text-sm text-muted-foreground">{t("streamTagsNote")}</p>
          </div>
        )}
      </section>

      {/* Shown on a hidden poll too, by number: moderation never withholds a
          result (docs/moderation-policy.md). Nothing is counted before it opens. */}
      {results === undefined || status === "scheduled" ? null : (
        <PollResults
          poll={poll}
          results={results}
          status={status}
          words={moderation.state === "hidden" ? undefined : words}
          phoneVerification={phoneVerification}
        />
      )}

      <section
        aria-labelledby="answer-title"
        className="grid max-w-3xl gap-3 bg-muted/60 p-5 sm:p-6"
      >
        <h2 id="answer-title" className="m-0 font-heading text-2xl font-semibold">
          {t("pollAnswerTitle")}
        </h2>
        <p className="m-0 text-base text-pretty">
          {t(status === "closed" ? "pollAnswerClosed" : "pollAnswer")}
        </p>
        {status === "scheduled" ? (
          <p className="m-0 text-base text-pretty">{t("pollAnswerScheduled")}</p>
        ) : status === "open" && ballot === null ? (
          <p className="m-0 text-base text-pretty text-muted-foreground">{t("streamNoBallot")}</p>
        ) : null}
        {/* Nobody can have answered before it opens. */}
        {answered === undefined || status === "scheduled" ? null : (
          <PollAnswered
            answered={answered}
            closed={status === "closed"}
            phoneVerification={phoneVerification}
          />
        )}
        {answering === null ? null : (
          <div className="grid justify-items-start gap-2 pt-2">
            <a
              href={ballotLink(answering, poll.electionId)}
              className={cn(
                buttonVariants({ size: "lg" }),
                "h-auto min-h-12 justify-between gap-3 py-3 text-start whitespace-normal",
              )}
            >
              {t("pollAnswerOpen", { count: poll.questions.length })}
              <ArrowRight aria-hidden="true" />
            </a>
            <p className="m-0 text-sm text-pretty text-muted-foreground">
              {t("pollAnswerOpenNote")}
            </p>
          </div>
        )}
        {share === undefined ? null : (
          <div className="pt-2">
            <PollShare {...share} />
          </div>
        )}
      </section>

      {/* Side by side from a tablet's width: stacked under Answering they
          stood as two more full sections between the answers and the
          evidence, 600px of a 1280px screen (P2-29, the poll page's
          iteration 5). Neither is shown on a hidden poll, which takes no
          reactions or new followers and shows no counts (T-68). */}
      {moderation.state === "hidden" ||
      (reactions === undefined && follows === undefined) ? null : (
        <div
          className={cn(
            "grid max-w-3xl items-start gap-16",
            reactions !== undefined && follows !== undefined && "md:grid-cols-2 md:gap-10",
          )}
        >
          {reactions === undefined ? null : (
            <PollReactions electionId={poll.electionId} client={reactions} />
          )}
          {follows === undefined ? null : (
            <PollFollow electionId={poll.electionId} client={follows} />
          )}
        </div>
      )}

      {/* As both poll mockups lay it out: the question and its answer in
          plain words are on the surface, and the evidence they rest on one
          step down. The summary says what it does, its words following the
          disclosure's state without script. */}
      <section aria-labelledby="evidence-title" className="grid gap-6 border-t border-border pt-8">
        <div className="flex items-center gap-4">
          {/* A seal only: the evidence below names the same fingerprint. */}
          <span aria-hidden="true" className="contents">
            <Fingerprint
              value={poll.definitionHash}
              label={t("fingerprintDefinition", { prefix: poll.definitionHash.slice(0, 8) })}
              size={44}
            />
          </span>
          <h2 id="evidence-title" className="m-0 font-heading text-2xl font-semibold">
            {t("evidenceSummary")}
          </h2>
        </div>
        <p className="m-0 max-w-prose text-lg text-pretty">{t("evidenceLede")}</p>
        {/* The brief's launch line, said in every state of the poll, as the
            open poll's mockup says who can open the answers: the asker can't,
            and during launch the key is ours alone (T-14). */}
        <p className="m-0 max-w-prose text-lg text-pretty">{t("evidenceKey")}</p>
        <details ref={evidence} className="group">
          <summary className="inline-flex h-12 cursor-pointer list-none items-center gap-2 border border-border px-5 text-base hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none [&::-webkit-details-marker]:hidden">
            <span className="group-open:hidden">{t("evidenceShow")}</span>
            <span className="hidden group-open:inline">{t("evidenceHide")}</span>
            <ChevronDown aria-hidden="true" className="size-4 group-open:rotate-180" />
          </summary>
          {/* The link's target is inside the disclosure, not the disclosure
            itself, so a fragment to it opens it (HTML's ancestor revealing);
            the margin keeps the summary above it in view. */}
          <div id="evidence" className="grid scroll-mt-20 gap-12 pt-8">
            <p className="m-0 max-w-prose border-l-2 border-foreground ps-4 text-pretty text-muted-foreground">
              {t("pollClaim")}
            </p>

            <section aria-labelledby="fingerprint-title" className="grid gap-4">
              <h3 id="fingerprint-title" className="m-0 font-heading text-xl font-semibold">
                {t("evidenceFingerprintTitle")}
              </h3>
              <p className="m-0 max-w-prose text-muted-foreground">{t("evidenceFingerprint")}</p>
              <div className="flex min-w-0 items-start gap-4">
                <Fingerprint
                  value={poll.definitionHash}
                  label={t("fingerprintDefinition", { prefix: poll.definitionHash.slice(0, 8) })}
                  size={64}
                />
                <div className="min-w-0">
                  <Hash value={poll.definitionHash} label={t("definitionHash")} />
                </div>
              </div>
              <Hash value={poll.electionId} label={t("pollId")} />
            </section>

            <section aria-labelledby="definition-title" className="grid gap-4">
              <h3 id="definition-title" className="m-0 font-heading text-xl font-semibold">
                {t("evidenceDefinitionTitle")}
              </h3>
              <dl className="m-0">
                <Fact term={t("factKind")}>{pollClass}</Fact>
                <Fact term={t("factType")}>{counting}</Fact>
                <Fact term={t("factOptions")}>
                  <Count value={options} />
                </Fact>
                {poll.version !== 1 ? (
                  <Fact term={t("factQuestions")}>
                    {/* Each question's limits as the proof enforces them, and no
                      figure across questions (T-29, T-34). */}
                    <ol className="m-0 grid list-none gap-1 p-0">
                      {poll.questions.map((q, i) => {
                        const instruction = instructionMessage(instructionOf(q));
                        return (
                          <li key={i}>
                            <span className="font-medium">
                              {t("questionNumber", { number: i + 1 })}
                            </span>
                            {": "}
                            {t("questionLimits", {
                              instruction: t(instruction.key, instruction.values),
                              options: t("optionCount", { count: q.optionCount }),
                              min: q.minSelections,
                              max: q.maxSelections,
                            })}
                          </li>
                        );
                      })}
                    </ol>
                  </Fact>
                ) : (
                  poll.questions.map((q, i) => (
                    <Fact key={i} term={t("factSelections")}>
                      {t("selectionsRange", { min: q.minSelections, max: q.maxSelections })}
                    </Fact>
                  ))
                )}
                <Fact term={t("factElectorate")}>
                  <ul className="m-0 grid list-none gap-1 p-0">
                    {poll.electorate.map((group, i) => (
                      <li key={i}>
                        {t(tierMessage(group.tier, phoneVerification))}:{" "}
                        <span className="tabular-nums">
                          {t(poll.rolling ? "groupMembersAtOpening" : "groupMembers", {
                            count: BigInt(group.groupSize),
                          })}
                        </span>
                        {poll.rolling ? <RollingTier tier={group.tier} /> : null}
                      </li>
                    ))}
                  </ul>
                </Fact>
                <Fact term={t("factTrustees")}>
                  <span className="tabular-nums">
                    {t("trusteesOf", { threshold: poll.threshold, size: poll.panelSize })}
                  </span>
                </Fact>
                <Fact term={t("factOpens")}>
                  <When instant={poll.opensAt} />
                </Fact>
                <Fact term={t("factCloses")}>
                  <When instant={poll.closesAt} />
                </Fact>
                {code === undefined ? null : (
                  <Fact term={t("factShortLink")}>
                    <a
                      className="font-mono underline underline-offset-4 focus-text"
                      href={`/p/${code}`}
                    >
                      /p/{code}
                    </a>
                  </Fact>
                )}
              </dl>
            </section>

            <section aria-labelledby="board-title" className="grid gap-4">
              <h3 id="board-title" className="m-0 font-heading text-xl font-semibold">
                {t("boardTitle")}
              </h3>
              <BoardHeadFacts head={board} />
              <a
                className="inline-flex min-h-12 items-center gap-2 justify-self-start underline underline-offset-4 focus-text"
                href={`/polls/${poll.electionId}/board`}
              >
                {t("boardLink")}
                <ArrowRight aria-hidden="true" className="size-4" />
              </a>
            </section>
          </div>
        </details>
      </section>

      {/* Not for a hidden poll: moderators have already removed its text (T-68). */}
      {report === undefined || moderation.state === "hidden" ? null : (
        <ReportSection words={POLL_WORDS} send={(reason) => report(poll.electionId, reason)} />
      )}
    </article>
  );
}
