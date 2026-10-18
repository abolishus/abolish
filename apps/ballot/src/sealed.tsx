import {
  Button,
  buttonVariants,
  cn,
  Fingerprint,
  groupHex,
  Hash,
  QrCode,
  useTranslate,
} from "@abolishus/ui";
import { useEffect, useState } from "react";

import { ACTION, EverydayFrame, type FramePoll, Note, Part, ScreenTitle } from "./frame.tsx";
import { catalogs, type Messages } from "./messages.ts";
import { openingFileName, trackingCodeText } from "./tracking.ts";

// The screens between "Seal my answers" and sending (P2-8 part 3b-2c): the
// sealed ballot's tracking code, shown before the voter chooses to cast or
// to challenge ([[challenge]], Client rule 1), and a challenged ballot's
// opening, handed to the voter's other device as a file (Client rule 2).
// The casting device never says whether its own opening checks: it drew the
// screen, so only the checker that recorded the code before the choice can
// (T-42, T-44). Nothing here goes through a server.

/** A hash's first two groups of four hex digits, as a label reads it aloud. */
function shortHex(hash: string): string {
  return groupHex(hash).slice(0, 2).join(" ");
}

const WORKING = {
  finding: { title: "findingTitle", detail: "finding" },
  sealing: { title: "sealingTitle", detail: "sealing" },
  opening: { title: "openingTitle", detail: "opening" },
} as const satisfies Record<
  string,
  { readonly title: keyof Messages; readonly detail: keyof Messages }
>;

/**
 * While the page reads the board and the worker finds the voter's cell in
 * it, seals or opens: nothing to press, and nothing is sent.
 */
export function Working({ poll, kind }: { poll: FramePoll; kind: keyof typeof WORKING }) {
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

/** The tracking code: its QR code (full 32 bytes, with the election), fingerprint and hex. */
function TrackingCode({ electionId, code }: { electionId: string; code: string }) {
  const t = useTranslate(catalogs);
  return (
    <div className="grid gap-4 border-2 border-foreground px-4 py-5 sm:grid-cols-[auto_1fr] sm:items-start">
      <QrCode
        value={trackingCodeText(electionId, code)}
        label={t("trackingCodeQr", { hash: shortHex(code) })}
        size={208}
      />
      <div className="grid min-w-0 gap-4">
        <Fingerprint
          value={code}
          label={t("trackingCodeFingerprint", { hash: shortHex(code) })}
          size={56}
        />
        <Hash value={code} label={t("trackingCodeLabel")} />
      </div>
    </div>
  );
}

/**
 * A sealed ballot's tracking code, then the choice. It's the same screen
 * whether or not anyone scans it, and it stays until the voter chooses, so
 * this device learns as little as it can about who checks (T-44).
 * `electionId` and `trackingCode` are lowercase hex.
 */
export function Sealed({
  poll,
  electionId,
  trackingCode,
  onCast,
  onChallenge,
}: {
  poll: FramePoll;
  electionId: string;
  trackingCode: string;
  onCast: () => void;
  onChallenge: () => void;
}) {
  const t = useTranslate(catalogs);
  return (
    <EverydayFrame
      poll={poll}
      primary={
        <Button size="lg" className={ACTION} onClick={onCast}>
          {t("cast")}
        </Button>
      }
      secondary={
        <Button size="lg" variant="outline" className={ACTION} onClick={onChallenge}>
          {t("challenge")}
        </Button>
      }
    >
      <ScreenTitle title={t("sealedTitle")} focus>
        <p className="m-0">{t("sealed")}</p>
      </ScreenTitle>
      <div className="mt-8">
        <TrackingCode electionId={electionId} code={trackingCode} />
      </div>
      <Part title={t("scanTitle")}>
        <p className="m-0">{t("scan")}</p>
      </Part>
      <Part title={t("chooseTitle")}>
        <dl className="m-0 grid gap-4">
          <div className="grid gap-1 border-s-4 border-s-primary ps-4">
            <dt className="font-semibold">{t("cast")}</dt>
            <dd className="m-0">{t("castExplained")}</dd>
          </div>
          <div className="grid gap-1 border-s-4 border-s-border ps-4">
            <dt className="font-semibold">{t("challenge")}</dt>
            <dd className="m-0 grid gap-2">
              <p className="m-0">{t("challengeExplained")}</p>
              <p className="m-0 text-muted-foreground">{t("challengeOptional")}</p>
            </dd>
          </div>
        </dl>
      </Part>
    </EverydayFrame>
  );
}

/**
 * A challenged ballot, opened: the tracking code it opens and the opening
 * (the `0x0003` record's bytes) as a file to save for the other device. The
 * vote isn't shown here: this device's word on its own ballot proves nothing
 * (challenge, Client rules; T-42).
 */
export function Opened({
  poll,
  trackingCode,
  opening,
  onAgain,
}: {
  poll: FramePoll;
  trackingCode: string;
  opening: Uint8Array;
  onAgain: () => void;
}) {
  const t = useTranslate(catalogs);
  // A blob: URL lives until revoked; it goes with the screen.
  const [href, setHref] = useState<string>();
  useEffect(() => {
    const url = URL.createObjectURL(
      new Blob([opening.slice()], { type: "application/octet-stream" }),
    );
    setHref(url);
    return () => URL.revokeObjectURL(url);
  }, [opening]);
  return (
    <EverydayFrame
      poll={poll}
      // Saving comes first: the opening can't be saved once the voter leaves.
      primary={
        href === undefined ? undefined : (
          <a
            href={href}
            download={openingFileName(trackingCode)}
            className={cn(buttonVariants({ size: "lg" }), ACTION)}
          >
            {t("saveOpening")}
          </a>
        )
      }
      secondary={
        <Button size="lg" variant="outline" className={ACTION} onClick={onAgain}>
          {t("answerAgain")}
        </Button>
      }
    >
      <ScreenTitle title={t("openedTitle")} focus>
        <p className="m-0">{t("opened")}</p>
      </ScreenTitle>
      <div className="mt-8 grid gap-4 border-2 border-foreground px-4 py-5">
        <Fingerprint
          value={trackingCode}
          label={t("trackingCodeFingerprint", { hash: shortHex(trackingCode) })}
          size={56}
        />
        <Hash value={trackingCode} label={t("openedCode")} />
      </div>
      <Part title={t("checkElsewhereTitle")}>
        <p className="m-0">{t("checkElsewhere")}</p>
        <p className="m-0 text-muted-foreground">{t("savedOpeningNote")}</p>
      </Part>
      <Part title={t("answerAgain")}>
        <p className="m-0">{t("answerAgainExplained")}</p>
      </Part>
    </EverydayFrame>
  );
}

const STOPPED: Record<
  | "cant-seal-version"
  | "no-identity"
  | "identity-unreadable"
  | "not-listed"
  | "board-unavailable"
  | "no-registrars"
  | "cell-refused"
  | "seal-failed"
  | "open-failed"
  | "no-l1"
  | "cast-failed"
  | "cast-faulty",
  { readonly title: keyof Messages; readonly detail: keyof Messages }
> = {
  "cant-seal-version": { title: "cantSealTitle", detail: "cantSealVersion" },
  "no-identity": { title: "noIdentityTitle", detail: "noIdentity" },
  "identity-unreadable": { title: "identityUnreadableTitle", detail: "identityUnreadable" },
  "not-listed": { title: "notListedTitle", detail: "notListed" },
  "board-unavailable": { title: "boardUnavailableTitle", detail: "boardUnavailable" },
  "no-registrars": { title: "noRegistrarsTitle", detail: "noRegistrars" },
  "cell-refused": { title: "cellRefusedTitle", detail: "cellRefused" },
  "seal-failed": { title: "sealFailedTitle", detail: "sealFailed" },
  "open-failed": { title: "openFailedTitle", detail: "openFailed" },
  "no-l1": { title: "noL1Title", detail: "noL1" },
  "cast-failed": { title: "castFailedTitle", detail: "castFailed" },
  "cast-faulty": { title: "castFaultyTitle", detail: "castFaulty" },
};

export type SealProblem = keyof typeof STOPPED;

/**
 * Sealing, opening or casting stopped: what stopped it, the check's own
 * name where one refused (`code`, for whoever the voter reports it to) and,
 * where answering again could help, a fresh start. A poll this client can't
 * seal offers none.
 */
export function SealStopped({
  poll,
  problem,
  code,
  onAgain,
}: {
  poll: FramePoll;
  problem: SealProblem;
  code?: string | undefined;
  onAgain?: (() => void) | undefined;
}) {
  const t = useTranslate(catalogs);
  const { title, detail } = STOPPED[problem];
  return (
    <EverydayFrame
      poll={poll}
      primary={
        onAgain === undefined ? undefined : (
          <Button size="lg" className={ACTION} onClick={onAgain}>
            {t("answerAgain")}
          </Button>
        )
      }
    >
      <ScreenTitle title={t(title)} focus>
        <p className="m-0">{t(detail)}</p>
      </ScreenTitle>
      {code === undefined ? null : (
        <Part title={t("proofCheckTitle")}>
          <p className="m-0 text-sm text-muted-foreground">
            {t("proofCheckNamed")}{" "}
            <code translate="no" className="font-mono">
              {code}
            </code>
          </p>
        </Part>
      )}
      <div className="mt-8">
        <Note title={t("localTitle")}>
          <p className="m-0">{t("local")}</p>
        </Note>
      </div>
    </EverydayFrame>
  );
}
