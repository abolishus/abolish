import type { CastShare } from "@abolishus/crypto";
import { Button, useI18n, useTranslate } from "@abolishus/ui";
import { useEffect, useMemo, useRef, useState } from "react";

import { type Answers, pickLanguage, questionsOf, votesOf } from "./answers.ts";
import {
  type Boarded,
  type CastAsked,
  type CastsRead,
  newestBlock,
  type RecordBoardedOutcome,
  type RecordCastOutcome,
} from "./casts.ts";
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
  /** Sends a recorded cast's bytes to the ballot route (`sendBallot`). */
  send(electionId: Uint8Array, ballot: Uint8Array): Promise<SendAnswer>;
  /** Keeps the operator's checked answer for a recorded cast (`recordBoarded`). */
  keepBoarded(
    electionId: Uint8Array,
    tier: number,
    ballot: Uint8Array,
    boarded: Boarded,
  ): Promise<RecordBoardedOutcome>;
  /**
   * Tier 0 registration, for a voter whose identity is in none of a poll's
   * tiers where the poll admits Tier 0, or `undefined` while the build can't
   * register anyone (no published region, no challenge frame).
   */
  readonly registrar: Registrar | undefined;
  /**
   * Whether this build delivers each seat's share ciphertext to its intake
   * before a cast is shown as cast ([[0002-everlasting-privacy]], Synchronous
   * intake). Until one does, no cast is sent: a boarded ballot whose shares
   * never reach the trustees outranks the voter's earlier ballot and then
   * fails delivery, voiding their vote ([[revoting]], Selection).
   */
  readonly delivers: boolean;
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
          // Each check starts the ballot afresh, even where React renders the
          // new check's answer without the checking screen between: a restart
          // asked for from a promise can land in one batch with it.
          key={attempt}
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
  | { readonly kind: "sending" }
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
}

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
  const electionId = fromHex(election.electionId);

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
          const sending = { ballot: cast.ballot, tier, trackingCode };
          if (current()) setStep({ kind: "sending" });
          return send(sending);
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
        return kept === "conflict"
          ? stopped("answer-conflict")
          : { kind: "sent", trackingCode, index: checked.index };
      }
      // A copy of this ballot is already on the board: it counts as this
      // one, never as a failed cast that needs a new ballot ([[revoting]],
      // Keyed by content).
      case "rejected":
        return answer.code === "repeat"
          ? { kind: "sent", trackingCode }
          : stopped("send-rejected", answer.code);
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

  function sendAgain(sending: Sending) {
    setStep({ kind: "sending" });
    run(() => send(sending), { kind: "unsent", reason: "unreachable", sending });
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
    case "sending":
      return <Working poll={poll} kind={step.kind} />;
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
