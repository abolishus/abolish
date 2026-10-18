import { useI18n, useTranslate } from "@abolishus/ui";
import type { PollState } from "@abolishus/core";
import { Check, Circle, Hourglass, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { DraftsError, type DraftsClient, type PollSummary } from "../account/drafts.ts";
import { catalogs, POLL_FAILURE_MESSAGES } from "../messages.ts";
import { formatUtc } from "./format.ts";
import { PageHeader } from "./page-parts.tsx";

/**
 * Setup's steps as the author reads them, each finished by one of the
 * worker's states (ADR 0032, rule 12): never a step's own name, a code or a
 * hash (rule 14, T-34).
 */
const STEPS = ["submitted", "created", "rooted", "keyed", "opened"] as const;
type Step = (typeof STEPS)[number];

/** How many steps a state has finished; `ceremony` is the key still being made. */
const FINISHED: Readonly<Record<Exclude<PollState, "drafted" | "failed">, number>> = {
  submitted: 1,
  created: 2,
  rooted: 3,
  ceremony: 3,
  registered: 4,
  open: 5,
};

const MARK = {
  done: { icon: Check, tone: "text-recorded" },
  now: { icon: Hourglass, tone: "text-pending" },
  later: { icon: Circle, tone: "text-muted-foreground" },
} as const satisfies Record<string, { icon: LucideIcon; tone: string }>;

type Unavailable = "signedOut" | "gone" | "unloaded";

const ID = /^[a-z0-9]{32}$/;

/** How long the page waits between reads while the poll sets up. */
export const SETUP_REFRESH_MS = 10_000;

export interface PollSetupPageProps {
  readonly client: DraftsClient;
  /** The poll whose setup this page follows. */
  readonly id: string;
  /** Milliseconds between reads while it sets up. */
  readonly every?: number;
}

/**
 * "Setting up your poll" (P2-22 part 6d): where an author lands after
 * submitting, following setup step by step until the poll opens, with a
 * link to its public page, or fails, in the failure's own words (ADR 0032,
 * rules 12 and 14). It reads the author's own poll from the drafts handler
 * again while setup runs; nothing names a voter (T-10), and analytics keeps
 * only the page's template (T-67).
 */
export function PollSetupPage({ client, id, every = SETUP_REFRESH_MS }: PollSetupPageProps) {
  const t = useTranslate(catalogs);
  const { locale } = useI18n();
  const [poll, setPoll] = useState<PollSummary | undefined>();
  const [unavailable, setUnavailable] = useState<Unavailable | undefined>();
  // A read after the first failed: what was shown stays, and the next read may work.
  const [stale, setStale] = useState(false);

  useEffect(() => {
    setPoll(undefined);
    setUnavailable(undefined);
    setStale(false);
    if (!ID.test(id)) return setUnavailable("gone");
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let shown = false;
    const read = async () => {
      try {
        const { summary } = await client.read(id);
        if (!live) return;
        shown = true;
        setPoll(summary);
        setStale(false);
        // Setup has finished, one way or the other (or never began): nothing more to follow.
        if (summary.state === "open" || summary.state === "failed" || summary.state === "drafted")
          return;
      } catch (e) {
        if (!live) return;
        const why = e instanceof DraftsError ? e.failure : "failed";
        if (why === "signedOut" || why === "gone") return setUnavailable(why);
        if (!shown) return setUnavailable("unloaded");
        setStale(true);
      }
      timer = setTimeout(() => void read(), every);
    };
    void read();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [client, id, every]);

  const header = (
    <PageHeader eyebrow={t("setupEyebrow")} title={t("setupTitle")} lede={t("setupLede")}>
      <p className="m-0">
        <a href="/account" className="underline underline-offset-4">
          {t("setupBack")}
        </a>
      </p>
      <noscript>
        <p className="m-0 text-lg">{t("setupNeedsScript")}</p>
      </noscript>
    </PageHeader>
  );

  if (poll === undefined || unavailable !== undefined)
    return (
      <div className="grid gap-12">
        {header}
        <p
          role={unavailable === undefined ? "status" : "alert"}
          className="m-0 max-w-prose text-lg"
        >
          {unavailable === undefined
            ? t("setupLoading")
            : t(
                (
                  {
                    signedOut: "setupSignedOut",
                    gone: "setupGone",
                    unloaded: "setupUnloaded",
                  } as const
                )[unavailable],
              )}
        </p>
      </div>
    );

  const title = poll.title === "" ? t("pollsUntitled") : poll.title;
  const state = poll.state;
  const finished = state === "drafted" || state === "failed" ? undefined : FINISHED[state];
  const row = (s: Step, i: number) => {
    const where =
      finished === undefined ? "later" : i < finished ? "done" : i === finished ? "now" : "later";
    const { icon: Icon, tone } = MARK[where];
    return (
      <li
        key={s}
        aria-current={where === "now" ? "step" : undefined}
        className="flex items-start gap-3 border-b border-border py-4 text-lg"
      >
        <Icon aria-hidden="true" className={`mt-1 size-5 shrink-0 ${tone}`} />
        <span>
          {t(`setupStep_${s}`)}
          <span className="sr-only"> ({t(`setupWhere_${where}`)})</span>
        </span>
      </li>
    );
  };

  return (
    <div className="grid gap-12">
      {header}
      <section
        aria-labelledby="poll-setup-title"
        className="grid gap-6 border-t border-border pt-12"
      >
        <h2
          id="poll-setup-title"
          className="m-0 font-heading text-3xl leading-tight font-semibold tracking-tight text-balance break-words"
        >
          {title}
        </h2>
        {state === "drafted" ? (
          <p className="m-0 max-w-prose text-lg">
            {t("setupDraft")}{" "}
            <a href={`/account/polls/${poll.id}`} className="underline underline-offset-4">
              {t("pollsEdit")}
            </a>
          </p>
        ) : state === "failed" ? (
          <div role="alert" className="grid max-w-prose gap-3 border-2 border-destructive p-5">
            <p className="m-0 text-lg font-semibold">{t("setupFailed")}</p>
            {poll.failure === undefined ? null : (
              <p className="m-0">{t(POLL_FAILURE_MESSAGES[poll.failure])}</p>
            )}
            <p className="m-0">
              <a href="/account" className="underline underline-offset-4">
                {t(poll.retryable ? "setupFailedNext" : "setupBack")}
              </a>
            </p>
          </div>
        ) : (
          <>
            <ol aria-label={t("setupStepsLabel")} className="m-0 grid max-w-2xl list-none p-0">
              {STEPS.map(row)}
            </ol>
            {/* Each read's step is said again, so a screen reader hears it move. */}
            <div role="status" className="grid max-w-prose gap-3 text-lg">
              {state === "open" ? (
                <>
                  <p className="m-0 font-semibold">{t("setupOpen")}</p>
                  <p className="m-0" suppressHydrationWarning>
                    {t("setupOpenUntil", {
                      when: formatUtc(locale, new Date(Number(poll.closesAt) * 1000)),
                    })}
                  </p>
                </>
              ) : (
                <p className="m-0">
                  {t("setupNow", { step: t(`setupStep_${STEPS[FINISHED[state]] ?? "opened"}`) })}
                </p>
              )}
            </div>
            {state === "open" && poll.electionId !== undefined ? (
              <p className="m-0">
                <a
                  href={`/polls/${poll.electionId}`}
                  className="text-lg font-semibold underline underline-offset-4"
                >
                  {t("setupPollPage")}
                </a>
              </p>
            ) : state === "open" ? null : (
              <p className="m-0 max-w-prose text-sm text-muted-foreground">
                {t(stale ? "setupStale" : "setupLeave")}
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
