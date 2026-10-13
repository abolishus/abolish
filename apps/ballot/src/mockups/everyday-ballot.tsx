import { Button, Fingerprint, Hash, ReceiptStub, StatusTrail, TallyBars } from "@abolishus/ui";
import { Check, Download, ShieldCheck } from "lucide-react";
import { useId, useState } from "react";

import {
  EVERYDAY_RECEIPT,
  EVERYDAY_SEALED,
  type Answers,
  type EverydayPoll,
  type EverydayQuestion,
  type QuestionRule,
} from "./everyday-fixtures.ts";
import {
  Choice,
  EVERYDAY_ACTION,
  EverydayFrame,
  EverydayTitle,
  everydayLink,
  Note,
  OneTapAway,
  Part,
} from "./everyday-frame.tsx";
import { CLIENT, shortHex } from "./fixtures.ts";

export type EverydayScreen =
  | { name: "question"; index: number }
  | { name: "check" }
  | { name: "opened" }
  | { name: "sending" }
  | { name: "done" }
  | { name: "results" }
  | { name: "returning" };

const NUMBER_WORDS = ["none", "one", "two", "three", "four", "five", "six"];

function words(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

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
      return `Choose up to ${words(rule.max)}.`;
    case "exactly":
      return `Choose exactly ${words(rule.count)}.`;
  }
}

function labelsOf(question: EverydayQuestion, keys: readonly string[]): string[] {
  return keys.map((key) => question.options.find((o) => o.key === key)?.label ?? key);
}

const TAPPED_NOTE = "You chose this on the website — change it if you like";

/** Who holds the key that opens the answers, said plainly. */
function KeyHolders({ poll }: { poll: EverydayPoll }) {
  return (
    <div className="grid gap-2">
      <p className="m-0 font-semibold">Who holds the key</p>
      <p className="m-0 text-pretty">
        During launch, Abolish alone holds the key for this poll. We could read individual answers,
        though not who gave them; we've promised not to and destroy the key after the final count.
      </p>
      {poll.addedTrustee === undefined ? null : (
        <p className="m-0 text-pretty">
          The asker added their own trustee, {poll.addedTrustee}, so these answers can only be
          opened with them too.
        </p>
      )}
    </div>
  );
}

/** The arrival line: one plain check on the surface, the evidence one tap away. */
function RealPollCheck({ poll }: { poll: EverydayPoll }) {
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
        <Fingerprint
          value={poll.definitionHash}
          label={`Seal of this poll, ${shortHex(poll.definitionHash)}`}
          size={56}
        />
        <p className="m-0 text-pretty">
          Before showing you anything, this app checked that these questions are exactly the ones{" "}
          {poll.askedBy} registered. The seal is drawn from them; the poll's page shows the same
          one.
        </p>
      </div>
      <Hash value={poll.definitionHash} label="The poll's registered fingerprint" />
      <p className="m-0 text-sm text-muted-foreground">
        This ballot app is release {CLIENT.version}, the same copy published for anyone to check.
      </p>
      <KeyHolders poll={poll} />
      <a
        href={`${poll.url}/record`}
        className="text-foreground underline decoration-primary underline-offset-4"
      >
        See the full record of this poll
      </a>
    </OneTapAway>
  );
}

function QuestionStep({
  poll,
  index,
  chosen,
  prefill,
  toCheck,
  onChange,
  onBack,
  onNext,
  onSkip,
}: {
  poll: EverydayPoll;
  index: number;
  chosen: readonly string[];
  prefill: readonly string[];
  /** The next step is the check screen: the last question, or a Change from it. */
  toCheck: boolean;
  onChange: (next: readonly string[]) => void;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
}) {
  const question = poll.questions[index];
  const name = useId();
  const [blocked, setBlocked] = useState<string | null>(null);
  const [asking, setAsking] = useState<"skip" | "short" | null>(null);
  if (question === undefined) return null;
  const rule = question.rule;
  const multi = rule.kind !== "one";
  const limit = limitOf(rule, question.options.length);
  const blockedLabel = question.options.find((o) => o.key === blocked)?.label;

  function choose(key: string) {
    setAsking(null);
    if (!multi) {
      onChange([key]);
      return;
    }
    if (chosen.includes(key)) {
      onChange(chosen.filter((k) => k !== key));
      setBlocked(null);
    } else if (chosen.length >= limit) {
      setBlocked(key);
    } else {
      onChange([...chosen, key]);
      setBlocked(null);
    }
  }

  // Pick exactly N proves N selections, so it has no blank to skip to.
  const skippable = rule.kind !== "exactly";

  function next() {
    if (rule.kind === "exactly" && chosen.length < rule.count) setAsking("short");
    else if (chosen.length === 0) setAsking("skip");
    else onNext();
  }

  const left = limit - chosen.length;
  return (
    <EverydayFrame
      poll={poll}
      question={index + 1}
      primary={
        <Button size="lg" className={EVERYDAY_ACTION} onClick={next}>
          {toCheck ? "Check your answers" : "Next question"}
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
          <p className="m-0 text-base text-pretty text-muted-foreground">
            {poll.title}{" "}
            <span className="whitespace-nowrap">· {words(poll.questions.length)} questions</span>
          </p>
          <RealPollCheck poll={poll} />
        </div>
      ) : null}
      <h1 className="m-0 font-heading text-3xl leading-tight font-semibold tracking-tight text-pretty sm:text-4xl">
        {question.text}
      </h1>
      <div className="mt-6 grid gap-1 border-y border-border py-3">
        <p className="m-0 text-lg font-semibold">{instructionOf(rule)}</p>
        <p className="m-0 text-muted-foreground">
          {multi
            ? "To remove a choice, choose it again."
            : "To change your answer, choose a different one."}
          {question.scale === undefined ? null : ` ${question.scale}`}
          {skippable ? null : " This question can't be skipped."}
        </p>
      </div>
      <fieldset className="m-0 mt-6 grid gap-3 border-0 p-0">
        <legend className="sr-only">{instructionOf(rule)}</legend>
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
      <p role="status" className="m-0 mt-4 flex items-baseline justify-between gap-4">
        {multi ? (
          <>
            <span>
              <span className="font-semibold tabular-nums">
                {chosen.length} of {limit}
              </span>{" "}
              chosen
            </span>
            {rule.kind === "any" ? null : (
              <span className="text-sm text-muted-foreground">
                {left === 0 ? "No more choices left" : `${words(left)} more allowed`}
              </span>
            )}
          </>
        ) : chosen.length === 0 ? (
          "Nothing chosen yet."
        ) : (
          `You chose: ${labelsOf(question, chosen).join(", ")}.`
        )}
      </p>
      <div role="status" className="mt-4 grid gap-4 empty:hidden">
        {blockedLabel === undefined ? null : (
          <Note tone="warn" title={`You've already chosen ${words(limit)}`}>
            <p className="m-0">
              That's the most this question allows, so nothing changed. To choose “{blockedLabel}”,
              first remove one of your other choices.
            </p>
          </Note>
        )}
        {asking === "skip" ? (
          <Note title="Skip this question?">
            <p className="m-0">
              A skipped question counts as no answer. Your other answers still count, and you can
              come back to this one before you send.
              {chosen.length > 0 ? " Skipping clears what you chose here." : ""}
            </p>
            <div className="flex flex-wrap gap-3">
              <Button variant="outline" onClick={onSkip}>
                Skip and go on
              </Button>
              <Button variant="ghost" onClick={() => setAsking(null)}>
                Keep answering
              </Button>
            </div>
          </Note>
        ) : null}
        {asking === "short" && rule.kind === "exactly" ? (
          <Note tone="warn" title={`This question needs exactly ${words(rule.count)}`}>
            <p className="m-0">
              You've chosen {words(chosen.length)}. Choose {words(rule.count - chosen.length)} more
              to go on; this question can't be skipped.
            </p>
          </Note>
        ) : null}
      </div>
      {!skippable || asking === "skip" ? null : (
        <div className="mt-4">
          <Button variant="link" className="px-0" onClick={() => setAsking("skip")}>
            Skip this question
          </Button>
        </div>
      )}
    </EverydayFrame>
  );
}

function CheckAnswers({
  poll,
  answers,
  onChange,
  onSend,
  onOpen,
}: {
  poll: EverydayPoll;
  answers: Answers;
  onChange: (index: number) => void;
  onSend: () => void;
  onOpen: () => void;
}) {
  const skipped = poll.questions
    .map((q, i) => ({ q, i }))
    .filter(({ q }) => (answers[q.key] ?? []).length === 0);
  return (
    <EverydayFrame
      poll={poll}
      primary={
        <Button size="lg" className={EVERYDAY_ACTION} onClick={onSend}>
          Send my answers
        </Button>
      }
      secondary={
        <Button size="lg" variant="ghost" className={EVERYDAY_ACTION} onClick={onOpen}>
          Check the encryption first
        </Button>
      }
    >
      <EverydayTitle title="Check your answers">
        <p className="m-0">Nothing has been sent yet. Change anything you like.</p>
      </EverydayTitle>
      {skipped.length === 0 ? null : (
        <div className="mt-6">
          <Note
            tone="warn"
            title={
              skipped.length === 1
                ? `You skipped question ${(skipped[0]?.i ?? 0) + 1}`
                : `You skipped ${words(skipped.length)} questions`
            }
          >
            <p className="m-0">A skipped question counts as no answer. To answer it, use Change.</p>
          </Note>
        </div>
      )}
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
                  {labelsOf(question, chosen).map((label) => (
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
      <p className="m-0 mt-8 text-pretty text-muted-foreground">
        <span className="font-semibold text-foreground">Check the encryption first</span> opens a
        sealed copy of your answers to show it holds exactly what you chose; that copy can never be
        counted, so you then send a fresh one.
      </p>
    </EverydayFrame>
  );
}

function Opened({
  poll,
  answers,
  onBack,
}: {
  poll: EverydayPoll;
  answers: Answers;
  onBack: () => void;
}) {
  return (
    <EverydayFrame
      poll={poll}
      primary={
        <Button size="lg" className={EVERYDAY_ACTION} onClick={onBack}>
          Back to my answers
        </Button>
      }
    >
      <EverydayTitle title="Your sealed answers, opened">
        <p className="m-0">
          This is the sealed copy this device made, opened with its key, so you can see what's
          inside.
        </p>
      </EverydayTitle>
      <div className="mt-8 grid gap-4 rounded-xl border-2 border-foreground px-4 py-5">
        <div className="flex items-center gap-3">
          <Fingerprint
            value={EVERYDAY_SEALED.hash}
            label={`Fingerprint of the sealed copy, ${shortHex(EVERYDAY_SEALED.hash)}`}
            size={48}
          />
          <p className="m-0 text-sm text-muted-foreground">Inside the sealed copy</p>
        </div>
        <dl className="m-0 grid gap-3">
          {poll.questions.map((question) => {
            const chosen = answers[question.key] ?? [];
            return (
              <div key={question.key} className="grid gap-0.5">
                <dt className="text-sm text-muted-foreground">{question.text}</dt>
                <dd className="m-0 text-lg font-semibold">
                  {chosen.length === 0 ? "No answer" : labelsOf(question, chosen).join(", ")}
                </dd>
              </div>
            );
          })}
        </dl>
        <Note tone="done" title="This is what you chose" />
      </div>
      <Part title="What happens now">
        <p className="m-0">
          An opened copy can never be counted, so it is set aside on the public board as entry{" "}
          {EVERYDAY_SEALED.spoiledEntry.toLocaleString("en-US")}, where anyone can check it. Nothing
          has been sent. When you go on, your answers are sealed again with a new key.
        </p>
      </Part>
    </EverydayFrame>
  );
}

const TRAIL_STATES = { complete: "done", pending: "in progress", upcoming: "not yet" };

function Sending({ poll }: { poll: EverydayPoll }) {
  return (
    <EverydayFrame poll={poll}>
      <EverydayTitle title="Sending your answers">
        <p className="m-0">Keep this open. It usually takes a few seconds.</p>
      </EverydayTitle>
      <div className="mt-8 rounded-xl border border-border px-4 py-5">
        <StatusTrail
          label="Your answers"
          steps={[
            { label: "Sealed on this device", state: "complete" },
            { label: "Sent to the public board", state: "pending" },
            { label: "Counted", state: "upcoming", detail: `When the poll closes, ${poll.closes}` },
          ]}
          stateLabels={TRAIL_STATES}
          stepTemplate="{step}, {state}"
        />
      </div>
    </EverydayFrame>
  );
}

function Done({
  poll,
  replacing,
  onResults,
}: {
  poll: EverydayPoll;
  replacing: boolean;
  onResults: () => void;
}) {
  const live = poll.results === "live";
  return (
    <EverydayFrame
      poll={poll}
      primary={
        live ? (
          <Button size="lg" className={EVERYDAY_ACTION} onClick={onResults}>
            See results so far
          </Button>
        ) : (
          <a className={everydayLink()} href={poll.url}>
            Back to the poll's page
          </a>
        )
      }
    >
      <div className="flex items-center gap-4">
        <Fingerprint
          value={EVERYDAY_RECEIPT.hash}
          label={`Seal of your receipt, ${shortHex(EVERYDAY_RECEIPT.hash)}`}
          size={48}
        />
        <h1 className="m-0 font-heading text-3xl leading-tight font-semibold tracking-tight sm:text-4xl">
          Your answers are in
        </h1>
      </div>
      <div className="mt-4 grid gap-3 text-lg text-pretty">
        <p className="m-0">
          {replacing ? "They replace your earlier answers. " : ""}They're sealed and on the public
          board, and no one can see how you answered, including us.
        </p>
      </div>
      <Part title="Keep your receipt" className="reveal">
        <p className="m-0">
          It shows your answers are on the board, not what they were. The seal above is drawn from
          it.
        </p>
        <div>
          <Button size="lg" variant="outline" className={EVERYDAY_ACTION}>
            <Download aria-hidden="true" />
            Save receipt
          </Button>
        </div>
        <OneTapAway summary={<span className="font-medium">Show the full receipt</span>}>
          <div className="[&>[role=group]]:max-w-none">
            <ReceiptStub
              title="Your receipt"
              hash={EVERYDAY_RECEIPT.hash}
              entry={EVERYDAY_RECEIPT.entry}
              recordedAt={EVERYDAY_RECEIPT.recordedAt}
              labels={{
                hash: "Receipt hash",
                fingerprint: `Fingerprint of receipt ${shortHex(EVERYDAY_RECEIPT.hash)}`,
                entry: "Board entry",
                recordedAt: "Recorded",
              }}
            />
          </div>
          <KeyHolders poll={poll} />
        </OneTapAway>
      </Part>
      <Part title="Changed your mind?" className="reveal">
        <p className="m-0">
          You can change your answers until {poll.changeUntil}; only your last answers count.
        </p>
      </Part>
      <Part title={live ? "Results so far" : "When results appear"} className="reveal">
        {live ? (
          <p className="m-0">
            Totals are published at fixed times, each once at least {poll.batchFloor} new answers
            are in. The latest is from {poll.latest.at} UTC.
          </p>
        ) : (
          <p className="m-0">
            Results stay sealed until the poll closes, {poll.closes}. They'll appear here and on the
            poll's page then.
          </p>
        )}
      </Part>
    </EverydayFrame>
  );
}

function Results({ poll, onBack }: { poll: EverydayPoll; onBack: () => void }) {
  const { latest } = poll;
  const among = `among ${latest.people.toLocaleString("en-US")} ${poll.audience}`;
  return (
    <EverydayFrame
      poll={poll}
      primary={
        <a className={everydayLink()} href={poll.url}>
          See the poll's page
        </a>
      }
      secondary={
        <Button size="lg" variant="outline" className={EVERYDAY_ACTION} onClick={onBack}>
          Back
        </Button>
      }
    >
      <EverydayTitle title="Results so far">
        <p className="m-0 text-muted-foreground">
          updated {latest.at} UTC · {among}
        </p>
        <p className="m-0">
          Your answers aren't in these totals yet. They'll be in the next update, published once at
          least {poll.batchFloor} new answers are in.
        </p>
      </EverydayTitle>
      {poll.questions.map((question, i) => {
        const counts = latest.counts[question.key] ?? {};
        const rows = question.options.map((o) => ({
          key: o.key,
          label: o.label,
          count: counts[o.key] ?? 0,
        }));
        const leader = rows.toSorted((a, b) => b.count - a.count)[0]?.key;
        return (
          <section
            key={question.key}
            aria-labelledby={`result-${question.key}`}
            className="reveal mt-10 grid gap-4"
          >
            <p className="m-0 text-sm text-muted-foreground">Question {i + 1}</p>
            <h2 id={`result-${question.key}`} className="m-0 font-heading text-xl font-semibold">
              {question.text}
            </h2>
            <p className="m-0 text-lg text-pretty">{latest.sentences[question.key]}</p>
            <TallyBars
              caption={`Among ${latest.people.toLocaleString("en-US")} ${poll.audience}`}
              rows={rows}
              total={latest.people}
              {...(leader === undefined ? {} : { highlight: leader })}
            />
            {question.rule.kind === "one" ? null : (
              <p className="m-0 text-sm text-muted-foreground">
                People could choose more than one, so the shares add up to more than 100%.
              </p>
            )}
          </section>
        );
      })}
    </EverydayFrame>
  );
}

function Returning({ poll, onChange }: { poll: EverydayPoll; onChange: () => void }) {
  return (
    <EverydayFrame
      poll={poll}
      primary={
        <Button size="lg" className={EVERYDAY_ACTION} onClick={onChange}>
          Change my answers
        </Button>
      }
      secondary={
        <a className={everydayLink("outline")} href={poll.url}>
          Keep my earlier answers
        </a>
      }
    >
      <EverydayTitle title="You've already answered this poll">
        <p className="m-0">
          You can change your answers until {poll.changeUntil}. Your new answers replace all of your
          earlier ones; only your last answers count.
        </p>
      </EverydayTitle>
      <Part title="You'll start fresh">
        <p className="m-0">
          You'll answer all {words(poll.questions.length)} questions again, starting from nothing
          chosen. This app doesn't keep your earlier answers, so no one who picks up your phone can
          see how you answered. They're sealed on the board, where no one, including us, can show
          them back to you.
        </p>
      </Part>
      <Part title="If someone pressured you">
        <p className="m-0">
          You can change your answers later, somewhere private, and only those count.
        </p>
      </Part>
    </EverydayFrame>
  );
}

export interface EverydayBallotProps {
  poll: EverydayPoll;
  /** The screen the story opens on. */
  start?: EverydayScreen;
  /** Answers already made; a missing question is unanswered. */
  answers?: Answers;
  /** The answer the person tapped on the website, shown chosen and labelled as theirs. */
  prefill?: Answers;
  /** These answers replace earlier ones. */
  replacing?: boolean;
}

/** The whole everyday ballot, one screen at a time, from arrival to results. */
export function EverydayBallot({
  poll,
  start = { name: "question", index: 0 },
  answers: initialAnswers = {},
  prefill: initialPrefill = {},
  replacing: initialReplacing = false,
}: EverydayBallotProps) {
  const [screen, setScreen] = useState<EverydayScreen>(start);
  const [answers, setAnswers] = useState<Answers>({ ...initialPrefill, ...initialAnswers });
  const [prefill, setPrefill] = useState<Answers>(initialPrefill);
  const [replacing, setReplacing] = useState(initialReplacing);
  const [returnToCheck, setReturnToCheck] = useState(false);

  function go(next: EverydayScreen) {
    setScreen(next);
    window.scrollTo?.(0, 0);
  }

  switch (screen.name) {
    case "question": {
      const question = poll.questions[screen.index];
      const toCheck = returnToCheck || screen.index === poll.questions.length - 1;
      const after = (): EverydayScreen =>
        toCheck ? { name: "check" } : { name: "question", index: screen.index + 1 };
      return (
        <QuestionStep
          key={screen.index}
          poll={poll}
          index={screen.index}
          chosen={question === undefined ? [] : (answers[question.key] ?? [])}
          prefill={question === undefined ? [] : (prefill[question.key] ?? [])}
          toCheck={toCheck}
          onChange={(next) => {
            if (question !== undefined) setAnswers({ ...answers, [question.key]: next });
          }}
          onBack={() => go({ name: "question", index: Math.max(0, screen.index - 1) })}
          onNext={() => go(after())}
          onSkip={() => {
            if (question !== undefined) setAnswers({ ...answers, [question.key]: [] });
            go(after());
          }}
        />
      );
    }
    case "check":
      return (
        <CheckAnswers
          poll={poll}
          answers={answers}
          onChange={(index) => {
            setReturnToCheck(true);
            go({ name: "question", index });
          }}
          onSend={() => go({ name: "sending" })}
          onOpen={() => go({ name: "opened" })}
        />
      );
    case "opened":
      return <Opened poll={poll} answers={answers} onBack={() => go({ name: "check" })} />;
    case "sending":
      return <Sending poll={poll} />;
    case "done":
      return <Done poll={poll} replacing={replacing} onResults={() => go({ name: "results" })} />;
    case "results":
      return <Results poll={poll} onBack={() => go({ name: "done" })} />;
    case "returning":
      return (
        <Returning
          poll={poll}
          onChange={() => {
            setAnswers({});
            setPrefill({});
            setReplacing(true);
            go({ name: "question", index: 0 });
          }}
        />
      );
  }
}
