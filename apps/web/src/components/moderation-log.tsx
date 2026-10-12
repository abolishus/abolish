import { useI18n, useTranslate } from "@abolishus/ui";

import { catalogs } from "../messages.ts";
import type { ModerationLog as Log } from "../server/load.ts";
import { formatUtc } from "./format.ts";

export interface ModerationLogProps {
  log: Log;
  /** Where the next page starts, if this one was full. */
  next: string | undefined;
}

/**
 * The public moderation log (T-68): what was done to which poll and why,
 * never who did it or who reported it.
 */
export function ModerationLog({ log, next }: ModerationLogProps) {
  const t = useTranslate(catalogs);
  const { locale } = useI18n();
  return (
    <section aria-labelledby="moderation-title" className="grid gap-6">
      <h1 id="moderation-title" className="text-3xl font-semibold">
        {t("moderationTitle")}
      </h1>
      <p className="max-w-prose text-muted-foreground">{t("moderationLede")}</p>
      {log.entries.length === 0 ? (
        <p>{t("moderationEmpty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className="py-2 pr-4 font-semibold">
                  {t("moderationSeq")}
                </th>
                <th scope="col" className="py-2 pr-4 font-semibold">
                  {t("moderationPoll")}
                </th>
                <th scope="col" className="py-2 pr-4 font-semibold">
                  {t("moderationAction")}
                </th>
                <th scope="col" className="py-2 pr-4 font-semibold">
                  {t("moderationReason")}
                </th>
                <th scope="col" className="py-2 font-semibold">
                  {t("moderationDecided")}
                </th>
              </tr>
            </thead>
            <tbody>
              {log.entries.map((entry) => (
                <tr key={entry.seq} className="border-b border-border">
                  <td className="py-2 pr-4 tabular-nums">{entry.seq}</td>
                  <td className="py-2 pr-4">
                    <a
                      className="font-mono underline underline-offset-4"
                      translate="no"
                      href={`/polls/${entry.electionId}`}
                    >
                      {entry.electionId.slice(0, 16)}…
                    </a>
                  </td>
                  <td className="py-2 pr-4">{t(`action_${entry.action}`)}</td>
                  <td className="py-2 pr-4">{t(`reason_${entry.reason}`)}</td>
                  <td className="py-2 tabular-nums">
                    <time dateTime={entry.decidedAt}>
                      {formatUtc(locale, new Date(entry.decidedAt))}
                    </time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next !== undefined ? (
        <a className="underline underline-offset-4" href={`/moderation?after=${next}`}>
          {t("moderationMore")}
        </a>
      ) : null}
    </section>
  );
}
