import { buttonVariants, cn, Fingerprint, Hash } from "@abolishus/ui";
import { Check, Circle, Clock, X } from "lucide-react";
import type { ReactNode } from "react";

import { CLIENT, shortHex, type BallotElection } from "./fixtures.ts";

/** The voter's path through one ballot; detours (checking a ballot) keep their step. */
export const STEPS = ["Check", "Choose", "Review", "Cast", "Receipt"] as const;

export type StepName = (typeof STEPS)[number];

/** Classes for a bottom-bar action, so primary and secondary line up. */
export const ACTION = "w-full sm:w-auto sm:min-w-48";

/** A link that looks like a bottom-bar action. */
export function linkAction(variant: "default" | "outline" | "link" = "default"): string {
  return cn(buttonVariants({ variant, size: "lg" }), ACTION);
}

/**
 * The ballot client's frame for the screen mockups: what is being voted on
 * and which client is doing it (each with its fingerprint), the step, one
 * task, and the actions at the bottom. Nothing in it moves.
 */
export function BallotFrame({
  election,
  step,
  primary,
  secondary,
  children,
}: {
  /** Absent when the client stopped before it could show an election. */
  election?: BallotElection;
  step?: StepName;
  primary?: ReactNode;
  secondary?: ReactNode;
  children: ReactNode;
}) {
  const index = step === undefined ? -1 : STEPS.indexOf(step);
  return (
    <div className="flex min-h-dvh flex-col bg-background font-sans text-foreground">
      <header className="border-b border-foreground">
        <div className="mx-auto flex max-w-xl items-center justify-between gap-4 px-4 py-3">
          {election === undefined ? (
            <p className="m-0 font-heading text-lg font-semibold tracking-tight">Abolish ballot</p>
          ) : (
            <div className="flex min-w-0 items-center gap-3">
              <Fingerprint
                value={election.definitionHash}
                label={`Fingerprint of the election definition ${shortHex(election.definitionHash)}`}
                size={36}
              />
              <div className="min-w-0">
                <p className="m-0 truncate font-heading text-base leading-tight font-semibold">
                  {election.shortName}
                </p>
                <p className="m-0 font-mono text-xs tracking-wide whitespace-nowrap text-muted-foreground">
                  Election {shortHex(election.definitionHash)}
                </p>
              </div>
            </div>
          )}
          <div className="flex shrink-0 items-center gap-3 text-end">
            <div>
              <p className="m-0 text-xs whitespace-nowrap text-muted-foreground">
                Client {CLIENT.version}
              </p>
              <p className="m-0 font-mono text-xs tracking-wide whitespace-nowrap">
                {shortHex(CLIENT.hash)}
              </p>
            </div>
            <Fingerprint
              value={CLIENT.hash}
              label={`Fingerprint of ballot client ${CLIENT.version}, ${shortHex(CLIENT.hash)}`}
              size={36}
            />
          </div>
        </div>
        {step === undefined ? null : (
          <div className="border-t border-border">
            <div className="mx-auto flex max-w-xl items-center gap-4 px-4 py-2">
              <p className="m-0 shrink-0 text-sm">
                <span className="tabular-nums">
                  Step {index + 1} of {STEPS.length}
                </span>
                <span aria-hidden="true"> · </span>
                <span className="sr-only">: </span>
                <span className="font-semibold">{step}</span>
              </p>
              <ol aria-hidden="true" className="m-0 flex flex-1 list-none gap-1 p-0">
                {STEPS.map((name, i) => (
                  <li
                    key={name}
                    className={cn(
                      "h-1 flex-1",
                      i < index && "bg-foreground",
                      i === index && "bg-primary",
                      i > index && "bg-border",
                    )}
                  />
                ))}
              </ol>
            </div>
          </div>
        )}
      </header>
      <main className="mx-auto w-full max-w-xl flex-1 px-4 pt-8 pb-12">{children}</main>
      {primary === undefined && secondary === undefined ? null : (
        <div className="sticky bottom-0 border-t border-foreground bg-background">
          <div className="mx-auto flex max-w-xl flex-col gap-3 px-4 py-4 sm:flex-row-reverse sm:justify-between">
            {primary}
            {secondary}
          </div>
        </div>
      )}
    </div>
  );
}

/** The screen's one heading, with an optional line above it and a lede below. */
export function ScreenTitle({
  eyebrow,
  title,
  children,
}: {
  eyebrow?: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="grid gap-4">
      {eyebrow === undefined ? null : (
        <p className="m-0 font-mono text-xs tracking-widest text-muted-foreground uppercase">
          {eyebrow}
        </p>
      )}
      <h1 className="m-0 font-heading text-3xl leading-tight font-semibold tracking-tight text-balance sm:text-4xl">
        {title}
      </h1>
      {children === undefined ? null : (
        <div className="grid gap-3 text-lg text-pretty">{children}</div>
      )}
    </div>
  );
}

/** A ruled section of a screen, numbered like a clause in a printed record. */
export function Section({
  index,
  title,
  children,
  className,
}: {
  index?: string;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("mt-10 grid gap-4 border-t border-border pt-6", className)}>
      <h2 className="m-0 flex items-baseline gap-3 font-heading text-lg font-semibold">
        {index === undefined ? null : (
          <span
            aria-hidden="true"
            className="font-mono text-xs font-normal tracking-widest text-muted-foreground tabular-nums"
          >
            {index}
          </span>
        )}
        {title}
      </h2>
      {children}
    </section>
  );
}

const CHECK_ICONS = { passed: Check, failed: X, waiting: Clock, upcoming: Circle } as const;
const CHECK_WORDS = {
  passed: "Passed",
  failed: "Failed",
  waiting: "Waiting",
  upcoming: "Not yet",
} as const;

export type CheckState = keyof typeof CHECK_ICONS;

/** A checklist of what the client checked, each with its state in an icon and in words. */
export function Checklist({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul aria-label={label} className="m-0 grid list-none gap-0 border-y border-foreground p-0">
      {children}
    </ul>
  );
}

export function CheckItem({
  state,
  title,
  children,
}: {
  state: CheckState;
  title: string;
  children?: ReactNode;
}) {
  const Icon = CHECK_ICONS[state];
  return (
    <li className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-3 border-b border-border py-4 last:border-b-0">
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 flex size-6 items-center justify-center border",
          state === "passed" && "border-recorded text-recorded",
          state === "failed" && "border-destructive text-destructive",
          state === "waiting" && "border-pending text-pending",
          state === "upcoming" && "border-muted-foreground text-muted-foreground",
        )}
      >
        <Icon className="size-4" strokeWidth={state === "passed" ? 3 : 2} />
      </span>
      <div className="grid gap-1">
        <p className="m-0 font-medium">{title}</p>
        <p
          className={cn(
            "m-0 font-mono text-xs tracking-widest uppercase",
            state === "failed" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {CHECK_WORDS[state]}
        </p>
      </div>
      {children === undefined ? null : <div className="col-start-2 grid gap-3">{children}</div>}
    </li>
  );
}

/** A hash a person might compare: its fingerprint beside it, the full hex below. */
export function Evidence({
  label,
  hash,
  of,
  size = 48,
}: {
  /** What the hash is ("Registered definition hash"). */
  label: string;
  hash: string;
  /** What the fingerprint is of, for its accessible name ("the registered definition"). */
  of: string;
  size?: number;
}) {
  return (
    <div className="flex items-start gap-3">
      <Fingerprint value={hash} label={`Fingerprint of ${of}, ${shortHex(hash)}`} size={size} />
      <div className="min-w-0 flex-1 [&_code]:text-sm">
        <Hash value={hash} label={label} />
      </div>
    </div>
  );
}

/** A plain numbered list of what happens, with the numbers in the evidence face. */
export function NumberedSteps({ label, items }: { label: string; items: readonly ReactNode[] }) {
  return (
    <ol aria-label={label} className="m-0 grid list-none gap-0 p-0">
      {items.map((item, i) => (
        <li
          key={i}
          className="grid grid-cols-[2.25rem_1fr] gap-2 border-b border-border py-3 last:border-b-0"
        >
          <span
            aria-hidden="true"
            className="flex size-6 items-center justify-center border border-foreground font-mono text-xs tabular-nums"
          >
            {i + 1}
          </span>
          <span>{item}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * A boxed message. The tone shows in its rule and icon and always in words
 * as well (the title), never in colour alone.
 */
export function Notice({
  tone = "info",
  title,
  children,
  live = false,
}: {
  tone?: "info" | "pending" | "error" | "done";
  title: string;
  children?: ReactNode;
  /** Announce it when it appears in answer to the voter's action. */
  live?: boolean;
}) {
  return (
    <div
      role={live ? "status" : undefined}
      className={cn(
        "grid gap-2 border-s-4 bg-card px-4 py-4 ring-1 ring-border",
        tone === "info" && "border-s-foreground",
        tone === "pending" && "border-s-pending",
        tone === "error" && "border-s-destructive",
        tone === "done" && "border-s-recorded",
      )}
    >
      <p className={cn("m-0 font-semibold", tone === "error" && "text-destructive")}>{title}</p>
      {children === undefined ? null : <div className="grid gap-2 text-pretty">{children}</div>}
    </div>
  );
}

/** A labelled fact in a definition list. */
export function Facts({ items }: { items: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
      {items.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-muted-foreground">{term}</dt>
          <dd className="m-0">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
