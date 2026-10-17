import { Button, useI18n, useTranslate } from "@abolishus/ui";
import { useEffect, useMemo, useState } from "react";

import { pickLanguage, questionsOf } from "./answers.ts";
import { ArrivalCheck, ElectionRefused } from "./check.tsx";
import type { CheckedElection, ElectionCheck } from "./election.ts";
import { ACTION, EverydayFrame, Note, ScreenTitle } from "./frame.tsx";
import type { Loaded, LoadProblem } from "./load.ts";
import { catalogs, type Messages } from "./messages.ts";
import { AnswerQuestions } from "./questions.tsx";

// Opening the election a ballot link names (P2-8 part 2b-2): the page fetches
// the registry's hash and the records (load.ts), the worker checks them
// (election.ts), and only an election that passed is shown. Every other end
// is a screen that says what stopped it and shows no poll text (T-34, T-41).

/** Where the records come from and who checks them; injected so stories and tests need no network or worker. */
export interface ElectionSource {
  /** `signal` aborts the requests of a load nobody waits for any more (another link, a retry). */
  load(electionId: Uint8Array, signal: AbortSignal): Promise<Loaded>;
  /** The worker's check (`BallotWorker.checkElection`); rejects if the worker fails. */
  check(
    electionId: Uint8Array,
    registeredHash: Uint8Array,
    definition: Uint8Array,
    displayText: Uint8Array,
  ): Promise<ElectionCheck>;
}

type State =
  | { readonly kind: "checking" }
  | { readonly kind: "unavailable"; readonly problem: LoadProblem | "worker-failed" }
  | {
      readonly kind: "refused";
      readonly check: Extract<ElectionCheck, { ok: false }>;
      readonly registeredHash: string;
    }
  | { readonly kind: "ready"; readonly election: CheckedElection };

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Fetches, checks and shows one election; `origin` is the page's own, which `onSharedGatewayPath` passed. */
export function OpenElection({
  electionId,
  source,
  origin,
  languages,
}: {
  electionId: Uint8Array;
  source: ElectionSource;
  origin: string;
  /** The reader's preferred languages, most preferred first (`navigator.languages`). */
  languages: readonly string[];
}) {
  const [state, setState] = useState<State>({ kind: "checking" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "checking" });
    void (async () => {
      const next = await open(source, electionId, controller.signal);
      if (!controller.signal.aborted) setState(next);
    })();
    return () => controller.abort();
  }, [source, electionId, attempt]);

  switch (state.kind) {
    case "checking":
      // After "Try again", whose button is gone now, focus moves to the title.
      return <Checking focus={attempt > 0} />;
    case "unavailable":
      return <Unavailable problem={state.problem} onRetry={() => setAttempt(attempt + 1)} />;
    case "refused":
      return (
        <ElectionRefused
          refusal={state.check}
          registeredHash={state.registeredHash}
          origin={origin}
        />
      );
    case "ready":
      return <Ballot election={state.election} languages={languages} />;
  }
}

async function open(
  source: ElectionSource,
  electionId: Uint8Array,
  signal: AbortSignal,
): Promise<State> {
  let loaded: Loaded;
  try {
    loaded = await source.load(electionId, signal);
  } catch {
    // load.ts turns every network and answer failure into a problem; anything
    // else is a fault of this page, shown the same way rather than as a blank.
    return { kind: "unavailable", problem: "unreachable" };
  }
  if (!loaded.ok) return { kind: "unavailable", problem: loaded.problem };
  let check: ElectionCheck;
  try {
    check = await source.check(
      electionId,
      loaded.registeredHash,
      loaded.definition,
      loaded.displayText,
    );
  } catch {
    return { kind: "unavailable", problem: "worker-failed" };
  }
  return check.ok
    ? { kind: "ready", election: check.election }
    : { kind: "refused", check, registeredHash: toHex(loaded.registeredHash) };
}

/** While the page fetches and the worker checks: no poll text yet, nothing to press. */
export function Checking({ focus = false }: { focus?: boolean }) {
  const t = useTranslate(catalogs);
  return (
    <EverydayFrame>
      <ScreenTitle title={t("checkingTitle")} focus={focus}>
        <p className="m-0" role="status">
          {t("checking")}
        </p>
      </ScreenTitle>
    </EverydayFrame>
  );
}

const UNAVAILABLE: Record<
  LoadProblem | "worker-failed",
  { readonly title: keyof Messages; readonly detail: keyof Messages; readonly retry: boolean }
> = {
  "no-registry": { title: "noRegistryTitle", detail: "noRegistry", retry: false },
  "wrong-chain": { title: "wrongChainTitle", detail: "wrongChain", retry: true },
  "not-registered": { title: "notRegisteredTitle", detail: "notRegistered", retry: true },
  "not-found": { title: "notFoundTitle", detail: "notFound", retry: true },
  withheld: { title: "withheldTitle", detail: "withheld", retry: false },
  unreachable: { title: "unreachableTitle", detail: "unreachable", retry: true },
  "bad-answer": { title: "badAnswerTitle", detail: "badAnswer", retry: true },
  "worker-failed": { title: "workerFailedTitle", detail: "workerFailed", retry: true },
};

/** The election couldn't be fetched or checked: what stopped it, and a retry where one could help. */
export function Unavailable({
  problem,
  onRetry,
}: {
  problem: LoadProblem | "worker-failed";
  onRetry: () => void;
}) {
  const t = useTranslate(catalogs);
  const { title, detail, retry } = UNAVAILABLE[problem];
  return (
    <EverydayFrame
      primary={
        retry ? (
          <Button className={ACTION} onClick={onRetry}>
            {t("tryAgain")}
          </Button>
        ) : undefined
      }
    >
      <ScreenTitle title={t(title)} focus>
        <p className="m-0">{t(detail)}</p>
      </ScreenTitle>
    </EverydayFrame>
  );
}

/** The link's fragment names no election. */
export function BrokenLink() {
  const t = useTranslate(catalogs);
  return (
    <EverydayFrame>
      <ScreenTitle title={t("brokenLinkTitle")}>
        <p className="m-0">{t("brokenLink")}</p>
      </ScreenTitle>
    </EverydayFrame>
  );
}

/** A checked election's questions, in the reader's language where the election has it. */
export function Ballot({
  election,
  languages,
}: {
  election: CheckedElection;
  languages: readonly string[];
}) {
  const { locale } = useI18n();
  const [round, setRound] = useState(0);
  const [stopped, setStopped] = useState(false);
  const language = pickLanguage(election.translations, languages);
  const questions = useMemo(() => questionsOf(election, language), [election, language]);
  const poll = {
    definitionHash: election.definitionHash,
    closes: formatTime(locale, election.closesAt),
  };
  if (stopped)
    return (
      <NotSent
        definitionHash={election.definitionHash}
        closes={poll.closes}
        onAgain={() => {
          setStopped(false);
          setRound(round + 1);
        }}
      />
    );
  return (
    <AnswerQuestions
      // A fresh start each round: nothing chosen carries over (questions.tsx).
      key={`${election.definitionHash}/${round}`}
      poll={poll}
      questions={questions}
      arrival={<ArrivalCheck definitionHash={election.definitionHash} />}
      // Sealing and sending are part 3; until then nothing leaves the page.
      onSend={() => setStopped(true)}
      onChallenge={() => setStopped(true)}
    />
  );
}

/** Until part 3 seals and sends: says plainly that nothing was sent. */
export function NotSent({
  definitionHash,
  closes,
  onAgain,
}: {
  definitionHash: string;
  closes: string;
  onAgain: () => void;
}) {
  const t = useTranslate(catalogs);
  return (
    <EverydayFrame
      poll={{ definitionHash, closes }}
      primary={
        <Button className={ACTION} onClick={onAgain}>
          {t("answerAgain")}
        </Button>
      }
    >
      <ScreenTitle title={t("notSentTitle")} focus>
        <p className="m-0">{t("notSent")}</p>
      </ScreenTitle>
      <div className="mt-8">
        <Note title={t("localTitle")}>
          <p className="m-0">{t("local")}</p>
        </Note>
      </div>
    </EverydayFrame>
  );
}

// The largest time a Date holds, in milliseconds either side of the epoch.
const MAX_DATE_MS = 8.64e15;

/** Seconds since the epoch, for the reader; a time no Date holds is shown as the seconds themselves. */
export function formatTime(locale: string, seconds: bigint): string {
  const ms = Number(seconds) * 1000;
  if (!(Math.abs(ms) <= MAX_DATE_MS)) return seconds.toString();
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(ms),
  );
}
