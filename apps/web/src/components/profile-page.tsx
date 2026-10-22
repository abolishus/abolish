import { Button, buttonVariants, cn, useTranslate } from "@abolishus/ui";
import { Label } from "@abolishus/ui/ui/label";
import { RadioGroup, RadioGroupItem } from "@abolishus/ui/ui/radio-group";
import { ArrowRight, EyeOff, Flag } from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";

import { catalogs } from "../messages.ts";
import type { ReportOutcome, ReportProfile } from "../profile-report.ts";
import type { ProfilePage as Profile } from "../server/load.ts";
import { REMOVAL_GROUNDS, type RemovalGround } from "./moderation-log.tsx";
import { PageHeader } from "./page-parts.tsx";
import { Notice } from "./site-layout.tsx";
import { StreamCard } from "./stream.tsx";

const OUTCOME = {
  reported: "byReportDone",
  gone: "byReportGone",
  failed: "byReportFailed",
} as const satisfies Record<ReportOutcome, string>;

/**
 * Reporting the profile to moderators, under one of the policy's removal
 * grounds (docs/moderation-policy.md): nothing is sent until a ground is
 * chosen and the report confirmed, and nothing about the reporter is sent
 * at all (src/profile-report.ts; T-10, T-11).
 */
export function ProfileReport({ handle, report }: { handle: string; report: ReportProfile }) {
  const t = useTranslate(catalogs);
  const legendId = useId();
  const helpId = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<RemovalGround | undefined>();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ReportOutcome | undefined>();
  const legend = useRef<HTMLLegendElement>(null);
  const opener = useRef<HTMLButtonElement>(null);

  const start = () => {
    setOutcome(undefined);
    setReason(undefined);
    setOpen(true);
    // The form replaces the button: focus goes to its question.
    requestAnimationFrame(() => legend.current?.focus());
  };

  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => opener.current?.focus());
  };

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (reason === undefined) return;
    setBusy(true);
    const result = await report(handle, reason);
    setBusy(false);
    setOutcome(result);
    if (result !== "failed") close();
  };

  return (
    <section
      aria-labelledby={`${legendId}-title`}
      className="grid gap-4 border-t border-border pt-8"
    >
      <h2 id={`${legendId}-title`} className="m-0 font-heading text-xl font-semibold">
        {t("byReportTitle")}
      </h2>
      <p id={helpId} className="m-0 max-w-prose text-base text-pretty text-muted-foreground">
        {t("byReportHelp")}{" "}
        <a className="underline underline-offset-4" href="/moderation">
          {t("byReportPolicy")}
        </a>
      </p>
      {open ? (
        <form className="grid gap-4" aria-busy={busy} onSubmit={(e) => void send(e)}>
          <fieldset className="m-0 grid gap-3 border-0 p-0" aria-describedby={helpId}>
            <legend
              id={legendId}
              ref={legend}
              tabIndex={-1}
              className="mb-3 p-0 text-base font-semibold outline-none"
            >
              {t("byReportLegend")}
            </legend>
            <RadioGroup
              aria-labelledby={legendId}
              value={reason ?? ""}
              onValueChange={(value) => setReason(value as RemovalGround)}
              className="flex flex-wrap gap-2"
            >
              {REMOVAL_GROUNDS.map((r) => (
                <Label
                  key={r}
                  className={cn(
                    "flex min-h-12 items-center gap-3 border px-4 text-sm leading-tight font-normal",
                    reason === r
                      ? "border-2 border-primary px-[15px] font-semibold"
                      : "border-border",
                  )}
                >
                  <RadioGroupItem value={r} />
                  {t(`reason_${r}`)}
                </Label>
              ))}
            </RadioGroup>
          </fieldset>
          <div className="flex flex-wrap gap-3">
            <Button type="submit" disabled={busy || reason === undefined}>
              {t("byReportSend")}
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={close}>
              {t("byReportCancel")}
            </Button>
          </div>
        </form>
      ) : (
        <Button
          ref={opener}
          type="button"
          variant="outline"
          className="justify-self-start"
          onClick={start}
        >
          <Flag aria-hidden="true" />
          {t("byReport")}
        </Button>
      )}
      <p role="status" className="m-0 text-sm empty:hidden">
        {outcome === undefined ? null : t(OUTCOME[outcome])}
      </p>
    </section>
  );
}

export interface ProfilePageProps {
  readonly handle: string;
  readonly profile: Exclude<Profile, { kind: "not-found" }>;
  /** Whether this page starts after the top of the list. */
  readonly paged: boolean;
  /** The ballot client's address, or `null` where this site has none. */
  readonly ballot: string | null;
  readonly report: ReportProfile;
}

/**
 * A creator's profile, `/by/<handle>` ([[0040-creator-profiles]]): the name
 * its author chose, isolated so a right-to-left name can't reorder the words
 * around it (T-75), and the polls it shows, each the stream's card. It says
 * what it is: a name nobody checked, and a list that is this website's word,
 * not part of any poll (T-75). A hidden profile shows the decision's ground
 * alone (T-68).
 */
export function ProfilePage({ handle, profile, paged, ballot, report }: ProfilePageProps) {
  const t = useTranslate(catalogs);
  if (profile.kind === "hidden")
    return (
      <div className="grid gap-6">
        <Notice title={t("byHiddenTitle")}>
          {t("byHidden", { reason: t(`reason_${profile.reason}`) })}
        </Notice>
        <p className="m-0 flex items-center gap-2 text-base">
          <EyeOff aria-hidden="true" className="size-4 shrink-0" />
          <a className="underline underline-offset-4" href="/moderation">
            {t("byHiddenLog")}
          </a>
        </p>
      </div>
    );
  return (
    <div className="grid gap-10">
      <PageHeader eyebrow={t("byEyebrow")} title={<bdi>{profile.name}</bdi>} lede={t("byLede")}>
        <p className="m-0 max-w-prose text-sm text-pretty text-muted-foreground">{t("byNote")}</p>
      </PageHeader>
      <section aria-labelledby="by-polls" className="grid content-start gap-6">
        <h2 id="by-polls" className="sr-only">
          {t("byPolls")}
        </h2>
        {profile.cards.length === 0 ? (
          <div className="grid justify-items-start gap-3 border border-dashed border-border p-8">
            <p className="m-0 font-heading text-xl font-semibold">{t("byEmpty")}</p>
            <p className="m-0 text-base text-muted-foreground">{t("byEmptyLede")}</p>
          </div>
        ) : (
          <ol aria-labelledby="by-polls" className="m-0 grid list-none gap-6 p-0">
            {profile.cards.map((card) => (
              <li key={card.kind === "poll" ? card.poll.electionId : card.electionId}>
                <StreamCard card={card} ballot={ballot} />
              </li>
            ))}
          </ol>
        )}
        <div className="flex flex-wrap gap-3">
          {paged ? (
            <a className={buttonVariants({ variant: "outline" })} href={`/by/${handle}`}>
              {t("streamStart")}
            </a>
          ) : null}
          {profile.next === undefined ? null : (
            <a
              className={buttonVariants({ variant: "outline" })}
              href={`/by/${handle}?after=${profile.next}`}
            >
              {t("byMore")}
              <ArrowRight aria-hidden="true" />
            </a>
          )}
        </div>
      </section>
      <ProfileReport handle={handle} report={report} />
    </div>
  );
}
