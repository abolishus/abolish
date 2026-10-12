import type { Instant } from "../poll.ts";

/**
 * A date and time for `locale`, always in UTC: the server and the browser
 * then render the same text, whatever their time zones.
 */
export function formatUtc(locale: string, date: Date): string {
  const formatted = new Intl.DateTimeFormat(locale, {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
  return `${formatted} UTC`;
}

/** A definition's instant, or its raw seconds if it is past what `Date` holds. */
export function formatInstant(locale: string, instant: Instant): string {
  return instant.iso === undefined ? instant.seconds : formatUtc(locale, new Date(instant.iso));
}
