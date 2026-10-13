import { buttonVariants, cn, Fingerprint } from "@abolishus/ui";
import { ArrowRight, Check, KeyRound, Lock } from "lucide-react";
import type { ReactNode } from "react";

import { sampleHash } from "./board-data.ts";
import { LATEST, MY_ANSWER, num, PEOPLE, ranked } from "./everyday-data.ts";
import { RIVERSIDE, STREAM } from "./everyday-fixtures.ts";
import { Byline, EverydayShell, Frame, ROUND, StepScene } from "./everyday-parts.tsx";
import { AnswerLinks, StreamCard } from "./everyday-stream.tsx";

const FEATURED = RIVERSIDE.questions[0]!;

function Hero() {
  return (
    <Frame className="grid gap-12 pt-12 pb-20 md:pt-20 lg:grid-cols-12 lg:gap-x-10">
      <div className="grid content-start gap-8 lg:col-span-7">
        <h1 className="m-0 font-heading text-5xl leading-[1] font-semibold tracking-tight text-balance sm:text-7xl">
          Ask anything. Anyone can answer. Anyone can check the count.
        </h1>
        <p className="m-0 max-w-prose text-xl text-pretty">
          Questions big and small, from your street to your county. Answering takes a tap or two,
          and every count is public, so nobody has to take anyone’s word for a result.
        </p>
        <div className="flex flex-wrap gap-3">
          <a href="/polls/new" className={cn(buttonVariants({ size: "lg" }), ROUND)}>
            Ask a question
          </a>
          <a
            href="/discover"
            className={cn(buttonVariants({ size: "lg", variant: "outline" }), ROUND)}
          >
            Browse questions
          </a>
        </div>
        <p className="m-0 text-base text-muted-foreground">Non-binding, and run by citizens.</p>
      </div>
      <section
        aria-labelledby="featured-title"
        className="grid content-start gap-5 border border-border p-5 sm:p-7 lg:col-span-5"
      >
        <Byline className="text-sm">
          <span>Asked by {RIVERSIDE.askedBy}</span>
          <span aria-hidden="true">·</span>
          <span>Closes 15 Nov</span>
        </Byline>
        <h2
          id="featured-title"
          className="m-0 font-heading text-3xl leading-tight font-semibold text-balance"
        >
          {FEATURED.text}
        </h2>
        <p className="m-0 text-sm text-muted-foreground">
          Question 1 of {RIVERSIDE.questions.length} in{" "}
          <a href="/polls/riverside" className="text-foreground underline underline-offset-4">
            {RIVERSIDE.title}
          </a>
        </p>
        <AnswerLinks pollId="riverside" question={FEATURED.text} options={FEATURED.options} />
        <p className="m-0 text-sm text-pretty">
          Tap an answer to open the ballot app with it picked. Nothing is sent until you confirm
          there.
        </p>
        <p className="m-0 border-t border-border pt-4 text-sm">
          {num(LATEST.ballots)} {PEOPLE} have answered.{" "}
          <a href="/polls/riverside#results" className="underline underline-offset-4">
            See results so far
          </a>
        </p>
      </section>
    </Frame>
  );
}

function StreamPreview() {
  const items = STREAM.filter((s) => s.id !== "riverside" && !("civic" in s));
  return (
    <section aria-labelledby="stream-title" className="border-t border-border pt-16">
      <Frame className="grid gap-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="grid gap-3">
            <h2
              id="stream-title"
              className="m-0 font-heading text-3xl leading-tight font-semibold sm:text-5xl"
            >
              What people are asking
            </h2>
            <p className="m-0 max-w-prose text-lg text-pretty">
              The newest questions, in the order they were asked.
            </p>
          </div>
          <a
            href="/discover"
            className={cn(buttonVariants({ variant: "outline" }), ROUND, "gap-2")}
          >
            See all questions
            <ArrowRight aria-hidden="true" />
          </a>
        </div>
        <ul className="m-0 grid list-none gap-6 p-0 lg:grid-cols-3">
          {items.map((item) => (
            <li key={item.id} className="grid">
              <StreamCard item={item} />
            </li>
          ))}
        </ul>
      </Frame>
    </section>
  );
}

interface TrustStep {
  title: string;
  body: string;
  detail: string;
}

const TRUST: readonly TrustStep[] = [
  {
    title: "Sealed on your phone",
    body: "When you answer, the ballot app seals it on your own device before it goes anywhere. What travels is a locked box, not your answer.",
    detail: "The detail: it is encrypted with the poll’s public key.",
  },
  {
    title: "Put on a public list",
    body: "Every sealed answer goes on a public board that anyone can read. You keep a small seal of your own, so you can find yours there and see it was counted.",
    detail: "The detail: your receipt’s fingerprint matches one row on the board.",
  },
  {
    title: "Opened only at set times",
    body: "Results are unlocked only at set release times, and only once enough new people have answered that no one answer stands out. During launch Abolish holds the key; an asker can add a trustee of their own, and then it takes both.",
    detail: "The detail: Riverside’s poll needs at least 50 new answers per release.",
  },
  {
    title: "Counted again by anyone",
    body: "Anyone can take the public list and count it again with the free verifier. If their count matches ours, nobody has to take our word for it.",
    detail: "The detail: the verifier works without our servers.",
  },
];

function Panel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid content-start gap-3 border border-border p-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

const ROWS = ["a", "b", "c", "mine", "d"].map((seed) =>
  seed === "mine" ? MY_ANSWER.receipt : sampleHash(`everyday-home-${seed}`),
);

function MiniBars() {
  const rows = ranked(FEATURED, LATEST);
  return (
    <span className="grid gap-2">
      {rows.map((r, i) => (
        <span key={r.key} className="block h-2.5 overflow-hidden bg-muted">
          <span
            className={cn("block h-full ", i === 0 ? "bg-primary" : "bg-foreground/55")}
            style={{ width: `${r.share * 100}%` }}
          />
        </span>
      ))}
    </span>
  );
}

function TrustGraphic({ step }: { step: number }) {
  return (
    <div
      aria-hidden="true"
      data-testid="trust-graphic"
      data-step={step}
      className="mx-auto grid w-full max-w-lg gap-4"
    >
      {step === 0 ? (
        <div className="grid items-center gap-4 sm:grid-cols-[1fr_auto_1fr]">
          <Panel label="Your answer">
            <span className="border border-border px-3 py-2 text-base">
              {FEATURED.options[0]!.label}
            </span>
          </Panel>
          <ArrowRight className="mx-auto size-6 rotate-90 text-muted-foreground sm:rotate-0" />
          <Panel label="What leaves your phone">
            <span className="flex items-center gap-3">
              <Lock className="size-5" />
              <Fingerprint value={MY_ANSWER.receipt} label="Sealed answer" size={48} />
            </span>
          </Panel>
        </div>
      ) : null}
      {step === 1 ? (
        <Panel label="The public board">
          <ol className="m-0 grid list-none gap-2 p-0">
            {ROWS.map((hash) => {
              const mine = hash === MY_ANSWER.receipt;
              return (
                <li
                  key={hash}
                  className={cn(
                    "flex items-center gap-3 border px-3 py-2",
                    mine ? "border-primary" : "border-border",
                  )}
                >
                  <Fingerprint value={hash} label="Board entry" size={24} />
                  <span className="h-2 flex-1 bg-muted" />
                  {mine ? <span className="text-sm font-medium">Yours</span> : null}
                </li>
              );
            })}
          </ol>
        </Panel>
      ) : null}
      {step === 2 ? (
        <Panel label="To open the results">
          <span className="flex flex-wrap items-center gap-3">
            <Lock className="size-8" />
            {["Abolish", ...RIVERSIDE.trustees.added].map((name) => (
              <span
                key={name}
                className="inline-flex items-center gap-2 border border-border px-3 py-1.5 text-sm"
              >
                <KeyRound className="size-4" />
                {name}
              </span>
            ))}
          </span>
          <span className="text-base">Both keys, at a set release time.</span>
        </Panel>
      ) : null}
      {step >= 3 ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Panel label="Published count">
            <MiniBars />
          </Panel>
          <Panel label="Anyone’s recount">
            <MiniBars />
          </Panel>
          <span className="flex items-center gap-2 text-base font-medium sm:col-span-2">
            <Check className="size-5 text-recorded" />
            They match.
          </span>
        </div>
      ) : null}
    </div>
  );
}

function TrustBand() {
  return (
    <section aria-labelledby="trust-title" className="mt-16 border-t border-border pt-16">
      <Frame className="grid gap-6">
        <div className="grid gap-4 lg:grid-cols-12 lg:gap-x-10">
          <h2
            id="trust-title"
            className="m-0 font-heading text-3xl leading-tight font-semibold text-balance sm:text-5xl lg:col-span-6"
          >
            Why you can trust a casual poll
          </h2>
          <p className="m-0 max-w-prose text-lg text-pretty lg:col-span-6 lg:self-end">
            A question about street trees gets the same care as a referendum. Here is what happens
            to an answer, in four steps.
          </p>
        </div>
        <StepScene
          label="What happens to an answer"
          steps={TRUST.map((s, i) => (
            <div key={s.title} className="grid gap-3">
              <p className="m-0 text-sm text-muted-foreground">Step {i + 1} of 4</p>
              <h3 className="m-0 font-heading text-2xl font-semibold">{s.title}</h3>
              <p className="m-0 text-lg text-pretty">{s.body}</p>
              <p className="m-0 text-sm text-muted-foreground">{s.detail}</p>
            </div>
          ))}
          graphic={(step) => <TrustGraphic step={step} />}
        />
        <div className="flex flex-wrap gap-3">
          <a href="/how-it-works" className={cn(buttonVariants({ size: "lg" }), ROUND)}>
            How it works, in full
          </a>
          <a
            href="/verify"
            className={cn(buttonVariants({ size: "lg", variant: "outline" }), ROUND)}
          >
            Recount a result yourself
          </a>
        </div>
      </Frame>
    </section>
  );
}

export function EverydayHomePage() {
  return (
    <EverydayShell current="/">
      <Hero />
      <StreamPreview />
      <TrustBand />
    </EverydayShell>
  );
}
