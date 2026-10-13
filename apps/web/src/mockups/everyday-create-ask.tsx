import { Button, cn } from "@abolishus/ui";
import { Input } from "@abolishus/ui/ui/input";
import { Label } from "@abolishus/ui/ui/label";
import { RadioGroup, RadioGroupItem } from "@abolishus/ui/ui/radio-group";
import { Textarea } from "@abolishus/ui/ui/textarea";
import { ArrowDown, ArrowUp, Minus, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  type AnswerRule,
  type Draft,
  type DraftQuestion,
  type Errors,
  fieldId,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  RULES,
} from "./everyday-create-data.ts";
import { describedBy, ErrorText, fieldInput, Help, invalid } from "./everyday-create-parts.tsx";

function move<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}

/** Up, down and remove for one item in a list: buttons, so nothing depends on dragging. */
function ItemControls({
  base,
  noun,
  index,
  count,
  canRemove,
  onMove,
  onRemove,
}: {
  base: string;
  noun: string;
  index: number;
  count: number;
  canRemove: boolean;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex shrink-0 gap-1">
      <Button
        id={`${base}-up`}
        variant="outline"
        size="icon"
        aria-label={`Move ${noun} up`}
        disabled={index === 0}
        onClick={() => onMove(-1)}
      >
        <ArrowUp aria-hidden="true" />
      </Button>
      <Button
        id={`${base}-down`}
        variant="outline"
        size="icon"
        aria-label={`Move ${noun} down`}
        disabled={index === count - 1}
        onClick={() => onMove(1)}
      >
        <ArrowDown aria-hidden="true" />
      </Button>
      {canRemove ? (
        <Button variant="outline" size="icon" aria-label={`Remove ${noun}`} onClick={onRemove}>
          <Trash2 aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}

function QuestionCard({
  q,
  index,
  count,
  errors,
  onChange,
  onMove,
  onRemove,
  onAddOption,
  onMoveOption,
  onRemoveOption,
}: {
  q: DraftQuestion;
  index: number;
  count: number;
  errors: Errors;
  onChange: (q: DraftQuestion) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  onAddOption: () => void;
  onMoveOption: (from: number, dir: -1 | 1) => void;
  onRemoveOption: (at: number) => void;
}) {
  const n = index + 1;
  const textId = fieldId.question(q.id);
  const hintId = `q-${q.id}-hint`;
  const ruleId = `q-${q.id}-rule`;
  const nId = fieldId.n(q.id);
  const addId = fieldId.addOption(q.id);
  const optionsCount = q.options.length;
  const counted = q.rule === "upTo" || q.rule === "exactly";
  return (
    <section
      aria-labelledby={`q-${q.id}-heading`}
      className="grid gap-6 border border-border p-4 sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id={`q-${q.id}-heading`} className="m-0 text-xl font-semibold">
          Question {n}
        </h3>
        <ItemControls
          base={`q-${q.id}`}
          noun={`question ${n}`}
          index={index}
          count={count}
          canRemove={count > 1}
          onMove={onMove}
          onRemove={onRemove}
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor={textId} className="text-base font-semibold">
          What do you want to ask?
        </Label>
        <ErrorText errors={errors} id={textId} />
        <Textarea
          id={textId}
          rows={2}
          aria-describedby={describedBy(errors, textId)}
          aria-invalid={invalid(errors, textId)}
          className="min-h-20 p-3 text-lg md:text-lg"
          value={q.text}
          onChange={(e) => onChange({ ...q, text: e.target.value })}
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor={hintId} className="text-base font-semibold">
          Hint <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Help id={`${hintId}-help`}>A short line under the question, like “Choose up to two.”</Help>
        <Input
          id={hintId}
          aria-describedby={`${hintId}-help`}
          className={fieldInput}
          value={q.hint}
          onChange={(e) => onChange({ ...q, hint: e.target.value })}
        />
      </div>

      <fieldset className="m-0 grid gap-3 border-0 p-0">
        <legend id={`${ruleId}-legend`} className="mb-3 p-0 text-base font-semibold">
          How do people answer?
        </legend>
        <RadioGroup
          aria-labelledby={`${ruleId}-legend`}
          value={q.rule}
          onValueChange={(value) => {
            const rule = value as AnswerRule;
            const max = Math.max(2, optionsCount - (rule === "exactly" ? 1 : 0));
            onChange({ ...q, rule, n: Math.min(Math.max(q.n, 2), max) });
          }}
          className="flex flex-wrap gap-2"
        >
          {RULES.map((r) => (
            <Label
              key={r.key}
              className={cn(
                "flex min-h-12 items-center gap-3 border px-4 text-sm leading-tight font-normal",
                q.rule === r.key
                  ? "border-2 border-primary px-[15px] font-semibold"
                  : "border-border",
                r.later && "border-dashed text-muted-foreground",
              )}
            >
              <RadioGroupItem value={r.key} disabled={r.later ?? false} />
              <span>
                {r.label}
                {r.later ? <span className="block text-xs">Coming later</span> : null}
              </span>
            </Label>
          ))}
        </RadioGroup>
      </fieldset>

      {counted ? (
        <div className="grid gap-2">
          <Label htmlFor={nId} className="text-base font-semibold">
            {q.rule === "upTo" ? "Up to how many?" : "Exactly how many?"}
          </Label>
          <ErrorText errors={errors} id={nId} />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              aria-label={`Fewer for question ${n}`}
              disabled={q.n <= 2}
              onClick={() => onChange({ ...q, n: q.n - 1 })}
            >
              <Minus aria-hidden="true" />
            </Button>
            <Input
              id={nId}
              inputMode="numeric"
              aria-describedby={describedBy(errors, nId)}
              aria-invalid={invalid(errors, nId)}
              className={cn(fieldInput, "w-20 text-center tabular-nums")}
              value={String(q.n)}
              onChange={(e) => {
                const value = Number.parseInt(e.target.value, 10);
                if (Number.isInteger(value) && value >= 1 && value <= MAX_OPTIONS)
                  onChange({ ...q, n: value });
              }}
            />
            <Button
              variant="outline"
              size="icon"
              aria-label={`More for question ${n}`}
              disabled={q.n >= MAX_OPTIONS}
              onClick={() => onChange({ ...q, n: q.n + 1 })}
            >
              <Plus aria-hidden="true" />
            </Button>
            <span className="text-muted-foreground">
              of {optionsCount} {optionsCount === 1 ? "option" : "options"}
            </span>
          </div>
        </div>
      ) : null}

      <fieldset
        id={fieldId.options(q.id)}
        aria-describedby={describedBy(errors, addId)}
        className="m-0 grid gap-4 border-0 p-0"
      >
        <legend className="mb-3 p-0 text-base font-semibold">Options</legend>
        <ol className="m-0 grid list-none gap-4 p-0">
          {q.options.map((o, j) => {
            const id = fieldId.option(q.id, o.id);
            return (
              <li key={o.id} className="grid gap-2">
                <Label htmlFor={id} className="text-sm font-medium">
                  Option {j + 1}
                </Label>
                <ErrorText errors={errors} id={id} />
                <div className="flex flex-wrap gap-2">
                  <Input
                    id={id}
                    aria-describedby={describedBy(errors, id)}
                    aria-invalid={invalid(errors, id)}
                    className={cn(fieldInput, "min-w-0 flex-1 basis-48")}
                    value={o.label}
                    onChange={(e) =>
                      onChange({
                        ...q,
                        options: q.options.map((x) =>
                          x.id === o.id ? { ...x, label: e.target.value } : x,
                        ),
                      })
                    }
                  />
                  <ItemControls
                    base={id}
                    noun={`option ${j + 1} of question ${n}`}
                    index={j}
                    count={optionsCount}
                    canRemove={optionsCount > 1}
                    onMove={(dir) => onMoveOption(j, dir)}
                    onRemove={() => onRemoveOption(j)}
                  />
                </div>
              </li>
            );
          })}
        </ol>
        <ErrorText errors={errors} id={addId} />
        <div>
          <Button
            id={addId}
            variant="outline"
            disabled={optionsCount >= MAX_OPTIONS}
            aria-describedby={describedBy(errors, addId)}
            aria-invalid={invalid(errors, addId)}
            onClick={onAddOption}
          >
            <Plus aria-hidden="true" data-icon="inline-start" />
            Add an option<span className="sr-only"> to question {n}</span>
          </Button>
        </div>
      </fieldset>
    </section>
  );
}

/** Step 1: the poll's title, place and topic, then its questions. */
export function AskFields({
  draft,
  errors,
  onChange,
}: {
  draft: Draft;
  errors: Errors;
  onChange: (draft: Draft) => void;
}) {
  const nextId = useRef(0);
  const newId = (prefix: string) => `${prefix}-new-${(nextId.current += 1)}`;
  const [announcement, setAnnouncement] = useState("");
  const focusNext = useRef<string | null>(null);

  useEffect(() => {
    if (focusNext.current === null) return;
    document.getElementById(focusNext.current)?.focus();
    focusNext.current = null;
  });

  const update = (next: Draft, focus: string | null, say: string) => {
    focusNext.current = focus;
    setAnnouncement(say);
    onChange(next);
  };

  const setQuestion = (q: DraftQuestion) =>
    onChange({ ...draft, questions: draft.questions.map((x) => (x.id === q.id ? q : x)) });

  const questions = draft.questions;
  const titleId = fieldId.title;

  /** After a move the same button keeps focus, unless it is now disabled at the end of the list. */
  const movedFocus = (base: string, to: number, count: number, dir: -1 | 1) =>
    `${base}-${(dir === -1 && to === 0) || (dir === 1 && to !== count - 1) ? "down" : "up"}`;

  return (
    <>
      <div className="grid gap-6">
        <div className="grid gap-2">
          <Label htmlFor={titleId} className="text-lg font-semibold">
            Title
          </Label>
          <Help id={`${titleId}-help`}>
            What your poll is about, in a line. People see it first.
          </Help>
          <ErrorText errors={errors} id={titleId} />
          <Textarea
            id={titleId}
            rows={2}
            aria-describedby={describedBy(errors, titleId, true)}
            aria-invalid={invalid(errors, titleId)}
            className="min-h-20 p-3 text-lg md:text-lg"
            value={draft.title}
            onChange={(e) => onChange({ ...draft, title: e.target.value })}
          />
        </div>
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="grid content-start gap-2">
            <Label htmlFor="poll-place" className="text-base font-semibold">
              Place <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Help id="poll-place-help">A town, a street, a school.</Help>
            <Input
              id="poll-place"
              aria-describedby="poll-place-help"
              className={fieldInput}
              value={draft.place}
              onChange={(e) => onChange({ ...draft, place: e.target.value })}
            />
          </div>
          <div className="grid content-start gap-2">
            <Label htmlFor="poll-topic" className="text-base font-semibold">
              Topic <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Help id="poll-topic-help">Helps people find it.</Help>
            <Input
              id="poll-topic"
              aria-describedby="poll-topic-help"
              className={fieldInput}
              value={draft.topic}
              onChange={(e) => onChange({ ...draft, topic: e.target.value })}
            />
          </div>
        </div>
      </div>

      <section aria-labelledby="questions-heading" className="grid gap-6">
        <div className="grid gap-1">
          <h2
            id="questions-heading"
            tabIndex={-1}
            className="m-0 text-2xl font-semibold outline-none"
          >
            Questions
          </h2>
          <p className="m-0 text-muted-foreground">
            Ask as many as you like, one ballot for all of them. Each is counted on its own.
          </p>
        </div>
        <p role="status" className="sr-only">
          {announcement}
        </p>
        {questions.map((q, i) => (
          <QuestionCard
            key={q.id}
            q={q}
            index={i}
            count={questions.length}
            errors={errors}
            onChange={setQuestion}
            onMove={(dir) => {
              const to = i + dir;
              update(
                { ...draft, questions: move(questions, i, to) },
                movedFocus(`q-${q.id}`, to, questions.length, dir),
                `Question ${i + 1} is now question ${to + 1}.`,
              );
            }}
            onRemove={() =>
              update(
                { ...draft, questions: questions.filter((x) => x.id !== q.id) },
                "questions-heading",
                `Question ${i + 1} removed.`,
              )
            }
            onAddOption={() => {
              const id = newId("o");
              update(
                {
                  ...draft,
                  questions: questions.map((x) =>
                    x.id === q.id ? { ...x, options: [...x.options, { id, label: "" }] } : x,
                  ),
                },
                fieldId.option(q.id, id),
                `Option ${q.options.length + 1} added to question ${i + 1}.`,
              );
            }}
            onMoveOption={(from, dir) => {
              const to = from + dir;
              const option = q.options[from];
              if (option === undefined) return;
              update(
                {
                  ...draft,
                  questions: questions.map((x) =>
                    x.id === q.id ? { ...x, options: move(x.options, from, to) } : x,
                  ),
                },
                movedFocus(fieldId.option(q.id, option.id), to, q.options.length, dir),
                `Option ${from + 1} is now option ${to + 1}.`,
              );
            }}
            onRemoveOption={(at) =>
              update(
                {
                  ...draft,
                  questions: questions.map((x) =>
                    x.id === q.id ? { ...x, options: x.options.filter((_, j) => j !== at) } : x,
                  ),
                },
                fieldId.addOption(q.id),
                `Option ${at + 1} removed from question ${i + 1}.`,
              )
            }
          />
        ))}
        <div>
          <Button
            variant="outline"
            size="lg"
            disabled={questions.length >= MAX_QUESTIONS}
            onClick={() => {
              const id = newId("q");
              update(
                {
                  ...draft,
                  questions: [
                    ...questions,
                    {
                      id,
                      text: "",
                      hint: "",
                      rule: "one",
                      n: 2,
                      options: [
                        { id: `${id}-a`, label: "" },
                        { id: `${id}-b`, label: "" },
                      ],
                    },
                  ],
                },
                fieldId.question(id),
                `Question ${questions.length + 1} added.`,
              );
            }}
          >
            <Plus aria-hidden="true" data-icon="inline-start" />
            Add a question
          </Button>
        </div>
      </section>
    </>
  );
}
