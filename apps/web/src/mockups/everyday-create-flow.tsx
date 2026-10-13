import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";

import { AskFields } from "./everyday-create-ask.tsx";
import { type Draft, type Errors, STEPS, type StepKey, validate } from "./everyday-create-data.ts";
import { PollPreview, StepFrame } from "./everyday-create-parts.tsx";
import {
  KeyFields,
  ResultsFields,
  ReviewBody,
  ScheduleFields,
  WhoFields,
} from "./everyday-create-steps.tsx";
import { MockShell } from "./shell.tsx";

const SCREENS: Record<StepKey, { title: string; lede: ReactNode; submit?: string }> = {
  ask: {
    title: "What would you like to ask?",
    lede: "Give your poll a title, then add your questions. Anyone can ask anything; keep it plain enough that people who disagree would still call it fair.",
  },
  who: {
    title: "Who can answer?",
    lede: "Choose who’s let in. Stricter means fewer people, but more certainty that each answer is one real person.",
  },
  results: {
    title: "How should results appear?",
    lede: "Show totals as they come in, or keep everything sealed until the poll closes. It’s your call.",
  },
  key: {
    title: "Who holds the key?",
    lede: "Answers stay locked until they’re counted. You don’t need to change anything here to publish.",
  },
  schedule: {
    title: "When can people answer?",
    lede: "Set when your poll opens and closes. Times are in UTC, the clock every poll keeps; we show your own time beside them.",
  },
  review: {
    title: "Ready to publish?",
    lede: "Here’s everything in one place. Read it through once more as someone answering would.",
    submit: "Publish poll",
  },
};

export function EverydayCreateFlow({
  initialStep = "ask",
  initialDraft,
  advancedOpen = false,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
}: {
  initialStep?: StepKey;
  initialDraft: Draft;
  /** Whether "Add your own trustees" starts expanded. */
  advancedOpen?: boolean;
  /** The author's own time zone; defaults to the browser's. */
  timeZone?: string;
}) {
  const [index, setIndex] = useState(STEPS.findIndex((s) => s.key === initialStep));
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [errors, setErrors] = useState<Errors>([]);
  const [attempt, setAttempt] = useState(0);
  const [published, setPublished] = useState(false);
  const [advanced, setAdvanced] = useState(advancedOpen);
  const summaryRef = useRef<HTMLDivElement>(null);
  const step = STEPS[index]?.key ?? "ask";

  useEffect(() => {
    if (attempt > 0) summaryRef.current?.focus();
  }, [attempt]);

  const go = (next: number) => {
    setErrors([]);
    setIndex(next);
    window.scrollTo({ top: 0 });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (step === "review") {
      setPublished(true);
      return;
    }
    const found = validate(step, draft);
    if (found.length > 0) {
      if (step === "key") setAdvanced(true);
      setErrors(found);
      setAttempt((a) => a + 1);
      return;
    }
    go(index + 1);
  };

  // A fixed field drops its error at once; new problems wait for the next Continue.
  const change = (next: Draft) => {
    setDraft(next);
    if (errors.length === 0) return;
    const still = validate(step, next);
    setErrors(errors.filter(([id, msg]) => still.some(([i, m]) => i === id && m === msg)));
  };

  let body: ReactNode;
  switch (step) {
    case "ask":
      body = <AskFields draft={draft} errors={errors} onChange={change} />;
      break;
    case "who":
      body = <WhoFields draft={draft} onChange={change} />;
      break;
    case "results":
      body = <ResultsFields draft={draft} onChange={change} />;
      break;
    case "key":
      body = (
        <KeyFields
          draft={draft}
          errors={errors}
          open={advanced}
          onOpenChange={setAdvanced}
          onChange={change}
        />
      );
      break;
    case "schedule":
      body = <ScheduleFields draft={draft} errors={errors} timeZone={timeZone} onChange={change} />;
      break;
    case "review":
      body = <ReviewBody draft={draft} published={published} onJump={go} />;
      break;
  }

  const screen = SCREENS[step];
  return (
    <MockShell current="/polls/new" signedIn>
      <StepFrame
        index={index}
        title={screen.title}
        lede={screen.lede}
        errors={errors}
        summaryRef={summaryRef}
        onJump={go}
        onSubmit={submit}
        submitLabel={screen.submit ?? "Continue"}
        preview={<PollPreview draft={draft} />}
        {...(index > 0 ? { onBack: () => go(index - 1) } : {})}
      >
        {body}
      </StepFrame>
    </MockShell>
  );
}
