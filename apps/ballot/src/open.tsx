import { Button, useI18n, useTranslate } from "@abolishus/ui";
import { useEffect, useMemo, useRef, useState } from "react";

import { type Answers, pickLanguage, questionsOf, votesOf } from "./answers.ts";
import { ArrivalCheck, ElectionRefused } from "./check.tsx";
import type { CheckedElection, ElectionCheck } from "./election.ts";
import { ACTION, EverydayFrame, Note, ScreenTitle } from "./frame.tsx";
import type { IdentityRead, Membership } from "./identity.ts";
import type { Loaded, LoadedBoard, LoadProblem } from "./load.ts";
import { catalogs, type Messages } from "./messages.ts";
import type { ProverArtifactError, ProverArtifacts } from "./prover-artifacts.ts";
import type { ProvingProgress } from "./prover-client.ts";
import { Proving, ProvingRefused, type ProvingProblem, type ProvingSteps } from "./proving.tsx";
import { AnswerQuestions } from "./questions.tsx";
import { Opened, Sealed, SealStopped, type SealProblem, Working } from "./sealed.tsx";
import type {
  CastResult,
  ChallengeResult,
  FindCellResult,
  MembershipProofProblem,
  SealResult,
} from "./worker/protocol.ts";

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
    entries: readonly Uint8Array[],
  ): Promise<ElectionCheck>;
  /** The worker's seal of `votes` in `cell` of the poll it last checked (`BallotWorker.seal`); rejects if the worker fails. */
  seal(definitionHash: Uint8Array, cell: number, votes: readonly (0 | 1)[]): Promise<SealResult>;
  /** The opening of a seal the voter challenged (`BallotWorker.challenge`); rejects if the worker fails. */
  challenge(seal: number): Promise<ChallengeResult>;
  /** The voting identity this device holds (identity.ts), read afresh for each use. */
  identity(): Promise<IdentityRead>;
  /** The election's whole board (`loadBoard`), which the worker finds the voter's cell in. */
  loadBoard(electionId: Uint8Array): Promise<LoadedBoard>;
  /**
   * The worker's search for the voter's cell in the poll it last checked
   * (`BallotWorker.findCell`), under the registrars the build pins; rejects
   * if the worker fails. `secret` is copied to the worker before this
   * returns, so the caller zeroes its own at once (T-12).
   */
  findCell(
    definitionHash: Uint8Array,
    secret: Uint8Array,
    membership: Membership,
    entries: readonly Uint8Array[],
  ): Promise<CellAnswer>;
  /**
   * The L1 block a ballot names, read from sources this client chose, never
   * from our API ([[revoting]], Client rules 1 and 2), or `undefined` while
   * the build has none (part 3c).
   */
  l1Block(): Promise<L1Block | undefined>;
  /** The release's prover artifacts, checked against their pins (`loadProverArtifacts`). */
  loadArtifacts(): Promise<ProverArtifacts | ArtifactProblem>;
  /**
   * The cast of a seal the worker holds, proved by a prover worker
   * (`castBallot`), reporting the prover's steps; rejects if either worker
   * fails. `secret` is copied to the worker before this returns, so the
   * caller zeroes its own at once (T-12).
   */
  cast(
    seal: number,
    secret: Uint8Array,
    l1: L1Block,
    artifacts: ProverArtifacts,
    onProgress: ProvingProgress,
  ): Promise<CastResult>;
}

/** An L1 block, by number and hash, that a ballot's membership message names. */
export interface L1Block {
  readonly number: bigint;
  /** 32 bytes. */
  readonly hash: Uint8Array;
}

/** `find-cell`'s answer, or `no-registrars` from a build that pins no group registry. */
export type CellAnswer = FindCellResult | { readonly ok: false; readonly problem: "no-registrars" };

/** Why the prover artifacts weren't loaded, before any prover started. */
export interface ArtifactProblem {
  readonly ok: false;
  readonly problem: ProverArtifactError["problem"];
}

type State =
  | { readonly kind: "checking" }
  | { readonly kind: "unavailable"; readonly problem: LoadProblem | "worker-failed" }
  | {
      readonly kind: "refused";
      readonly check: Extract<ElectionCheck, { ok: false }>;
      readonly registeredHash: string;
    }
  | {
      readonly kind: "ready";
      readonly election: CheckedElection;
      readonly hiddenAsThreat: boolean;
    };

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));

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
      return (
        <Ballot
          election={state.election}
          hiddenAsThreat={state.hiddenAsThreat}
          source={source}
          languages={languages}
          // A failed seal or opening checks the poll anew, in a fresh worker
          // if the last one stopped: the worker holds the poll it seals for.
          onRestart={() => setAttempt(attempt + 1)}
        />
      );
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
      loaded.entries,
    );
  } catch {
    return { kind: "unavailable", problem: "worker-failed" };
  }
  return check.ok
    ? { kind: "ready", election: check.election, hiddenAsThreat: loaded.hiddenAsThreat }
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

/** Where a voter is between answering and sending. */
type Step =
  | { readonly kind: "answering" }
  | { readonly kind: "finding" }
  | { readonly kind: "sealing" }
  | { readonly kind: "sealed"; readonly seal: number; readonly trackingCode: string }
  | { readonly kind: "opening" }
  | { readonly kind: "opened"; readonly trackingCode: string; readonly opening: Uint8Array }
  | { readonly kind: "proving"; readonly steps: ProvingSteps | undefined }
  | { readonly kind: "proving-refused"; readonly problem: ProvingProblem }
  | { readonly kind: "cast" }
  | { readonly kind: "stopped"; readonly problem: SealProblem; readonly code?: string };

const stopped = (problem: SealProblem, code?: string): Step =>
  code === undefined ? { kind: "stopped", problem } : { kind: "stopped", problem, code };

// The cast's refusals the membership proof makes, each shown on the proving
// screen; the rest are the worker's or the page's (sealed.tsx).
// A record, not a list, so a code the prover gains must be placed here.
const PROOF_PROBLEMS: Record<MembershipProofProblem | "unavailable", true> = {
  secret: true,
  root: true,
  "not-a-member": true,
  zkey: true,
  wasm: true,
  proof: true,
  rerandomised: true,
  prover: true,
  unavailable: true,
};
const isProofProblem = (problem: string): problem is keyof typeof PROOF_PROBLEMS =>
  Object.hasOwn(PROOF_PROBLEMS, problem);

// What answering again can change: the worker and the records are fetched and
// checked anew. Never after the prover saw the witness (proving.tsx, T-55),
// and never for the voter's own standing.
const RESTARTS: ReadonlySet<SealProblem> = new Set<SealProblem>([
  "seal-failed",
  "open-failed",
  "board-unavailable",
  "cell-refused",
  "cast-failed",
]);

/**
 * A checked election's questions, in the reader's language where the
 * election has it, then the seal: the voter's cell found from the board,
 * the tracking code before the choice, and a challenged seal's opening or a
 * cast seal's proof ([[challenge]], Client rules 1 and 2; [[revoting]],
 * Client rule 6). Every attempt starts from nothing chosen.
 */
export function Ballot({
  election,
  hiddenAsThreat = false,
  source,
  languages,
  onRestart,
}: {
  election: CheckedElection;
  /** Our web pages withhold the text as a threat while the poll is open: shown here under a notice (docs/moderation-policy.md, Open polls). */
  hiddenAsThreat?: boolean;
  source: Omit<ElectionSource, "load" | "check">;
  languages: readonly string[];
  /** Check the poll again from the start. */
  onRestart: () => void;
}) {
  const t = useTranslate(catalogs);
  const { locale } = useI18n();
  const [round, setRound] = useState(0);
  const [step, setStep] = useState<Step>({ kind: "answering" });
  // Each request's answer lands only on the step that asked for it: never
  // after the voter left this election, or on a later attempt.
  const asked = useRef(0);
  useEffect(() => () => void asked.current++, []);
  // The seals the voter already chose for: a second tap before the screen
  // changes neither opens a seal chosen for casting nor asks twice (T-45).
  const chosen = useRef(new Set<number>());
  const language = pickLanguage(election.translations, languages);
  const questions = useMemo(() => questionsOf(election, language), [election, language]);
  const poll = {
    definitionHash: election.definitionHash,
    closes: formatTime(locale, election.closesAt),
  };
  const definitionHash = fromHex(election.definitionHash);

  function again() {
    setStep({ kind: "answering" });
    setRound(round + 1);
  }

  /** Runs `steps`, whose screens land only while this is still the latest request. */
  function run(steps: (current: () => boolean) => Promise<Step>, failed: Step) {
    const mine = ++asked.current;
    const current = () => asked.current === mine;
    void (async () => {
      let next: Step;
      try {
        next = await steps(current);
      } catch {
        next = failed;
      }
      if (current()) setStep(next);
    })();
  }

  /**
   * The voter's cell, from the whole board and their identity, or the step
   * that says why there is none. The page's copy of the secret is zeroed as
   * soon as the worker has its own (T-12).
   */
  async function findCell(): Promise<number | Step> {
    // The board first, whatever this device holds: the fetch says nothing
    // of whether the voter has an identity in the poll's tiers (T-10).
    const board = await source.loadBoard(fromHex(election.electionId));
    if (!board.ok) return stopped("board-unavailable", board.problem);
    const read = await source.identity();
    if (read.kind !== "found")
      return stopped(read.kind === "none" ? "no-identity" : "identity-unreadable");
    const { secret, memberships } = read.identity;
    let asked: Promise<CellAnswer>;
    try {
      // One tier per cast: a voter in several of the poll's tiers casts in
      // each independently ([[revoting]], Client rule 7), the first here.
      const membership = memberships.find(({ tier }) => election.tiers.includes(tier));
      if (membership === undefined) return stopped("not-listed");
      asked = source.findCell(definitionHash, secret, membership, board.entries);
    } finally {
      secret.fill(0);
    }
    const found = await asked;
    if (found.ok) return found.cell;
    switch (found.problem) {
      case "no-registrars":
        return stopped("no-registrars");
      case "secret":
        return stopped("identity-unreadable");
      case "no-election":
        return stopped("seal-failed");
      case "cell":
        return stopped("cell-refused", found.code);
    }
  }

  function seal(answers: Answers) {
    if (election.version !== 5) return setStep(stopped("cant-seal-version"));
    const votes = votesOf(questions, answers);
    setStep({ kind: "finding" });
    run(async (current) => {
      const cell = await findCell();
      if (typeof cell !== "number") return cell;
      if (current()) setStep({ kind: "sealing" });
      const sealed = await source.seal(definitionHash, cell, votes);
      // A code of any other length is the worker's fault, shown as one.
      return sealed.ok && sealed.trackingCode.length === 32
        ? { kind: "sealed", seal: sealed.seal, trackingCode: toHex(sealed.trackingCode) }
        : stopped("seal-failed");
    }, stopped("seal-failed"));
  }

  function choose(seal: number): boolean {
    if (chosen.current.has(seal)) return false;
    chosen.current.add(seal);
    return true;
  }

  function challenge(seal: number, shown: string) {
    if (!choose(seal)) return;
    setStep({ kind: "opening" });
    run(async () => {
      const opened = await source.challenge(seal);
      // The worker opens only the core it sealed; an opening of any other is
      // a fault this device reports, never one it hands over (T-42).
      return opened.ok && toHex(opened.trackingCode) === shown
        ? { kind: "opened", trackingCode: shown, opening: opened.opening }
        : stopped("open-failed");
    }, stopped("open-failed"));
  }

  // The proof is made only now, once the voter chose to cast ([[revoting]],
  // Client rule 6), and the page never asks to open this seal again, so a
  // ballot the voter chose to cast is never challenged (T-45).
  function cast(seal: number) {
    if (!choose(seal)) return;
    setStep({ kind: "proving", steps: undefined });
    run(
      async (current) => {
        const l1 = await source.l1Block();
        if (l1 === undefined) return stopped("no-l1");
        const artifacts = await source.loadArtifacts();
        if ("ok" in artifacts) return { kind: "proving-refused", problem: artifacts.problem };
        // Read only now, so the page holds the secret for no download.
        const read = await source.identity();
        if (read.kind !== "found")
          return stopped(read.kind === "none" ? "no-identity" : "identity-unreadable");
        const { secret } = read.identity;
        // A step the prover reports after the ballot worker answered never
        // puts the voter back on the proving screen.
        let finished = false;
        let asked: Promise<CastResult>;
        try {
          asked = source.cast(seal, secret, l1, artifacts, (done, of) => {
            if (current() && !finished) setStep({ kind: "proving", steps: { done, of } });
          });
        } finally {
          secret.fill(0);
        }
        const cast = await asked.finally(() => (finished = true));
        if (cast.ok) return { kind: "cast" };
        if (isProofProblem(cast.problem)) return { kind: "proving-refused", problem: cast.problem };
        // A record that fails this device's own admission checks was made
        // after the prover saw the witness: shown, never retried (T-55).
        return cast.problem === "ballot"
          ? stopped("cast-faulty", cast.code)
          : stopped("cast-failed", cast.problem);
      },
      // Also an L1 or storage read that threw before any witness: shown as
      // the worker's failure, without a retry, which is the safe side.
      { kind: "proving-refused", problem: "worker-failed" },
    );
  }

  switch (step.kind) {
    case "answering":
      return (
        <AnswerQuestions
          // A fresh start each round: nothing chosen carries over (questions.tsx).
          key={`${election.definitionHash}/${round}`}
          poll={poll}
          questions={questions}
          arrival={
            <div className="grid gap-4">
              {hiddenAsThreat ? (
                <Note tone="warn" title={t("hiddenAsThreatTitle")}>
                  <p className="m-0">{t("hiddenAsThreat")}</p>
                </Note>
              ) : null}
              <ArrivalCheck definitionHash={election.definitionHash} />
            </div>
          }
          onSeal={seal}
        />
      );
    case "finding":
    case "sealing":
    case "opening":
      return <Working poll={poll} kind={step.kind} />;
    case "sealed":
      return (
        <Sealed
          poll={poll}
          electionId={election.electionId}
          trackingCode={step.trackingCode}
          onCast={() => cast(step.seal)}
          onChallenge={() => challenge(step.seal, step.trackingCode)}
        />
      );
    case "opened":
      return (
        <Opened
          poll={poll}
          trackingCode={step.trackingCode}
          opening={step.opening}
          onAgain={again}
        />
      );
    case "proving":
      return <Proving steps={step.steps} />;
    case "proving-refused":
      return <ProvingRefused problem={step.problem} onRetry={onRestart} />;
    case "cast":
      return (
        <NotSent definitionHash={election.definitionHash} closes={poll.closes} onAgain={again} />
      );
    case "stopped":
      return (
        <SealStopped
          poll={poll}
          problem={step.problem}
          code={step.code}
          onAgain={RESTARTS.has(step.problem) ? onRestart : undefined}
        />
      );
  }
}

/** A cast, until part 3c sends it: says plainly that nothing was sent. */
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
