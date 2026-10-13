import { Button, cn } from "@abolishus/ui";
import { Label } from "@abolishus/ui/ui/label";
import { RadioGroupItem } from "@abolishus/ui/ui/radio-group";
import { ArrowLeft, ArrowRight, Check, Lock, Radio } from "lucide-react";
import { type FormEvent, type ReactNode, type RefObject, type SyntheticEvent } from "react";

import {
  ASKED_BY,
  AUDIENCES,
  type Draft,
  type Errors,
  parseUtc,
  ruleText,
  scheduleText,
  STEPS,
} from "./everyday-create-data.ts";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const pad = (n: number) => String(n).padStart(2, "0");

export function formatUtc(date: Date, withYear = true): string {
  const day = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
  return withYear ? `${day} ${date.getUTCFullYear()}, ${time}` : `${day}, ${time}`;
}

/** The same instant on the author's own clock, or undefined when their clock is UTC. */
export function formatLocal(date: Date, timeZone: string): string | undefined {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "shortOffset",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const offset = get("timeZoneName");
  if (offset === "GMT" || offset === "UTC") return undefined;
  const place = timeZone.split("/").pop()?.replaceAll("_", " ") ?? timeZone;
  return `${get("weekday")} ${get("day")} ${get("month")}, ${get("hour")}:${get("minute")} your time (${place})`;
}

export const fieldInput = "h-12 px-3 text-base md:text-base";

export function errorFor(errors: Errors, id: string): string | undefined {
  return errors.find(([field]) => field === id)?.[1];
}

export function describedBy(errors: Errors, id: string, help = false): string | undefined {
  const ids = [help ? `${id}-help` : "", errorFor(errors, id) === undefined ? "" : `${id}-error`];
  return ids.filter(Boolean).join(" ") || undefined;
}

export function invalid(errors: Errors, id: string): true | undefined {
  return errorFor(errors, id) === undefined ? undefined : true;
}

export function ErrorText({ errors, id }: { errors: Errors; id: string }) {
  const message = errorFor(errors, id);
  if (message === undefined) return null;
  return (
    <p id={`${id}-error`} className="m-0 text-sm font-medium text-destructive">
      <span className="sr-only">Error: </span>
      {message}
    </p>
  );
}

export function Help({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="m-0 text-sm text-pretty text-muted-foreground">
      {children}
    </p>
  );
}

/** A large, friendly radio: a card holding the choice's name and what it means. */
export function ChoiceCard({
  value,
  selected,
  title,
  icon,
  children,
}: {
  value: string;
  selected: boolean;
  title: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Label
      className={cn(
        "flex min-h-12 w-full items-start gap-4 rounded-xl border p-5 text-base leading-normal font-normal",
        selected ? "border-2 border-primary p-[19px]" : "border-border",
      )}
    >
      <RadioGroupItem value={value} className="mt-1.5" />
      <span className="grid gap-1">
        <span className="flex items-center gap-2 text-lg font-semibold">
          {icon}
          {title}
        </span>
        <span className="text-pretty text-muted-foreground">{children}</span>
      </span>
    </Label>
  );
}

function Progress({ index, onJump }: { index: number; onJump: (i: number) => void }) {
  return (
    <div className="grid gap-3">
      <p className="m-0 text-sm text-muted-foreground">
        Step {index + 1} of {STEPS.length}
      </p>
      <ol aria-label="Steps" className="m-0 grid list-none grid-cols-6 gap-1.5 p-0">
        {STEPS.map((s, i) => {
          const done = i < index;
          const here = i === index;
          return (
            <li key={s.key} aria-current={here ? "step" : undefined} className="grid gap-1">
              <span
                aria-hidden="true"
                className={cn(
                  "block h-1.5 rounded-full",
                  here ? "bg-primary" : done ? "bg-foreground" : "bg-border",
                )}
              />
              {done ? (
                <button
                  type="button"
                  onClick={() => onJump(i)}
                  className="hidden min-h-12 items-start pt-1 text-start text-sm underline decoration-border underline-offset-4 hover:decoration-foreground md:flex"
                >
                  {s.label}
                  <span className="sr-only">, done. Go back to this step</span>
                </button>
              ) : (
                <span
                  className={cn(
                    "hidden min-h-12 pt-1 text-sm md:block",
                    here ? "font-semibold" : "text-muted-foreground",
                  )}
                >
                  {s.label}
                  {here ? <span className="sr-only">, current step</span> : null}
                </span>
              )}
              <span className="sr-only md:hidden">
                {s.label}
                {here ? ", current step" : done ? ", done" : ""}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function ErrorSummary({
  errors,
  summaryRef,
}: {
  errors: Errors;
  summaryRef: RefObject<HTMLDivElement | null>;
}) {
  const jump = (event: SyntheticEvent, id: string) => {
    const target = document.getElementById(id);
    if (target === null) return;
    event.preventDefault();
    target.focus();
    target.scrollIntoView({ block: "center" });
  };
  return (
    <div
      ref={summaryRef}
      tabIndex={-1}
      role="alert"
      aria-labelledby="error-summary-title"
      className="grid gap-2 rounded-xl border-2 border-destructive p-5 outline-none focus-visible:ring-3 focus-visible:ring-ring"
    >
      <h2 id="error-summary-title" className="m-0 text-lg font-semibold">
        There is a problem
      </h2>
      <ul className="m-0 grid list-none gap-0 p-0">
        {errors.map(([field, message]) => (
          <li key={`${field}-${message}`}>
            <a
              href={`#${field}`}
              onClick={(e) => jump(e, field)}
              className="inline-flex min-h-12 items-center text-destructive underline underline-offset-4"
            >
              {message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One screen of the flow: progress, the task, the way on, and the poll as people will see it. */
export function StepFrame({
  index,
  title,
  lede,
  errors,
  summaryRef,
  onJump,
  onBack,
  onSubmit,
  submitLabel = "Continue",
  preview,
  children,
}: {
  index: number;
  title: string;
  lede: ReactNode;
  errors: Errors;
  summaryRef: RefObject<HTMLDivElement | null>;
  onJump: (i: number) => void;
  onBack?: () => void;
  onSubmit: (event: FormEvent) => void;
  submitLabel?: string;
  preview: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto grid max-w-6xl gap-10 px-4 pt-8 md:pt-12">
      <Progress index={index} onJump={onJump} />
      <div className="grid gap-14 lg:grid-cols-12 lg:gap-x-12">
        <form
          noValidate
          onSubmit={onSubmit}
          className="grid min-w-0 content-start gap-10 lg:col-span-7"
        >
          <div className="grid gap-4">
            <h1 className="m-0 font-heading text-4xl leading-[1.1] font-semibold tracking-tight text-balance sm:text-5xl">
              {title}
            </h1>
            <div className="m-0 max-w-prose text-lg text-pretty">{lede}</div>
          </div>
          {errors.length > 0 ? <ErrorSummary errors={errors} summaryRef={summaryRef} /> : null}
          <div className="grid gap-10">{children}</div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-6">
            {onBack === undefined ? (
              <span />
            ) : (
              <Button variant="outline" onClick={onBack}>
                <ArrowLeft aria-hidden="true" data-icon="inline-start" />
                Back
              </Button>
            )}
            <Button type="submit" size="lg">
              {submitLabel}
              {submitLabel === "Continue" ? (
                <ArrowRight aria-hidden="true" data-icon="inline-end" />
              ) : null}
            </Button>
          </div>
        </form>
        <aside aria-labelledby="preview-title" className="min-w-0 lg:col-span-5">
          <div className="lg:sticky lg:top-6">{preview}</div>
        </aside>
      </div>
    </div>
  );
}

/** The poll as answerers will see it, redrawn from the draft as the author edits. */
export function PollPreview({ draft }: { draft: Draft }) {
  const closes = parseUtc(draft.closes);
  const audience = AUDIENCES.find((a) => a.key === draft.audience);
  const questions = draft.questions;
  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h2 id="preview-title" className="m-0 text-base font-semibold">
          Preview
        </h2>
        <p className="m-0 text-sm text-muted-foreground">
          How people will see your poll. It changes as you edit.
        </p>
      </div>
      <div className="grid gap-6 rounded-xl border border-border bg-card p-5 text-card-foreground sm:p-6">
        <div className="grid gap-3">
          <p className="m-0 text-sm text-muted-foreground">
            {ASKED_BY} asked
            {closes === undefined ? "" : ` · closes ${formatUtc(closes, false)}`}
          </p>
          <p
            data-testid="preview-title"
            className="m-0 font-heading text-2xl leading-tight font-semibold text-balance sm:text-3xl"
          >
            {draft.title.trim() === "" ? "Your poll’s title" : draft.title}
          </p>
          {draft.place.trim() === "" && draft.topic.trim() === "" ? null : (
            <ul aria-label="Place and topic" className="m-0 flex list-none flex-wrap gap-2 p-0">
              {[draft.place, draft.topic]
                .filter((t) => t.trim() !== "")
                .map((t) => (
                  <li key={t} className="rounded-full border border-border px-3 py-1 text-sm">
                    {t}
                  </li>
                ))}
            </ul>
          )}
        </div>
        <ol className="m-0 grid list-none gap-6 p-0">
          {questions.map((q, i) => {
            const square = q.rule !== "one";
            return (
              <li
                key={q.id}
                data-testid={`preview-q-${i + 1}`}
                className="grid gap-3 border-t border-border pt-5"
              >
                <div className="grid gap-1">
                  <p className="m-0 text-sm text-muted-foreground">
                    {questions.length > 1 ? `Question ${i + 1} of ${questions.length} · ` : ""}
                    {ruleText(q)}
                  </p>
                  <p className="m-0 text-lg leading-snug font-semibold text-pretty">
                    {q.text.trim() === "" ? "Your question" : q.text}
                  </p>
                  {q.hint.trim() === "" ? null : (
                    <p className="m-0 text-sm text-muted-foreground">{q.hint}</p>
                  )}
                </div>
                <ul className="m-0 grid list-none gap-2 p-0">
                  {q.options.map((o, j) => (
                    <li
                      key={o.id}
                      className="flex min-h-12 items-center gap-3 rounded-lg border border-border px-4 py-2"
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          "size-5 shrink-0 border-2 border-muted-foreground",
                          square ? "rounded-sm" : "rounded-full",
                        )}
                      />
                      <span className="text-pretty">
                        {o.label.trim() === "" ? `Option ${j + 1}` : o.label}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ol>
        <ul className="m-0 grid list-none gap-2 border-t border-border p-0 pt-5 text-sm">
          <li className="flex items-start gap-2">
            <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span data-testid="preview-audience">
              Open to {audience?.name.toLowerCase() ?? "anyone with an account"}
            </span>
          </li>
          <li className="flex items-start gap-2">
            {draft.results === "live" ? (
              <Radio aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            ) : (
              <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            )}
            <span data-testid="preview-results">
              {draft.results === "live"
                ? `Results so far, updated ${scheduleText(draft)}`
                : "Results appear when the poll closes"}
            </span>
          </li>
        </ul>
      </div>
    </div>
  );
}
