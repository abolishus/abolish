// Its own module, so the lists and cards that show a time don't bring the
// poll page's share sheet and reactions into their pages' script (P2-28
// part 2b).

import { useI18n, useTranslate } from "@abolishus/ui";

import { catalogs } from "../messages.ts";
import type { Instant } from "../poll.ts";
import { formatUtcWhole } from "./format.ts";

/**
 * An instant from the definition, or its raw seconds past what `Date` holds.
 * Its time and "UTC" wrap whole: a card's closing time at 360px left "UTC"
 * alone on a line (P2-29, the stream's iteration 3).
 */
export function When({ instant }: { instant: Instant }) {
  const t = useTranslate(catalogs);
  const { locale } = useI18n();
  if (instant.iso === undefined) return <span className="tabular-nums">{instant.seconds}</span>;
  return (
    <time dateTime={instant.iso} suppressHydrationWarning>
      {t("utcTime", { time: formatUtcWhole(locale, new Date(instant.iso)) })}
    </time>
  );
}
