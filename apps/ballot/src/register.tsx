import { isForbiddenCommitment } from "@abolishus/crypto";
import { Button, useI18n, useTranslate } from "@abolishus/ui";
import { type ComponentType, useEffect, useRef, useState } from "react";

import { type Backer, BackupOffer } from "./backup-offer.tsx";
import { ACTION, EverydayFrame, type FramePoll, Note, Part, ScreenTitle } from "./frame.tsx";
import type { IdentityRead, Tier0Request } from "./identity.ts";
import type { LoadedRegistry } from "./load.ts";
import { catalogs, type Messages } from "./messages.ts";
import { Recover, type Recoverer } from "./recover.tsx";
import { retryDue, type Tier0Answer, tier0RequestBody } from "./registration.ts";
import { formatTime } from "./time.ts";
import type { CommitmentResult, Tier0OutcomeResult } from "./worker/protocol.ts";

// Registering at Tier 0 from a poll that admits it ([[registration]]): a
// voting identity made on this device and kept before anything is sent, its
// commitment from the worker, the challenge page's token, the request, and
// the request noted beside the identity once the route accepted it. The
// outcome is read from the group registry's whole log on the L2, never asked
// of the service (T-11, T-13): registered, kept as the identity's Tier 0
// membership; not yet, with the request offered again once it is due; or
// moved, an alarm ([[registration]], Outcome).

/** A registry read that succeeded (`loadGroupRegistry`). */
export type ReadRegistry = Extract<LoadedRegistry, { ok: true }>;

/** What a build needs to register a voter at Tier 0; injected so stories and tests need no network, frame or worker. */
export interface Registrar {
  /** The region every request of this build asks for (`tier0Region`), a u32. */
  readonly region: number;
  /**
   * The challenge page in its frame ([[registration]], The handoff), which
   * calls `onToken` once with a token it accepted (`challengeToken`).
   */
  readonly Challenge: ComponentType<{ onToken: (token: string) => void }>;
  /** A new identity kept as this device's (`createIdentity`), never over one it holds. */
  create(): Promise<"created" | "exists" | "unwritable">;
  /** The voting identity this device holds (identity.ts), read afresh. */
  identity(): Promise<IdentityRead>;
  /**
   * The worker's commitment of `secret`; rejects if the worker fails.
   * `secret` is copied to the worker before this returns, so the caller's
   * copy is its own to zero as soon as it is done with it (T-12).
   */
  commitment(secret: Uint8Array): Promise<CommitmentResult>;
  /** The request (`tier0RequestBody`) sent to the registration route (`sendTier0Request`). */
  send(body: string): Promise<Tier0Answer>;
  /** Notes the accepted request beside the identity whose secret is `secret` (`recordTier0Request`). */
  record(secret: Uint8Array, request: Tier0Request): Promise<"recorded" | "changed" | "unwritable">;
  /** The group registry's whole log up to the L2's finalized head (`loadGroupRegistry`). */
  registry(): Promise<LoadedRegistry>;
  /**
   * The worker's outcome of a request for `region` by the identity whose
   * secret is `secret`, over `registry` (`BallotWorker.tier0Outcome`);
   * rejects if the worker fails. `secret` is copied to the worker before
   * this returns (T-12).
   */
  outcome(secret: Uint8Array, region: number, registry: ReadRegistry): Promise<Tier0OutcomeResult>;
  /** Keeps `group` as the Tier 0 membership of the identity whose secret is `secret`, in place of its request (`recordTier0Membership`). */
  join(secret: Uint8Array, group: bigint): Promise<"recorded" | "changed" | "unwritable">;
  /** This device's clock, in milliseconds since the UNIX epoch. */
  now(): number;
  /**
   * The passkey backup offered once a request went, or `undefined` where
   * the build offers none (`Deployment.backups`).
   */
  readonly backup: Backer | undefined;
  /**
   * Recovery from a backup passkey, offered instead of making an identity
   * on a device that holds none, or `undefined` where the build offers no
   * backup (`Deployment.backups`).
   */
  readonly recovery: Recoverer | undefined;
}

const STOPPED = {
  /** The browser refused to keep a new identity. */
  unwritable: { title: "registerUnwritableTitle", detail: "registerUnwritable", retry: false },
  /** The identity kept, or the one read back, couldn't be read or isn't one. */
  unreadable: { title: "identityUnreadableTitle", detail: "identityUnreadable", retry: false },
  /** The worker stopped or failed: the poll is checked anew in a fresh one. */
  "worker-failed": {
    title: "registerWorkerFailedTitle",
    detail: "registerWorkerFailed",
    retry: true,
  },
  /** The route refused the token: a new solve may pass. */
  "challenge-refused": {
    title: "challengeRefusedTitle",
    detail: "challengeRefused",
    retry: true,
  },
  /** The route couldn't check the token, is busy or unavailable, or wasn't reached. */
  later: { title: "registerLaterTitle", detail: "registerLater", retry: true },
  /** The route says the request is outside its forms or names no published region: this build's fault. */
  faulty: { title: "registerFaultyTitle", detail: "registerFaulty", retry: false },
  /** Accepted, but the device now holds another identity or couldn't note the request. */
  "not-noted": { title: "registerNotNotedTitle", detail: "registerNotNoted", retry: false },
  /** The group registry's log couldn't be read, or wasn't the registry's: another read may pass. */
  "registry-unavailable": {
    title: "registryUnavailableTitle",
    detail: "registryUnavailable",
    retry: true,
  },
  /** This build names no group registry to read the outcome from. */
  "no-group-registry": {
    title: "noGroupRegistryTitle",
    detail: "noGroupRegistry",
    retry: false,
  },
  /**
   * The request waits on a region this build doesn't serve: asking again
   * elsewhere would change the cell the voter is counted in (T-16).
   */
  "region-changed": { title: "regionChangedTitle", detail: "regionChanged", retry: false },
  /** Registered, but the device now holds another identity or couldn't keep the membership. */
  "join-not-noted": { title: "joinNotNotedTitle", detail: "joinNotNoted", retry: true },
} as const satisfies Record<
  string,
  { readonly title: keyof Messages; readonly detail: keyof Messages; readonly retry: boolean }
>;

export type RegisterProblem = keyof typeof STOPPED;

// Each answer the route gives, as the screens act on it. A record, so an
// answer `sendTier0Request` gains must be placed here.
const ANSWERS: Record<Exclude<Tier0Answer, "accepted">, RegisterProblem> = {
  malformed: "faulty",
  "region-unknown": "faulty",
  busy: "later",
  unavailable: "later",
  "challenge-refused": "challenge-refused",
  "challenge-unavailable": "later",
  unreachable: "later",
};

type Step =
  | { readonly kind: "intro" }
  | { readonly kind: "recover" }
  | { readonly kind: "reading" }
  | { readonly kind: "waiting"; readonly acceptedAt: number }
  | { readonly kind: "due"; readonly acceptedAt: number }
  | { readonly kind: "joined" }
  | { readonly kind: "moved" }
  | { readonly kind: "preparing" }
  | { readonly kind: "challenge"; readonly commitment: bigint; readonly round: number }
  | { readonly kind: "sending" }
  | { readonly kind: "sent" }
  | { readonly kind: "stopped"; readonly problem: RegisterProblem; readonly commitment?: bigint };

// Each registry read the screens can't use, as they act on it.
const UNREAD: Record<Exclude<LoadedRegistry, { ok: true }>["problem"], RegisterProblem> = {
  "no-registry": "no-group-registry",
  "wrong-chain": "registry-unavailable",
  "not-registered": "registry-unavailable",
  "not-found": "registry-unavailable",
  withheld: "registry-unavailable",
  unreachable: "registry-unavailable",
  "bad-answer": "registry-unavailable",
};

/** Whether the device holds no identity, one in no group waiting on nothing, or one waiting on a Tier 0 request. */
export type Held = "none" | "made" | "waiting";

/**
 * Registers this device's voting identity at Tier 0, making one first when
 * it holds none, or reads the outcome of the request it waits on. `onDone`
 * checks the poll again from the start: after a request went, once the
 * identity is registered, and after a worker failure.
 */
export function Register({
  poll,
  registrar,
  held,
  onDone,
}: {
  poll: FramePoll;
  registrar: Registrar;
  held: Held;
  onDone: () => void;
}) {
  const { locale } = useI18n();
  const [step, setStep] = useState<Step>({ kind: held === "waiting" ? "reading" : "intro" });
  // Each answer lands only on the step that asked for it, and never after
  // the voter left; a second tap or a second token asks nothing twice.
  const asked = useRef(0);
  useEffect(() => () => void asked.current++, []);
  // Each challenge frame's round, and the rounds a token was already sent
  // for: checked synchronously, since a second token can arrive before the
  // screen changes.
  const rounds = useRef(0);
  const sent = useRef(new Set<number>());

  // A waiting identity's outcome is read as soon as the screen opens.
  useEffect(() => {
    if (held === "waiting") read();
    // Once, on the first render: `read` asks again only from a button.
  }, []);

  /** Runs `steps`; `restart` checks the poll again, for an identity that needs no registering. */
  function run(steps: () => Promise<Step | "restart">) {
    const mine = ++asked.current;
    void (async () => {
      let next: Step | "restart";
      try {
        next = await steps();
      } catch {
        next = { kind: "stopped", problem: "worker-failed" };
      }
      if (asked.current !== mine) return;
      if (next === "restart") onDone();
      else setStep(next);
    })();
  }

  /**
   * The outcome of the request the device's identity waits on, from the
   * group registry's whole log, read before the identity so the page holds
   * the secret for no download ([[registration]], Outcome). The page's copy
   * is kept across the outcome, so the membership is kept only beside the
   * identity it was read for, then zeroed (T-12).
   */
  function read() {
    setStep({ kind: "reading" });
    run(async () => {
      const registry = await registrar.registry();
      if (!registry.ok) return { kind: "stopped", problem: UNREAD[registry.problem] };
      const read = await registrar.identity();
      if (read.kind !== "found") return { kind: "stopped", problem: "unreadable" };
      const { secret, tier0Request } = read.identity;
      try {
        // Registered meanwhile (another tab), or no longer waiting: the poll
        // decides anew. A membership in another tier doesn't end the wait.
        if (tier0Request === undefined) return "restart";
        // T-16: the outcome is read, and a request repeated, only for the region first asked for.
        if (tier0Request.region !== registrar.region)
          return { kind: "stopped", problem: "region-changed" };
        const result = await registrar.outcome(secret, tier0Request.region, registry);
        if (!result.ok)
          return {
            kind: "stopped",
            problem: result.problem === "secret" ? "unreadable" : "registry-unavailable",
          };
        const { outcome } = result;
        switch (outcome.kind) {
          case "registered": {
            const joined = await registrar.join(secret, outcome.group);
            return joined === "recorded"
              ? { kind: "joined" }
              : { kind: "stopped", problem: "join-not-noted" };
          }
          case "moved":
            return { kind: "moved" };
          case "not-yet":
            return retryDue(tier0Request.acceptedAt, registry.timestamp)
              ? { kind: "due", acceptedAt: tier0Request.acceptedAt }
              : { kind: "waiting", acceptedAt: tier0Request.acceptedAt };
        }
      } finally {
        secret.fill(0);
      }
    });
  }

  /**
   * The commitment of the identity the device holds, with the page's copy of
   * the secret zeroed as soon as the worker has its own (T-12); a held
   * identity already in a group isn't registered again, nor one waiting on
   * a request unless it is `due` to be repeated, nor one whose request
   * another tab sent meanwhile.
   */
  async function commitmentHeld(due: boolean): Promise<bigint | RegisterProblem | "done"> {
    const read = await registrar.identity();
    if (read.kind !== "found") return "unreadable";
    const { secret, memberships, tier0Request } = read.identity;
    let asked: Promise<CommitmentResult>;
    try {
      if (due ? tier0Request === undefined : memberships.length > 0 || tier0Request !== undefined)
        return "done";
      if (tier0Request !== undefined && tier0Request.region !== registrar.region)
        return "region-changed";
      asked = registrar.commitment(secret);
    } finally {
      secret.fill(0);
    }
    const result = await asked;
    if (!result.ok) return "unreadable";
    // A forbidden commitment ([[membership]]) can't be registered: no solve is spent on it.
    return isForbiddenCommitment(result.commitment) ? "unreadable" : result.commitment;
  }

  // Made and kept before any request, so a request is never sent for an
  // identity this device could lose ([[registration]], Outcome; T-18). One
  // that appeared meanwhile (another tab) is registered instead, never replaced.
  //
  // A repeat of a request that is due sends the same commitment and region
  // ([[registration]], Outcome); the route takes a repeat as it took the first.
  function prepare() {
    if (step.kind !== "intro" && step.kind !== "due") return;
    const due = step.kind === "due";
    setStep({ kind: "preparing" });
    run(async () => {
      if (held === "none" && (await registrar.create()) === "unwritable")
        return { kind: "stopped", problem: "unwritable" };
      const commitment = await commitmentHeld(due);
      if (commitment === "done") return "restart";
      return typeof commitment === "bigint"
        ? { kind: "challenge", commitment, round: ++rounds.current }
        : { kind: "stopped", problem: commitment };
    });
  }

  function send(commitment: bigint, round: number, token: string) {
    if (sent.current.has(round)) return;
    sent.current.add(round);
    setStep({ kind: "sending" });
    run(async () => {
      const answer = await registrar.send(tier0RequestBody(commitment, registrar.region, token));
      if (answer !== "accepted") return { kind: "stopped", problem: ANSWERS[answer], commitment };
      const acceptedAt = registrar.now();
      // The request went: whatever fails from here, the voter is told it was
      // sent and not noted, never that nothing was sent.
      try {
        return (await note(commitment, acceptedAt))
          ? { kind: "sent" }
          : { kind: "stopped", problem: "not-noted" };
      } catch {
        return { kind: "stopped", problem: "not-noted" };
      }
    });
  }

  /**
   * Notes the accepted request only beside the identity it was made for: the
   * secret read back must still commit to what was sent, and the store still
   * hold it (`recordTier0Request`). The page's copy is kept across the check
   * for that comparison, then zeroed (T-12).
   */
  async function note(commitment: bigint, acceptedAt: number): Promise<boolean> {
    const read = await registrar.identity();
    if (read.kind !== "found") return false;
    const { secret } = read.identity;
    try {
      const again = await registrar.commitment(secret);
      if (!again.ok || again.commitment !== commitment) return false;
      const noted = await registrar.record(secret, { region: registrar.region, acceptedAt });
      return noted === "recorded";
    } finally {
      secret.fill(0);
    }
  }

  switch (step.kind) {
    case "intro":
      return (
        <RegisterIntro
          poll={poll}
          made={held !== "none"}
          onStart={prepare}
          // Only where the device holds no identity: a recovery never replaces one (T-18).
          onRecover={
            held !== "none" || registrar.recovery === undefined
              ? undefined
              : () => setStep({ kind: "recover" })
          }
        />
      );
    case "recover":
      return registrar.recovery === undefined ? null : (
        <Recover
          poll={poll}
          recoverer={registrar.recovery}
          backer={registrar.backup}
          onDone={onDone}
          onBack={() => setStep({ kind: "intro" })}
        />
      );
    case "reading":
    case "preparing":
    case "sending":
      return <RegisterWorking poll={poll} kind={step.kind} />;
    case "waiting":
      return (
        <RegisterWaiting
          poll={poll}
          sentAt={formatTime(locale, BigInt(Math.floor(step.acceptedAt / 1000)))}
          onCheck={read}
        />
      );
    case "due":
      return (
        <RegisterDue
          poll={poll}
          sentAt={formatTime(locale, BigInt(Math.floor(step.acceptedAt / 1000)))}
          onSend={prepare}
        />
      );
    case "joined":
      return <RegisterJoined poll={poll} backer={registrar.backup} onBack={onDone} />;
    case "moved":
      return <RegisterMoved poll={poll} />;
    case "challenge":
      return (
        <RegisterChallenge
          // A fresh frame each round: a token is solved once.
          key={step.round}
          poll={poll}
          Challenge={registrar.Challenge}
          onToken={(token) => send(step.commitment, step.round, token)}
        />
      );
    case "sent":
      return <RegisterSent poll={poll} backer={registrar.backup} onBack={onDone} />;
    case "stopped": {
      const { commitment } = step;
      // A new solve where the route could take one; the worker's failure
      // checks the poll anew; anything else is shown without a way on.
      const retry = !STOPPED[step.problem].retry
        ? undefined
        : commitment === undefined
          ? onDone
          : () => setStep({ kind: "challenge", commitment, round: ++rounds.current });
      return <RegisterStopped poll={poll} problem={step.problem} onRetry={retry} />;
    }
  }
}

/**
 * Why the voter is making an identity, and what stays on the device, before
 * anything happens; with recovery from a backup passkey offered beside it
 * where `onRecover` is given.
 */
export function RegisterIntro({
  poll,
  made,
  onStart,
  onRecover,
}: {
  poll: FramePoll;
  made: boolean;
  onStart: () => void;
  onRecover?: (() => void) | undefined;
}) {
  const t = useTranslate(catalogs);
  return (
    <EverydayFrame
      poll={poll}
      primary={
        <Button size="lg" className={ACTION} onClick={onStart}>
          {t(made ? "registerStart" : "makeIdentityStart")}
        </Button>
      }
    >
      <ScreenTitle title={t(made ? "registerTitle" : "makeIdentityTitle")} focus>
        <p className="m-0">{t(made ? "register" : "makeIdentity")}</p>
      </ScreenTitle>
      <Part title={t("identityKeptTitle")}>
        <p className="m-0">{t("identityKept")}</p>
      </Part>
      <Part title={t("registerStepsTitle")}>
        <p className="m-0">{t("registerSteps")}</p>
      </Part>
      {onRecover === undefined ? null : (
        <Part title={t("recoverOfferTitle")}>
          <p className="m-0">{t("recoverOffer")}</p>
          <div>
            <Button variant="outline" onClick={onRecover}>
              {t("recoverOfferStart")}
            </Button>
          </div>
        </Part>
      )}
    </EverydayFrame>
  );
}

const WORKING = {
  reading: { title: "registerReadingTitle", detail: "registerReading" },
  preparing: { title: "registerPreparingTitle", detail: "registerPreparing" },
  sending: { title: "registerSendingTitle", detail: "registerSending" },
} as const satisfies Record<
  string,
  { readonly title: keyof Messages; readonly detail: keyof Messages }
>;

/** While the registry is read, the identity made and its commitment worked out, or the request sent: nothing to press. */
export function RegisterWorking({ poll, kind }: { poll: FramePoll; kind: keyof typeof WORKING }) {
  const t = useTranslate(catalogs);
  const { title, detail } = WORKING[kind];
  return (
    <EverydayFrame poll={poll}>
      <ScreenTitle title={t(title)} focus>
        <p className="m-0" role="status">
          {t(detail)}
        </p>
      </ScreenTitle>
    </EverydayFrame>
  );
}

/** The challenge page's frame, with what it is for: only its token reaches this device. */
export function RegisterChallenge({
  poll,
  Challenge,
  onToken,
}: {
  poll: FramePoll;
  Challenge: Registrar["Challenge"];
  onToken: (token: string) => void;
}) {
  const t = useTranslate(catalogs);
  return (
    <EverydayFrame poll={poll}>
      <ScreenTitle title={t("challengeStepTitle")} focus>
        <p className="m-0">{t("challengeStep")}</p>
      </ScreenTitle>
      <div className="mt-6">
        <Challenge onToken={onToken} />
      </div>
      <div className="mt-8">
        <Note title={t("challengeSeesTitle")}>
          <p className="m-0">{t("challengeSees")}</p>
        </Note>
      </div>
    </EverydayFrame>
  );
}

/**
 * The route accepted the request: it is signed into a group in a later
 * batch, and the voter comes back. The identity now waits on a list, so this
 * is where its backup is offered, with nothing else to do meanwhile.
 */
export function RegisterSent({
  poll,
  backer,
  onBack,
}: {
  poll: FramePoll;
  backer?: Backer | undefined;
  onBack: () => void;
}) {
  const t = useTranslate(catalogs);
  return (
    <EverydayFrame
      poll={poll}
      primary={
        <Button size="lg" className={ACTION} onClick={onBack}>
          {t("backToPoll")}
        </Button>
      }
    >
      <ScreenTitle title={t("registerSentTitle")} focus>
        <p className="m-0">{t("registerSent")}</p>
      </ScreenTitle>
      <Part title={t("registerWaitTitle")}>
        <p className="m-0">{t("registerWait")}</p>
      </Part>
      {backer === undefined ? null : <BackupOffer backer={backer} />}
    </EverydayFrame>
  );
}

/** A request went earlier and isn't on the list yet, or the client can't read the list: when, and to come back. */
export function RegisterWaiting({
  poll,
  sentAt,
  onCheck,
}: {
  poll: FramePoll;
  /** When the route accepted it, already formatted for the reader. */
  sentAt: string;
  onCheck: () => void;
}) {
  const t = useTranslate(catalogs);
  return (
    <EverydayFrame
      poll={poll}
      primary={
        <Button size="lg" className={ACTION} onClick={onCheck}>
          {t("checkAgain")}
        </Button>
      }
    >
      <ScreenTitle title={t("registerWaitingTitle")} focus>
        <p className="m-0">{t("registerWaiting", { when: sentAt })}</p>
      </ScreenTitle>
      <Part title={t("registerWaitTitle")}>
        <p className="m-0">{t("registerWait")}</p>
      </Part>
    </EverydayFrame>
  );
}

/**
 * A request went long enough ago that it should be on the list and isn't
 * (`retryDue`): it may have been dropped, so the voter may send it again.
 */
export function RegisterDue({
  poll,
  sentAt,
  onSend,
}: {
  poll: FramePoll;
  /** When the route last accepted it, already formatted for the reader. */
  sentAt: string;
  onSend: () => void;
}) {
  const t = useTranslate(catalogs);
  return (
    <EverydayFrame
      poll={poll}
      primary={
        <Button size="lg" className={ACTION} onClick={onSend}>
          {t("registerAgain")}
        </Button>
      }
    >
      <ScreenTitle title={t("registerDueTitle")} focus>
        <p className="m-0">{t("registerDue", { when: sentAt })}</p>
      </ScreenTitle>
      <Part title={t("registerRepeatTitle")}>
        <p className="m-0">{t("registerRepeat")}</p>
      </Part>
    </EverydayFrame>
  );
}

/**
 * The identity is on the list of the region it asked for, and kept as
 * registered: back to the poll, with the backup offered again if it wasn't
 * made, or where it stands if it was.
 */
export function RegisterJoined({
  poll,
  backer,
  onBack,
}: {
  poll: FramePoll;
  backer?: Backer | undefined;
  onBack: () => void;
}) {
  const t = useTranslate(catalogs);
  return (
    <EverydayFrame
      poll={poll}
      primary={
        <Button size="lg" className={ACTION} onClick={onBack}>
          {t("backToPoll")}
        </Button>
      }
    >
      <ScreenTitle title={t("registerJoinedTitle")} focus>
        <p className="m-0">{t("registerJoined")}</p>
      </ScreenTitle>
      {backer === undefined ? null : <BackupOffer backer={backer} />}
    </EverydayFrame>
  );
}

/**
 * The alarm: the identity's code is counted on another region's list, which
 * someone else put it on first ([[registration]], Outcome; T-16). Nothing to
 * press: its place can't be taken back, and a new identity comes only with
 * its backup and a second look at the list (Known-weak).
 */
export function RegisterMoved({ poll }: { poll: FramePoll }) {
  const t = useTranslate(catalogs);
  return (
    <EverydayFrame poll={poll}>
      <ScreenTitle title={t("registerMovedTitle")} focus>
        <p className="m-0">{t("registerMoved")}</p>
      </ScreenTitle>
      <div className="mt-8">
        <Note tone="warn" title={t("registerMovedWhyTitle")}>
          <p className="m-0">{t("registerMovedWhy")}</p>
        </Note>
      </div>
    </EverydayFrame>
  );
}

/** Registration stopped: why, and a retry where one could help. */
export function RegisterStopped({
  poll,
  problem,
  onRetry,
}: {
  poll: FramePoll;
  problem: RegisterProblem;
  onRetry?: (() => void) | undefined;
}) {
  const t = useTranslate(catalogs);
  const { title, detail } = STOPPED[problem];
  return (
    <EverydayFrame
      poll={poll}
      primary={
        onRetry === undefined ? undefined : (
          <Button size="lg" className={ACTION} onClick={onRetry}>
            {t("tryAgain")}
          </Button>
        )
      }
    >
      <ScreenTitle title={t(title)} focus>
        <p className="m-0">{t(detail)}</p>
      </ScreenTitle>
    </EverydayFrame>
  );
}
