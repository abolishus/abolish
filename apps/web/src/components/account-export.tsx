import { Button, useTranslate } from "@abolishus/ui";
import { Download } from "lucide-react";
import { useRef, useState } from "react";

import { type ExportClient, ExportError, type ExportFailure } from "../account/export.ts";
import { catalogs, type Messages } from "../messages.ts";
import { Section } from "./page-parts.tsx";

/** What the file holds, in the export's order (packages/core's `AccountExport`). */
const HOLDS = [
  "exportHolds_account",
  "exportHolds_verification",
  "exportHolds_polls",
  "exportHolds_profile",
  "exportHolds_reactions",
  "exportHolds_token",
] as const satisfies readonly (keyof Messages)[];

export interface AccountExportProps {
  readonly client: ExportClient;
  /** The section's number on the page. */
  readonly index: string;
  /** Called when the session turns out to have ended. */
  readonly onSignedOut?: () => void;
}

/**
 * The account's own data to take away (P2-27 part 2b): what the file holds,
 * what it never holds, and a button that saves it. The file is everything
 * our servers keep about the account and nothing about answering, which
 * no account table holds (T-10).
 */
export function AccountExport({ client, index, onSignedOut }: AccountExportProps) {
  const t = useTranslate(catalogs);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState<ExportFailure | undefined>();
  // The button is disabled while the file is made, which can drop focus to
  // the page: then it goes to the section's heading, so keyboard users keep
  // their place. Focus the visitor moved elsewhere meanwhile stays there.
  const heading = useRef<HTMLHeadingElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  const download = async () => {
    setBusy(true);
    setDone(false);
    setFailure(undefined);
    try {
      await client.download();
      setDone(true);
    } catch (e) {
      const why = e instanceof ExportError ? e.failure : "failed";
      setFailure(why);
      if (why === "signedOut") onSignedOut?.();
    } finally {
      setBusy(false);
      const at = document.activeElement;
      if (at === null || at === document.body || at === button.current) heading.current?.focus();
    }
  };

  return (
    <Section
      index={index}
      mark={t("exportMark")}
      title={t("exportTitle")}
      id="export-title"
      titleRef={heading}
      lede={<p className="m-0">{t("exportLede")}</p>}
    >
      <div className="grid max-w-prose gap-4 text-base text-pretty">
        <ul className="m-0 grid list-none border-t-2 border-foreground p-0">
          {HOLDS.map((item) => (
            <li key={item} className="border-b border-border py-3">
              {t(item)}
            </li>
          ))}
        </ul>
        <p className="m-0">{t("exportNever")}</p>
        <p className="m-0 text-muted-foreground">{t("exportCare")}</p>
        <div>
          <Button ref={button} variant="outline" disabled={busy} onClick={download}>
            <Download aria-hidden="true" data-icon="inline-start" />
            {t(busy ? "exportPreparing" : "exportDownload")}
          </Button>
        </div>
        <div role="status" className="min-h-6">
          {done ? t("exportDone") : null}
        </div>
        {failure === undefined ? null : (
          <p role="alert" className="m-0 text-destructive">
            {t(`exportFailure_${failure}`)}
          </p>
        )}
      </div>
    </Section>
  );
}
