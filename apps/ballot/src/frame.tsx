import { cn, Fingerprint, groupHex, useTranslate } from "@abolishus/ui";
import { Check, Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

import { catalogs } from "./messages.ts";

// The ballot client's frame, in the two registers of [[language]]: the
// everyday register (the default; `mockups/everyday-frame.tsx`) and the
// civic record (`mockups/frame.tsx`), each with what is being answered and
// its seal, where the voter is, one task, and the actions at the bottom.
// Nothing in either moves (the Center for Civic Design's Keep rules, P2-20).

/** Classes for a bottom-bar action, so primary and secondary line up. */
export const ACTION = "w-full sm:w-auto sm:min-w-48";

/** The poll a frame names: its definition hash (64 lowercase hex digits) and how the frame shows it. */
export interface FramePoll {
  readonly definitionHash: string;
  /** Everyday: who asked. Civic: the election's short name. */
  readonly name: string;
  /** When voting closes, already formatted for the reader. */
  readonly closes: string;
}

/** The poll's class, from its definition (version 6's `poll_class`): 1 everyday, 2 organisational vote, 3 civic referendum. */
export type PollClass = 1 | 2 | 3;

/** A hash's first two groups of four hex digits, as a label reads it aloud. */
function shortHex(hash: string): string {
  return groupHex(hash).slice(0, 2).join(" ");
}

interface FrameProps {
  /** Absent when the client stopped before it could show a poll. */
  poll?: FramePoll | undefined;
  /** Where the voter is: question `current` of `total` (everyday) or step `current` of `total` (civic), from 1. */
  progress?: { readonly current: number; readonly total: number } | undefined;
  /** Under the civic record, the step's name beside its number. */
  stepName?: string | undefined;
  primary?: ReactNode;
  secondary?: ReactNode;
  children: ReactNode;
}

/**
 * The frame for a poll of `pollClass`: the everyday register for everyday
 * polls and wherever no poll is known yet, the civic record for
 * organisational votes and civic referendums ([[language]], Registers).
 */
export function Frame({ pollClass, ...props }: FrameProps & { pollClass?: PollClass | undefined }) {
  return pollClass === 2 || pollClass === 3 ? (
    <CivicFrame {...props} />
  ) : (
    <EverydayFrame {...props} />
  );
}

/**
 * The everyday register: who asked and when it closes beside the poll's
 * small seal, "Question n of m", one task, and the actions at the bottom.
 * Lighter than the civic frame (softer rules, no numbering) with the same
 * structure.
 */
export function EverydayFrame({ poll, progress, primary, secondary, children }: FrameProps) {
  const t = useTranslate(catalogs);
  return (
    <div className="flex min-h-dvh flex-col bg-background font-sans text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-xl items-center gap-3 px-4 py-3">
          {poll === undefined ? (
            <p className="m-0 font-heading text-lg font-semibold tracking-tight">{t("name")}</p>
          ) : (
            <>
              <Fingerprint
                value={poll.definitionHash}
                label={t("sealLabel", { hash: shortHex(poll.definitionHash) })}
                size={36}
              />
              {/* The whole name, never cut short: a look-alike poll could
                  hide what tells it apart past an ellipsis (T-53). */}
              <p className="m-0 min-w-0 flex-1 text-sm break-words">
                {t("askedBy", { name: poll.name })}
              </p>
              <p className="m-0 shrink-0 text-sm text-muted-foreground">
                {t("closes", { when: poll.closes })}
              </p>
            </>
          )}
        </div>
        {progress === undefined ? null : (
          <div className="mx-auto flex max-w-xl items-center gap-4 px-4 pb-3">
            <p className="m-0 shrink-0 text-sm font-semibold tabular-nums">
              {t("questionOf", { current: progress.current, total: progress.total })}
            </p>
            <Steps progress={progress} done="bg-foreground/60" height="h-1.5" gap="gap-1.5" />
          </div>
        )}
      </header>
      <Body>{children}</Body>
      <ActionBar primary={primary} secondary={secondary} rule="border-border" />
    </div>
  );
}

/**
 * The civic record: the election's short name and fingerprint with its hash
 * in words, "Step n of m" and the step's name, one task, and the actions at
 * the bottom, under heavier rules.
 */
export function CivicFrame({ poll, progress, stepName, primary, secondary, children }: FrameProps) {
  const t = useTranslate(catalogs);
  return (
    <div className="flex min-h-dvh flex-col bg-background font-sans text-foreground">
      <header className="border-b border-foreground">
        <div className="mx-auto flex max-w-xl items-center gap-3 px-4 py-3">
          {poll === undefined ? (
            <p className="m-0 font-heading text-lg font-semibold tracking-tight">{t("name")}</p>
          ) : (
            <>
              <Fingerprint
                value={poll.definitionHash}
                label={t("definitionLabel", { hash: shortHex(poll.definitionHash) })}
                size={36}
              />
              <div className="min-w-0 flex-1">
                <p className="m-0 font-heading text-base leading-tight font-semibold break-words">
                  {poll.name}
                </p>
                <p
                  translate="no"
                  className="m-0 font-mono text-xs tracking-wide whitespace-nowrap text-muted-foreground"
                >
                  {t("election", { hash: shortHex(poll.definitionHash) })}
                </p>
              </div>
              <p className="m-0 shrink-0 text-end text-sm text-muted-foreground">
                {t("closes", { when: poll.closes })}
              </p>
            </>
          )}
        </div>
        {progress === undefined ? null : (
          <div className="border-t border-border">
            <div className="mx-auto flex max-w-xl items-center gap-4 px-4 py-2">
              <p className="m-0 shrink-0 text-sm font-semibold tabular-nums">
                {stepName === undefined
                  ? t("stepOf", { current: progress.current, total: progress.total })
                  : t("stepNamed", {
                      step: t("stepOf", { current: progress.current, total: progress.total }),
                      name: stepName,
                    })}
              </p>
              <Steps progress={progress} done="bg-foreground" height="h-1" gap="gap-1" />
            </div>
          </div>
        )}
      </header>
      <Body>{children}</Body>
      <ActionBar primary={primary} secondary={secondary} rule="border-foreground" />
    </div>
  );
}

// The progress bar repeats the words beside it, so it is hidden from
// assistive technology.
function Steps({
  progress,
  done,
  height,
  gap,
}: {
  progress: { readonly current: number; readonly total: number };
  done: string;
  height: string;
  gap: string;
}) {
  return (
    <ol aria-hidden="true" className={cn("m-0 flex flex-1 list-none p-0", gap)}>
      {Array.from({ length: progress.total }, (_, i) => (
        <li
          key={i}
          className={cn(
            "flex-1",
            height,
            i + 1 < progress.current && done,
            i + 1 === progress.current && "bg-primary",
            i + 1 > progress.current && "bg-border",
          )}
        />
      ))}
    </ol>
  );
}

function Body({ children }: { children: ReactNode }) {
  return <main className="mx-auto w-full max-w-xl flex-1 px-4 pt-8 pb-12">{children}</main>;
}

function ActionBar({
  primary,
  secondary,
  rule,
}: {
  primary: ReactNode;
  secondary: ReactNode;
  rule: string;
}) {
  if (primary === undefined && secondary === undefined) return null;
  return (
    <div className={cn("sticky bottom-0 border-t bg-background", rule)}>
      <div className="mx-auto flex max-w-xl flex-col gap-3 px-4 py-4 sm:flex-row-reverse sm:justify-between">
        {primary}
        {secondary}
      </div>
    </div>
  );
}

/** The screen's one heading, with a lede below it. */
export function ScreenTitle({ title, children }: { title: string; children?: ReactNode }) {
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

/** A plain section of a screen, with its own heading. */
export function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-10 grid gap-4">
      <h2 className="m-0 font-heading text-xl font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/** A boxed message; its tone is in its icon and always in its title's words. */
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
