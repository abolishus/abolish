import { Button, useTranslate } from "@abolishus/ui";
import { type ComponentType, useEffect, useRef, useState } from "react";

import { ACTION, EverydayFrame, type FramePoll, Note, Part, ScreenTitle } from "./frame.tsx";
import type { IdentityRead, Tier0Request } from "./identity.ts";
import { catalogs, type Messages } from "./messages.ts";
import { type Tier0Answer, tier0RequestBody } from "./registration.ts";
import type { CommitmentResult } from "./worker/protocol.ts";

// Registering at Tier 0 from a poll that admits it ([[registration]]): a
// voting identity made on this device and kept before anything is sent, its
// commitment from the worker, the challenge page's token, the request, and
// the request noted beside the identity once the route accepted it. The
// outcome is read from the group registry, never asked of the service
// (T-11, T-13); until the client reads it (P2-8 part 3b-2c-2b-2b-2) a
// waiting voter is told when the request went and to come back.

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
   * `secret` is copied to the worker before this returns, so the caller
   * zeroes its own at once (T-12).
   */
  commitment(secret: Uint8Array): Promise<CommitmentResult>;
  /** The request (`tier0RequestBody`) sent to the registration route (`sendTier0Request`). */
  send(body: string): Promise<Tier0Answer>;
  /** Notes the accepted request beside the identity whose secret is `secret` (`recordTier0Request`). */
  record(secret: Uint8Array, request: Tier0Request): Promise<"recorded" | "changed" | "unwritable">;
  /** This device's clock, in milliseconds since the UNIX epoch. */
  now(): number;
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
  | { readonly kind: "preparing" }
  | { readonly kind: "challenge"; readonly commitment: bigint; readonly round: number }
  | { readonly kind: "sending" }
  | { readonly kind: "sent" }
  | { readonly kind: "stopped"; readonly problem: RegisterProblem; readonly commitment?: bigint };

/**
 * Registers this device's voting identity at Tier 0, making one first when
 * it holds none (`made` false). `onDone` checks the poll again from the
 * start: after a request went, and after a worker failure.
 */
export function Register({
  poll,
  registrar,
  made,
  onDone,
}: {
  poll: FramePoll;
  registrar: Registrar;
  /** Whether the device already holds an identity in no group, waiting on no request. */
  made: boolean;
  onDone: () => void;
}) {
  const [step, setStep] = useState<Step>({ kind: "intro" });
  // Each answer lands only on the step that asked for it, and never after
  // the voter left; a second tap or a second token asks nothing twice.
  const asked = useRef(0);
  useEffect(() => () => void asked.current++, []);

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
   * The commitment of the identity the device holds, with the page's copy of
   * the secret zeroed as soon as the worker has its own (T-12); a held
   * identity already in a group or waiting on a request isn't registered
   * again.
   */
  async function commitmentHeld(): Promise<bigint | RegisterProblem | "done"> {
    const read = await registrar.identity();
    if (read.kind !== "found") return "unreadable";
    const { secret, memberships, tier0Request } = read.identity;
    let asked: Promise<CommitmentResult>;
    try {
      if (memberships.length > 0 || tier0Request !== undefined) return "done";
      asked = registrar.commitment(secret);
    } finally {
      secret.fill(0);
    }
    const result = await asked;
    return result.ok ? result.commitment : "unreadable";
  }

  // Made and kept before any request, so a request is never sent for an
  // identity this device could lose ([[registration]], Outcome; T-18). One
  // that appeared meanwhile (another tab) is registered instead, never replaced.
  function prepare() {
    if (step.kind !== "intro") return;
    setStep({ kind: "preparing" });
    run(async () => {
      if (!made && (await registrar.create()) === "unwritable")
        return { kind: "stopped", problem: "unwritable" };
      const commitment = await commitmentHeld();
      if (commitment === "done") return "restart";
      return typeof commitment === "bigint"
        ? { kind: "challenge", commitment, round: 0 }
        : { kind: "stopped", problem: commitment };
    });
  }

  function send(commitment: bigint, token: string) {
    if (step.kind !== "challenge") return;
    setStep({ kind: "sending" });
    run(async () => {
      const answer = await registrar.send(tier0RequestBody(commitment, registrar.region, token));
      if (answer !== "accepted") return { kind: "stopped", problem: ANSWERS[answer], commitment };
      const acceptedAt = registrar.now();
      // The request is noted only beside the identity it was made for: the
      // secret read back must still commit to what was sent.
      const read = await registrar.identity();
      if (read.kind !== "found") return { kind: "stopped", problem: "not-noted" };
      const { secret } = read.identity;
      try {
        const again = await registrar.commitment(secret);
        if (!again.ok || again.commitment !== commitment)
          return { kind: "stopped", problem: "not-noted" };
        const noted = await registrar.record(secret, { region: registrar.region, acceptedAt });
        return noted === "recorded" ? { kind: "sent" } : { kind: "stopped", problem: "not-noted" };
      } finally {
        secret.fill(0);
      }
    });
  }

  switch (step.kind) {
    case "intro":
      return <RegisterIntro poll={poll} made={made} onStart={prepare} />;
    case "preparing":
    case "sending":
      return <RegisterWorking poll={poll} kind={step.kind} />;
    case "challenge":
      return (
        <RegisterChallenge
          // A fresh frame each round: a token is solved once.
          key={step.round}
          poll={poll}
          Challenge={registrar.Challenge}
          onToken={(token) => send(step.commitment, token)}
        />
      );
    case "sent":
      return <RegisterSent poll={poll} onBack={onDone} />;
    case "stopped": {
      const { commitment } = step;
      // A new solve where the route could take one; the worker's failure
      // checks the poll anew; anything else is shown without a way on.
      const retry = !STOPPED[step.problem].retry
        ? undefined
        : commitment === undefined
          ? onDone
          : () => setStep({ kind: "challenge", commitment, round: asked.current });
      return <RegisterStopped poll={poll} problem={step.problem} onRetry={retry} />;
    }
  }
}

/** Why the voter is making an identity, and what stays on the device, before anything happens. */
export function RegisterIntro({
  poll,
  made,
  onStart,
}: {
  poll: FramePoll;
  made: boolean;
  onStart: () => void;
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
    </EverydayFrame>
  );
}

const WORKING = {
  preparing: { title: "registerPreparingTitle", detail: "registerPreparing" },
  sending: { title: "registerSendingTitle", detail: "registerSending" },
} as const satisfies Record<
  string,
  { readonly title: keyof Messages; readonly detail: keyof Messages }
>;

/** While the identity is made and its commitment worked out, or the request is sent: nothing to press. */
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

/** The route accepted the request: it is signed into a group in a later batch, and the voter comes back. */
export function RegisterSent({ poll, onBack }: { poll: FramePoll; onBack: () => void }) {
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
    </EverydayFrame>
  );
}

/** A request went earlier and the client can't read its outcome yet: when, and to come back. */
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
