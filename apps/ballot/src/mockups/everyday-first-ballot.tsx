import { Button, Fingerprint, StatusTrail, type StatusStep } from "@abolishus/ui";
import { Check, Download, ShieldCheck } from "lucide-react";
import { useId, useState } from "react";

import {
  EVERYDAY_RECEIPT,
  type Answers,
  type EverydayPoll,
  type QuestionRule,
} from "./everyday-fixtures.ts";
import { JOIN_WITHIN } from "./everyday-first-fixtures.ts";
import {
  BackupOffer,
  FirstFrame,
  FirstTimeHere,
  PollSeal,
  SetupLine,
  type Backup,
  type Setup,
} from "./everyday-first-frame.tsx";
import {
  Choice,
  EVERYDAY_ACTION,
  EverydayTitle,
  everydayLink,
  Note,
  OneTapAway,
  Part,
} from "./everyday-frame.tsx";
import { shortHex } from "./fixtures.ts";

export type FirstScreen =
  | { name: "question"; index: number }
  | { name: "check" }
  | { name: "sending" }
  | { name: "done" };

/** How the wait for this device's setup is going, after Send. */
export type Wait = "normal" | "slow" | "offline";

const TAPPED_NOTE = "You chose this on the website — change it if you like";
const TRAIL_STATES = { complete: "done", pending: "in progress", upcoming: "not yet" };
const WORDS = ["none", "one", "two", "three", "four", "five"];

function limitOf(rule: QuestionRule, options: number): number {
  switch (rule.kind) {
    case "one":
      return 1;
    case "any":
      return options;
    case "upTo":
      return rule.max;
    case "exactly":
      return rule.count;
  }
}

function instructionOf(rule: QuestionRule): string {
  switch (rule.kind) {
    case "one":
      return "Choose one.";
    case "any":
      return "Choose as many as you like.";
    case "upTo":
      return `Choose up to ${WORDS[rule.max] ?? rule.max}.`;
    case "exactly":
      return `Choose exactly ${WORDS[rule.count] ?? rule.count}.`;
  }
}

function labelsOf(poll: EverydayPoll, key: string, chosen: readonly string[]): string[] {
  const question = poll.questions.find((q) => q.key === key);
  return chosen.map((k) => question?.options.find((o) => o.key === k)?.label ?? k);
}

/** The arrival check, as on every everyday ballot: one plain line, the seal one tap down. */
function RealPoll({ poll }: { poll: EverydayPoll }) {
  return (
    <OneTapAway
      summary={
        <>
          <ShieldCheck aria-hidden="true" className="size-5 shrink-0 text-recorded" />
          <span className="font-medium">This is the real poll, checked</span>
        </>
      }
    >
      <div className="flex items-start gap-3">
        <PollSeal poll={poll} />
        <p className="m-0 text-pretty">
          These questions are exactly the ones {poll.askedBy} registered. The seal is drawn from
          them, and it's the same one you saw on the website.
        </p>
      </div>
      <p className="m-0 text-pretty">
        During launch, Abolish alone holds the key for this poll. We could read individual answers,
        though not who gave them; we've promised not to and destroy the key after the final count.
      </p>
    </OneTapAway>
  );
}

function Question({
  poll,
  index,
  chosen,
  prefill,
  first,
  setup,
  blocked,
  onChange,
  onSetup,
  onRestore,
  onBack,
  onNext,
}: {
  poll: EverydayPoll;
  index: number;
  chosen: readonly string[];
  prefill: readonly string[];
  first: boolean;
  setup: Setup;
  /** Send was tapped before the check finished. */
  blocked: boolean;
  onChange: (next: readonly string[]) => void;
  onSetup: (next: Setup) => void;
  onRestore: () => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const name = useId();
  const question = poll.questions[index];
  if (question === undefined) return null;
  const single = poll.questions.length === 1;
  const last = index === poll.questions.length - 1;
  const multi = question.rule.kind !== "one";
  const limit = limitOf(question.rule, question.options.length);

  function choose(key: string) {
    if (!multi) onChange([key]);
    else if (chosen.includes(key)) onChange(chosen.filter((k) => k !== key));
    else if (chosen.length < limit) onChange([...chosen, key]);
  }

  return (
    <FirstFrame
      poll={poll}
      question={index + 1}
      primary={
        <Button size="lg" className={EVERYDAY_ACTION} onClick={onNext}>
          {single ? "Send my answer" : last ? "Check your answers" : "Next question"}
        </Button>
      }
      secondary={
        index === 0 ? (
          <a className={everydayLink("outline")} href={poll.url}>
            Back to the poll's page
          </a>
        ) : (
          <Button size="lg" variant="outline" className={EVERYDAY_ACTION} onClick={onBack}>
            Back
          </Button>
        )
      }
    >
      {index === 0 ? (
        <div className="mb-8 grid gap-3">
          {first ? <FirstTimeHere onRestore={onRestore} /> : null}
          {single ? null : (
            <p className="m-0 text-base text-pretty text-muted-foreground">
              {poll.title}{" "}
              <span className="whitespace-nowrap">· {WORDS[poll.questions.length]} questions</span>
            </p>
          )}
          <RealPoll poll={poll} />
        </div>
      ) : null}
      <h1 className="m-0 font-heading text-3xl leading-tight font-semibold tracking-tight text-pretty sm:text-4xl">
        {question.text}
      </h1>
      <div className="mt-6 grid gap-1 border-y border-border py-3">
        <p className="m-0 text-lg font-semibold">{instructionOf(question.rule)}</p>
        <p className="m-0 text-muted-foreground">
          {multi
            ? "To remove a choice, choose it again."
            : "To change your answer, choose a different one."}
          {question.scale === undefined ? null : ` ${question.scale}`}
        </p>
      </div>
      <fieldset className="m-0 mt-6 grid gap-3 border-0 p-0">
        <legend className="sr-only">{instructionOf(question.rule)}</legend>
        {question.options.map((option) => {
          const checked = chosen.includes(option.key);
          return (
            <Choice
              key={option.key}
              type={multi ? "checkbox" : "radio"}
              name={name}
              label={option.label}
              note={checked && prefill.includes(option.key) ? TAPPED_NOTE : undefined}
              noteId={`${name}-${option.key}-note`}
              checked={checked}
              onChange={() => choose(option.key)}
            />
          );
        })}
      </fieldset>
      <p role="status" className="m-0 mt-4">
        {chosen.length === 0
          ? "Nothing chosen yet."
          : `You chose: ${labelsOf(poll, question.key, chosen).join(", ")}.`}
        {single ? " Nothing is sent until you tap Send." : ""}
      </p>
      {single && first ? <SendGate setup={setup} blocked={blocked} onSetup={onSetup} /> : null}
    </FirstFrame>
  );
}

/** The setup line beside Send, and what Send says if the check isn't done. */
function SendGate({
  setup,
  blocked,
  onSetup,
}: {
  setup: Setup;
  blocked: boolean;
  onSetup: (next: Setup) => void;
}) {
  return (
    <div className="mt-8 grid gap-4">
      <SetupLine
        setup={setup}
        onChecked={() => onSetup("ready")}
        onRetry={() => onSetup("working")}
      />
      {blocked && (setup === "check" || setup === "failed") ? (
        <p role="alert" className="m-0 font-medium">
          Not sent yet: the check above needs to finish first. Your answer is kept.
        </p>
      ) : null}
    </div>
  );
}

function CheckAnswers({
  poll,
  answers,
  first,
  setup,
  blocked,
  onSetup,
  onChange,
  onSend,
}: {
  poll: EverydayPoll;
  answers: Answers;
  first: boolean;
  setup: Setup;
  blocked: boolean;
  onSetup: (next: Setup) => void;
  onChange: (index: number) => void;
  onSend: () => void;
}) {
  return (
    <FirstFrame
      poll={poll}
      primary={
        <Button size="lg" className={EVERYDAY_ACTION} onClick={onSend}>
          Send my answers
        </Button>
      }
      secondary={
        <Button
          size="lg"
          variant="outline"
          className={EVERYDAY_ACTION}
          onClick={() => onChange(poll.questions.length - 1)}
        >
          Back
        </Button>
      }
    >
      <EverydayTitle title="Check your answers">
        <p className="m-0">Nothing has been sent yet. Change anything you like.</p>
      </EverydayTitle>
      <ol aria-label="Your answers" className="m-0 mt-8 grid list-none gap-4 p-0">
        {poll.questions.map((question, i) => {
          const chosen = answers[question.key] ?? [];
          return (
            <li key={question.key} className="grid gap-3 rounded-xl border border-border px-4 py-4">
              <p className="m-0 text-sm text-muted-foreground">Question {i + 1}</p>
              <h2 className="m-0 text-base font-normal text-pretty">{question.text}</h2>
              {chosen.length === 0 ? (
                <p className="m-0 text-xl font-semibold">Skipped: counts as no answer</p>
              ) : (
                <ul className="m-0 grid list-none gap-1 p-0">
                  {labelsOf(poll, question.key, chosen).map((label) => (
                    <li key={label} className="flex items-start gap-2 text-xl font-semibold">
                      <Check aria-hidden="true" className="mt-1 size-5 shrink-0 text-primary" />
                      {label}
                    </li>
                  ))}
                </ul>
              )}
              <div>
                <Button
                  variant="outline"
                  aria-label={`Change your answer to question ${i + 1}`}
                  onClick={() => onChange(i)}
                >
                  Change
                </Button>
              </div>
            </li>
          );
        })}
      </ol>
      {first ? <SendGate setup={setup} blocked={blocked} onSetup={onSetup} /> : null}
    </FirstFrame>
  );
}

/**
 * After Send. A returning device sends in seconds; a new one waits for its
 * registration batch first, with the answer already sealed, and is offered
 * the backup meanwhile, since there is nothing else to do.
 */
function Sending({
  poll,
  first,
  wait,
  backup,
  plural,
  onRetry,
  onBackUp,
  onSkip,
}: {
  poll: EverydayPoll;
  first: boolean;
  wait: Wait;
  backup: Backup;
  plural: boolean;
  onRetry: () => void;
  onBackUp: () => void;
  onSkip: () => void;
}) {
  const answer = plural ? "answers" : "answer";
  const steps: StatusStep[] = [
    { label: "Sealed on this device", state: "complete" },
    ...(first
      ? [
          {
            label: "This device joins the people who can answer",
            state: "pending" as const,
            detail: `Usually within ${JOIN_WITHIN}`,
          },
          { label: "Sent to the public board", state: "upcoming" as const },
        ]
      : [{ label: "Sent to the public board", state: "pending" as const }]),
    { label: "Counted", state: "upcoming", detail: `When the poll closes, ${poll.closes}` },
  ];
  return (
    <FirstFrame poll={poll}>
      {first ? (
        <EverydayTitle title={`Your ${answer} ${plural ? "are" : "is"} sealed and ready to go`}>
          <p className="m-0">
            This device is new here, so it first joins the people who can answer. That happens in
            batches, usually within {JOIN_WITHIN}, so no one can tell who joined when. Then your{" "}
            {answer} {plural ? "are" : "is"} sent by {plural ? "themselves" : "itself"}.
          </p>
          <p className="m-0 text-base text-muted-foreground">
            Leave this open. If you close it, your {answer} {plural ? "are" : "is"} sent the next
            time you open the voting app on this device.
          </p>
        </EverydayTitle>
      ) : (
        <EverydayTitle title={`Sending your ${answer}`}>
          <p className="m-0">Keep this open. It usually takes a few seconds.</p>
        </EverydayTitle>
      )}
      {wait === "normal" ? null : (
        <div role="status" className="mt-6">
          {wait === "slow" ? (
            <Note tone="warn" title="Setup is taking longer than usual">
              <p className="m-0">
                Your {answer} {plural ? "are" : "is"} sealed and safe on this device, and will be
                sent as soon as setup finishes. You can keep waiting here, or close this and come
                back later.
              </p>
            </Note>
          ) : (
            <Note tone="warn" title="You're offline">
              <p className="m-0">
                Your {answer} {plural ? "are" : "is"} sealed and kept on this device.{" "}
                {plural ? "They're" : "It's"} sent when you're back online with this page open, or
                the next time you open the voting app.
              </p>
              <div>
                <Button variant="outline" onClick={onRetry}>
                  Try again now
                </Button>
              </div>
            </Note>
          )}
        </div>
      )}
      <div className="mt-8 rounded-xl border border-border px-4 py-5">
        <StatusTrail
          label={`Your ${answer}`}
          steps={steps}
          stateLabels={TRAIL_STATES}
          stepTemplate="{step}, {state}"
        />
      </div>
      {first ? <BackupOffer backup={backup} onBackUp={onBackUp} onSkip={onSkip} /> : null}
    </FirstFrame>
  );
}

function Done({
  poll,
  first,
  backup,
  plural,
  onBackUp,
  onSkip,
}: {
  poll: EverydayPoll;
  first: boolean;
  backup: Backup;
  plural: boolean;
  onBackUp: () => void;
  onSkip: () => void;
}) {
  return (
    <FirstFrame
      poll={poll}
      primary={
        <a className={everydayLink()} href={`${poll.url}#from=voting-app`}>
          Back to the poll's page
        </a>
      }
    >
      <div className="flex items-center gap-4">
        <Fingerprint
          value={EVERYDAY_RECEIPT.hash}
          label={`Seal of your receipt, ${shortHex(EVERYDAY_RECEIPT.hash)}`}
          size={48}
        />
        <h1 className="m-0 font-heading text-3xl leading-tight font-semibold tracking-tight sm:text-4xl">
          {plural ? "Your answers are in" : "Your answer is in"}
        </h1>
      </div>
      <p className="m-0 mt-4 text-lg text-pretty">
        {plural ? "They're" : "It's"} sealed and on the public board, and no one can see how you
        answered, including us.
      </p>
      {first ? <BackupOffer backup={backup} onBackUp={onBackUp} onSkip={onSkip} /> : null}
      <Part title="Keep your receipt">
        <p className="m-0">
          It shows your {plural ? "answers are" : "answer is"} on the board, not what you chose. The
          seal above is drawn from it.
        </p>
        <div>
          <Button size="lg" variant="outline" className={EVERYDAY_ACTION}>
            <Download aria-hidden="true" />
            Save receipt
          </Button>
        </div>
      </Part>
      <Part title="Changed your mind?">
        <p className="m-0">
          You can change your {plural ? "answers" : "answer"} until {poll.changeUntil}; only your
          last {plural ? "answers count" : "answer counts"}.
        </p>
      </Part>
    </FirstFrame>
  );
}

export interface FirstAnswerProps {
  poll: EverydayPoll;
  /** A device answering for the first time, or one already set up. */
  visitor?: "first" | "returning";
  start?: FirstScreen;
  /** The answer tapped on the website, shown chosen and labelled as theirs. */
  prefill?: Answers;
  answers?: Answers;
  /** Where setup stands when the screen opens. */
  setup?: Setup;
  /** How the bot check ends when it is retried or ticked. */
  checkEnds?: Setup;
  wait?: Wait;
  backup?: Backup;
  /** Whether the passkey made for the backup can derive its key (WebAuthn PRF). */
  prf?: boolean;
}

/** The first answer from a new device, from arrival to the backup offer. */
export function FirstAnswer({
  poll,
  visitor = "first",
  start = { name: "question", index: 0 },
  prefill = {},
  answers: initialAnswers = {},
  setup: initialSetup = "working",
  checkEnds = "ready",
  wait: initialWait = "normal",
  backup: initialBackup = "offer",
  prf = true,
}: FirstAnswerProps) {
  const [screen, setScreen] = useState<FirstScreen>(start);
  const [answers, setAnswers] = useState<Answers>({ ...prefill, ...initialAnswers });
  const [setup, setSetup] = useState<Setup>(initialSetup);
  const [blocked, setBlocked] = useState(false);
  const [wait, setWait] = useState<Wait>(initialWait);
  const [backup, setBackup] = useState<Backup>(initialBackup);
  const [restoring, setRestoring] = useState(false);
  const first = visitor === "first";
  const plural = poll.questions.length > 1;

  function go(next: FirstScreen) {
    setScreen(next);
    setBlocked(false);
    window.scrollTo?.(0, 0);
  }

  function send() {
    if (first && (setup === "check" || setup === "failed")) setBlocked(true);
    else go({ name: "sending" });
  }

  const backupProps = {
    backup,
    onBackUp: () => setBackup(prf ? "saved" : "unsupported"),
    onSkip: () => setBackup("skipped"),
  };

  if (restoring) {
    return (
      <FirstFrame
        poll={poll}
        primary={
          <Button size="lg" className={EVERYDAY_ACTION} onClick={() => setRestoring(false)}>
            Back to the question
          </Button>
        }
      >
        <EverydayTitle title="Use your passkey backup">
          <p className="m-0">
            Your device will ask for the passkey you backed up with. Choose it, and this device
            carries on as the same person.
          </p>
        </EverydayTitle>
      </FirstFrame>
    );
  }

  switch (screen.name) {
    case "question": {
      const question = poll.questions[screen.index];
      const single = poll.questions.length === 1;
      const last = screen.index === poll.questions.length - 1;
      return (
        <Question
          key={screen.index}
          poll={poll}
          index={screen.index}
          chosen={question === undefined ? [] : (answers[question.key] ?? [])}
          prefill={question === undefined ? [] : (prefill[question.key] ?? [])}
          first={first}
          setup={setup}
          blocked={blocked}
          onChange={(next) => {
            if (question !== undefined) setAnswers({ ...answers, [question.key]: next });
          }}
          onSetup={(next) => setSetup(next === "working" ? checkEnds : next)}
          onRestore={() => setRestoring(true)}
          onBack={() => go({ name: "question", index: Math.max(0, screen.index - 1) })}
          onNext={() => {
            if (single) send();
            else go(last ? { name: "check" } : { name: "question", index: screen.index + 1 });
          }}
        />
      );
    }
    case "check":
      return (
        <CheckAnswers
          poll={poll}
          answers={answers}
          first={first}
          setup={setup}
          blocked={blocked}
          onSetup={(next) => setSetup(next === "working" ? checkEnds : next)}
          onChange={(index) => go({ name: "question", index })}
          onSend={send}
        />
      );
    case "sending":
      return (
        <Sending
          poll={poll}
          first={first}
          wait={wait}
          plural={plural}
          onRetry={() => setWait("normal")}
          {...backupProps}
        />
      );
    case "done":
      return <Done poll={poll} first={first} plural={plural} {...backupProps} />;
  }
}
