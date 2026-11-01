// Its own module, so the lists and cards that show a time don't bring the
// poll page's share sheet and reactions into their pages' script (P2-28
// part 2b).

import { useI18n, useTranslate } from "@abolishus/ui";
import { createContext, useContext, useSyncExternalStore } from "react";

import { catalogs } from "../messages.ts";
import type { Instant } from "../poll.ts";
import {
  formatUtcWhole,
  formatZonedDaySince,
  formatZonedNear,
  formatZonedWhole,
} from "./format.ts";

/**
 * The visitor's time zone, where a story fixes one so its words don't depend
 * on the machine drawing it. Unset, `When` asks the browser.
 */
export const ViewerTimeZone = createContext<string | undefined>(undefined);

/**
 * The visitor's clock, where a story fixes one so "today" and "tomorrow"
 * don't depend on when it is drawn. Unset, `When` reads the browser's.
 */
export const ViewerNow = createContext<(() => Date) | undefined>(undefined);

const browserNow = () => new Date();

const noSubscription = () => () => {};
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const serverZone = () => undefined;

/**
 * The visitor's time zone once the page runs in their browser, and nothing on
 * the server or while the page hydrates, so the served words (in UTC) and the
 * first client render agree and React then redraws in the visitor's zone.
 */
function useViewerZone(): string | undefined {
  const fixed = useContext(ViewerTimeZone);
  const zone = useSyncExternalStore(noSubscription, browserZone, serverZone);
  return fixed ?? zone;
}

/**
 * An instant from the definition, or its raw seconds past what `Date` holds.
 * Its time and "UTC" wrap whole: a card's closing time at 360px left "UTC"
 * alone on a line (P2-29, the stream's iteration 3). `short` abbreviates the
 * month, for a card's line of facts, where the long date wrapped its clock
 * to a second line on a phone (the stream's iteration 6).
 *
 * `local` draws it on the visitor's own clock once the browser runs the page:
 * an asker sets a closing time on theirs, and in UTC an evening's close in
 * the Americas reads as the next day's (the stream's iteration 22). The
 * served page, and a visitor without scripts, keep UTC, which is never wrong,
 * only unfamiliar. The evidence face keeps UTC always
 * (`docs/design/language.md`). On the visitor's clock a close today or
 * tomorrow says so in place of its date (the stream's iteration 23): the
 * day is read only once the page runs, never on the server, which knows
 * neither the visitor's zone nor when a cached page is read.
 */
export function When({
  instant,
  short = false,
  local = false,
}: {
  instant: Instant;
  short?: boolean;
  local?: boolean;
}) {
  const t = useTranslate(catalogs);
  const { locale } = useI18n();
  const zone = useViewerZone();
  const now = useContext(ViewerNow) ?? browserNow;
  if (instant.iso === undefined) return <span className="tabular-nums">{instant.seconds}</span>;
  const date = new Date(instant.iso);
  const style = short ? "medium" : "long";
  const zoned = ({ day, ...words }: { time: string; zone: string; day?: string }) =>
    day === undefined ? t("zonedTime", words) : t("zonedDayTime", { day, ...words });
  return (
    <time dateTime={instant.iso} suppressHydrationWarning>
      {local && zone !== undefined
        ? zoned(formatZonedNear(locale, zone, date, now(), style))
        : t("utcTime", { time: formatUtcWhole(locale, date, style) })}
    </time>
  );
}

/**
 * `When`'s words with `local`, for a sentence that says them after "on"
 * ("closes on {when}"), so always with the date: "closes on tomorrow" isn't
 * a sentence. The poll page's sealed results said the close in UTC under
 * facts that said it on the visitor's clock (P2-29, the poll page's
 * iteration 3). Undefined when the instant is past what `Date` holds.
 */
export function useWhenWords(instant: Instant): string | undefined {
  const t = useTranslate(catalogs);
  const { locale } = useI18n();
  const zone = useViewerZone();
  if (instant.iso === undefined) return undefined;
  const date = new Date(instant.iso);
  return zone === undefined
    ? t("utcTime", { time: formatUtcWhole(locale, date) })
    : t("zonedTime", formatZonedWhole(locale, zone, date));
}

/**
 * The day `instant` fell on, on the visitor's own calendar, once the page
 * runs in their browser ("today", "yesterday", "Dec 28"), and nothing on
 * the server or while the page hydrates: the server knows neither the
 * visitor's zone nor when a cached page is read, and a day in UTC can be
 * the wrong one (P2-29, the stream's iteration 24).
 */
export function useViewerDaySince(
  instant: Instant,
): { day: string; relative: boolean } | undefined {
  const { locale } = useI18n();
  const zone = useViewerZone();
  const now = useContext(ViewerNow) ?? browserNow;
  if (zone === undefined || instant.iso === undefined) return undefined;
  return formatZonedDaySince(locale, zone, new Date(instant.iso), now());
}
