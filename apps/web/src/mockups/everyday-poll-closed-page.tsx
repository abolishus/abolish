import { cn } from "@abolishus/ui";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@abolishus/ui/ui/collapsible";
import { ChevronDown, CircleCheck } from "lucide-react";

import {
  headline,
  num,
  PEOPLE,
  releaseTime,
  RIVERSIDE_CLOSED,
  RIVERSIDE_FINAL,
} from "./everyday-data.ts";
import { RIVERSIDE } from "./everyday-fixtures.ts";
import {
  audienceCaption,
  Byline,
  EverydayShell,
  EvidenceDetails,
  Frame,
  QuestionResult,
  ROUND,
  Seal,
} from "./everyday-parts.tsx";
import { HowItChanged } from "./everyday-poll-page.tsx";

const POLL = RIVERSIDE;
const FINAL = RIVERSIDE_FINAL;

export function EverydayPollClosedPage({ evidenceOpen = false }: { evidenceOpen?: boolean }) {
  const closed = releaseTime(FINAL.at);
  return (
    <EverydayShell current="/discover">
      <article>
        <Frame className="grid gap-8 pt-12 pb-16 md:pt-20">
          <Byline>
            <span>Asked by {POLL.askedBy}</span>
            <span aria-hidden="true">·</span>
            <span>Closed {closed.day}</span>
          </Byline>
          <h1 className="m-0 max-w-4xl font-heading text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-6xl">
            {POLL.title}
          </h1>
          <p className="m-0 flex items-center gap-2 text-lg">
            <CircleCheck aria-hidden="true" className="size-5 shrink-0 text-recorded" />
            <span>
              Final results. {num(FINAL.ballots)} {PEOPLE} answered; here is what they said.
            </span>
          </p>
          <ul aria-label="In short" className="m-0 grid list-none gap-4 p-0 md:grid-cols-3">
            {POLL.questions.map((q) => (
              <li key={q.key} className="reveal grid content-start gap-2 bg-muted/60 p-5">
                <span className="text-sm text-foreground/80">{q.text}</span>
                <span className="font-heading text-xl leading-snug font-semibold text-pretty">
                  {headline(q, FINAL)}
                </span>
              </li>
            ))}
          </ul>
          <dl className="m-0 grid gap-x-10 gap-y-4 text-base sm:grid-cols-3">
            <div className="grid gap-1">
              <dt className="text-sm text-muted-foreground">Answered</dt>
              <dd className="m-0 tabular-nums">
                {num(FINAL.ballots)} {PEOPLE}
              </dd>
            </div>
            <div className="grid gap-1">
              <dt className="text-sm text-muted-foreground">Closed</dt>
              <dd className="m-0">{RIVERSIDE_CLOSED.closed}</dd>
            </div>
            <div className="grid gap-1">
              <dt className="text-sm text-muted-foreground">Final count published</dt>
              <dd className="m-0">{RIVERSIDE_CLOSED.counted}</dd>
            </div>
          </dl>
          <a
            href="#evidence"
            className="inline-flex min-h-12 items-center self-start pe-3 underline-offset-4 hover:underline"
          >
            <Seal hash={POLL.id} subject="poll">
              How do we know this is real?
            </Seal>
          </a>
        </Frame>

        <section aria-labelledby="final-title" className="border-t border-border pt-16">
          <Frame className="grid gap-10">
            <div className="grid gap-3">
              <h2
                id="final-title"
                className="m-0 font-heading text-3xl leading-tight font-semibold sm:text-5xl"
              >
                Question by question
              </h2>
              <p className="m-0 max-w-prose text-lg text-pretty">
                Each question is counted on its own. Answers to different questions are never
                matched up, so no one can tell how any one person answered the set.
              </p>
            </div>
            <div className="grid gap-6">
              {POLL.questions.map((q, i) => (
                <QuestionResult
                  key={q.key}
                  question={q}
                  number={i + 1}
                  batch={FINAL}
                  caption={audienceCaption(FINAL.ballots, `final count, closed ${closed.day}`)}
                />
              ))}
            </div>
            <HowItChanged poll={POLL} final={FINAL} />
          </Frame>
        </section>

        <section
          id="evidence"
          aria-labelledby="evidence-title"
          className="mt-16 scroll-mt-6 border-t border-border pt-16"
        >
          <Frame>
            <Collapsible defaultOpen={evidenceOpen} className="grid gap-6">
              <div className="grid gap-4 lg:grid-cols-12 lg:gap-x-10">
                <h2
                  id="evidence-title"
                  className="m-0 font-heading text-3xl leading-tight font-semibold text-balance lg:col-span-5"
                >
                  How do we know this is real?
                </h2>
                <div className="grid content-start gap-4 lg:col-span-7">
                  <p className="m-0 max-w-prose text-lg text-pretty">
                    The count was done in the open: every answer sealed, listed on the public board
                    and counted in a way anyone can repeat.
                  </p>
                  <CollapsibleTrigger
                    className={cn(
                      "group inline-flex h-12 items-center gap-2 justify-self-start border border-border px-5 text-base hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none",
                      ROUND,
                    )}
                  >
                    <span className="group-data-panel-open:hidden">Show the evidence</span>
                    <span className="hidden group-data-panel-open:inline">Hide the evidence</span>
                    <ChevronDown
                      aria-hidden="true"
                      className="size-4 transition-transform duration-200 group-data-panel-open:rotate-180 motion-reduce:transition-none"
                    />
                  </CollapsibleTrigger>
                </div>
              </div>
              <CollapsibleContent className="border border-border p-5 sm:p-8">
                <EvidenceDetails poll={POLL} />
              </CollapsibleContent>
            </Collapsible>
          </Frame>
        </section>
      </article>
    </EverydayShell>
  );
}
