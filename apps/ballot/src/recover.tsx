import { Button, useTranslate } from "@abolishus/ui";
import { useEffect, useRef, useState } from "react";

import { type Backer, BackupOffer } from "./backup-offer.tsx";
import { ACTION, EverydayFrame, type FramePoll, Note, Part, ScreenTitle } from "./frame.tsx";
import type { LoadProblem } from "./load.ts";
import { catalogs, type Messages } from "./messages.ts";
import type { RecoveryOutcome, RecoveryProblem } from "./recovery.ts";

// Recovering the voting identity on a new device, on the screens
// ([[0017-identity-recovery-backup]], Option A, step 6): what a backup
// passkey brings back and what stays on the old device, the steps
// (`recover`, recovery.ts), and the outcome. A recovered identity names the
// area whose list counts it, for the voter to judge, since a move before
// the recovery can't be seen (T-16), and the voter is told to answer each
// poll from one device; this device answers no poll with it until the
// recovered client's checks exist (open.tsx; T-18). Nothing here touches
// the secret or the PRF output.

/** What the screens need; injected so stories need no authenticator, store, worker or network. */
export interface Recoverer {
  /**
   * A recovery in its steps (`recover`), each in a worker of its own that
   * ends once it settles, so a stopped recovery leaves no PRF output behind
   * (T-41).
   */
  readonly recover: () => Promise<RecoveryOutcome>;
}

/**
 * Why a recovery stopped, as the screens show it: a recovery's own problem,
 * or a registry read's. `exists` is never shown: the poll decides anew.
 */
type Stopped = Exclude<RecoveryProblem, "exists"> | "registry-unavailable" | "no-group-registry";

/**
 * Each reason a recovery stopped, as the voter is told it, and whether trying
 * again could help: with the same passkey, or another one the prompt offers
 * (`other`). A record, so a problem `recover` gains must be placed here.
 */
const STOPPED: Record<
  Stopped,
  {
    readonly title: keyof Messages;
    readonly detail: keyof Messages;
    readonly retry: "again" | "other" | undefined;
  }
> = {
  unreadable: { title: "identityUnreadableTitle", detail: "recoverUnreadable", retry: undefined },
  cancelled: { title: "recoverCancelledTitle", detail: "recoverCancelled", retry: "again" },
  // Another passkey app or browser may support the PRF.
  "no-prf": { title: "recoverUnsupportedTitle", detail: "recoverUnsupported", retry: "other" },
  "no-uv": { title: "backupNoUvTitle", detail: "recoverNoUv", retry: "again" },
  failed: { title: "recoverFailedTitle", detail: "recoverFailed", retry: "again" },
  "worker-failed": { title: "recoverFailedTitle", detail: "recoverFailed", retry: "again" },
  unreachable: { title: "recoverUnreachableTitle", detail: "recoverUnreachable", retry: "again" },
  // Step 6: a credential with no envelope gets a prompt to pick another.
  "no-backup": { title: "recoverNoBackupTitle", detail: "recoverNoBackup", retry: "other" },
  damaged: { title: "recoverDamagedTitle", detail: "recoverDamaged", retry: "other" },
  "registry-unavailable": {
    title: "recoverRegistryTitle",
    detail: "recoverRegistry",
    retry: "again",
  },
  "registry-refused": { title: "recoverRegistryTitle", detail: "recoverRegistry", retry: "again" },
  "no-group-registry": {
    title: "recoverNoGroupRegistryTitle",
    detail: "recoverNoGroupRegistry",
    retry: undefined,
  },
  // A registration still waiting to be added counts nowhere yet.
  "not-registered": {
    title: "recoverNotRegisteredTitle",
    detail: "recoverNotRegistered",
    retry: "again",
  },
  unwritable: { title: "recoverUnwritableTitle", detail: "recoverUnwritable", retry: undefined },
};

// Each registry read the screens can't use, as they act on it.
const UNREAD: Record<LoadProblem, Stopped> = {
  "no-registry": "no-group-registry",
  "wrong-chain": "registry-unavailable",
  "not-registered": "registry-unavailable",
  "not-found": "registry-unavailable",
  withheld: "registry-unavailable",
  unreachable: "registry-unavailable",
  "bad-answer": "registry-unavailable",
};

type Step =
  | { readonly kind: "intro" }
  | { readonly kind: "working" }
  | {
      readonly kind: "restored";
      readonly region: number;
      readonly syncable: boolean;
      readonly backedUp: boolean;
    }
  | { readonly kind: "stopped"; readonly problem: Stopped };

/**
 * Recovers a voting identity from its backup passkey onto this device,
 * which holds none. `onDone` checks the poll again from the start: once the
 * identity is back, and when the device turns out to hold one already
 * (another tab). `onBack` returns to making a new identity instead.
 */
export function Recover({
  poll,
  recoverer,
  backer,
  onDone,
  onBack,
}: {
  poll: FramePoll;
  recoverer: Recoverer;
  /** The backup offered once the identity is back, so its envelope is renewed; `undefined` where the build offers none. */
  backer: Backer | undefined;
  onDone: () => void;
  onBack: () => void;
}) {
  const [step, setStep] = useState<Step>({ kind: "intro" });
  // Each answer lands only on the step that asked for it, and never after
  // the voter left; a second tap asks nothing twice.
  const asked = useRef(0);
  useEffect(() => () => void asked.current++, []);

  function start() {
    if (step.kind === "working" || step.kind === "restored") return;
    setStep({ kind: "working" });
    const mine = ++asked.current;
    void (async () => {
      let next: Step | "restart";
      try {
        next = stepOf(await recoverer.recover());
      } catch {
        next = { kind: "stopped", problem: "worker-failed" };
      }
      if (asked.current !== mine) return;
      if (next === "restart") onDone();
      else setStep(next);
    })();
  }

  switch (step.kind) {
    case "intro":
      return <RecoverIntro poll={poll} onStart={start} onBack={onBack} />;
    case "working":
      return <RecoverWorking poll={poll} />;
    case "restored":
      return (
        <RecoverRestored
          poll={poll}
          region={step.region}
          syncable={step.syncable}
          backedUp={step.backedUp}
          backer={backer}
          onBack={onDone}
        />
      );
    case "stopped":
      return <RecoverStopped poll={poll} problem={step.problem} onRetry={start} onBack={onBack} />;
  }
}

function stepOf(outcome: RecoveryOutcome): Step | "restart" {
  if (outcome.kind === "restored") {
    const { region, syncable, backedUp } = outcome;
    return { kind: "restored", region, syncable, backedUp };
  }
  // An identity appeared meanwhile (another tab): the poll decides anew,
  // and nothing replaced it.
  if (outcome.problem === "exists") return "restart";
  if (outcome.problem === "registry") return { kind: "stopped", problem: UNREAD[outcome.load] };
  return { kind: "stopped", problem: outcome.problem };
}

/** What a recovery brings back and what it doesn't, before any passkey prompt. */
export function RecoverIntro({
  poll,
  onStart,
  onBack,
}: {
  poll: FramePoll;
  onStart: () => void;
  onBack: () => void;
}) {
  const t = useTranslate(catalogs);
  return (
    <EverydayFrame
      poll={poll}
      primary={
        <Button size="lg" className={ACTION} onClick={onStart}>
          {t("recoverStart")}
        </Button>
      }
      secondary={
        <Button size="lg" variant="outline" className={ACTION} onClick={onBack}>
          {t("back")}
        </Button>
      }
    >
      <ScreenTitle title={t("recoverTitle")} focus>
        <p className="m-0">{t("recover")}</p>
      </ScreenTitle>
      <Part title={t("recoverKeptTitle")}>
        <p className="m-0">{t("recoverKept")}</p>
      </Part>
      <Part title={t("recoverLeftTitle")}>
        <p className="m-0">{t("recoverLeft")}</p>
      </Part>
    </EverydayFrame>
  );
}

/** While the passkey is asked for and the backup fetched, opened and checked: nothing to press. */
export function RecoverWorking({ poll }: { poll: FramePoll }) {
  const t = useTranslate(catalogs);
  return (
    <EverydayFrame poll={poll}>
      <ScreenTitle title={t("recoverWorkingTitle")} focus>
        <p className="m-0" role="status">
          {t("recoverWorking")}
        </p>
      </ScreenTitle>
    </EverydayFrame>
  );
}

/**
 * The identity is back and kept: the area whose list counts it, for the
 * voter to judge; one device per poll; the passkey's sync where it won't
 * outlive its authenticator (step 2, checked again on every use); and the
 * backup offered again, which renews its envelope under the same passkey.
 */
export function RecoverRestored({
  poll,
  region,
  syncable,
  backedUp,
  backer,
  onBack,
}: {
  poll: FramePoll;
  /** The region code (a u32) of the group that counts the identity. */
  region: number;
  syncable: boolean;
  backedUp: boolean;
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
      <ScreenTitle title={t("recoveredTitle")} focus>
        <p className="m-0">{t("recovered", { region })}</p>
      </ScreenTitle>
      <div className="mt-8 grid gap-4">
        {/* [[0017-identity-recovery-backup]], Consequences: two devices
            without each other's records can void a vote by naming the same
            block. */}
        <Note tone="warn" title={t("recoveredOneDeviceTitle")}>
          <p className="m-0">{t("recoveredOneDevice")}</p>
        </Note>
        <Note title={t("recoveredAreaTitle")}>
          <p className="m-0">{t("recoveredArea", { region })}</p>
        </Note>
        {/* T-18: a passkey that can't sync, or isn't synced yet, takes the
            backup with it if this authenticator is lost. */}
        {!syncable ? (
          <Note tone="warn" title={t("backupNoSyncTitle")}>
            <p className="m-0">{t("recoveredNoSync")}</p>
          </Note>
        ) : !backedUp ? (
          <Note tone="warn" title={t("backupNotSyncedTitle")}>
            <p className="m-0">{t("recoveredNotSynced")}</p>
          </Note>
        ) : null}
      </div>
      {backer === undefined ? null : <BackupOffer backer={backer} />}
    </EverydayFrame>
  );
}

/** A recovery stopped: why, a retry where one could help, and the way back to making a new identity. */
export function RecoverStopped({
  poll,
  problem,
  onRetry,
  onBack,
}: {
  poll: FramePoll;
  problem: Stopped;
  onRetry: () => void;
  onBack: () => void;
}) {
  const t = useTranslate(catalogs);
  const { title, detail, retry } = STOPPED[problem];
  return (
    <EverydayFrame
      poll={poll}
      primary={
        retry === undefined ? undefined : (
          <Button size="lg" className={ACTION} onClick={onRetry}>
            {t(retry === "other" ? "recoverOther" : "tryAgain")}
          </Button>
        )
      }
      secondary={
        <Button size="lg" variant="outline" className={ACTION} onClick={onBack}>
          {t("back")}
        </Button>
      }
    >
      <ScreenTitle title={t(title)} focus>
        <p className="m-0">{t(detail)}</p>
      </ScreenTitle>
    </EverydayFrame>
  );
}
