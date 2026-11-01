/**
 * A date and time for `locale`, in UTC, so the server and the browser agree
 * whatever their time zones. Their ICU versions can still word it slightly
 * differently, so callers render it with `suppressHydrationWarning`.
 */
export function formatUtc(
  locale: string,
  date: Date,
  dateStyle: "long" | "medium" = "long",
): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle,
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}

/**
 * `formatUtc` with its last space a no-break one. With a no-break space
 * before "UTC" in the words, a narrow phone wraps "2:20 PM UTC" whole: never
 * "2:20" over "PM UTC", nor "UTC" alone.
 */
export function formatUtcWhole(
  locale: string,
  date: Date,
  dateStyle: "long" | "medium" = "long",
): string {
  return formatUtc(locale, date, dateStyle).replace(/\s(?=\S+$)/, "\u00a0");
}

/**
 * `formatUtcWhole` on `timeZone`'s clock, with that zone's short name as
 * `locale` says it ("EST", "GMT+1"), for what only the browser shows: the
 * server doesn't know a visitor's zone (P2-29, the stream's iteration 22).
 */
export function formatZonedWhole(
  locale: string,
  timeZone: string,
  date: Date,
  dateStyle: "long" | "medium" = "long",
): { time: string; zone: string } {
  const time = new Intl.DateTimeFormat(locale, { dateStyle, timeStyle: "short", timeZone })
    .format(date)
    .replace(/\s(?=\S+$)/, "\u00a0");
  const zone =
    new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "short" })
      .formatToParts(date)
      .find((p) => p.type === "timeZoneName")?.value ?? timeZone.replaceAll("_", " ");
  return { time, zone };
}

/** `date`'s calendar day on `timeZone`'s clock, as days since 1970-01-01. */
function zonedDay(timeZone: string, date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day")) / 86_400_000;
}

/**
 * `formatZonedWhole`, with the day said as "today" or "tomorrow" ("hoy",
 * "mañana") where `date` falls on one of them on `timeZone`'s clock at
 * `now`: a card read "Closes Jan 7, 2026, 7:00 PM EST" on the morning of
 * January 7, and only a visitor who knew the date learned it closed that
 * evening (P2-29, the stream's iteration 23). Any other day keeps its date.
 */
export function formatZonedNear(
  locale: string,
  timeZone: string,
  date: Date,
  now: Date,
  dateStyle: "long" | "medium" = "long",
): { time: string; zone: string; day?: string } {
  const { time, zone } = formatZonedWhole(locale, timeZone, date, dateStyle);
  const days = zonedDay(timeZone, date) - zonedDay(timeZone, now);
  if (days !== 0 && days !== 1) return { time, zone };
  const day = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(days, "day");
  const clock = new Intl.DateTimeFormat(locale, { timeStyle: "short", timeZone })
    .format(date)
    .replace(/\s(?=\S+$)/, "\u00a0");
  return { time: clock, zone, day };
}

/** A UTC day, `YYYY-MM-DD`, for `locale`. */
export function formatUtcDay(locale: string, day: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(
    new Date(`${day}T00:00:00Z`),
  );
}
