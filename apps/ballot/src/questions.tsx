import { Button, cn, type Translate, useTranslate } from "@abolishus/ui";
import { Check } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import {
  type Answers,
  type BallotQuestion,
  firstUnfit,
  fits,
  instructionOf,
  singleChoice,
  skippable,
  stillNeeded,
  toggle,
} from "./answers.ts";
import { ACTION, Frame, type FramePoll, Note, type PollClass, ScreenTitle } from "./frame.tsx";
import { catalogs, type Messages } from "./messages.ts";

// The question screens (P2-20 part 3), ported from the mockups
// (`mockups/everyday-ballot.tsx`, `mockups/ballot.stories.tsx`): one question
// per screen, then "Check your answers". They follow the Center for Civic
// Design's Keep rules: the question, then its instruction, then the options;
// every option a full-width target whose selected state shows as a check and
// in words; nothing chosen for the voter; a plain message for an overvote
// before it happens and for an undervote before going on; nothing moves.
//
// The answers live only in this component's state. Nothing is stored on the
// device, so a re-vote starts from nothing chosen and a coercer who picks up
// the phone finds no earlier answers ([[0026-multi-question-ballots]],
// Re-voting; T-45, T-47).

function instructionText(t: Translate<Messages>, q: BallotQuestion): string {
  const i = instructionOf(q);
  switch (i.kind) {
    case "one":
      return t("chooseOne");
    case "any":
      return t("chooseAny");
    case "upTo":
      return t("chooseUpTo", { count: i.max });
    case "exactly":
      return t("chooseExactly", { count: i.count });
    case "atLeast":
      return t("chooseAtLeast", { count: i.min });
    case "between":
      return t("chooseBetween", { min: i.min, max: i.max });
  }
}

/**
 * Where the voter is. The everyday register counts questions; the civic
 * record counts steps, the questions and then the check.
 */
function progressOf(pollClass: PollClass | undefined, step: number, questions: number) {
  const civic = pollClass === 2 || pollClass === 3;
  if (!civic) return step < questions ? { current: step + 1, total: questions } : undefined;
  return { current: step + 1, total: questions + 1 };
}

/** One option: the whole row is the target, and its state shows as a mark and in words. */
function OptionRow({
  type,
  name,
  label,
  description,
  checked,
  onChange,
}: {
  type: "radio" | "checkbox";
  name: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: () => void;
}) {
  const t = useTranslate(catalogs);
  const labelId = useId();
  const descriptionId = useId();
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
        // The label alone names the option; its description describes it.
        aria-labelledby={labelId}
        aria-describedby={description === "" ? undefined : descriptionId}
        className="sr-only"
      />
      <span
        aria-hidden="true"
        className={cn(
          "flex size-7 shrink-0 items-center justify-center border-2",
          type === "radio" && "rounded-full",
          checked
            ? "border-primary bg-primary text-primary-foreground"
            : "border-foreground bg-background",
        )}
      >
        {checked ? <Check className="size-4" strokeWidth={3} /> : null}
      </span>
      <span className="grid min-w-0 flex-1 gap-1">
        <span id={labelId} className="text-lg leading-snug font-medium break-words">
          {label}
        </span>
        {description === "" ? null : (
          <span id={descriptionId} className="text-sm break-words text-muted-foreground">
            {description}
          </span>
        )}
      </span>
      {/* The input's checked state already tells assistive technology. */}
      {checked ? (
        <span aria-hidden="true" className="shrink-0 text-sm font-semibold">
          {t("selected")}
        </span>
      ) : null}
    </label>
  );
}

export interface QuestionStepProps {
  pollClass?: PollClass | undefined;
  poll: FramePoll;
  questions: readonly BallotQuestion[];
  /** The question shown, from 0. */
  index: number;
  /** The voter's answer to it so far. */
  selection: readonly number[];
  /** Shown above the first question: the arrival check. */
  arrival?: ReactNode;
  /** Take focus on the heading, as after moving from another screen. */
  focus?: boolean;
  /** Open with the message that the answer is short, as when sending found it so. */
  short?: boolean;
  /** The next step is "Check your answers": the last question, or a Change from it. */
  toCheck: boolean;
  onChange: (selection: readonly number[]) => void;
  onBack: () => void;
  onNext: () => void;
  /** Leave the question blank and go on; offered only where the limits allow a blank. */
  onSkip: () => void;
}

/** One question: its text, its instruction, its options, and what the voter has chosen. */
export function QuestionStep({
  pollClass,
  poll,
  questions,
  index,
  selection,
  arrival,
  focus = false,
  short = false,
  toCheck,
  onChange,
  onBack,
  onNext,
  onSkip,
}: QuestionStepProps) {
  const t = useTranslate(catalogs);
  const name = useId();
  // The option a tap couldn't add, so the overvote message can name it.
  const [refused, setRefused] = useState<number | null>(null);
  const [asking, setAsking] = useState<"skip" | "short" | null>(short ? "short" : null);
  const shown = questions[index];
  if (shown === undefined) throw new RangeError(`no question ${index}`);
  const question: BallotQuestion = shown;
  const single = singleChoice(question);
  const canSkip = skippable(question);
  const instruction = instructionText(t, question);
  const refusedLabel = refused === null ? undefined : question.options[refused]?.label;
  const left = question.maxSelections - selection.length;
  const needed = stillNeeded(question, selection);

  function choose(option: number) {
    setAsking(null);
    const next = toggle(question, selection, option);
    setRefused(next.refused ? option : null);
    if (!next.refused) onChange(next.selection);
  }

  function next() {
    setRefused(null);
    if (needed > 0) setAsking("short");
    else if (selection.length === 0) setAsking("skip");
    else onNext();
  }

  return (
    <Frame
      pollClass={pollClass}
      poll={poll}
      progress={progressOf(pollClass, index, questions.length)}
      stepName={t("questionNumber", { number: index + 1 })}
      primary={
        <Button size="lg" className={ACTION} onClick={next}>
          {toCheck ? t("toCheck") : t("nextQuestion")}
        </Button>
      }
      secondary={
        index === 0 ? undefined : (
          <Button size="lg" variant="outline" className={ACTION} onClick={onBack}>
            {t("back")}
          </Button>
        )
      }
    >
      {index === 0 && arrival !== undefined ? <div className="mb-8">{arrival}</div> : null}
      <ScreenTitle title={question.question} focus={focus}>
        {question.description === "" ? undefined : <p className="m-0">{question.description}</p>}
      </ScreenTitle>
      <div className="mt-6 grid gap-1 border-y border-border py-3">
        <p className="m-0 text-lg font-semibold">{instruction}</p>
        <p className="m-0 text-muted-foreground">
          {single ? t("changeSingle") : t("changeMulti")}
          {canSkip ? null : ` ${t("cantSkip")}`}
        </p>
      </div>
      <fieldset className="m-0 mt-6 grid gap-3 border-0 p-0">
        <legend className="sr-only">{instruction}</legend>
        {question.options.map((option, i) => (
          <OptionRow
            key={i}
            type={single ? "radio" : "checkbox"}
            name={name}
            label={option.label}
            description={option.description}
            checked={selection.includes(i)}
            onChange={() => choose(i)}
          />
        ))}
      </fieldset>
      <p role="status" className="m-0 mt-4 flex flex-wrap items-baseline justify-between gap-x-4">
        {single ? (
          selection.length === 0 ? (
            t("nothingChosen")
          ) : (
            t("youChose", { label: question.options[selection[0] ?? 0]?.label ?? "" })
          )
        ) : (
          <>
            <span className="font-semibold tabular-nums">
              {t("chosenOf", { count: selection.length, max: question.maxSelections })}
            </span>
            <span className="text-sm text-muted-foreground">
              {left === 0 ? t("noMoreAllowed") : t("moreAllowed", { count: left })}
            </span>
          </>
        )}
      </p>
      <div role="status" className="mt-4 grid gap-4 empty:hidden">
        {refusedLabel === undefined ? null : (
          <Note tone="warn" title={t("overvoteTitle", { count: question.maxSelections })}>
            <p className="m-0">{t("overvote", { label: refusedLabel })}</p>
          </Note>
        )}
        {asking === "skip" ? (
          <Note title={t("skipTitle")}>
            <p className="m-0">
              {t("skipExplained")}
              {selection.length > 0 ? ` ${t("skipClears")}` : null}
            </p>
            <div className="flex flex-wrap gap-3">
              <Button variant="outline" onClick={onSkip}>
                {t("skipAndGoOn")}
              </Button>
              <Button variant="ghost" onClick={() => setAsking(null)}>
                {t("keepAnswering")}
              </Button>
            </div>
          </Note>
        ) : null}
        {asking === "short" && needed > 0 ? (
          <Note
            tone="warn"
            title={
              question.minSelections === question.maxSelections
                ? t("shortExactlyTitle", { count: question.minSelections })
                : t("shortAtLeastTitle", { count: question.minSelections })
            }
          >
            <p className="m-0">
              {t("shortExplained", { count: needed })} {t("cantSkip")}
            </p>
          </Note>
        ) : null}
      </div>
      {!canSkip || asking === "skip" ? null : (
        <div className="mt-4">
          <Button
            variant="link"
            className="px-0"
            onClick={() => {
              setRefused(null);
              setAsking("skip");
            }}
          >
            {t("skipQuestion")}
          </Button>
        </div>
      )}
    </Frame>
  );
}

export interface CheckAnswersProps {
  pollClass?: PollClass | undefined;
  poll: FramePoll;
  questions: readonly BallotQuestion[];
  answers: Answers;
  focus?: boolean;
  /** Back to question `index`, with its answer kept. */
  onChange: (index: number) => void;
  onSend: () => void;
  /** Open a sealed copy first (Benaloh's challenge); the copy is never counted. */
  onChallenge: () => void;
}

/** Every question with what the voter chose, before anything is sealed or sent. */
export function CheckAnswers({
  pollClass,
  poll,
  questions,
  answers,
  focus = false,
  onChange,
  onSend,
  onChallenge,
}: CheckAnswersProps) {
  const t = useTranslate(catalogs);
  // A question left blank where its limits allow it is skipped; one whose
  // answer doesn't fit (a required question emptied after a Change) still
  // needs an answer, and is never called skipped.
  const unfit = questions.flatMap((q, i) => (fits(q, answers[i] ?? []) ? [] : [i]));
  const skipped = questions.flatMap((q, i) =>
    skippable(q) && (answers[i] ?? []).length === 0 ? [i] : [],
  );
  return (
    <Frame
      pollClass={pollClass}
      poll={poll}
      progress={progressOf(pollClass, questions.length, questions.length)}
      stepName={t("checkStep")}
      primary={
        <Button size="lg" className={ACTION} onClick={onSend}>
          {t("send")}
        </Button>
      }
      secondary={
        <Button size="lg" variant="ghost" className={ACTION} onClick={onChallenge}>
          {t("challenge")}
        </Button>
      }
    >
      <ScreenTitle title={t("checkTitle")} focus={focus}>
        <p className="m-0">{t("checkLede")}</p>
      </ScreenTitle>
      {unfit.length === 0 ? null : (
        <div className="mt-6">
          <Note
            tone="warn"
            title={
              unfit.length === 1
                ? t("unfitOne", { number: (unfit[0] ?? 0) + 1 })
                : t("unfitMany", { count: unfit.length })
            }
          >
            <p className="m-0">{t("unfitExplained")}</p>
          </Note>
        </div>
      )}
      {skipped.length === 0 ? null : (
        <div className="mt-6">
          <Note
            tone="warn"
            title={
              skipped.length === 1
                ? t("skippedOne", { number: (skipped[0] ?? 0) + 1 })
                : t("skippedMany", { count: skipped.length })
            }
          >
            <p className="m-0">{t("skippedExplained")}</p>
          </Note>
        </div>
      )}
      <ol aria-label={t("answersLabel")} className="m-0 mt-8 grid list-none gap-4 p-0">
        {questions.map((question, i) => {
          const chosen = answers[i] ?? [];
          const needed = stillNeeded(question, chosen);
          return (
            <li key={i} className="grid gap-3 border border-border px-4 py-4">
              <p className="m-0 text-sm text-muted-foreground">
                {t("questionNumber", { number: i + 1 })}
              </p>
              <h2 className="m-0 text-base font-normal break-words text-pretty">
                {question.question}
              </h2>
              {needed > 0 ? (
                <p className="m-0 font-semibold">
                  {t("shortExplained", { count: needed })} {t("cantSkip")}
                </p>
              ) : null}
              {chosen.length === 0 ? (
                needed > 0 ? null : (
                  <p className="m-0 text-xl font-semibold">{t("skippedAnswer")}</p>
                )
              ) : (
                <ul className="m-0 grid list-none gap-1 p-0">
                  {chosen.map((option) => (
                    <li
                      key={option}
                      className="flex items-start gap-2 text-xl font-semibold break-words"
                    >
                      <Check aria-hidden="true" className="mt-1 size-5 shrink-0 text-primary" />
                      <span className="min-w-0">{question.options[option]?.label}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div>
                <Button
                  variant="outline"
                  aria-label={t("changeLabel", { number: i + 1 })}
                  onClick={() => onChange(i)}
                >
                  {t("change")}
                </Button>
              </div>
            </li>
          );
        })}
      </ol>
      <p className="m-0 mt-8 text-pretty text-muted-foreground">{t("challengeExplained")}</p>
    </Frame>
  );
}

export interface AnswerQuestionsProps {
  pollClass?: PollClass | undefined;
  poll: FramePoll;
  /** At least one, from a checked election (`questionsOf`). */
  questions: readonly BallotQuestion[];
  /** Shown above the first question: the arrival check. */
  arrival?: ReactNode;
  /** The voter's answers, each fitting its question; sealing and sending are the caller's. */
  onSend: (answers: Answers) => void;
  /** The same answers, to seal and open as a challenge; the voter then answers again or sends. */
  onChallenge: (answers: Answers) => void;
}

/** A question, opened with the short-answer message if sending found it short, or the check. */
type Screen = { readonly index: number; readonly short?: boolean } | "check";

/**
 * The questions one at a time, then "Check your answers", starting from
 * nothing chosen. Hands the caller the voter's answers, every one checked
 * against its question's limits, only when the voter sends or challenges.
 *
 * Key it by the election's definition hash: the answers are kept by
 * question number, so another election's questions passed to the same
 * instance would inherit them.
 */
export function AnswerQuestions({
  pollClass,
  poll,
  questions,
  arrival,
  onSend,
  onChallenge,
}: AnswerQuestionsProps) {
  const [screen, setScreen] = useState<Screen>({ index: 0 });
  const [answers, setAnswers] = useState<readonly (readonly number[])[]>(() =>
    questions.map(() => []),
  );
  const [returnToCheck, setReturnToCheck] = useState(false);
  // Focus follows the voter to each new screen, not on the first one.
  const [moved, setMoved] = useState(false);
  // The frame's "Question n of m" comes from here, so an empty election
  // can't show "Question 1 of 0" (part 1's review).
  if (questions.length === 0) throw new RangeError("an election asks at least one question");

  function go(next: Screen) {
    setScreen(next);
    setMoved(true);
    window.scrollTo?.(0, 0);
  }

  function answered(index: number, selection: readonly number[]) {
    setAnswers(answers.map((a, i) => (i === index ? selection : a)));
  }

  // Every answer fits by construction; checked again before it leaves, and a
  // misfit goes back to its question rather than out.
  function release(send: (answers: Answers) => void) {
    const unfit = firstUnfit(questions, answers);
    if (unfit === undefined) send(answers);
    else go({ index: unfit, short: true });
  }

  if (screen === "check")
    return (
      <CheckAnswers
        pollClass={pollClass}
        poll={poll}
        questions={questions}
        answers={answers}
        focus={moved}
        onChange={(index) => {
          setReturnToCheck(true);
          go({ index });
        }}
        onSend={() => release(onSend)}
        onChallenge={() => release(onChallenge)}
      />
    );

  const { index, short = false } = screen;
  const toCheck = returnToCheck || index === questions.length - 1;
  const after = () => go(toCheck ? "check" : { index: index + 1 });
  return (
    <QuestionStep
      key={index}
      pollClass={pollClass}
      poll={poll}
      questions={questions}
      index={index}
      selection={answers[index] ?? []}
      arrival={arrival}
      focus={moved}
      short={short}
      toCheck={toCheck}
      onChange={(selection) => answered(index, selection)}
      onBack={() => go({ index: Math.max(0, index - 1) })}
      onNext={after}
      onSkip={() => {
        answered(index, []);
        after();
      }}
    />
  );
}
