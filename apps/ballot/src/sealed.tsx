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

/** While the worker seals or opens: nothing to press, and nothing is sent. */
export function Working({ poll, kind }: { poll: FramePoll; kind: "sealing" | "opening" }) {
  const t = useTranslate(catalogs);
  return (
    <EverydayFrame poll={poll}>
      <ScreenTitle title={t(kind === "sealing" ? "sealingTitle" : "openingTitle")} focus>
        <p className="m-0" role="status">
          {t(kind)}
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
      primary={
        <Button size="lg" className={ACTION} onClick={onAgain}>
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
        <div>
          {href === undefined ? null : (
            <a
              href={href}
              download={openingFileName(trackingCode)}
              className={cn(buttonVariants({ variant: "outline", size: "lg" }), ACTION)}
            >
              {t("saveOpening")}
            </a>
          )}
        </div>
        <p className="m-0 text-muted-foreground">{t("savedOpeningNote")}</p>
      </Part>
      <Part title={t("answerAgain")}>
        <p className="m-0">{t("answerAgainExplained")}</p>
      </Part>
    </EverydayFrame>
  );
}

const STOPPED: Record<
  "cant-seal-cells" | "cant-seal-version" | "seal-failed" | "open-failed",
  { readonly title: keyof Messages; readonly detail: keyof Messages }
> = {
  "cant-seal-cells": { title: "cantSealTitle", detail: "cantSealCells" },
  "cant-seal-version": { title: "cantSealTitle", detail: "cantSealVersion" },
  "seal-failed": { title: "sealFailedTitle", detail: "sealFailed" },
  "open-failed": { title: "openFailedTitle", detail: "openFailed" },
};

export type SealProblem = keyof typeof STOPPED;

/**
 * Sealing or opening stopped: what stopped it and, where answering again
 * could help, a fresh start. A poll this client can't seal offers none.
 */
export function SealStopped({
  poll,
  problem,
  onAgain,
}: {
  poll: FramePoll;
  problem: SealProblem;
  onAgain?: (() => void) | undefined;
}) {
  const t = useTranslate(catalogs);
  const { title, detail } = STOPPED[problem];
  return (
    <EverydayFrame
      poll={poll}
      primary={
        onAgain === undefined ? undefined : (
          <Button className={ACTION} onClick={onAgain}>
            {t("answerAgain")}
          </Button>
        )
      }
    >
      <ScreenTitle title={t(title)} focus>
        <p className="m-0">{t(detail)}</p>
      </ScreenTitle>
      <div className="mt-8">
        <Note title={t("localTitle")}>
          <p className="m-0">{t("local")}</p>
        </Note>
      </div>
    </EverydayFrame>
  );
}
