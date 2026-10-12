import { useI18n } from "../i18n/context.tsx";
import { Count } from "./count.tsx";
import { Fingerprint } from "./fingerprint.tsx";
import { Hash } from "./hash.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.tsx";

export interface ReceiptStubProps {
  /** The stub's heading, translated by the caller ("Your receipt"). */
  title: string;
  /** The receipt hash: 64 lowercase hex digits, as the board holds it. */
  hash: string;
  /** Translated labels for each field. */
  labels: {
    hash: string;
    /** Include the hash's first digits; see `Fingerprint`. */
    fingerprint: string;
    entry: string;
    recordedAt: string;
  };
  /** The board entry's index. */
  entry: number | bigint;
  /** When the board recorded the entry. */
  recordedAt: Date;
  /**
   * The time zone the time is shown in. UTC by default, the board's own, so
   * the stub reads the same as the board for everyone comparing them.
   */
  timeZone?: string;
}

/**
 * The receipt (brief, signature elements): a ticket stub holding the receipt
 * hash, its fingerprint, the board entry number and the time, split by a
 * perforated divider. Everything on it is what a voter compares with the
 * board, so it is evidence, shown exactly (T-24, T-41, T-53). It shows
 * nothing about the vote: a receipt proves inclusion, not choice (T-47).
 */
export function ReceiptStub({
  title,
  hash,
  labels,
  entry,
  recordedAt,
  timeZone = "UTC",
}: ReceiptStubProps) {
  const { locale } = useI18n();
  const time = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "long",
    timeZone,
  }).format(recordedAt);
  return (
    <Card role="group" aria-label={title} className="max-w-md gap-0 py-0 text-sm">
      <CardHeader className="pt-(--card-spacing)">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-start gap-4 py-(--card-spacing)">
        <Fingerprint value={hash} label={labels.fingerprint} />
        <div className="min-w-0 flex-1 basis-48">
          <Hash value={hash} label={labels.hash} />
        </div>
      </CardContent>
      {/* The perforation: notches cut into both edges and a dashed rule. */}
      <div aria-hidden="true" className="relative h-6">
        <span className="absolute top-0 -left-3 size-6 rounded-full bg-background ring-1 ring-foreground/10" />
        <span className="absolute top-1/2 right-4 left-4 border-t-2 border-dashed border-muted-foreground" />
        <span className="absolute top-0 -right-3 size-6 rounded-full bg-background ring-1 ring-foreground/10" />
      </div>
      <CardContent className="pb-(--card-spacing)">
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">{labels.entry}</dt>
          <dd className="m-0 font-mono">
            <Count value={entry} />
          </dd>
          <dt className="text-muted-foreground">{labels.recordedAt}</dt>
          <dd className="m-0 font-mono tabular-nums">
            <time dateTime={recordedAt.toISOString()}>{time}</time>
          </dd>
        </dl>
      </CardContent>
    </Card>
  );
}
