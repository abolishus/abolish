import { buttonVariants, cn } from "@abolishus/ui";
import { ArrowRight, Landmark, Lock } from "lucide-react";
import { useId } from "react";

import { answerHref, num, STREAM_DETAIL, type StreamItem } from "./everyday-data.ts";
import { ROUND } from "./everyday-parts.tsx";

const ANSWER =
  "inline-flex min-h-12 w-full items-center justify-between gap-3 rounded-lg border border-border px-4 py-2 text-start text-base hover:border-foreground hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none";

/** The big friendly answer targets. Each opens the ballot app with that answer picked. */
export function AnswerLinks({
  pollId,
  question,
  options,
  className,
}: {
  pollId: string;
  question: string;
  options: readonly { key: string; label: string }[];
  className?: string;
}) {
  return (
    <ul
      aria-label={`Answers to “${question}”`}
      className={cn("m-0 grid list-none gap-2 p-0", className)}
    >
      {options.map((o) => (
        <li key={o.key}>
          <a href={answerHref(pollId, o.key)} className={ANSWER}>
            <span>{o.label}</span>
            <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          </a>
        </li>
      ))}
    </ul>
  );
}

function CivicCard({ item, level }: { item: StreamItem; level: 2 | 3 }) {
  const titleId = useId();
  const H = level === 2 ? "h2" : "h3";
  const detail = STREAM_DETAIL[item.id];
  return (
    <article
      aria-labelledby={titleId}
      data-civic=""
      className="grid gap-4 border-2 border-foreground p-5 sm:p-6"
    >
      <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs tracking-wide text-muted-foreground uppercase">
        <Landmark aria-hidden="true" className="size-4 text-foreground" />
        <span>From the civic record</span>
        <span>·</span>
        <span>{detail.civic?.kind}</span>
      </p>
      <H id={titleId} className="m-0 font-heading text-2xl leading-tight font-semibold">
        <a href={`/polls/${item.id}`} className="underline-offset-4 hover:underline">
          {item.title}
        </a>
      </H>
      <p className="m-0 text-lg text-pretty">{item.lead}</p>
      <p className="m-0 text-sm text-muted-foreground">
        {detail.civic?.scope}. {item.closes}. Each tier is reported on its own.
      </p>
      <a
        href={`/polls/${item.id}`}
        className={cn(buttonVariants({ variant: "outline" }), "justify-between self-start")}
      >
        Read the full record
        <ArrowRight aria-hidden="true" />
      </a>
    </article>
  );
}

/** One question in the stream: answerable from the card, results in a sentence. */
export function StreamCard({ item, level = 3 }: { item: StreamItem; level?: 2 | 3 }) {
  const titleId = useId();
  if ("civic" in item) return <CivicCard item={item} level={level} />;
  const H = level === 2 ? "h2" : "h3";
  const detail = STREAM_DETAIL[item.id];
  const live = item.results === "live";
  return (
    <article
      aria-labelledby={titleId}
      className="reveal grid content-start gap-5 rounded-xl border border-border p-5 sm:p-6"
    >
      <p className="m-0 flex flex-wrap justify-between gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span>
          {item.topic} · {item.place}
        </span>
        <span>{item.closes}</span>
      </p>
      <div className="grid gap-2">
        <H
          id={titleId}
          className="m-0 font-heading text-2xl leading-tight font-semibold text-balance sm:text-3xl"
        >
          <a href={`/polls/${item.id}`} className="underline-offset-4 hover:underline">
            {item.title}
          </a>
        </H>
        <p className="m-0 text-base text-muted-foreground">
          Asked by {item.askedBy} · {detail.asked}
        </p>
      </div>
      <div className="grid gap-1 rounded-lg bg-muted/60 px-4 py-3">
        {live ? (
          <>
            <p className="m-0 text-base font-medium text-pretty">{item.lead}</p>
            <p className="m-0 text-sm text-foreground/80">
              Results so far, among {num(item.answers)} {detail.audience}
              {detail.updated === undefined ? "" : ` · updated ${detail.updated}`}
            </p>
          </>
        ) : (
          <>
            <p className="m-0 flex items-center gap-2 text-base font-medium">
              <Lock aria-hidden="true" className="size-4" />
              Results when it closes
            </p>
            <p className="m-0 text-sm text-foreground/80">
              {num(item.answers)} {detail.audience} have answered so far
            </p>
          </>
        )}
      </div>
      {detail.options !== undefined && item.questions === 1 ? (
        <AnswerLinks pollId={item.id} question={item.title} options={detail.options} />
      ) : (
        <a
          href={answerHref(item.id)}
          className={cn(buttonVariants({ size: "lg" }), ROUND, "justify-between")}
        >
          Answer {item.questions === 1 ? "the question" : `${item.questions} questions`}
          <span className="sr-only">: {item.title}</span>
          <ArrowRight aria-hidden="true" />
        </a>
      )}
    </article>
  );
}
