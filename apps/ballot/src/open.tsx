import type { CastShare } from "@abolishus/crypto";
import { Button, useI18n, useTranslate } from "@abolishus/ui";
import { useEffect, useMemo, useRef, useState } from "react";

import { type Answers, pickLanguage, questionsOf, votesOf } from "./answers.ts";
import {
  type Boarded,
  type CastAsked,
  type CastsRead,
  type CheckedReceipt,
  type DeclinePostingOutcome,
  type EraseSharesOutcome,
  keepsShares,
  newestBlock,
  type RecordBoardedOutcome,
  type RecordCastOutcome,
  type RecordReceiptOutcome,
  unboardedReceipts,
  unsentCast,
} from "./casts.ts";
import { ArrivalCheck, ElectionRefused } from "./check.tsx";
import type { CheckedElection, ElectionCheck } from "./election.ts";
import { ACTION, EverydayFrame, Note, ScreenTitle } from "./frame.tsx";
import type { IdentityRead, Membership } from "./identity.ts";
import type { Delivery, IntakeAnswer } from "./intake.ts";
import { passedOnDevice, postingCutoff, postingLapsed } from "./lapse.ts";
import type { ElectionLock } from "./lock.ts";
import type { Loaded, LoadedBoard, LoadedChainTime, LoadProblem } from "./load.ts";
import { catalogs, type Messages } from "./messages.ts";
import { Declined, PostingOffer } from "./posting-offer.tsx";
import type { ProverArtifactError, ProverArtifacts } from "./prover-artifacts.ts";
import type { ProvingProgress } from "./prover-client.ts";
import { Proving, ProvingRefused, type ProvingProblem, type ProvingSteps } from "./proving.tsx";
import { AnswerQuestions } from "./questions.tsx";
import { checkReceiptEntry, type ReceiptAnswer } from "./receipts.ts";
import { type Held, Register, type Registrar, RegisterWaiting } from "./register.tsx";
import {
  Opened,
  Sealed,
  SealStopped,
  type SealProblem,
  Sent,
  Unsent,
  type UnsentReason,
  Working,
} from "./sealed.tsx";
import { checkBoarded, type SendAnswer } from "./send.ts";
import { formatTime } from "./time.ts";
import type { WalletAnswer } from "./wallet.ts";
import type {
  CastResult,
  ChallengeResult,
  DeclineResult,
  FindCellResult,
  IntakeResult,
  MembershipProofProblem,
  PostingResult,
  ReceiptResult,
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
  /**
   * This device's casts in `electionId` at `tier` (`readCasts`), read afresh
   * before each cast is proved.
   */
  casts(electionId: Uint8Array, tier: number): Promise<CastsRead>;
  /**
   * Records a cast's ballot with its qualified seats' shares before it
   * leaves the device (`recordCast`), only if it names exactly what the cast
   * asked for (`castAsAsked`), and `not-asked` otherwise ([[revoting]],
   * Client rule 3; [[delivery]], Client rule 4).
   */
  record(
    electionId: Uint8Array,
    tier: number,
    ballot: Uint8Array,
    shares: readonly CastShare[],
    asked: CastAsked,
  ): Promise<RecordCastOutcome | "not-asked">;
  /** The stub and transcript each seat's intake takes, from the poll the worker last checked (`BallotWorker.intake`). */
  intake(definitionHash: Uint8Array): Promise<IntakeResult>;
  /** Delivers a recorded cast's share to its seat's intake through the operator's relay (`deliverShare`). */
  deliver(seat: number, delivery: Delivery): Promise<IntakeAnswer>;
  /**
   * The worker's check of an intake's answer for a cast of the poll it
   * holds (`BallotWorker.receipt`), which also erases that seat's `m_i`
   * from the seal it cast; rejects if the worker fails.
   */
  receipt(
    ballot: Uint8Array,
    receipt: Uint8Array,
  ): Promise<
    | { readonly ok: true; readonly checked: CheckedReceipt }
    | Extract<ReceiptResult, { readonly ok: false }>
  >;
  /**
   * The worker's check that a seat's kept share would deliver it if posted
   * (`BallotWorker.posting`), before any posting is offered or made
   * ([[delivery]], Client rule 4); rejects if the worker fails. The worker
   * gets its own copy of `m`.
   */
  posting(ballot: Uint8Array, share: PostingShare): Promise<PostingResult>;
  /**
   * Posts each of `postings`, the posting records the worker made from the
   * kept shares of the recorded cast whose bytes are `ballot`, through the
   * contract path, the only path a posting delivers by ([[delivery]],
   * Direct submit), answering `recorded` only once every one is recorded by
   * the contract, and by `cutoff`, the poll's `c_D` in seconds, at the
   * latest ([[posting-relay]], Outcome); absent while the build has no
   * contract path, and then no posting is offered. The caller zeroes the
   * records once this settles.
   */
  readonly post?: (
    electionId: Uint8Array,
    ballot: Uint8Array,
    postings: readonly Uint8Array[],
    cutoff: bigint,
  ) => Promise<PostAnswer>;
  /**
   * Posts each of `postings` as `post` does, from the voter's own wallet
   * once a run through the relay fell back ([[posting-relay]], Own wallet;
   * [[0042-posting-relay]], rule 6), answering `recorded` only once every
   * one is recorded by the contract, and sending nothing past `cutoff`, the
   * poll's `c_D`; absent where `post` is, and then never offered. The caller
   * zeroes the records once this settles.
   */
  readonly postOwn?: (
    electionId: Uint8Array,
    ballot: Uint8Array,
    postings: readonly Uint8Array[],
    cutoff: bigint,
  ) => Promise<WalletAnswer>;
  /**
   * The election's lock across this origin's tabs (`electionLock`), held
   * from a posting's check through its posting and by every delivery and
   * decline of the election's casts, so no tab keeps a receipt for, or
   * erases, a seat another is posting ([[delivery]], Client rule 2);
   * absent where the browser has no Web Locks, and then no posting is
   * offered, whatever `post` says.
   */
  readonly exclusive?: ElectionLock;
  /**
   * Erases the unreceipted seats' `ct_i` and `m_i` of the recorded cast
   * whose bytes are `ballot`, once the voter declined to post them
   * (`declinePosting`).
   */
  declinePosting(
    electionId: Uint8Array,
    tier: number,
    ballot: Uint8Array,
  ): Promise<DeclinePostingOutcome>;
  /** The worker's erasure of every `m_i` its seals keep for `ballot` once the voter declined (`BallotWorker.decline`). */
  declineSeal(ballot: Uint8Array): Promise<DeclineResult>;
  /**
   * Erases every unreceipted seat's `ct_i` and `m_i` from the recorded casts
   * (`eraseShares`), once the poll's posting cutoff passed.
   */
  eraseShares(electionId: Uint8Array, tier: number): Promise<EraseSharesOutcome>;
  /** The timestamp of the L2's finalized head (`loadChainTime`), read only when a cutoff may have passed. */
  chainTime(): Promise<LoadedChainTime>;
  /** This device's clock, in milliseconds since the epoch. */
  now(): number;
  /** The release's `F`, in seconds (`Deployment.forcedInclusion`): the posting cutoff is `t_D − F`. */
  readonly forcedInclusion: bigint;
  /** Keeps a checked receipt in place of its seat's `m_i` in the recorded casts (`recordReceipt`). */
  keepReceipt(
    electionId: Uint8Array,
    tier: number,
    ballot: Uint8Array,
    checked: CheckedReceipt,
  ): Promise<RecordReceiptOutcome>;
  /** Sends a recorded cast's bytes to the ballot route (`sendBallot`). */
  send(electionId: Uint8Array, ballot: Uint8Array): Promise<SendAnswer>;
  /** Keeps the operator's checked answer for a recorded cast (`recordBoarded`). */
  keepBoarded(
    electionId: Uint8Array,
    tier: number,
    ballot: Uint8Array,
    boarded: Boarded,
  ): Promise<RecordBoardedOutcome>;
  /** Submits a kept receipt through the operator's board path (`submitReceipt`). */
  submitReceipt(electionId: Uint8Array, receipt: Uint8Array): Promise<ReceiptAnswer>;
  /**
   * Keeps the operator's checked board entry for a receipt beside the
   * seat's receipt in the recorded casts (`recordReceiptBoarded`).
   */
  keepReceiptBoarded(
    electionId: Uint8Array,
    tier: number,
    ballot: Uint8Array,
    checked: CheckedReceipt,
    boarded: Boarded,
  ): Promise<RecordReceiptOutcome>;
  /**
   * Tier 0 registration, for a voter whose identity is in none of a poll's
   * tiers where the poll admits Tier 0, or `undefined` while the build can't
   * register anyone (no published region, no challenge frame).
   */
  readonly registrar: Registrar | undefined;
  /**
   * Whether this build has every route to a seat's intake that
   * [[delivery]], Client rule 4, asks for before delivery counts as failed:
   * the operator's relay, a node's own endpoint through an anonymiser, and
   * the posting the voter may choose (`post`). Until one does, no ballot is made:
   * the relay holds the whole record, and an operator that refuses one seat
   * could board it undelivered, outranking the voter's earlier ballot and
   * voiding their vote ([[revoting]], Selection; T-25).
   */
  readonly delivers: boolean;
}

/** One unreceipted seat's kept share: its `ct_i` and ML-KEM message `m_i`. */
export interface PostingShare {
  readonly seat: number;
  readonly ciphertext: Uint8Array;
  readonly m: Uint8Array;
}

/**
 * A posting's outcome: `recorded` by the contract, `refused` by it,
 * `relayed` (not recorded, but sent to the relay, which may have read their
 * `m_i`, so they are out of the voter's hands and may still land), or
 * `unreachable` (never sent),
 * which may still land too: a posting is the same whoever boards it, so
 * posting again is safe.
 */
export type PostAnswer = "recorded" | "refused" | "relayed" | "unreachable";

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
const equalBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

/** Fetches, checks and shows one election; `origin` is the page's own, which `onSharedGatewayPath` passed. */
export function OpenElection({
  electionId,
  pick,
  source,
  origin,
  languages,
}: {
  electionId: Uint8Array;
  /** The first question's option the link was tapped on, chosen until the ballot restarts. */
  pick?: number | undefined;
  source: ElectionSource;
  origin: string;
  /** The reader's preferred languages, most preferred first (`navigator.languages`). */
  languages: readonly string[];
}) {
  const [state, setState] = useState<State>({ kind: "checking" });
  const [attempt, setAttempt] = useState(0);
  // The link's pick holds until a ballot restarts; a load that failed and
  // was tried again showed no ballot, so it keeps it. A later link (a new
  // fragment, so new bytes) brings its own pick.
  const [restartedFor, setRestartedFor] = useState<Uint8Array | undefined>(undefined);

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
          // Each check starts the ballot afresh, even where React renders the
          // new check's answer without the checking screen between: a restart
          // asked for from a promise can land in one batch with it.
          key={attempt}
          election={state.election}
          hiddenAsThreat={state.hiddenAsThreat}
          pick={restartedFor === electionId ? undefined : pick}
          source={source}
          languages={languages}
          // A failed seal or opening checks the poll anew, in a fresh worker
          // if the last one stopped: the worker holds the poll it seals for.
          onRestart={() => {
            setRestartedFor(electionId);
            setAttempt(attempt + 1);
          }}
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
  | { readonly kind: "resuming" }
  | { readonly kind: "answering" }
  | { readonly kind: "finding" }
  | { readonly kind: "sealing" }
  | {
      readonly kind: "sealed";
      readonly seal: number;
      readonly trackingCode: string;
      /** The voter's cell, and the tier it is in, that the seal was made for. */
      readonly cell: number;
      readonly tier: number;
    }
  | { readonly kind: "opening" }
  | { readonly kind: "opened"; readonly trackingCode: string; readonly opening: Uint8Array }
  | { readonly kind: "proving"; readonly steps: ProvingSteps | undefined }
  | { readonly kind: "proving-refused"; readonly problem: ProvingProblem }
  | { readonly kind: "delivering" }
  | { readonly kind: "sending" }
  | { readonly kind: "checking-posting" }
  | {
      readonly kind: "offer";
      readonly sending: Sending;
      /** A posting the voter chose didn't go through. */
      readonly failed?: true;
      /** And the relay had its parts, which may still reach the board. */
      readonly relayed?: true;
      /**
       * A run through the relay fell back, so the voter's own wallet may be
       * offered ([[0042-posting-relay]], rule 6): never before, while the
       * relay may still record.
       */
      readonly fallback?: true;
      /** What the voter's own wallet last met, if it didn't record them. */
      readonly wallet?: Exclude<WalletAnswer, "recorded">;
    }
  | { readonly kind: "declining" }
  | { readonly kind: "posting" }
  | { readonly kind: "posting-wallet" }
  | { readonly kind: "declined" }
  | {
      readonly kind: "unsent";
      readonly reason: UnsentReason;
      readonly sending: Sending;
    }
  | { readonly kind: "sent"; readonly trackingCode: string; readonly index?: bigint }
  | { readonly kind: "register"; readonly registrar: Registrar; readonly held: Held }
  | { readonly kind: "waiting"; readonly acceptedAt: number }
  | { readonly kind: "stopped"; readonly problem: SealProblem; readonly code?: string };

/** A recorded cast, as every send of it sends it: the same bytes each time. */
interface Sending {
  readonly ballot: Uint8Array;
  readonly tier: number;
  readonly trackingCode: string;
  /** Its qualified seats with no receipt kept yet, each with its `ct_i`: delivered before the ballot is sent. */
  readonly undelivered: readonly { readonly seat: number; readonly ciphertext: Uint8Array }[];
  /** Found recorded on opening the poll, not cast on this page: the voter may leave it and answer anew. */
  readonly resumed?: true;
}

/** Deliveries in flight at once: the relay takes a few at a time from everyone (T-52). */
const DELIVERIES_AT_ONCE = 4;

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
// checked anew. Never for an outcome the prover, or whoever sees when ballots
// arrive, could choose after the prover saw the witness: each retry would be
// another sample of it (proving.tsx, T-55). This device's own records may
// stop a cast after the proof, and are no such party's choice. Never for the
// voter's own standing.
const RESTARTS: ReadonlySet<SealProblem> = new Set<SealProblem>([
  "seal-failed",
  "open-failed",
  "board-unavailable",
  "cell-refused",
  "cast-failed",
  "casts-unreadable",
  "casts-unwritable",
  "not-newer",
]);

/**
 * A checked election's questions, in the reader's language where the
 * election has it, then the seal: the voter's cell found from the board,
 * the tracking code before the choice, and a challenged seal's opening or a
 * cast seal's proof ([[challenge]], Client rules 1 and 2; [[revoting]],
 * Client rule 6). Every attempt starts from nothing chosen, but the first
 * shown with the link's `pick` ([[first-answer]], step 1).
 */
export function Ballot({
  election,
  hiddenAsThreat = false,
  pick,
  source,
  languages,
  onRestart,
}: {
  election: CheckedElection;
  /** Our web pages withhold the text as a threat while the poll is open: shown here under a notice (docs/moderation-policy.md, Open polls). */
  hiddenAsThreat?: boolean;
  /** The first question's option the link was tapped on, chosen in the first round only. */
  pick?: number | undefined;
  source: Omit<ElectionSource, "load" | "check">;
  languages: readonly string[];
  /** Check the poll again from the start. */
  onRestart: () => void;
}) {
  const t = useTranslate(catalogs);
  const { locale } = useI18n();
  const [round, setRound] = useState(0);
  // Only a build that delivers ever recorded a cast to resume, and only
  // under a definition it seals for.
  const [step, setStep] = useState<Step>(() =>
    source.delivers && election.version === 5 ? { kind: "resuming" } : { kind: "answering" },
  );
  // Each request's answer lands only on the step that asked for it: never
  // after the voter left this election, or on a later attempt.
  const asked = useRef(0);
  useEffect(() => () => void asked.current++, []);
  useEffect(() => {
    if (step.kind === "resuming") run(resume, { kind: "answering" });
    // Once per mount: every restart mounts the ballot afresh.
  }, []);
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
  const electionId = fromHex(election.electionId);

  /** The poll's posting cutoff `c_D`, in seconds ([[delivery]], Client rule 4). */
  const cutoff = () =>
    postingCutoff(election.closesAt, election.l1InclusionBound, source.forcedInclusion);

  /** Runs `steps` under the election's lock, where the build has one (`ElectionSource.exclusive`). */
  const locked = <T,>(steps: () => Promise<T>): Promise<T> =>
    source.exclusive === undefined ? steps() : source.exclusive(electionId, steps);
  // A posting only under the lock: without it another tab could keep a
  // receipt for a seat this one posts (Client rule 2; T-15).
  const posting = source.exclusive === undefined ? undefined : source.post;
  const postingOwn = posting === undefined ? undefined : source.postOwn;

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
   * A cast this device recorded in one of the poll's tiers that the board
   * never confirmed, offered to be delivered and sent with the same bytes
   * before anything is answered: the page that recorded it may have gone
   * before its seats were receipted or its ballot sent (a reload, a crash,
   * a store that refused a receipt), and only this device can finish it
   * ([[revoting]], Client rule 3; [[delivery]], Client rule 4; T-25). A
   * seat whose `m_i` is still kept is delivered again, so a receipt the
   * store refused after the worker erased its seal's copy is asked for once
   * more, and its node answers with the same receipt (T-18). Casts that
   * can't be read offer nothing here: the cast's own read stops on them.
   * Once the poll's posting cutoff passed, every unreceipted seat's `ct_i`
   * and `m_i` are erased first, and a cast holding an erased seat is never
   * offered ([[delivery]], Client rule 4).
   */
  async function resume(): Promise<Step> {
    const c = cutoff();
    // The chain's time, read at most once, and only for a tier that keeps a
    // share past the cutoff by this device's clock: most visits read nothing.
    let chain: Promise<LoadedChainTime> | undefined;
    for (const tier of election.tiers) {
      let held = await source.casts(electionId, tier);
      if (held.kind === "unreadable") continue;
      if (keepsShares(held.casts) && passedOnDevice(c, source.now())) {
        chain ??= source.chainTime();
        const time = await chain;
        // An RPC that fails or answers wrongly leaves the shares kept: erasing
        // on its word alone could lose a posting still in time (T-25). Not
        // under the election's lock: past the cutoff no posting is in time,
        // and one still running posts from its own copies.
        if (time.ok && postingLapsed(c, time.timestamp, source.now())) {
          await source.eraseShares(electionId, tier);
          held = await source.casts(electionId, tier);
          if (held.kind === "unreadable") continue;
        }
      }
      const unsent = unsentCast(held.casts, definitionHash);
      if (unsent === undefined) continue;
      if (unsent === "other-election") return stopped("cast-faulty");
      const { ballot, trackingCode, undelivered } = unsent;
      return {
        kind: "unsent",
        reason: "earlier",
        sending: { ballot, tier, trackingCode: toHex(trackingCode), undelivered, resumed: true },
      };
    }
    return { kind: "answering" };
  }

  /**
   * The voter's cell, from the whole board and their identity, or the step
   * that says why there is none. The page's copy of the secret is zeroed as
   * soon as the worker has its own (T-12).
   */
  async function findCell(): Promise<{ readonly cell: number; readonly tier: number } | Step> {
    // The board first, whatever this device holds: the fetch says nothing
    // of whether the voter has an identity in the poll's tiers (T-10).
    const board = await source.loadBoard(electionId);
    if (!board.ok) return stopped("board-unavailable", board.problem);
    const read = await source.identity();
    // Registering helps only where the poll admits Tier 0.
    const registrar = election.tiers.includes(0) ? source.registrar : undefined;
    if (read.kind === "none")
      return registrar === undefined
        ? stopped("no-identity")
        : { kind: "register", registrar, held: "none" };
    if (read.kind !== "found") return stopped("identity-unreadable");
    const { secret, memberships, tier0Request, recovered } = read.identity;
    let asked: Promise<CellAnswer>;
    let tier: number;
    try {
      // A recovered identity starts without this device's records of the
      // polls it was cast in, which the cast's checks need first: showing
      // the voter their earlier ballots and one device per poll
      // ([[0017-identity-recovery-backup]], Consequences; T-18). Until those
      // checks exist (part 3c), nothing is sealed for it.
      if (recovered === true) return stopped("recovered");
      // One tier per cast: a voter in several of the poll's tiers casts in
      // each independently ([[revoting]], Client rule 7), the first here.
      const membership = memberships.find(({ tier }) => election.tiers.includes(tier));
      if (membership === undefined) {
        if (!election.tiers.includes(0)) return stopped("not-listed");
        // A request that went: its outcome is read from the group registry,
        // by a build that can; one that can't says when it went.
        if (tier0Request !== undefined)
          return registrar === undefined
            ? { kind: "waiting", acceptedAt: tier0Request.acceptedAt }
            : { kind: "register", registrar, held: "waiting" };
        // An identity made here whose request never went: registered now,
        // never replaced by a new one.
        if (memberships.length === 0)
          return registrar === undefined
            ? stopped("unregistered")
            : { kind: "register", registrar, held: "made" };
        return stopped("not-listed");
      }
      tier = membership.tier;
      asked = source.findCell(definitionHash, secret, membership, board.entries);
    } finally {
      secret.fill(0);
    }
    const found = await asked;
    if (found.ok) return { cell: found.cell, tier };
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
      const found = await findCell();
      if ("kind" in found) return found;
      const { cell, tier } = found;
      if (current()) setStep({ kind: "sealing" });
      const sealed = await source.seal(definitionHash, cell, votes);
      // A code of any other length is the worker's fault, shown as one.
      return sealed.ok && sealed.trackingCode.length === 32
        ? {
            kind: "sealed",
            seal: sealed.seal,
            trackingCode: toHex(sealed.trackingCode),
            cell,
            tier,
          }
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
  function cast({ seal, cell, tier, trackingCode }: Extract<Step, { kind: "sealed" }>) {
    if (!choose(seal)) return;
    setStep({ kind: "proving", steps: undefined });
    run(
      async (current) => {
        if (!source.delivers) return stopped("no-delivery");
        const l1 = await source.l1Block();
        if (l1 === undefined) return stopped("no-l1");
        // This device's casts before the artifacts and the secret: a ballot
        // on a block not newer than one it sent would tie that one or lose
        // to it, so it is never made ([[revoting]], Client rule 3; T-45).
        const held = await source.casts(electionId, tier);
        if (held.kind === "unreadable") return stopped("casts-unreadable");
        const newest = newestBlock(held.casts);
        if (newest !== undefined && l1.number <= newest) return stopped("not-newer");
        const artifacts = await source.loadArtifacts();
        if ("ok" in artifacts) return { kind: "proving-refused", problem: artifacts.problem };
        // Read only now, so the page holds the secret for no download.
        const read = await source.identity();
        if (read.kind !== "found")
          return stopped(read.kind === "none" ? "no-identity" : "identity-unreadable");
        const { secret, recovered } = read.identity;
        // Recovered since the seal (another tab): refused as at the search.
        if (recovered === true) {
          secret.fill(0);
          return stopped("recovered");
        }
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
        if (cast.ok) {
          // Recorded before it leaves the device, in one transaction with the
          // newest block's check, which another tab may have moved since the
          // read above (Client rule 3).
          const recorded = await source.record(electionId, tier, cast.ballot, cast.ciphertexts, {
            definitionHash,
            cell,
            l1Number: l1.number,
            l1Hash: l1.hash,
          });
          switch (recorded) {
            case "recorded":
              break;
            case "not-newer":
              return stopped("not-newer");
            case "unreadable":
              return stopped("casts-unreadable");
            case "unwritable":
              return stopped("casts-unwritable");
            // A ballot naming anything but what was asked, or a poll other
            // than the one recorded here, is this client's fault: never sent.
            case "not-asked":
            case "other-election":
            // The worker erased a seat's `m_i` on a receipt this device
            // never kept: neither is left to deliver or post with.
            case "unreceipted":
              return stopped("cast-faulty");
          }
          const sending: Sending = {
            ballot: cast.ballot,
            tier,
            trackingCode,
            // A seat the worker handed no `m_i` for was receipted already,
            // and its receipt carried to this record (casts.ts, `withCast`).
            undelivered: cast.ciphertexts.flatMap(({ seat, ciphertext, m }) =>
              m === undefined ? [] : [{ seat, ciphertext }],
            ),
          };
          return deliverThenSend(sending, current);
        }
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

  /**
   * Sends a recorded cast and turns the answer into the next screen. The
   * same bytes go every time, so a retry is at worst a copy the board
   * already holds (T-25). Only a boarded answer that passes `checkBoarded`
   * says the ballot is on the board; any other is sent again or shown.
   */
  async function send(sending: Sending): Promise<Step> {
    const { ballot, tier, trackingCode } = sending;
    const unsent = (reason: UnsentReason): Step => ({ kind: "unsent", reason, sending });
    let answer: SendAnswer;
    try {
      answer = await source.send(electionId, ballot);
    } catch {
      return unsent("unreachable");
    }
    switch (answer.kind) {
      case "boarded": {
        const { boardEntryVersion } = election;
        const checked =
          boardEntryVersion === undefined
            ? undefined
            : checkBoarded(answer, { electionId, ballot, boardEntryVersion });
        if (checked === undefined) return unsent("unconfirmed");
        // The first checked answer for these bytes is kept; a different one
        // for the same ballot is the operator contradicting itself (T-38).
        const kept = await source
          .keepBoarded(electionId, tier, ballot, checked)
          .catch(() => "unwritable" as const);
        if (kept === "conflict") return stopped("answer-conflict");
        afterSent(tier, ballot);
        return { kind: "sent", trackingCode, index: checked.index };
      }
      // A copy of this ballot is already on the board: it counts as this
      // one, never as a failed cast that needs a new ballot ([[revoting]],
      // Keyed by content). It carries the same ballot hash, so its
      // receipts are this one's.
      case "rejected":
        if (answer.code !== "repeat") return stopped("send-rejected", answer.code);
        afterSent(tier, ballot);
        return { kind: "sent", trackingCode };
      case "not-open":
        return stopped("not-open");
      case "malformed":
      case "not-found":
        return stopped("send-refused", answer.kind);
      case "busy":
      case "unavailable":
      case "unreachable":
        return unsent(answer.kind);
    }
  }

  /**
   * Submits each receipt kept for a recorded cast whose ballot is boarded
   * through the operator's board path, and keeps the entry the operator
   * answers with once it passes ([[delivery]], Client rule 3; [[receipts]],
   * Checks at cast), so a later drop is attributable. Whatever the entry
   * carries, the voter's receipt or an earlier one the board path held for
   * the seat (Boarding, rule 5), is kept only once the worker passes it for
   * exactly this ballot and seat under the poll's registered keys, as the
   * voter's own receipt passed (Client rule 1; T-38). Nothing here changes
   * what the voter is shown: the ballot is on the board, and every seat
   * receipted it before it was sent; a receipt not seen onto the board
   * stays kept without an entry, and the seat's node boards its own too.
   */
  async function boardReceipts(tier: number, ballot: Uint8Array): Promise<void> {
    const { boardEntryVersion } = election;
    if (boardEntryVersion === undefined) return;
    const read = await source.casts(electionId, tier).catch(() => undefined);
    if (read?.kind !== "read") return;
    for (const { seat, receipt } of unboardedReceipts(read.casts, ballot)) {
      const answer = await source.submitReceipt(electionId, receipt).catch(() => undefined);
      if (answer?.kind !== "boarded") continue;
      const entry = checkReceiptEntry(answer, { electionId, receipt, boardEntryVersion });
      if (entry === undefined) continue;
      const checked = await source.receipt(ballot, entry.payload).catch(() => undefined);
      // The worker stopped: no later entry can be checked either.
      if (checked === undefined) return;
      if (!checked.ok || checked.checked.seat !== seat) continue;
      const kept = await source
        .keepReceiptBoarded(electionId, tier, ballot, checked.checked, entry)
        .catch((): RecordReceiptOutcome => "unwritable");
      // A store this device can't read or write keeps no later entry
      // either; `missing` is this seat's alone.
      if (kept === "unreadable" || kept === "unwritable") return;
    }
  }

  /**
   * Boards a sent cast's receipts once the voter is shown it sent, never
   * before: an operator that stalls the receipt route would otherwise hold
   * the voter on the sending screen with their ballot already boarded.
   */
  function afterSent(tier: number, ballot: Uint8Array) {
    void boardReceipts(tier, ballot).catch(() => {});
  }

  /**
   * Delivers each of `sending`'s unreceipted shares to its seat's intake and
   * keeps every receipt that passes, answering the seats receipted, or the
   * step that says why delivery stopped. The caller holds the election's
   * lock, so no tab is posting a seat this one keeps a receipt for (Client
   * rule 2).
   */
  async function deliverShares(
    sending: Sending,
  ): Promise<{ readonly receipted: ReadonlySet<number> } | Step> {
    const { ballot, tier, undelivered } = sending;
    let election: IntakeResult;
    try {
      election = await source.intake(definitionHash);
    } catch {
      election = { ok: false, problem: "no-election" };
    }
    // The worker no longer holds the poll it cast in (it stopped since),
    // so it can check no receipt; this ballot was never sent.
    if (!election.ok) return stopped("cast-failed");
    const { stub, transcript } = election;
    const answers: IntakeAnswer[] = [];
    let next = 0;
    const deliverer = async () => {
      for (let at = next++; at < undelivered.length; at = next++) {
        const { seat, ciphertext } = undelivered[at] as (typeof undelivered)[number];
        answers[at] = await source
          .deliver(seat, { stub, transcript, record: ballot, ciphertext })
          .catch((): IntakeAnswer => ({ kind: "unreachable" }));
      }
    };
    await Promise.all(Array.from({ length: DELIVERIES_AT_ONCE }, deliverer));
    const receipted = new Set<number>();
    for (const answer of answers) {
      if (answer.kind !== "receipt") continue;
      // An answer that doesn't pass for exactly this ballot is no receipt:
      // its seat keeps `m_i` and stays undelivered (Client rule 1; T-25).
      const checked = await source.receipt(ballot, answer.receipt).catch(() => undefined);
      // The worker stopped: no later receipt can be checked either.
      if (checked === undefined) return stopped("cast-failed");
      if (!checked.ok) continue;
      // Kept before anything is sent: the worker has erased the seat's
      // `m_i` from its seal, so this record is the receipt's only copy
      // (Client rules 2 and 3).
      const kept = await source
        .keepReceipt(electionId, tier, ballot, checked.checked)
        .catch((): RecordReceiptOutcome => "unwritable");
      switch (kept) {
        case "recorded":
          receipted.add(checked.checked.seat);
          break;
        case "unreadable":
          return stopped("casts-unreadable");
        case "unwritable":
          return stopped("casts-unwritable");
        // The cast was recorded before delivery: a store without it now
        // was changed elsewhere, so nothing more is sent from it.
        case "missing":
          return stopped("cast-faulty");
      }
    }
    return { receipted };
  }

  /**
   * Delivers each of a recorded cast's unreceipted shares to its seat's
   * intake, keeps every receipt that passes, and sends the ballot only once
   * every qualified seat is receipted ([[0002-everlasting-privacy]],
   * Synchronous intake). A ballot boarded with a seat undelivered would
   * outrank the voter's earlier ballot and then fail delivery, voiding their
   * vote ([[revoting]], Selection), so the voter is offered the choice for
   * the seats left (`offer`; Client rule 4) as soon as delivery failed.
   */
  async function deliverThenSend(sending: Sending, current: () => boolean): Promise<Step> {
    const { undelivered } = sending;
    if (undelivered.length > 0) {
      if (current()) setStep({ kind: "delivering" });
      // A lock this browser refused leaves every share kept: sent again.
      const delivered = await locked(() => deliverShares(sending)).catch(() => undefined);
      if (delivered === undefined) return { kind: "unsent", reason: "unreachable", sending };
      if ("kind" in delivered) return delivered;
      const { receipted } = delivered;
      const left = undelivered.filter(({ seat }) => !receipted.has(seat));
      if (left.length > 0) {
        const rest: Sending = { ...sending, undelivered: left };
        // A cast found recorded on opening the poll names a ballot read from
        // storage alone, which no posting may name (`castPostingSeatV3`):
        // its voter sends it again or answers anew.
        return sending.resumed === true
          ? { kind: "unsent", reason: "undelivered", sending: rest }
          : offer(rest, current);
      }
    }
    if (current()) setStep({ kind: "sending" });
    return send({ ...sending, undelivered: [] });
  }

  /**
   * The posting record of each of `sending`'s unreceipted seats, made by the
   * worker from the share read back from this device's record once it
   * passes the posting check against the ballot cast on this page, the only
   * ballot a posting may name ([[delivery]], Client rule 4;
   * `castPostingRecordV3`), with `sending` less any seat receipted since
   * (another tab), which is never posted (Client rule 2). So a posting is
   * offered or made only for an `m_i` that would deliver its seat, never one
   * storage altered after the voter gave up the seat's everlasting privacy
   * for it (T-18, T-15): a share that fails is an unreadable record. The
   * caller zeroes the records, which hold each `m_i`, once done.
   */
  async function postable(
    sending: Sending,
  ): Promise<{ readonly sending: Sending; readonly postings: readonly Uint8Array[] } | Step> {
    const { ballot, tier, undelivered } = sending;
    const read = await source.casts(electionId, tier);
    if (read.kind === "unreadable") return stopped("casts-unreadable");
    const cast = read.casts.find((c) => equalBytes(c.ballot, ballot));
    // Recorded before delivery: a store without it now was changed elsewhere.
    if (cast === undefined) return stopped("cast-faulty");
    const shares: PostingShare[] = [];
    const postings: Uint8Array[] = [];
    const left: Sending["undelivered"][number][] = [];
    let passed = false;
    try {
      for (const seat of undelivered) {
        const kept = cast.shares.find((share) => share.seat === seat.seat);
        if (kept !== undefined && "receipt" in kept) {
          // Kept by another tab, which the worker passed there; checked again
          // here, since a stored receipt taken on trust would board this
          // ballot with the seat undelivered (T-18, T-25).
          const checked = await source.receipt(ballot, kept.receipt);
          if (!checked.ok || checked.checked.seat !== seat.seat) return stopped("casts-unreadable");
          continue;
        }
        // Erased since (a decline or the cutoff in another tab), or not the
        // ciphertext delivered: nothing is posted from this record.
        if (kept === undefined || !("m" in kept) || !equalBytes(kept.ciphertext, seat.ciphertext))
          return stopped("cast-faulty");
        shares.push({ seat: kept.seat, ciphertext: kept.ciphertext, m: kept.m });
        left.push(seat);
      }
      for (const share of shares) {
        const verdict = await source.posting(ballot, share);
        // A worker that no longer holds the poll checks nothing.
        if (!verdict.ok)
          return stopped(verdict.problem === "unknown" ? "cast-failed" : "casts-unreadable");
        postings.push(verdict.record);
      }
      passed = true;
      return { sending: { ...sending, undelivered: left }, postings };
    } finally {
      // Every `m` this read handed out goes now: the records carry the ones
      // posted, and go once used, or now if any failed.
      for (const { shares: kept } of read.casts)
        for (const share of kept) if ("m" in share) share.m.fill(0);
      if (!passed) for (const record of postings) record.fill(0);
    }
  }

  /**
   * Offers the voter the choice for a cast whose unreceipted seats no route
   * receipted ([[delivery]], Client rule 4), once their kept shares pass
   * (`postable`), asked as soon as delivery failed so a voter who leaves the
   * ballot can answer again while the poll is open. A cast every seat
   * receipted since is sent.
   */
  async function offer(sending: Sending, current: () => boolean): Promise<Step> {
    if (current()) setStep({ kind: "checking-posting" });
    const checked = await postable(sending);
    if ("kind" in checked) return checked;
    for (const record of checked.postings) record.fill(0);
    if (checked.sending.undelivered.length === 0) {
      if (current()) setStep({ kind: "sending" });
      return send(checked.sending);
    }
    return { kind: "offer", sending: checked.sending };
  }

  /**
   * The voter chose to post the missing parts, after the offer said what
   * that costs: each kept share passes the worker's check again, since the
   * record may have changed since the offer, then goes through the contract
   * path, and only once every one is recorded is the ballot sent: a ballot
   * boarded with a seat neither receipted nor posted would void the voter's
   * earlier one (Client rule 4; [[revoting]], Selection). A posting that
   * doesn't go through returns to the offer.
   */
  function post(sending: Sending) {
    if (posting === undefined) return;
    setStep({ kind: "posting" });
    run(
      async (current) => {
        const posted = await postChecked(sending, (postings) =>
          posting(electionId, sending.ballot, postings, cutoff()).catch(
            (): PostAnswer => "unreachable",
          ),
        );
        if ("kind" in posted) return posted;
        const { checked, answer } = posted;
        if (answer === "recorded") return sendPosted(checked, current);
        // Every answer but `recorded` is the end of a run that fell back
        // ([[posting-relay]], Outcome), so the voter's own wallet may now
        // be offered beside trying the relay again.
        return answer === "relayed"
          ? { kind: "offer", sending: checked, failed: true, relayed: true, fallback: true }
          : { kind: "offer", sending: checked, failed: true, fallback: true };
      },
      { kind: "offer", sending, failed: true },
    );
  }

  /**
   * The voter chose their own wallet, after the relay fell back and the
   * offer said that the paying address is published beside the ballot
   * ([[0042-posting-relay]], rule 6; T-13): the same check and lock as
   * `post`, then the wallet's run. A run that doesn't record them returns
   * to the offer with what the wallet met, the relay still there to try.
   */
  function postFromOwnWallet(sending: Sending, relayed: boolean) {
    if (postingOwn === undefined) return;
    setStep({ kind: "posting-wallet" });
    const back = (wallet: Exclude<WalletAnswer, "recorded">): Step =>
      relayed
        ? { kind: "offer", sending, failed: true, relayed: true, fallback: true, wallet }
        : { kind: "offer", sending, failed: true, fallback: true, wallet };
    run(async (current) => {
      const posted = await postChecked(sending, (postings) =>
        postingOwn(electionId, sending.ballot, postings, cutoff()).catch(
          (): WalletAnswer => "failed",
        ),
      );
      if ("kind" in posted) return posted;
      const { checked, answer } = posted;
      if (answer === "recorded") return sendPosted(checked, current);
      return { ...back(answer), sending: checked };
    }, back("failed"));
  }

  /**
   * Each kept share checked again (`postable`), since the record may have
   * changed since the offer, then `through` given the records, from the
   * check through the posting under the election's lock: a tab that keeps
   * a receipt for a seat between them would have this one post a receipted
   * seat (Client rule 2; T-15). The records are zeroed once it settles.
   */
  async function postChecked<A extends PostAnswer | WalletAnswer>(
    sending: Sending,
    through: (postings: readonly Uint8Array[]) => Promise<A>,
  ): Promise<{ readonly checked: Sending; readonly answer: A | "recorded" } | Step> {
    return locked(async () => {
      const checked = await postable(sending);
      if ("kind" in checked) return checked;
      try {
        const answer = checked.postings.length === 0 ? "recorded" : await through(checked.postings);
        return { checked: checked.sending, answer };
      } finally {
        for (const record of checked.postings) record.fill(0);
      }
    });
  }

  /** Every unreceipted seat recorded by the contract: only now is the ballot sent. */
  function sendPosted(checked: Sending, current: () => boolean): Promise<Step> {
    if (current()) setStep({ kind: "sending" });
    return send({ ...checked, undelivered: [] });
  }

  /**
   * The voter left the ballot rather than post its missing parts: their
   * `ct_i` and `m_i` are erased from this device's record and every `m_i`
   * from the worker's seals ([[delivery]], Client rule 4; T-18), and the
   * ballot is never sent from here. The worker erases its copies even if
   * the store refused, since the voter declined either way; a worker that
   * fails is stopped, and its seals go with it.
   */
  function decline(sending: Sending) {
    const { ballot, tier } = sending;
    setStep({ kind: "declining" });
    run(async () => {
      // Under the election's lock, so no tab is posting a seat this erases.
      const erased = await locked(async () => {
        const outcome = await source
          .declinePosting(electionId, tier, ballot)
          .catch((): DeclinePostingOutcome => "unwritable");
        await source.declineSeal(ballot).catch(() => undefined);
        return outcome;
      }).catch(() => undefined);
      // A lock this browser refused erased nothing: the offer stands.
      if (erased === undefined) return { kind: "offer", sending };
      switch (erased) {
        case "declined":
          return { kind: "declined" };
        case "missing":
          return stopped("cast-faulty");
        case "unreadable":
          return stopped("casts-unreadable");
        case "unwritable":
          return stopped("casts-unwritable");
      }
    }, stopped("casts-unwritable"));
  }

  function sendAgain(sending: Sending) {
    setStep({ kind: sending.undelivered.length > 0 ? "delivering" : "sending" });
    run((current) => deliverThenSend(sending, current), {
      kind: "unsent",
      reason: "unreachable",
      sending,
    });
  }

  switch (step.kind) {
    case "answering":
      return (
        <AnswerQuestions
          // A fresh start each round: nothing chosen carries over (questions.tsx).
          key={`${election.definitionHash}/${round}`}
          poll={poll}
          questions={questions}
          pick={round === 0 ? pick : undefined}
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
    case "resuming":
    case "finding":
    case "sealing":
    case "opening":
    case "delivering":
    case "sending":
    case "checking-posting":
    case "declining":
    case "posting":
    case "posting-wallet":
      return <Working poll={poll} kind={step.kind} />;
    case "offer": {
      const { sending } = step;
      return (
        <PostingOffer
          poll={poll}
          trackingCode={sending.trackingCode}
          missing={sending.undelivered.length}
          failed={step.failed === true}
          relayed={step.relayed === true}
          onRetry={() => sendAgain(sending)}
          onDecline={() => decline(sending)}
          onPost={posting === undefined ? undefined : () => post(sending)}
          onWallet={
            step.fallback === true && postingOwn !== undefined
              ? () => postFromOwnWallet(sending, step.relayed === true)
              : undefined
          }
          wallet={step.wallet}
        />
      );
    }
    case "declined":
      return <Declined poll={poll} onAgain={again} />;
    case "sealed":
      return (
        <Sealed
          poll={poll}
          electionId={election.electionId}
          trackingCode={step.trackingCode}
          onCast={() => cast(step)}
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
    case "unsent":
      return (
        <Unsent
          poll={poll}
          trackingCode={step.sending.trackingCode}
          reason={step.reason}
          onSend={() => sendAgain(step.sending)}
          // A recorded cast found on opening the poll, however its sending
          // went since: the voter may leave it and answer anew, which casts
          // a ballot that replaces it.
          onAgain={step.sending.resumed === true ? again : undefined}
        />
      );
    case "sent":
      return (
        <Sent poll={poll} trackingCode={step.trackingCode} index={step.index} onAgain={again} />
      );
    case "register":
      return (
        <Register poll={poll} registrar={step.registrar} held={step.held} onDone={onRestart} />
      );
    case "waiting":
      return (
        <RegisterWaiting
          poll={poll}
          sentAt={formatTime(locale, BigInt(Math.floor(step.acceptedAt / 1000)))}
          onCheck={onRestart}
        />
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
