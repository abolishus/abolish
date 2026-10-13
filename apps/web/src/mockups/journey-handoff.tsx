import { buttonVariants, cn } from "@abolishus/ui";
import { ArrowRight, Check, Lock } from "lucide-react";
import { type MouseEvent, useEffect, useId, useRef, useState } from "react";

import { EverydayShell, Frame, ROUND, Seal } from "./everyday-parts.tsx";
import {
  LIBRARY_JOURNEY,
  RIVERSIDE_JOURNEY,
  VOTING_APP_HOST,
  votingAppHref,
  type JourneyPoll,
} from "./journey-data.ts";

const ANSWER =
  "inline-flex min-h-12 w-full items-center justify-between gap-3 rounded-lg border border-border px-4 py-2 text-start text-base hover:border-foreground hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none";

/** What was tapped, carried into the interstitial. */
export interface Tapped {
  poll: JourneyPoll;
  pick: string;
}

/**
 * A stream card that hands off to the voting app. The poll's seal sits in
 * the byline, as it will in the app's header. A poll of several questions
 * offers its first question's answers too, so the first tap is an answer.
 */
export function JourneyCard({
  poll,
  onOpen,
}: {
  poll: JourneyPoll;
  onOpen: (tapped: Tapped) => void;
}) {
  const titleId = useId();
  const [first] = poll.questions;
  if (first === undefined) return null;
  const several = poll.questions.length > 1;
  function open(event: MouseEvent<HTMLAnchorElement>, pick: string) {
    event.preventDefault();
    onOpen({ poll, pick });
  }
  return (
    <article
      aria-labelledby={titleId}
      className="grid content-start gap-5 rounded-xl border border-border p-5 sm:p-6"
    >
      <div className="grid gap-3">
        <h2
          id={titleId}
          className="m-0 font-heading text-2xl leading-tight font-semibold text-balance sm:text-3xl"
        >
          {poll.title}
        </h2>
        <Seal hash={poll.hash} subject="poll">
          <span className="text-muted-foreground">
            Asked by {poll.askedBy} · {poll.closes}
          </span>
        </Seal>
      </div>
      {several ? (
        <p className="m-0 text-base text-pretty">
          <span className="font-semibold">Question 1 of {poll.questions.length}:</span> {first.text}
        </p>
      ) : null}
      <ul aria-label={`Answers to “${first.text}”`} className="m-0 grid list-none gap-2 p-0">
        {first.options.map((o) => (
          <li key={o.key}>
            <a
              href={votingAppHref(poll, o.key)}
              onClick={(event) => open(event, o.key)}
              className={ANSWER}
            >
              <span>{o.label}</span>
              <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            </a>
          </li>
        ))}
      </ul>
      <p className="m-0 text-sm text-pretty text-muted-foreground">
        {several
          ? `Your answer opens the voting app, with ${poll.questions.length - 1} more questions to go.`
          : "Your answer opens the voting app, where you send it."}
      </p>
    </article>
  );
}

/**
 * The moment between the two: the card's question and seal again, why the
 * answer moves to another app, and the address it opens at. Shown in the
 * same tab until the voting app paints; it never holds the person back.
 */
export function Opening({ tapped, onStay }: { tapped: Tapped; onStay: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const { poll, pick } = tapped;
  const several = poll.questions.length > 1;
  const first = poll.questions[0];
  const label = first?.options.find((o) => o.key === pick)?.label ?? pick;
  return (
    <Frame className="grid max-w-xl gap-8 pt-12 pb-16 md:pt-20">
      <div className="grid gap-4 rounded-xl border border-border p-5 sm:p-6">
        <Seal hash={poll.hash} subject="poll">
          <span className="text-muted-foreground">Asked by {poll.askedBy}</span>
        </Seal>
        <p className="m-0 font-heading text-2xl leading-tight font-semibold text-balance">
          {several ? `Question 1 of ${poll.questions.length}: ${first?.text}` : poll.title}
        </p>
        <p className="m-0 flex items-start gap-2 text-lg">
          <Check aria-hidden="true" className="mt-1 size-5 shrink-0 text-primary" />
          <span>
            Your answer: <span className="font-semibold">{label}</span>
          </span>
        </p>
      </div>
      <div className="grid gap-3">
        <h1
          ref={heading}
          tabIndex={-1}
          className="m-0 font-heading text-4xl leading-tight font-semibold tracking-tight outline-none"
        >
          Opening the secure voting app
        </h1>
        <p className="m-0 text-lg text-pretty">
          Your answer is sealed on your device, in an app nobody can change for you.
        </p>
        <p className="m-0 flex flex-wrap items-center gap-x-2 text-base">
          It opens in this tab at
          <span className="inline-flex items-center gap-1.5 font-semibold">
            <Lock aria-hidden="true" className="size-4" />
            {VOTING_APP_HOST}
          </span>
        </p>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <a
          href={votingAppHref(poll, pick)}
          onClick={(event) => event.preventDefault()}
          className={cn(buttonVariants({ size: "lg" }), ROUND, "justify-between")}
        >
          Open it now
          <ArrowRight aria-hidden="true" />
        </a>
        <button
          type="button"
          onClick={onStay}
          className={cn(buttonVariants({ size: "lg", variant: "ghost" }), ROUND)}
        >
          Stay on the website
        </button>
      </div>
      <p className="m-0 text-base text-pretty text-muted-foreground">
        To come back, use “Back to the poll's page” when you're done, or your browser's Back button.
      </p>
    </Frame>
  );
}

/**
 * The stream with the two journey cards. Tapping an answer swaps the page
 * for the interstitial; the header stays, so the wordmark never moves.
 */
export function HandoffPage({ tapped: initial }: { tapped?: Tapped }) {
  const [tapped, setTapped] = useState<Tapped | undefined>(initial);
  return (
    <EverydayShell current="/discover">
      {tapped === undefined ? (
        <Frame className="grid gap-8 pt-12 pb-16">
          <h1 className="m-0 font-heading text-4xl font-semibold tracking-tight sm:text-5xl">
            What people are asking
          </h1>
          <div className="grid gap-6 lg:grid-cols-2">
            <JourneyCard poll={LIBRARY_JOURNEY} onOpen={setTapped} />
            <JourneyCard poll={RIVERSIDE_JOURNEY} onOpen={setTapped} />
          </div>
        </Frame>
      ) : (
        <Opening tapped={tapped} onStay={() => setTapped(undefined)} />
      )}
    </EverydayShell>
  );
}

/**
 * Back from the voting app. The website can't know whether, or how, the
 * person answered, and says so rather than pretending.
 */
export function BackOnSite() {
  return (
    <EverydayShell current="/discover">
      <Frame className="grid gap-8 pt-12 pb-16">
        <section
          aria-labelledby="back-title"
          className="grid max-w-prose gap-2 rounded-xl border border-border bg-muted/60 p-5"
        >
          <h1 id="back-title" className="m-0 font-heading text-2xl font-semibold">
            Back from the voting app
          </h1>
          <p className="m-0 text-base text-pretty">
            If you sent an answer, its receipt is in the voting app on your device. This website
            never learns how you answered, or whether you did.
          </p>
        </section>
        <div className="grid gap-6 lg:grid-cols-2">
          <JourneyCard poll={LIBRARY_JOURNEY} onOpen={() => undefined} />
        </div>
      </Frame>
    </EverydayShell>
  );
}
