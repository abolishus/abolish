/**
 * A date and time for `locale`, in UTC, so the server and the browser agree
 * whatever their time zones. Their ICU versions can still word it slightly
 * differently, so callers render it with `suppressHydrationWarning`.
 */
export function formatUtc(locale: string, date: Date): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}

/** A UTC day, `YYYY-MM-DD`, for `locale`. */
export function formatUtcDay(locale: string, day: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(
    new Date(`${day}T00:00:00Z`),
  );
}
