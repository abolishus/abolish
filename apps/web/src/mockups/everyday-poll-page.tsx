import { buttonVariants, cn } from "@abolishus/ui";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@abolishus/ui/ui/sheet";
import { ArrowRight, CircleCheck, Lock } from "lucide-react";

import {
  answerHref,
  headline,
  LATEST,
  leader,
  MY_ANSWER,
  num,
  pct,
  PEOPLE,
  releaseTime,
  ruleText,
  updateLine,
} from "./everyday-data.ts";
import { type EverydayPoll, type LiveBatch, RIVERSIDE } from "./everyday-fixtures.ts";
import {
  audienceCaption,
  Byline,
  EverydayShell,
  EvidenceDetails,
  Frame,
  QuestionResult,
  ResultBars,
  ROUND,
  Seal,
  StepScene,
} from "./everyday-parts.tsx";

export interface EverydayPollPageProps {
  /** Whether the reader has already answered. */
  answered?: boolean;
  /** Live running totals, or sealed until close: the author's choice. */
  results?: EverydayPoll["results"];
}

export function EverydayPollPage({ answered = false, results = "live" }: EverydayPollPageProps) {
  const poll: EverydayPoll = { ...RIVERSIDE, results };
  return (
    <EverydayShell current="/discover" signedIn={answered}>
      <Sheet>
        <article>
          <Hero poll={poll} answered={answered} />
          {poll.results === "live" ? <LiveResults poll={poll} /> : <SealedResults poll={poll} />}
          <Trust poll={poll} />
        </article>
        <SheetContent className="overflow-y-auto text-base data-[side=right]:w-full data-[side=right]:sm:max-w-md">
          <SheetHeader className="gap-2 p-6 pe-16">
            <SheetTitle className="text-2xl font-semibold">How do we know this is real?</SheetTitle>
            <SheetDescription className="text-base text-muted-foreground">
              The evidence behind “{poll.title}”, in plain words.
            </SheetDescription>
          </SheetHeader>
          <div className="px-6 pb-8">
            <EvidenceDetails poll={poll} />
          </div>
        </SheetContent>
      </Sheet>
    </EverydayShell>
  );
}

const CHECK_TRIGGER =
  "inline-flex min-h-12 items-center pe-3 text-start underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none";

function Hero({ poll, answered }: { poll: EverydayPoll; answered: boolean }) {
  const count = poll.questions.length;
  return (
    <Frame className="grid gap-10 pt-12 pb-16 md:pt-20 lg:grid-cols-12 lg:gap-x-10">
      <div className="grid content-start gap-6 lg:col-span-12">
        <Byline>
          <span>Asked by {poll.askedBy}</span>
          <span aria-hidden="true">·</span>
          <span>Closes {poll.closes.replace(" 2026,", ",")}</span>
        </Byline>
        <h1 className="m-0 max-w-4xl font-heading text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-6xl">
          {poll.title}
        </h1>
        <p className="m-0 max-w-prose text-lg text-pretty">
          {count} short questions for {poll.audience} in {poll.place}. It takes about a minute, and
          you can change your answers until it closes.
        </p>
      </div>
      <ol className="m-0 grid list-none gap-4 p-0 lg:col-span-7">
        {poll.questions.map((q, i) => (
          <li
            key={q.key}
            className="grid grid-cols-[2.5rem_1fr] gap-x-4 border border-border p-5 sm:p-6"
          >
            <span
              aria-hidden="true"
              className="grid size-10 place-items-center bg-muted font-heading text-lg font-semibold"
            >
              {i + 1}
            </span>
            <div className="grid min-w-0 gap-2">
              <h2 className="m-0 font-heading text-xl leading-snug font-semibold text-pretty sm:text-2xl">
                <span className="sr-only">Question {i + 1}: </span>
                {q.text}
              </h2>
              <p className="m-0 text-sm text-muted-foreground">
                {ruleText(q.rule)} from {q.options.length}
                {q.hint === undefined ? "" : `. ${q.hint}`}
              </p>
              <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
                {q.options.map((o) => (
                  <li key={o.key} className="border border-border px-3 py-1 text-sm">
                    {o.label}
                  </li>
                ))}
              </ul>
            </div>
          </li>
        ))}
      </ol>
      <div className="grid content-start gap-6 lg:sticky lg:top-6 lg:col-span-5 lg:self-start">
        {answered ? (
          <Answered />
        ) : (
          <div className="grid gap-4 bg-muted/60 p-5 sm:p-6">
            <a
              href={answerHref("riverside")}
              className={cn(buttonVariants({ size: "lg" }), ROUND, "justify-between")}
            >
              Answer these {count} questions
              <ArrowRight aria-hidden="true" />
            </a>
            <p className="m-0 text-base text-pretty">
              Opens the ballot app. Your answers are sealed on your own device before they’re sent,
              and they’re never linked to who you are.
            </p>
          </div>
        )}
        <SheetTrigger className={CHECK_TRIGGER}>
          <Seal hash={poll.id} subject="poll">
            How do we know this is real?
          </Seal>
        </SheetTrigger>
      </div>
    </Frame>
  );
}

function Answered() {
  return (
    <section
      aria-labelledby="answered-title"
      className="grid gap-4 border-2 border-primary p-5 sm:p-6"
    >
      <h2
        id="answered-title"
        className="m-0 flex items-center gap-2 font-heading text-2xl font-semibold"
      >
        <CircleCheck aria-hidden="true" className="size-6 text-primary" />
        You answered
      </h2>
      <p className="m-0 text-base text-pretty">
        On {MY_ANSWER.on}. Your answers are counted in the {MY_ANSWER.inUpdate} results. They aren’t
        linked to who you are.
      </p>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <a
          href={`/receipt/${MY_ANSWER.receipt}`}
          className="inline-flex min-h-12 items-center underline-offset-4 hover:underline"
        >
          <Seal hash={MY_ANSWER.receipt} subject="your receipt">
            Your receipt
          </Seal>
        </a>
        <a
          href={answerHref("riverside")}
          className={cn(buttonVariants({ variant: "outline" }), ROUND)}
        >
          Change your answer
        </a>
      </div>
    </section>
  );
}

const FLOOR = (poll: EverydayPoll) =>
  `Results come out at set times, and only once at least ${poll.batchFloor} new people have answered since the last release, so no release can give away anyone’s answer.`;

function LiveResults({ poll }: { poll: EverydayPoll }) {
  const latest = updateLine(poll.batches.length - 1, poll.batches);
  const at = releaseTime(LATEST.at);
  return (
    <section id="results" aria-labelledby="results-title" className="border-t border-border pt-16">
      <Frame className="grid gap-10">
        <div className="grid gap-4 lg:grid-cols-12 lg:gap-x-10">
          <div className="grid content-start gap-3 lg:col-span-6">
            <h2
              id="results-title"
              className="m-0 font-heading text-3xl leading-tight font-semibold sm:text-5xl"
            >
              Results so far
            </h2>
            <p className="m-0 text-lg" data-testid="latest-update">
              {latest.when} · {latest.change}
            </p>
          </div>
          <p className="m-0 max-w-prose text-base text-pretty text-muted-foreground lg:col-span-6 lg:self-end">
            {FLOOR(poll)}
          </p>
        </div>
        <div className="grid gap-6">
          {poll.questions.map((q, i) => (
            <QuestionResult
              key={q.key}
              question={q}
              number={i + 1}
              batch={LATEST}
              caption={audienceCaption(LATEST.ballots, `updated ${at.day}, ${at.time}`)}
            />
          ))}
        </div>
        <HowItChanged poll={poll} />
      </Frame>
    </section>
  );
}

/** The scroll-driven walk through real releases; with `final`, the closing count is the last step. */
export function HowItChanged({ poll, final }: { poll: EverydayPoll; final?: LiveBatch }) {
  const q = poll.questions[0]!;
  const batches = final === undefined ? poll.batches : [...poll.batches, final];
  const steps = batches.map((batch, i) => {
    const line = updateLine(i, batches, final !== undefined);
    const before = batches[i - 1];
    const lead = leader(q, batch);
    const kept = before !== undefined && leader(q, before).key === lead.key;
    return (
      <div key={batch.at} className="grid gap-3">
        <p className="m-0 text-sm text-muted-foreground">{line.when}</p>
        <p className="m-0 text-lg text-pretty">
          {before === undefined
            ? `${num(batch.ballots)} ${PEOPLE} had answered by the first release.`
            : `${line.change}, ${num(batch.ballots)} in all.`}{" "}
          {kept ? `${lead.label} still leads.` : headline(q, batch)}
        </p>
        <ul className="m-0 grid list-none gap-1 p-0 text-sm">
          {q.options.map((o) => (
            <li key={o.key} className="flex justify-between gap-4">
              <span>{o.label}</span>
              <span className="tabular-nums">
                {pct((batch.counts[q.key]?.[o.key] ?? 0) / batch.ballots)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  });
  return (
    <section aria-labelledby="changed-title" className="grid gap-6 pt-10">
      <div className="grid gap-3 lg:grid-cols-12 lg:gap-x-10">
        <h3
          id="changed-title"
          className="m-0 font-heading text-2xl leading-tight font-semibold sm:text-3xl lg:col-span-6"
        >
          How the answers came in
        </h3>
        <p className="m-0 max-w-prose text-base text-pretty lg:col-span-6">
          Each release is a real count at a real time. Scroll through them to see how the first
          question moved; nothing in between is guessed.
          {final === undefined ? "" : " The last step is the final count."}
        </p>
      </div>
      <StepScene
        label="Releases of the first question’s results"
        steps={steps}
        graphic={(step) => {
          const i = Math.min(step, batches.length - 1);
          const batch = batches[i]!;
          const at = releaseTime(batch.at);
          return (
            <div data-testid="release-graphic" data-release={i} className="grid gap-4">
              <p className="m-0 font-heading text-lg leading-snug font-semibold text-pretty">
                {q.text}
              </p>
              <ResultBars
                question={q}
                batch={batch}
                showCounts={false}
                caption={audienceCaption(batch.ballots, `${at.day}, ${at.time}`)}
              />
            </div>
          );
        }}
      />
    </section>
  );
}

function SealedResults({ poll }: { poll: EverydayPoll }) {
  return (
    <section id="results" aria-labelledby="results-title" className="border-t border-border pt-16">
      <Frame className="grid gap-6 lg:grid-cols-12 lg:gap-x-10">
        <div className="grid content-start gap-4 lg:col-span-7">
          <h2
            id="results-title"
            className="m-0 font-heading text-3xl leading-tight font-semibold sm:text-5xl"
          >
            Results appear when it closes
          </h2>
          <p className="m-0 max-w-prose text-lg text-pretty">
            {poll.askedBy} chose to keep the results sealed until{" "}
            {poll.closes.replace(" 2026,", ",")}. Until then they stay locked, and {poll.askedBy}{" "}
            can’t see them either.
          </p>
        </div>
        <div className="grid content-start gap-2 border border-border p-5 sm:p-6 lg:col-span-5">
          <Lock aria-hidden="true" className="size-6" />
          <p className="m-0 font-heading text-4xl font-semibold tabular-nums">
            {num(LATEST.ballots)}
          </p>
          <p className="m-0 text-base">{PEOPLE} have answered so far.</p>
          <p className="m-0 text-sm text-muted-foreground">
            Anyone can count the sealed answers on the public board; what they say stays locked.
          </p>
        </div>
      </Frame>
    </section>
  );
}

function Trust({ poll }: { poll: EverydayPoll }) {
  return (
    <section aria-labelledby="trust-title" className="mt-16 border-t border-border pt-16">
      <Frame className="grid gap-6 lg:grid-cols-12 lg:gap-x-10">
        <h2
          id="trust-title"
          className="m-0 font-heading text-3xl leading-tight font-semibold text-balance lg:col-span-5"
        >
          How do we know this is real?
        </h2>
        <div className="grid content-start gap-4 lg:col-span-7">
          <p className="m-0 max-w-prose text-lg text-pretty">
            Every answer is sealed on the answerer’s device, listed in public and counted in a way
            anyone can repeat. {poll.askedBy} can’t see anyone’s answers, and opening them takes
            {poll.trustees.added.length > 0
              ? ` ${poll.trustees.added.join(" and ")} as well as`
              : ""}{" "}
            Abolish’s key.
          </p>
          <SheetTrigger
            className={cn(buttonVariants({ variant: "outline" }), ROUND, "justify-self-start")}
          >
            Show me the evidence
          </SheetTrigger>
        </div>
      </Frame>
    </section>
  );
}
