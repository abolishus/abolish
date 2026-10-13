import { buttonVariants, cn, Fingerprint } from "@abolishus/ui";
import { Check, ChevronDown, Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

import type { EverydayPoll } from "./everyday-fixtures.ts";
import { shortHex } from "./fixtures.ts";

/** Classes for a bottom-bar action, so primary and secondary line up. */
export const EVERYDAY_ACTION = "w-full sm:w-auto sm:min-w-48";

/** A link that looks like a bottom-bar action. */
export function everydayLink(variant: "default" | "outline" | "ghost" = "default"): string {
  return cn(buttonVariants({ variant, size: "lg" }), EVERYDAY_ACTION);
}

/**
 * The ballot client's frame in the everyday register: who asked and when it
 * closes beside the poll's small seal, the question count, one task, and the
 * actions at the bottom. Lighter than the civic frame (no client hash on the
 * surface, softer rules) but the same structure, and nothing in it moves.
 */
export function EverydayFrame({
  poll,
  question,
  primary,
  secondary,
  children,
}: {
  poll: EverydayPoll;
  /** Which question this screen asks, counting from 1. */
  question?: number;
  primary?: ReactNode;
  secondary?: ReactNode;
  children: ReactNode;
}) {
  const total = poll.questions.length;
  return (
    <div className="flex min-h-dvh flex-col bg-background font-sans text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-xl items-center gap-3 px-4 py-3">
          <Fingerprint
            value={poll.definitionHash}
            label={`Seal of this poll, ${shortHex(poll.definitionHash)}`}
            size={36}
          />
          <p className="m-0 min-w-0 flex-1 truncate text-sm">
            <span className="font-semibold">{poll.askedBy}</span>
            <span className="text-muted-foreground"> asked</span>
          </p>
          <p className="m-0 shrink-0 text-sm text-muted-foreground">{poll.closesShort}</p>
        </div>
        {question === undefined ? null : (
          <div className="mx-auto flex max-w-xl items-center gap-4 px-4 pb-3">
            <p className="m-0 shrink-0 text-sm font-semibold tabular-nums">
              Question {question} of {total}
            </p>
            <ol aria-hidden="true" className="m-0 flex flex-1 list-none gap-1.5 p-0">
              {poll.questions.map((q, i) => (
                <li
                  key={q.key}
                  className={cn(
                    "h-1.5 flex-1 ",
                    i + 1 < question && "bg-foreground/60",
                    i + 1 === question && "bg-primary",
                    i + 1 > question && "bg-border",
                  )}
                />
              ))}
            </ol>
          </div>
        )}
      </header>
      <main className="mx-auto w-full max-w-xl flex-1 px-4 pt-8 pb-12">{children}</main>
      {primary === undefined && secondary === undefined ? null : (
        <div className="sticky bottom-0 border-t border-border bg-background">
          <div className="mx-auto flex max-w-xl flex-col gap-3 px-4 py-4 sm:flex-row-reverse sm:justify-between">
            {primary}
            {secondary}
          </div>
        </div>
      )}
    </div>
  );
}

/** The screen's one heading, large and warm, with an optional lede. */
export function EverydayTitle({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="grid gap-4">
      <h1 className="m-0 font-heading text-3xl leading-tight font-semibold tracking-tight text-balance sm:text-4xl">
        {title}
      </h1>
      {children === undefined ? null : (
        <div className="grid gap-3 text-lg text-pretty">{children}</div>
      )}
    </div>
  );
}

/** A plain section of a screen: more air than the civic record, no numbering. */
export function Part({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("mt-10 grid gap-4", className)}>
      <h2 className="m-0 font-heading text-xl font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/**
 * One answer: the whole card is the target, and its state shows as a mark
 * and in words. `note` is a line the person should hear with it (where an
 * answer came from), read as its description, not its name.
 */
export function Choice({
  type,
  name,
  label,
  note,
  noteId,
  checked,
  onChange,
}: {
  type: "radio" | "checkbox";
  name: string;
  label: string;
  note?: string | undefined;
  noteId: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label
      className={cn(
        "flex min-h-16 cursor-pointer items-center gap-4 border-2 px-4 py-3 has-focus-visible:ring-3 has-focus-visible:ring-ring",
        checked ? "border-primary bg-card" : "border-border hover:border-muted-foreground",
      )}
    >
      <input
        type={type}
        name={name}
        checked={checked}
        onChange={onChange}
        aria-describedby={note === undefined ? undefined : noteId}
        className="sr-only"
      />
      <span
        aria-hidden="true"
        className={cn(
          "flex size-7 shrink-0 items-center justify-center border-2",
          type === "radio" ? "rounded-full" : "",
          checked
            ? "border-primary bg-primary text-primary-foreground"
            : "border-foreground bg-background",
        )}
      >
        {checked ? <Check className="size-4" strokeWidth={3} /> : null}
      </span>
      <span className="grid flex-1 gap-1">
        <span className="text-lg leading-snug font-medium">{label}</span>
        {note === undefined ? null : (
          <span id={noteId} aria-hidden="true" className="text-sm text-muted-foreground">
            {note}
          </span>
        )}
      </span>
      {checked ? (
        <span aria-hidden="true" className="shrink-0 text-sm font-semibold">
          Selected
        </span>
      ) : null}
    </label>
  );
}

/** A soft boxed message; its tone is in its icon and always in its title's words. */
export function Note({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "warn" | "done";
  title: string;
  children?: ReactNode;
}) {
  const Icon = tone === "warn" ? TriangleAlert : tone === "done" ? Check : Info;
  return (
    <div
      className={cn(
        "grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 border bg-card px-4 py-4",
        tone === "warn" ? "border-pending" : tone === "done" ? "border-recorded" : "border-border",
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "mt-0.5 size-5",
          tone === "warn" && "text-pending",
          tone === "done" && "text-recorded",
        )}
      />
      <p className="m-0 font-semibold">{title}</p>
      {children === undefined ? null : (
        <div className="col-start-2 grid gap-3 text-pretty">{children}</div>
      )}
    </div>
  );
}

/**
 * Evidence one step down: a disclosure that opens in place, with no motion.
 * `summary` is the whole of what shows until it is opened.
 */
export function OneTapAway({
  summary,
  children,
  className,
}: {
  summary: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details className={cn("group border border-border", className)}>
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 px-4 py-3 outline-none focus-visible:ring-3 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <span className="flex flex-1 items-center gap-3">{summary}</span>
        <ChevronDown aria-hidden="true" className="size-5 shrink-0 group-open:rotate-180" />
      </summary>
      <div className="grid gap-4 border-t border-border px-4 py-4">{children}</div>
    </details>
  );
}
