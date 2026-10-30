import { buttonVariants, useTranslate } from "@abolishus/ui";
import { ArrowRight, EyeOff } from "lucide-react";

import { catalogs } from "../messages.ts";
import type { ReportProfile } from "../profile-report.ts";
import type { ProfilePage as Profile } from "../server/load.ts";
import { PageHeader } from "./page-parts.tsx";
import { ReportSection, type ReportWords } from "./report-section.tsx";
import { Notice } from "./site-layout.tsx";
import { StreamCard } from "./stream.tsx";

const PROFILE_WORDS = {
  title: "byReportTitle",
  help: "byReportHelp",
  open: "byReport",
  legend: "byReportLegend",
  gone: "byReportGone",
} as const satisfies ReportWords;

/** Reporting the profile to moderators (src/profile-report.ts; T-10, T-11). */
export function ProfileReport({ handle, report }: { handle: string; report: ReportProfile }) {
  return <ReportSection words={PROFILE_WORDS} send={(reason) => report(handle, reason)} />;
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
