import { buttonVariants, Fingerprint, useI18n, useTranslate } from "@abolishus/ui";
import {
  ArrowLeft,
  ArrowLeftToLine,
  ArrowRight,
  Ban,
  EyeOff,
  ListX,
  RotateCcw,
  Tags,
  UserRound,
} from "lucide-react";
import type { ReactNode } from "react";

import { catalogs, type Messages, POLL_TOPIC_MESSAGES } from "../messages.ts";
import { LOG_ACTIONS, type LogAction } from "../log-actions.ts";
import { REMOVAL_GROUNDS, RESTORE_GROUNDS } from "../moderation-grounds.ts";
import type { LogCounts, LogPlace, ModerationLogPage as Log } from "../server/load.ts";
import { formatUtc, formatUtcDay } from "./format.ts";
import { Bar } from "./poll-results.tsx";
import { PageHeader, Section } from "./page-parts.tsx";
import { FilterGroup } from "./filter-group.tsx";

type Entry = Log["entries"][number];

const NEVER_GROUNDS = [
  "moderationNever_viewpoint",
  "moderationNever_controversy",
  "moderationNever_criticism",
  "moderationNever_publicFigure",
  "moderationNever_reports",
  "moderationNever_result",
] as const satisfies readonly (keyof Messages)[];

const ACTION_ICON: Record<Entry["action"], ReactNode> = {
  delist: <ListX className="size-4" />,
  hide: <EyeOff className="size-4" />,
  restore: <RotateCcw className="size-4" />,
  refile: <Tags className="size-4" />,
};

const ACTION_TEXT = {
  delist: "action_delist",
  hide: "action_hide",
  "hide-profile": "profileAction_hide",
  restore: "action_restore",
  refile: "action_refile",
} as const satisfies Record<LogAction, keyof Messages>;

/** What a decision did, as the filter names it. */
function logAction(entry: Entry): LogAction {
  return "electionId" in entry || entry.action === "restore" ? entry.action : "hide-profile";
}

type Refiling = Extract<Entry, { action: "refile" }>;

/** What a refiling changed: the topic's words, and only whether the place changed (T-17). */
function Refiled({ entry }: { entry: Refiling }) {
  const t = useTranslate(catalogs);
  const changes: string[] = [];
  if (entry.topic === null) changes.push(t("refiledTopicCleared"));
  else if (entry.topic !== undefined)
    changes.push(t("refiledTopic", { topic: t(POLL_TOPIC_MESSAGES[entry.topic]) }));
  if (entry.place !== undefined)
    changes.push(t(entry.place === "changed" ? "refiledPlaceChanged" : "refiledPlaceCleared"));
  return (
    <span className="grid gap-0.5">
      <span className="flex items-center gap-2">
        <span aria-hidden="true">{ACTION_ICON.refile}</span>
        {t("action_refile")}
      </span>
      <span className="text-xs text-muted-foreground">{changes.join(" · ")}</span>
    </span>
  );
}

const RULED = "m-0 grid list-none border-t border-foreground p-0";
const TERM = "text-sm text-muted-foreground lg:sr-only";
const COLUMNS = "lg:grid-cols-[4rem_14rem_minmax(0,1fr)_9rem_10rem]";

/** What moderation can and can't reach, stated before the log. */
function Boundary() {
  const t = useTranslate(catalogs);
  const side = (title: ReactNode, items: readonly (keyof Messages)[]) => (
    <>
      <p className="m-0 flex items-center gap-2 font-mono text-xs tracking-widest uppercase">
        {title}
      </p>
      <ul className={`${RULED} text-lg`}>
        {items.map((item) => (
          <li key={item} className="border-b border-border py-3">
            {t(item)}
          </li>
        ))}
      </ul>
    </>
  );
  return (
    <div className="grid border-y-2 border-foreground md:grid-cols-2">
      <div className="grid content-start gap-4 border-b border-border py-8 md:border-e md:border-b-0 md:pe-8">
        {side(t("moderationActsOn"), [
          "moderationActsOn_text",
          "moderationActsOn_listing",
          "moderationActsOn_profile",
        ])}
      </div>
      <div className="grid content-start gap-4 py-8 md:ps-8">
        {side(
          <>
            <Ban aria-hidden="true" className="size-4" />
            {t("moderationNeverActsOn")}
          </>,
          [
            "moderationNeverActsOn_board",
            "moderationNeverActsOn_definition",
            "moderationNeverActsOn_result",
          ],
        )}
      </div>
    </div>
  );
}

function Row({ entry }: { entry: Entry }) {
  const t = useTranslate(catalogs);
  const { locale } = useI18n();
  return (
    <li className="border-b border-border py-4">
      <dl
        className={`m-0 grid grid-cols-[6rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 lg:items-center ${COLUMNS}`}
      >
        <dt className={TERM}>{t("moderationSeq")}</dt>
        <dd className="m-0 font-mono text-sm tabular-nums">{entry.seq}</dd>
        <dt className={TERM}>{t("moderationDecided")}</dt>
        <dd className="m-0 font-mono text-xs tracking-wide tabular-nums">
          <time dateTime={entry.decidedAt} suppressHydrationWarning>
            {t("utcTime", { time: formatUtc(locale, new Date(entry.decidedAt)) })}
          </time>
        </dd>
        {"electionId" in entry ? (
          <>
            <dt className={TERM}>{t("moderationPoll")}</dt>
            <dd className="m-0 flex min-w-0 items-center gap-3">
              {/* A seal only: the link names the same poll. */}
              <span aria-hidden="true" className="contents">
                <Fingerprint
                  value={entry.electionId}
                  label={t("fingerprintPoll", { prefix: entry.electionId.slice(0, 8) })}
                  size={28}
                />
              </span>
              <a
                className="font-mono text-sm underline underline-offset-4"
                translate="no"
                href={`/polls/${entry.electionId}`}
              >
                {t("shortId", { prefix: entry.electionId.slice(0, 16) })}
              </a>
            </dd>
            <dt className={TERM}>{t("moderationAction")}</dt>
            {entry.action === "refile" ? (
              <dd className="m-0 text-sm">
                <Refiled entry={entry} />
              </dd>
            ) : (
              <dd className="m-0 flex items-center gap-2 text-sm">
                <span aria-hidden="true">{ACTION_ICON[entry.action]}</span>
                {t(`action_${entry.action}`)}
              </dd>
            )}
          </>
        ) : (
          <>
            <dt className={TERM}>{t("moderationProfile")}</dt>
            {/* The handle only, never the name: a hidden name stays off every
                page, and the log carries no free text (T-75, T-17). */}
            <dd className="m-0 flex min-w-0 items-center gap-3">
              <UserRound aria-hidden="true" className="size-7 shrink-0 p-1" />
              <a
                className="font-mono text-sm break-all underline underline-offset-4"
                translate="no"
                href={`/by/${entry.handle}`}
              >
                {entry.handle}
              </a>
            </dd>
            <dt className={TERM}>{t("moderationAction")}</dt>
            <dd className="m-0 flex items-center gap-2 text-sm">
              <span aria-hidden="true">{ACTION_ICON[entry.action]}</span>
              {t(entry.action === "hide" ? "profileAction_hide" : "action_restore")}
            </dd>
          </>
        )}
        <dt className={TERM}>{t("moderationReason")}</dt>
        <dd className="m-0 text-sm">{t(`reason_${entry.reason}`)}</dd>
      </dl>
    </li>
  );
}

/**
 * The whole log's decisions by action, as the filter names them, from the
 * API's counts rather than the page in hand, since the log's first decision:
 * a reader sees how often each action was taken, and over how long, without
 * paging through the log (T-68). The action the filter shows is marked in
 * words as well as by its bar's colour.
 */
function LogTally({
  counts,
  since,
  chosen,
}: {
  counts: LogCounts;
  since: string;
  chosen: LogAction | undefined;
}) {
  const t = useTranslate(catalogs);
  const { locale } = useI18n();
  const number = new Intl.NumberFormat(locale);
  return (
    <figure aria-labelledby="log-counts" className="m-0 grid gap-3">
      <figcaption
        id="log-counts"
        className="font-mono text-xs tracking-wide text-muted-foreground uppercase"
        // A day in the locale's words, which server and browser can word apart.
        suppressHydrationWarning
      >
        {t("moderationCounts", { count: counts.total, since: formatUtcDay(locale, since) })}
      </figcaption>
      <ol className="m-0 grid list-none border-t border-foreground p-0">
        {LOG_ACTIONS.map((a) => (
          <li
            key={a}
            aria-current={a === chosen ? "true" : undefined}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 border-b border-border py-3 sm:grid-cols-[12rem_minmax(0,1fr)_5rem]"
          >
            {a === chosen ? (
              <span className="grid text-sm">
                <span className="font-semibold">{t(ACTION_TEXT[a])}</span>
                <span className="text-xs text-muted-foreground">{t("moderationCountsShown")}</span>
              </span>
            ) : (
              <span className="text-sm">{t(ACTION_TEXT[a])}</span>
            )}
            {/* The bar after the count on a phone, between them otherwise. */}
            <span className="order-last col-span-full grid sm:order-none sm:col-span-1">
              <Bar share={counts[a] / counts.total} lead={a === chosen} />
            </span>
            <span className="text-end font-mono text-sm tabular-nums">
              {number.format(counts[a])}
            </span>
          </li>
        ))}
      </ol>
    </figure>
  );
}

export interface ModerationLogProps {
  log: Log;
  /** Where this page starts, if it isn't the latest. */
  place: LogPlace | undefined;
  /** The number the earlier page reads below, if there may be earlier decisions. */
  next: string | undefined;
  /** The number the later page reads above, if this page isn't the latest. */
  later: string | undefined;
  /** The action the page shows, or every action with `"all"` or `undefined`. */
  action: LogAction | "all" | undefined;
}

/**
 * The public moderation log (T-68): what was done to which poll or profile,
 * including where a poll is listed, and why, never who did it or who reported it, with the policy's limits and grounds
 * beside it. The log carries no free text, so a row can't carry personal
 * data (T-17); the page shows the API's rows as they come, newest first, so
 * what moderation did last is what a reader meets first, filtered by action
 * over the page in hand, beneath the whole log's counts by action. It ends
 * on how to report and appeal; reports are sent from each poll's and
 * profile's own page, which already knows what is reported.
 */
export function ModerationLog({ log, place, next, later, action }: ModerationLogProps) {
  const t = useTranslate(catalogs);
  const only = action === "all" ? undefined : action;
  const shown =
    only === undefined ? log.entries : log.entries.filter((entry) => logAction(entry) === only);
  // Values are canonical decimals and actions from a fixed list: nothing needs escaping.
  const pageHref = (at: LogPlace | undefined, of: LogAction | undefined) => {
    const query = [
      ...(at === undefined ? [] : "after" in at ? [`after=${at.after}`] : [`before=${at.before}`]),
      ...(of === undefined ? [] : [`action=${of}`]),
    ].join("&");
    return query === "" ? "/moderation" : `/moderation?${query}`;
  };
  return (
    <div className="grid gap-16">
      <PageHeader
        eyebrow={t("moderationEyebrow")}
        title={t("moderationTitle")}
        lede={t("moderationLede")}
      />

      <section aria-label={t("moderationReach")} className="grid gap-6">
        <Boundary />
        <p className="m-0 max-w-prose text-base text-pretty">{t("moderationResultsStay")}</p>
      </section>

      <Section
        index="01"
        mark={t("moderationLogMark")}
        title={t("moderationLogTitle")}
        id="log-title"
        lede={
          <p className="m-0">
            {t("moderationLogLede")}{" "}
            <code className="font-mono text-sm" translate="no">
              GET /moderation/log
            </code>
          </p>
        }
      >
        {log.counts?.since === undefined ? null : (
          <LogTally counts={log.counts} since={log.counts.since} chosen={only} />
        )}
        {log.entries.length === 0 ? (
          <p className="m-0 text-lg">{t("moderationEmpty")}</p>
        ) : (
          <form method="get" action="/moderation" className="grid gap-4">
            {place === undefined ? null : "after" in place ? (
              <input type="hidden" name="after" value={place.after} />
            ) : (
              <input type="hidden" name="before" value={place.before} />
            )}
            <FilterGroup
              name="action"
              legend={t("moderationAction")}
              // Only the actions on this page, and the one chosen, as on the board.
              options={LOG_ACTIONS.filter(
                (a) => a === only || log.entries.some((entry) => logAction(entry) === a),
              )}
              checked={only}
              count={(a) =>
                a === "all"
                  ? log.entries.length
                  : log.entries.filter((entry) => logAction(entry) === a).length
              }
              label={(a) => t(ACTION_TEXT[a])}
            />
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-border pt-4">
              <button type="submit" className={buttonVariants()}>
                {t("moderationActionApply")}
              </button>
              {only === undefined ? null : (
                <a className="underline underline-offset-4" href={pageHref(place, undefined)}>
                  {t("filterClear")}
                </a>
              )}
            </div>
          </form>
        )}
        {log.entries.length === 0 || only === undefined ? null : (
          <p className="m-0 text-sm font-medium">
            {t("moderationActionMatches", { shown: shown.length, total: log.entries.length })}
          </p>
        )}
        {log.entries.length === 0 ? null : shown.length === 0 ? (
          <p className="m-0 border-y border-foreground py-8 text-lg" role="status">
            {t("moderationActionNone")}
            {/* Only where there are earlier decisions to look through. */}
            {next === undefined ? null : ` ${t("moderationActionEarlier")}`}
          </p>
        ) : (
          <div className="grid gap-0">
            <div
              aria-hidden="true"
              className={`hidden gap-x-4 border-b border-foreground pb-2 font-mono text-xs tracking-wide text-muted-foreground uppercase lg:grid ${COLUMNS}`}
            >
              <span>{t("moderationSeq")}</span>
              <span>{t("moderationDecided")}</span>
              <span>{t("moderationSubject")}</span>
              <span>{t("moderationAction")}</span>
              <span>{t("moderationReason")}</span>
            </div>
            <ol
              aria-labelledby="log-title"
              className="m-0 grid list-none border-t-2 border-foreground p-0 lg:border-t-0"
            >
              {shown.map((entry) => (
                <Row key={entry.seq} entry={entry} />
              ))}
            </ol>
          </div>
        )}
        {/* Not where the page holds more than the counts: the two are read
            apart, so a decision made between them can leave the counts a
            little behind the page, which this hides only at its extreme. */}
        {log.counts === undefined ||
        log.entries.length === 0 ||
        log.entries.length > log.counts.total ? null : (
          <p className="m-0 font-mono text-xs tracking-wide text-muted-foreground">
            {t("moderationPageOfLog", { shown: log.entries.length, count: log.counts.total })}
          </p>
        )}
        {next === undefined && place === undefined ? null : (
          <div className="flex flex-wrap items-center gap-x-6">
            {place === undefined ? null : (
              <a
                className="inline-flex min-h-12 items-center gap-2 underline underline-offset-4"
                href={pageHref(undefined, only)}
              >
                <ArrowLeftToLine aria-hidden="true" className="size-4" />
                {t("moderationLatest")}
              </a>
            )}
            {later === undefined ? null : (
              <a
                className="inline-flex min-h-12 items-center gap-2 underline underline-offset-4"
                href={pageHref({ after: later }, only)}
              >
                <ArrowLeft aria-hidden="true" className="size-4" />
                {t("moderationLater")}
              </a>
            )}
            {next === undefined ? null : (
              <a
                className="inline-flex min-h-12 items-center gap-2 underline underline-offset-4"
                href={pageHref({ before: next }, only)}
              >
                {t("moderationMore")}
                <ArrowRight aria-hidden="true" className="size-4" />
              </a>
            )}
          </div>
        )}
      </Section>

      <Section
        index="02"
        mark={t("moderationGroundsMark")}
        title={t("moderationGroundsTitle")}
        id="grounds-title"
        lede={<p className="m-0">{t("moderationGroundsLede")}</p>}
      >
        <ol className="m-0 grid list-none border-t-2 border-foreground p-0 md:grid-cols-2">
          {REMOVAL_GROUNDS.map((ground, i) => (
            <li
              key={ground}
              className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-4 gap-y-1 border-b border-border py-5 md:odd:border-e md:odd:pe-6 md:even:ps-6"
            >
              <span aria-hidden="true" className="font-mono text-sm tabular-nums">
                {String(i + 1).padStart(2, "0")}
              </span>
              <h3 className="m-0 text-lg font-semibold">
                {t(`reason_${ground}`)}{" "}
                <code className="ms-1 font-mono text-xs font-normal" translate="no">
                  {ground}
                </code>
              </h3>
              <p className="col-start-2 m-0 text-sm text-pretty">{t(`ground_${ground}`)}</p>
            </li>
          ))}
        </ol>
        <div className="grid gap-10 md:grid-cols-2">
          <div className="grid content-start gap-3">
            <h3 className="m-0 text-xl font-semibold">{t("moderationNeverTitle")}</h3>
            <ul className={RULED}>
              {NEVER_GROUNDS.map((never) => (
                <li key={never} className="flex gap-3 border-b border-border py-3 text-base">
                  <Ban aria-hidden="true" className="mt-1 size-4 shrink-0" />
                  {t(never)}
                </li>
              ))}
            </ul>
          </div>
          <div className="grid content-start gap-3">
            <h3 className="m-0 text-xl font-semibold">{t("moderationRestoreTitle")}</h3>
            <ul className={RULED}>
              {RESTORE_GROUNDS.map((ground) => (
                <li key={ground} className="grid gap-0.5 border-b border-border py-3">
                  <span className="font-semibold">
                    {t(`reason_${ground}`)}{" "}
                    <code className="ms-1 font-mono text-xs font-normal" translate="no">
                      {ground}
                    </code>
                  </span>
                  <span className="text-sm">{t(`ground_${ground}`)}</span>
                </li>
              ))}
            </ul>
            <p className="m-0 text-sm text-muted-foreground">{t("moderationAppealOnce")}</p>
          </div>
        </div>
      </Section>

      <Section
        index="03"
        mark={t("moderationReportsMark")}
        title={t("moderationReportsTitle")}
        id="reports-title"
        lede={<p className="m-0">{t("moderationReportsLede")}</p>}
      >
        <p className="m-0">
          <a className={buttonVariants({ variant: "outline" })} href="/polls">
            {t("moderationReportsFind")}
          </a>
        </p>
      </Section>
    </div>
  );
}
