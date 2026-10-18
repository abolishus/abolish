// The largest time a Date holds, in milliseconds either side of the epoch.
const MAX_DATE_MS = 8.64e15;

/** Seconds since the epoch, for the reader; a time no Date holds is shown as the seconds themselves. */
export function formatTime(locale: string, seconds: bigint): string {
  const ms = Number(seconds) * 1000;
  if (!(Math.abs(ms) <= MAX_DATE_MS)) return seconds.toString();
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(ms),
  );
}
