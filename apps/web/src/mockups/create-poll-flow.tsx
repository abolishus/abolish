import { Button, Fingerprint, Hash, cn } from "@abolishus/ui";
import { Input } from "@abolishus/ui/ui/input";
import { Label } from "@abolishus/ui/ui/label";
import { RadioGroup, RadioGroupItem } from "@abolishus/ui/ui/radio-group";
import { Textarea } from "@abolishus/ui/ui/textarea";
import { ArrowLeft, ArrowRight, Check, Plus, X } from "lucide-react";
import { type FormEvent, type ReactNode, type RefObject, useEffect, useRef, useState } from "react";

import {
  DRAFT_DEFINITION_HASH,
  DRAFT_TEXT_HASH,
  type DateParts,
  type Draft,
  ELIGIBILITY,
  MAX_OPTIONS,
  MAX_QUESTION,
  METHODS,
  STEPS,
  type StepKey,
} from "./create-poll-data.ts";
import { TIERS } from "./fixtures.ts";
import { MockShell } from "./shell.tsx";

type Errors = Partial<Record<string, string>>;

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

function toUtc(p: DateParts): Date | undefined {
  const day = Number(p.day);
  const month = Number(p.month);
  const year = Number(p.year);
  const match = /^(\d{1,2}):(\d{2})$/.exec(p.time);
  if (!Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year) || !match) {
    return undefined;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hours > 23 || minutes > 59) {
    return undefined;
  }
  const date = new Date(Date.UTC(year, month - 1, day, hours, minutes));
  return date.getUTCDate() === day ? date : undefined;
}

function formatUtc(date: Date): string {
  const time = `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${time} UTC`;
}

function validate(step: StepKey, d: Draft): Errors {
  const e: Errors = {};
  if (step === "question") {
    if (d.question.trim() === "") e["question"] = "Enter the question voters will answer.";
    else if (d.question.length > MAX_QUESTION)
      e["question"] = `The question must be ${MAX_QUESTION} characters or fewer.`;
  }
  if (step === "options") {
    const filled = d.options.map((o) => o.trim());
    if (filled.filter((o) => o !== "").length < 2) {
      const blank = filled.findIndex((o) => o === "");
      e[`option-${blank < 0 ? 0 : blank}`] = "Enter at least two options.";
    }
    filled.forEach((o, i) => {
      const first = filled.indexOf(o);
      if (o !== "" && first < i)
        e[`option-${i}`] = `Option ${i + 1} is the same as option ${first + 1}.`;
    });
  }
  if (step === "method" && d.method === "") e["method"] = "Choose how the votes are counted.";
  if (step === "eligibility" && d.eligibility === "") e["eligibility"] = "Choose who can vote.";
  if (step === "schedule") {
    const opens = toUtc(d.opens);
    const closes = toUtc(d.closes);
    if (opens === undefined) e["opens"] = "Enter a real opening date and a time like 09:00.";
    if (closes === undefined) e["closes"] = "Enter a real closing date and a time like 18:00.";
    if (opens !== undefined && closes !== undefined && closes <= opens)
      e["closes"] = "The closing time must be after the opening time.";
  }
  return e;
}

const ASIDE: Record<StepKey, { title: string; body: string }> = {
  question: {
    title: "Display text",
    body: "The question and description are committed to by a hash in the poll's definition and pinned to IPFS. Moderation can withhold display text; nobody can change it once published.",
  },
  options: {
    title: "Fixed at publishing",
    body: "Voters see the options in this order. Option text can’t be edited after publishing, so a typo stays on the record.",
  },
  method: {
    title: "Recounted by anyone",
    body: "The counting method is part of the definition. The public verifier recounts every poll with the same rule, without our servers.",
  },
  eligibility: {
    title: "Never blended",
    body: "Results are reported for each tier on its own, with its count of voters. They are never added into one headline number.",
  },
  schedule: {
    title: "The board’s clock",
    body: "Times are in UTC. Once published, neither you nor we can move the opening or closing time, extend a poll, or close it early.",
  },
  review: {
    title: "What publishing does",
    body: "The definition hash is recorded on the L2. From then on, the record of this poll is permanent and anyone can verify it.",
  },
};

const fieldInput = "h-12 px-3 text-base md:text-base";

function ErrorText({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="m-0 flex items-start gap-2 text-sm font-medium text-destructive">
      <span className="sr-only">Error: </span>
      {children}
    </p>
  );
}

function Help({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="m-0 text-sm text-pretty text-muted-foreground">
      {children}
    </p>
  );
}

function StepIndicator({ current, onJump }: { current: number; onJump: (index: number) => void }) {
  const label = STEPS[current]?.label ?? "";
  return (
    <div className="grid gap-4">
      <p className="m-0 font-mono text-xs tracking-widest text-muted-foreground uppercase lg:hidden">
        Step {current + 1} of {STEPS.length} · {label}
      </p>
      <ol
        aria-label="Steps"
        className="m-0 grid list-none grid-cols-6 gap-1 p-0 lg:grid-cols-1 lg:gap-0"
      >
        {STEPS.map((s, i) => {
          const done = i < current;
          const here = i === current;
          return (
            <li
              key={s.key}
              aria-current={here ? "step" : undefined}
              className="lg:border-b lg:border-border lg:first:border-t lg:first:border-t-foreground"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "block h-1 lg:hidden",
                  here ? "bg-primary" : done ? "bg-foreground" : "bg-muted",
                )}
              />
              <div className="hidden min-h-12 items-center gap-3 lg:flex">
                <span
                  className={cn(
                    "flex size-7 shrink-0 items-center justify-center border font-mono text-xs",
                    here
                      ? "border-primary bg-primary text-primary-foreground"
                      : done
                        ? "border-foreground bg-foreground text-background"
                        : "border-border",
                  )}
                >
                  {done ? <Check className="size-3.5" aria-hidden="true" /> : i + 1}
                </span>
                {done ? (
                  <button
                    type="button"
                    onClick={() => onJump(i)}
                    className="min-h-12 text-start text-sm underline decoration-border underline-offset-4 hover:decoration-foreground"
                  >
                    {s.label}
                    <span className="sr-only">, done. Go back to this step</span>
                  </button>
                ) : (
                  <span className={cn("text-sm", here && "font-semibold")}>
                    {s.label}
                    {here ? <span className="sr-only">, current step</span> : null}
                  </span>
                )}
              </div>
              <span className="sr-only lg:hidden">
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

/** One screen of the flow: indicator, title, the task, and the way on. */
export function StepLayout({
  index,
  title,
  lede,
  errors,
  summaryRef,
  onJump,
  onBack,
  onSubmit,
  submitLabel,
  children,
}: {
  index: number;
  title: string;
  lede: ReactNode;
  errors: Errors;
  summaryRef: RefObject<HTMLDivElement | null>;
  onJump: (index: number) => void;
  onBack?: () => void;
  onSubmit: (event: FormEvent) => void;
  submitLabel: string;
  children: ReactNode;
}) {
  const step = STEPS[index];
  const aside = step === undefined ? undefined : ASIDE[step.key];
  const errorList = Object.entries(errors).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  return (
    <div className="mx-auto grid max-w-6xl gap-10 px-4 pt-10 md:pt-16 lg:grid-cols-12 lg:gap-x-8">
      <div className="lg:col-span-3 lg:pt-2">
        <div className="lg:sticky lg:top-6">
          <StepIndicator current={index} onJump={onJump} />
        </div>
      </div>
      <form noValidate onSubmit={onSubmit} className="grid content-start gap-10 lg:col-span-6">
        <div className="grid gap-4">
          <p className="m-0 hidden font-mono text-xs tracking-widest text-muted-foreground uppercase lg:block">
            Create a poll · Step {index + 1} of {STEPS.length}
          </p>
          <h1 className="m-0 font-heading text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-5xl">
            {title}
          </h1>
          <div className="m-0 max-w-prose text-lg text-pretty">{lede}</div>
        </div>
        {errorList.length > 0 ? (
          <div
            ref={summaryRef}
            tabIndex={-1}
            role="alert"
            aria-labelledby="error-summary-title"
            className="grid gap-3 border-2 border-destructive p-5 outline-none focus-visible:ring-3 focus-visible:ring-ring"
          >
            <h2 id="error-summary-title" className="m-0 text-lg font-semibold">
              There is a problem
            </h2>
            <ul className="m-0 grid list-none gap-1 p-0">
              {errorList.map(([field, message]) => (
                <li key={field}>
                  <a
                    href={`#${field}`}
                    className="inline-flex min-h-12 items-center text-destructive underline underline-offset-4"
                  >
                    {message}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="grid gap-8">{children}</div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t-2 border-foreground pt-6">
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
      {aside === undefined ? null : (
        <aside aria-labelledby="aside-title" className="lg:col-span-3 lg:pt-2">
          <div className="grid gap-2 border-t border-foreground pt-4 lg:sticky lg:top-6">
            <h2
              id="aside-title"
              className="m-0 font-mono text-xs tracking-widest text-muted-foreground uppercase"
            >
              {aside.title}
            </h2>
            <p className="m-0 text-sm text-pretty">{aside.body}</p>
          </div>
        </aside>
      )}
    </div>
  );
}

function DateField({
  id,
  legend,
  value,
  error,
  onChange,
}: {
  id: string;
  legend: string;
  value: DateParts;
  error: string | undefined;
  onChange: (value: DateParts) => void;
}) {
  const parts = [
    { key: "day", label: "Day", width: "w-20", mode: "numeric" },
    { key: "month", label: "Month", width: "w-20", mode: "numeric" },
    { key: "year", label: "Year", width: "w-28", mode: "numeric" },
    { key: "time", label: "Time (UTC)", width: "w-28", mode: "text" },
  ] as const;
  return (
    <fieldset
      id={id}
      aria-describedby={`${id}-help${error === undefined ? "" : ` ${id}-error`}`}
      className="m-0 grid gap-3 border-0 p-0"
    >
      <legend className="mb-1 p-0 text-lg font-semibold">{legend}</legend>
      <Help id={`${id}-help`}>For example, 15 11 2026 and 18:00. Use the 24-hour clock.</Help>
      {error === undefined ? null : <ErrorText id={`${id}-error`}>{error}</ErrorText>}
      <div className="flex flex-wrap gap-3">
        {parts.map((p) => (
          <div key={p.key} className="grid gap-1.5">
            <Label htmlFor={`${id}-${p.key}`} className="text-sm">
              {p.label}
            </Label>
            <Input
              id={`${id}-${p.key}`}
              inputMode={p.mode}
              autoComplete="off"
              aria-invalid={error === undefined ? undefined : true}
              className={cn(fieldInput, "font-mono tabular-nums", p.width)}
              value={value[p.key]}
              onChange={(e) => onChange({ ...value, [p.key]: e.target.value })}
            />
          </div>
        ))}
      </div>
    </fieldset>
  );
}

/** A tiny ballot that shows what the chosen method asks of a voter. */
function MethodExample({ method, options }: { method: string; options: readonly string[] }) {
  const shown = options.filter((o) => o.trim() !== "").slice(0, 3);
  const marks = method === "approval" ? [true, false, true] : [true, false, false];
  return (
    <figure className="m-0 grid gap-3 border border-border p-5" aria-labelledby="method-example">
      <figcaption
        id="method-example"
        className="font-mono text-xs tracking-wide text-muted-foreground uppercase"
      >
        {method === "approval"
          ? "Example: a voter approves two options"
          : "Example: a voter chooses one option"}
      </figcaption>
      <ul className="m-0 grid list-none gap-2 p-0">
        {shown.map((o, i) => (
          <li key={o} className="flex items-center gap-3 text-sm">
            <span
              aria-hidden="true"
              className={cn(
                "flex size-5 shrink-0 items-center justify-center border border-foreground",
                method === "approval" ? "" : "rounded-full",
                marks[i] && "bg-foreground text-background",
              )}
            >
              {marks[i] ? <Check className="size-3.5" /> : null}
            </span>
            <span>
              {o}
              <span className="sr-only">{marks[i] ? ", marked" : ", not marked"}</span>
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

export function CreatePollFlow({
  initialStep = "question",
  initialDraft,
  onPublish,
}: {
  initialStep?: StepKey;
  initialDraft: Draft;
  onPublish?: () => void;
}) {
  const [index, setIndex] = useState(STEPS.findIndex((s) => s.key === initialStep));
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [errors, setErrors] = useState<Errors>({});
  const [attempt, setAttempt] = useState(0);
  const [published, setPublished] = useState(false);
  const summaryRef = useRef<HTMLDivElement>(null);
  const step = STEPS[index]?.key ?? "question";

  useEffect(() => {
    if (attempt > 0) summaryRef.current?.focus();
  }, [attempt]);

  const go = (next: number) => {
    setErrors({});
    setIndex(next);
    window.scrollTo({ top: 0 });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (step === "review") {
      setPublished(true);
      onPublish?.();
      return;
    }
    const found = validate(step, draft);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      setAttempt((a) => a + 1);
      return;
    }
    go(index + 1);
  };

  const describedBy = (id: string, help?: boolean) =>
    [help ? `${id}-help` : "", errors[id] === undefined ? "" : `${id}-error`]
      .filter(Boolean)
      .join(" ") || undefined;

  const opens = toUtc(draft.opens);
  const closes = toUtc(draft.closes);
  const method = METHODS.find((m) => m.key === draft.method);
  const eligibility = ELIGIBILITY.find((e) => e.key === draft.eligibility);

  const common = {
    index,
    errors,
    summaryRef,
    onJump: go,
    onSubmit: submit,
    ...(index > 0 ? { onBack: () => go(index - 1) } : {}),
  };

  let screen: ReactNode;
  switch (step) {
    case "question":
      screen = (
        <StepLayout
          {...common}
          title="What are you asking?"
          lede="Write the question as voters will read it. Ask one thing, in plain words, so that people who disagree would still call it fair."
          submitLabel="Continue"
        >
          <div className="grid gap-2">
            <Label htmlFor="question" className="text-lg font-semibold">
              Question
            </Label>
            <Help id="question-help">
              Up to {MAX_QUESTION} characters. {MAX_QUESTION - draft.question.length} left.
            </Help>
            {errors["question"] === undefined ? null : (
              <ErrorText id="question-error">{errors["question"]}</ErrorText>
            )}
            <Textarea
              id="question"
              rows={2}
              aria-describedby={describedBy("question", true)}
              aria-invalid={errors["question"] === undefined ? undefined : true}
              className="min-h-24 p-3 text-lg md:text-lg"
              value={draft.question}
              onChange={(e) => setDraft({ ...draft, question: e.target.value })}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="description" className="text-lg font-semibold">
              Description <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Help id="description-help">
              Context voters need to answer: who is asking, why, and what happens with the result.
              Don’t include anyone’s personal details.
            </Help>
            <Textarea
              id="description"
              rows={5}
              aria-describedby="description-help"
              className="min-h-36 p-3 text-base md:text-base"
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </div>
        </StepLayout>
      );
      break;
    case "options":
      screen = (
        <StepLayout
          {...common}
          title="What can voters choose?"
          lede="Give between two and ten options. Make them distinct, so that each voter can find the one they mean."
          submitLabel="Continue"
        >
          <ol className="m-0 grid list-none gap-6 p-0">
            {draft.options.map((option, i) => {
              const id = `option-${i}`;
              return (
                <li key={i} className="grid gap-2">
                  <Label htmlFor={id} className="text-base font-semibold">
                    Option {i + 1}
                  </Label>
                  {errors[id] === undefined ? null : (
                    <ErrorText id={`${id}-error`}>{errors[id]}</ErrorText>
                  )}
                  <div className="flex gap-2">
                    <Input
                      id={id}
                      aria-describedby={describedBy(id)}
                      aria-invalid={errors[id] === undefined ? undefined : true}
                      className={fieldInput}
                      value={option}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          options: draft.options.map((o, j) => (j === i ? e.target.value : o)),
                        })
                      }
                    />
                    {draft.options.length > 2 ? (
                      <Button
                        variant="outline"
                        size="icon"
                        aria-label={`Remove option ${i + 1}`}
                        onClick={() =>
                          setDraft({ ...draft, options: draft.options.filter((_, j) => j !== i) })
                        }
                      >
                        <X aria-hidden="true" />
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
          <div className="flex flex-wrap items-center gap-4">
            <Button
              variant="outline"
              disabled={draft.options.length >= MAX_OPTIONS}
              onClick={() => setDraft({ ...draft, options: [...draft.options, ""] })}
            >
              <Plus aria-hidden="true" data-icon="inline-start" />
              Add an option
            </Button>
            <p className="m-0 font-mono text-xs tracking-wide text-muted-foreground">
              {draft.options.length} of {MAX_OPTIONS}
            </p>
          </div>
        </StepLayout>
      );
      break;
    case "method":
      screen = (
        <StepLayout
          {...common}
          title="How are votes counted?"
          lede="Pick the rule the count follows. The verifier recounts with the same rule, so anyone can check the result."
          submitLabel="Continue"
        >
          <fieldset
            id="method"
            aria-describedby={describedBy("method")}
            className="m-0 grid gap-3 border-0 p-0"
          >
            <legend className="mb-3 p-0 text-lg font-semibold">Counting method</legend>
            {errors["method"] === undefined ? null : (
              <ErrorText id="method-error">{errors["method"]}</ErrorText>
            )}
            <RadioGroup
              value={draft.method}
              onValueChange={(value) => setDraft({ ...draft, method: value as Draft["method"] })}
              className="gap-3"
            >
              {METHODS.map((m) => (
                <Label
                  key={m.key}
                  className={cn(
                    "flex min-h-12 w-full items-start gap-4 border p-5 text-base font-normal",
                    draft.method === m.key ? "border-primary border-l-4" : "border-border",
                    m.later && "border-dashed",
                  )}
                >
                  <RadioGroupItem value={m.key} disabled={m.later ?? false} className="mt-1" />
                  <span className="grid gap-1">
                    <span className="flex flex-wrap items-baseline gap-x-3 font-semibold">
                      {m.name}
                      {m.later ? (
                        <span className="font-mono text-xs font-normal tracking-widest uppercase">
                          Coming later
                        </span>
                      ) : null}
                    </span>
                    <span>{m.summary}</span>
                    <span className="text-sm text-muted-foreground">{m.detail}</span>
                  </span>
                </Label>
              ))}
            </RadioGroup>
          </fieldset>
          {draft.method === "" ? null : (
            <MethodExample method={draft.method} options={draft.options} />
          )}
        </StepLayout>
      );
      break;
    case "eligibility":
      screen = (
        <StepLayout
          {...common}
          title="Who can vote?"
          lede="Choose the lowest tier that may take part. Whatever you choose, results are reported per tier, never added together."
          submitLabel="Continue"
        >
          <fieldset
            id="eligibility"
            aria-describedby={describedBy("eligibility")}
            className="m-0 grid gap-3 border-0 p-0"
          >
            <legend className="mb-3 p-0 text-lg font-semibold">Eligible voters</legend>
            {errors["eligibility"] === undefined ? null : (
              <ErrorText id="eligibility-error">{errors["eligibility"]}</ErrorText>
            )}
            <RadioGroup
              value={draft.eligibility}
              onValueChange={(value) =>
                setDraft({ ...draft, eligibility: value as Draft["eligibility"] })
              }
              className="gap-3"
            >
              {ELIGIBILITY.map((e) => (
                <Label
                  key={e.key}
                  className={cn(
                    "flex min-h-12 w-full items-start gap-4 border p-5 text-base font-normal",
                    draft.eligibility === e.key ? "border-primary border-l-4" : "border-border",
                  )}
                >
                  <RadioGroupItem value={e.key} className="mt-1" />
                  <span className="grid gap-1">
                    <span className="font-semibold">{e.name}</span>
                    <span className="text-sm text-muted-foreground">{e.summary}</span>
                  </span>
                </Label>
              ))}
            </RadioGroup>
          </fieldset>
          <figure className="m-0 grid gap-3" aria-labelledby="tier-preview-caption">
            <figcaption
              id="tier-preview-caption"
              className="font-mono text-xs tracking-wide text-muted-foreground uppercase"
            >
              How the results page will report this poll
            </figcaption>
            <ul className="m-0 grid list-none border-t-2 border-foreground p-0 sm:grid-cols-3">
              {TIERS.map((t) => {
                const included = eligibility?.tiers.includes(t.key) ?? false;
                return (
                  <li
                    key={t.key}
                    data-included={included}
                    className={cn(
                      "grid content-start gap-1 border-b border-border py-4 sm:border-e sm:border-b-0 sm:px-4 sm:first:ps-0 sm:last:border-e-0",
                    )}
                  >
                    <span className="font-mono text-xs tracking-wide uppercase">{t.short}</span>
                    <span className="font-semibold">{t.name}</span>
                    <span
                      className={cn(
                        "text-sm",
                        included ? "text-foreground" : "text-muted-foreground line-through",
                      )}
                    >
                      {included ? "Reported on its own" : "Not eligible"}
                    </span>
                  </li>
                );
              })}
            </ul>
          </figure>
        </StepLayout>
      );
      break;
    case "schedule": {
      const hours =
        opens !== undefined && closes !== undefined && closes > opens
          ? Math.round((closes.getTime() - opens.getTime()) / 3_600_000)
          : undefined;
      const days = hours === undefined ? 0 : Math.floor(hours / 24);
      screen = (
        <StepLayout
          {...common}
          title="When is voting open?"
          lede="Set when the poll opens and closes, in Coordinated Universal Time (UTC), the clock the board keeps."
          submitLabel="Continue"
        >
          <DateField
            id="opens"
            legend="Voting opens"
            value={draft.opens}
            error={errors["opens"]}
            onChange={(opens) => setDraft({ ...draft, opens })}
          />
          <DateField
            id="closes"
            legend="Voting closes"
            value={draft.closes}
            error={errors["closes"]}
            onChange={(closes) => setDraft({ ...draft, closes })}
          />
          <figure className="m-0 grid gap-3 border-t-2 border-foreground pt-4">
            <figcaption className="font-mono text-xs tracking-wide text-muted-foreground uppercase">
              Voting window
            </figcaption>
            {hours === undefined ? (
              <p className="m-0 text-base">Enter both times to see how long voting is open.</p>
            ) : (
              <>
                <p
                  data-testid="window"
                  className="m-0 font-heading text-3xl font-semibold tabular-nums"
                >
                  {days} {days === 1 ? "day" : "days"}
                  {hours % 24 === 0 ? "" : `, ${hours % 24} ${hours % 24 === 1 ? "hour" : "hours"}`}
                </p>
                <div aria-hidden="true" className="flex gap-0.5">
                  {Array.from({ length: Math.min(days, 60) || 1 }, (_, i) => (
                    <span
                      key={i}
                      className="h-6 min-w-0 flex-1 bg-foreground/80 first:bg-primary"
                    />
                  ))}
                </div>
                <p className="m-0 font-mono text-xs tracking-wide">
                  {opens === undefined ? "" : formatUtc(opens)} to{" "}
                  {closes === undefined ? "" : formatUtc(closes)}
                </p>
              </>
            )}
          </figure>
        </StepLayout>
      );
      break;
    }
    case "review": {
      const rows: { label: string; value: ReactNode; step: number }[] = [
        { label: "Question", value: draft.question, step: 0 },
        {
          label: "Description",
          value: draft.description === "" ? "None" : draft.description,
          step: 0,
        },
        {
          label: "Options",
          value: (
            <ol className="m-0 grid gap-1 ps-5">
              {draft.options
                .filter((o) => o.trim() !== "")
                .map((o) => (
                  <li key={o}>{o}</li>
                ))}
            </ol>
          ),
          step: 1,
        },
        { label: "Method", value: method?.name ?? "Not chosen", step: 2 },
        { label: "Who can vote", value: eligibility?.name ?? "Not chosen", step: 3 },
        {
          label: "Opens",
          value: opens === undefined ? "Not set" : formatUtc(opens),
          step: 4,
        },
        {
          label: "Closes",
          value: closes === undefined ? "Not set" : formatUtc(closes),
          step: 4,
        },
      ];
      screen = (
        <StepLayout
          {...common}
          title="Check your poll before publishing"
          lede="Publishing makes this poll permanent. Read it through once more as a voter would."
          submitLabel="Publish poll"
        >
          <section aria-labelledby="summary-title" className="grid gap-3">
            <h2 id="summary-title" className="m-0 text-xl font-semibold">
              Your poll
            </h2>
            <dl className="m-0 grid border-t-2 border-foreground">
              {rows.map((r) => (
                <div
                  key={r.label}
                  className="grid gap-x-6 gap-y-1 border-b border-border py-4 sm:grid-cols-[9rem_1fr_auto]"
                >
                  <dt className="font-semibold">{r.label}</dt>
                  <dd className="m-0 text-pretty">{r.value}</dd>
                  <dd className="m-0">
                    <Button variant="link" className="h-12 px-0" onClick={() => go(r.step)}>
                      Change<span className="sr-only"> {r.label.toLowerCase()}</span>
                    </Button>
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          <section aria-labelledby="permanent-title" className="grid gap-5">
            <h2 id="permanent-title" className="m-0 text-xl font-semibold">
              What becomes permanent and public
            </h2>
            <div className="flex flex-wrap items-start gap-5 border-t-2 border-foreground pt-5">
              <Fingerprint
                value={DRAFT_DEFINITION_HASH}
                label={`Fingerprint of the definition hash ${DRAFT_DEFINITION_HASH.slice(0, 8)}`}
                size={72}
              />
              <div className="grid min-w-0 flex-1 basis-56 gap-2">
                <Hash value={DRAFT_DEFINITION_HASH} label="Definition hash" />
                <p className="m-0 text-sm text-muted-foreground">
                  Computed from everything above. It changes if you change anything.
                </p>
              </div>
            </div>
            <div className="grid gap-6 sm:grid-cols-2">
              <div className="grid content-start gap-2">
                <h3 className="m-0 font-mono text-xs tracking-widest uppercase">
                  Permanent, on the L2 and the board
                </h3>
                <ul className="m-0 grid gap-1 ps-5 text-sm">
                  <li>The definition hash</li>
                  <li>The counting method and who can vote</li>
                  <li>The opening and closing times</li>
                  <li>
                    A hash of the text:{" "}
                    <code className="font-mono text-xs">{DRAFT_TEXT_HASH.slice(0, 12)}…</code>
                  </li>
                  <li>Every ballot and the count</li>
                </ul>
              </div>
              <div className="grid content-start gap-2">
                <h3 className="m-0 font-mono text-xs tracking-widest uppercase">
                  Public, and can be withheld
                </h3>
                <ul className="m-0 grid gap-1 ps-5 text-sm">
                  <li>The question and description</li>
                  <li>The option text</li>
                  <li>Whether the poll is listed</li>
                </ul>
              </div>
            </div>
          </section>

          <section
            aria-labelledby="policy-title"
            className="grid gap-2 border-s-4 border-foreground ps-5"
          >
            <h2 id="policy-title" className="m-0 text-xl font-semibold">
              Moderation
            </h2>
            <p className="m-0 text-base text-pretty">
              We can delist or hide a poll’s text only on one of seven published grounds, such as
              personal data, a threat or spam, and never for its viewpoint or its result. Every
              decision is a public entry in the{" "}
              <a href="/moderation" className="underline underline-offset-4">
                moderation log
              </a>
              , and you can appeal it once. Moderation never touches ballots, the count or the
              result.
            </p>
          </section>

          {published ? (
            <p role="status" className="m-0 border-2 border-recorded p-4 font-semibold">
              Published. The definition is being recorded on the L2.
            </p>
          ) : null}
        </StepLayout>
      );
      break;
    }
  }

  return (
    <MockShell current="/polls/new" signedIn>
      {screen}
    </MockShell>
  );
}
