import { Button, useTranslate } from "@abolishus/ui";
import { KeyRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { BackupOutcome, BackupProblem } from "./backup.ts";
import { Note } from "./frame.tsx";
import type { BackupCredentialRead } from "./identity.ts";
import { catalogs, type Messages } from "./messages.ts";

// The backup offer ([[0017-identity-recovery-backup]], Option A; the
// everyday mockups' `BackupOffer`): once the device holds a voting identity
// it has sent for registration, one sentence of why, two equal choices, and
// what skipping means. A backup whose passkey can't sync (BE clear) or isn't
// synced yet (BS clear) dies with this authenticator, and the voter is told
// so, then again on every later visit until a check finds it synced (Option
// A, step 2; T-18). Nothing here touches the secret or the PRF output: the
// steps are `backUp`'s (backup.ts).

/** What the offer needs; injected so stories need no authenticator, store, worker or network. */
export interface Backer {
  /** The backup credential this device keeps (`readBackupCredential`), read afresh. */
  readonly credential: () => Promise<BackupCredentialRead>;
  /** A backup, or a check that renews one, in its steps (`backUp`). */
  readonly backUp: () => Promise<BackupOutcome>;
}

/** Where the backup stands, as the offer shows it. */
type State =
  | { readonly kind: "reading" }
  | { readonly kind: "offer" }
  | { readonly kind: "skipped" }
  | { readonly kind: "working" }
  /** Stored; `syncable` and `backedUp` are the passkey's BE and BS. */
  | { readonly kind: "stored"; readonly syncable: boolean; readonly backedUp: boolean }
  | { readonly kind: "stopped"; readonly problem: BackupProblem };

/**
 * Each reason a backup stopped, as the voter is told it, and whether trying
 * again could help. A record, so a problem `backUp` gains must be placed here.
 */
const STOPPED: Record<
  BackupProblem,
  { readonly title: keyof Messages; readonly detail: keyof Messages; readonly retry: boolean }
> = {
  // Nothing to back up, or a store this device can't read: the registration
  // screens say what to do about the identity itself.
  "no-identity": { title: "backupUnreadableTitle", detail: "backupUnreadable", retry: false },
  unreadable: { title: "backupUnreadableTitle", detail: "backupUnreadable", retry: false },
  unwritable: { title: "backupUnwritableTitle", detail: "backupUnwritable", retry: false },
  cancelled: { title: "backupCancelledTitle", detail: "backupCancelled", retry: true },
  // Another passkey app or browser may support the PRF: a passkey that
  // couldn't serve isn't kept, so trying again makes a new one (backup.ts).
  "no-prf": { title: "backupUnsupportedTitle", detail: "backupUnsupported", retry: true },
  "no-uv": { title: "backupNoUvTitle", detail: "backupNoUv", retry: true },
  failed: { title: "backupFailedTitle", detail: "backupFailed", retry: true },
  "worker-failed": { title: "backupFailedTitle", detail: "backupFailed", retry: true },
  // The route refuses only what isn't an envelope of its form: this build's fault.
  rejected: { title: "backupRejectedTitle", detail: "backupRejected", retry: false },
  unreachable: { title: "backupUnreachableTitle", detail: "backupUnreachable", retry: true },
  "not-kept": { title: "backupNotKeptTitle", detail: "backupNotKept", retry: true },
};

/** The state a kept credential record shows before anything is pressed. */
function heldState(read: BackupCredentialRead): State {
  if (read.kind === "unreadable") return { kind: "stopped", problem: "unreadable" };
  // A passkey kept with no envelope stored yet (a backup that stopped after
  // the ceremony) is offered again: the next try evaluates that one.
  if (read.kind === "none" || read.credential.storedAt === undefined) return { kind: "offer" };
  // The record keeps BS but not BE: one that isn't backed up is checked anew
  // on the voter's tap, which reads both again.
  return { kind: "stored", syncable: true, backedUp: read.credential.backedUp };
}

/** The backup offer, or where the backup stands, as a section of a registration screen. */
export function BackupOffer({ backer }: { backer: Backer }) {
  const t = useTranslate(catalogs);
  const [state, setState] = useState<State>({ kind: "reading" });
  // Each answer lands only if it is the latest asked for, and never after
  // the voter left; a second tap while one runs asks nothing.
  const asked = useRef(0);
  useEffect(() => () => void asked.current++, []);
  // The button the voter pressed goes when the state changes, so focus
  // moves to where the state is shown rather than falling to the page
  // (WCAG 2.4.3). Not on the first read: the screen's title keeps it then.
  const status = useRef<HTMLDivElement>(null);
  const pressed = useRef(false);
  useEffect(() => {
    if (pressed.current) status.current?.focus();
  }, [state]);

  function run(step: () => Promise<State>) {
    const mine = ++asked.current;
    void (async () => {
      let next: State;
      try {
        next = await step();
      } catch {
        next = { kind: "stopped", problem: "failed" };
      }
      if (asked.current === mine) setState(next);
    })();
  }

  useEffect(() => {
    run(async () => heldState(await backer.credential()));
    // Once, on the first render: later reads come from a button.
  }, []);

  function backUp() {
    if (state.kind === "working") return;
    pressed.current = true;
    setState({ kind: "working" });
    run(async () => {
      const outcome = await backer.backUp();
      return outcome.kind === "stored"
        ? { kind: "stored", syncable: outcome.syncable, backedUp: outcome.backedUp }
        : { kind: "stopped", problem: outcome.problem };
    });
  }

  return (
    <section aria-labelledby="backup-title" className="mt-10 grid gap-4">
      {state.kind === "offer" ? (
        <div className="grid gap-4 border border-border px-4 py-5">
          <h2 id="backup-title" className="m-0 font-heading text-xl font-semibold">
            {t("backupOfferTitle")}
          </h2>
          <p className="m-0 text-pretty">{t("backupOffer")}</p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button size="lg" variant="outline" onClick={backUp}>
              <KeyRound aria-hidden="true" />
              {t("backupStart")}
            </Button>
            <Button
              size="lg"
              variant="ghost"
              onClick={() => {
                pressed.current = true;
                setState({ kind: "skipped" });
              }}
            >
              {t("backupSkip")}
            </Button>
          </div>
          <p className="m-0 text-sm text-pretty text-muted-foreground">{t("backupSkipMeans")}</p>
        </div>
      ) : (
        <>
          <h2 id="backup-title" className="sr-only">
            {t("backupSectionTitle")}
          </h2>
          <div ref={status} role="status" tabIndex={-1} className="grid gap-4 outline-none">
            <BackupState state={state} onBackUp={backUp} />
          </div>
        </>
      )}
    </section>
  );
}

function BackupState({
  state,
  onBackUp,
}: {
  state: Exclude<State, { kind: "offer" }>;
  onBackUp: () => void;
}) {
  const t = useTranslate(catalogs);
  switch (state.kind) {
    case "reading":
      return null;
    case "skipped":
      return <p className="m-0 text-pretty text-muted-foreground">{t("backupSkipped")}</p>;
    case "working":
      return <p className="m-0 text-pretty">{t("backupWorking")}</p>;
    case "stored":
      // T-18: a passkey that can't sync, or isn't synced yet, takes the
      // backup with it if this authenticator is lost.
      if (!state.syncable)
        return (
          <Note tone="warn" title={t("backupNoSyncTitle")}>
            <p className="m-0">{t("backupNoSync")}</p>
          </Note>
        );
      if (!state.backedUp)
        return (
          <Note tone="warn" title={t("backupNotSyncedTitle")}>
            <p className="m-0">{t("backupNotSynced")}</p>
            <div>
              <Button variant="outline" onClick={onBackUp}>
                {t("backupCheckSync")}
              </Button>
            </div>
          </Note>
        );
      return (
        <Note tone="done" title={t("backupStoredTitle")}>
          <p className="m-0">{t("backupStored")}</p>
        </Note>
      );
    case "stopped": {
      const { title, detail, retry } = STOPPED[state.problem];
      return (
        <Note tone="warn" title={t(title)}>
          <p className="m-0">{t(detail)}</p>
          {retry ? (
            <div>
              <Button variant="outline" onClick={onBackUp}>
                {t("backupRetry")}
              </Button>
            </div>
          ) : null}
        </Note>
      );
    }
  }
}
