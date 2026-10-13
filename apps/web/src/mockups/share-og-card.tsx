import { cn } from "@abolishus/ui";
import { Lock } from "lucide-react";

import { num } from "./everyday-data.ts";
import {
  answersLine,
  leadOf,
  pct1,
  SHARE_CIVIC,
  type SharePoll,
  shortHref,
  shortLink,
  WEB_HOST,
} from "./share-data.ts";
import { ScaleToFit, SealMark } from "./share-parts.tsx";

export type OgFormat = "landscape" | "square";

export const OG_SIZE: Record<OgFormat, { width: number; height: number }> = {
  landscape: { width: 1200, height: 630 },
  square: { width: 1080, height: 1080 },
};

/** Type for each format, sized so the card still reads at 300px wide in a chat. */
const TYPE = {
  landscape: {
    pad: "p-16",
    byline: "text-[30px]",
    question: "text-[60px] leading-[1.08] line-clamp-3",
    lead: "text-[36px]",
    small: "text-[26px]",
    bar: "h-5",
    foot: "text-[28px]",
    seal: 64,
  },
  square: {
    pad: "p-20",
    byline: "text-[36px]",
    question: "text-[80px] leading-[1.06] line-clamp-5",
    lead: "text-[46px]",
    small: "text-[32px]",
    bar: "h-7",
    foot: "text-[34px]",
    seal: 88,
  },
} as const;

/**
 * The social card a link unfurls into: rendered by apps/web as a PNG, always
 * in the light palette. Everyday polls show the question, who asked, the
 * count so far and the live lead as one sentence and one bar; a sealed poll
 * shows only when its results appear.
 */
export function OgCard({ poll, format = "landscape" }: { poll: SharePoll; format?: OgFormat }) {
  const t = TYPE[format];
  const lead = leadOf(poll);
  const many = poll.questions.length > 1;
  return (
    <div
      data-theme="light"
      data-testid="og-card"
      className={cn("flex size-full flex-col bg-background font-sans text-foreground", t.pad)}
    >
      <p className={cn("m-0 flex flex-wrap gap-x-4 text-muted-foreground", t.byline)}>
        <span>Asked by {poll.askedBy}</span>
        <span aria-hidden="true">·</span>
        <span>{poll.place}</span>
        {many ? (
          <span className="ms-auto border-2 border-border px-5 text-foreground">
            {poll.questions.length} questions
          </span>
        ) : null}
      </p>
      <p
        className={cn(
          "m-0 mt-6 font-heading font-semibold tracking-tight text-balance",
          t.question,
        )}
      >
        {poll.title}
      </p>
      <div className="flex-1" />
      {lead === undefined ? (
        <div className="grid gap-2">
          <p className={cn("m-0 flex items-center gap-4 font-semibold", t.lead)}>
            <Lock aria-hidden="true" className="size-[1em]" strokeWidth={2.5} />
            Results when it closes on {poll.closesDay}
          </p>
          <p className={cn("m-0 text-muted-foreground tabular-nums", t.small)}>
            {answersLine(poll)}. What they say stays sealed until then.
          </p>
        </div>
      ) : (
        <div className="grid gap-3">
          {many ? (
            <p className={cn("m-0 text-muted-foreground", t.small)}>
              Question 1 of {poll.questions.length}
            </p>
          ) : null}
          <p className={cn("m-0 font-semibold text-pretty", t.lead)}>{lead.sentence}</p>
          <span aria-hidden="true" className={cn("block overflow-hidden bg-muted", t.bar)}>
            <span className="block h-full bg-primary" style={{ width: `${lead.share * 100}%` }} />
          </span>
          <p className={cn("m-0 text-muted-foreground tabular-nums", t.small)}>
            {poll.state === "closed"
              ? `Final count · ${answersLine(poll)}`
              : `${answersLine(poll)} · updated ${poll.updated?.split(",")[0] ?? ""}`}
          </p>
        </div>
      )}
      <div className="mt-8 flex items-center gap-5 border-t-2 border-border pt-6">
        <SealMark id={poll.id} size={t.seal} />
        <p className={cn("m-0 min-w-0 flex-1 font-semibold", t.foot)}>{shortLink(poll.id)}</p>
        <p className={cn("m-0 shrink-0 text-muted-foreground", t.foot)}>
          {poll.state === "closed" ? "Closed" : "Closes"} {poll.closesDay}
        </p>
      </div>
    </div>
  );
}

/**
 * The civic record's card, in the archival register: ruled, labelled in the
 * evidence face, one row per tier and never a blended headline.
 */
export function CivicOgCard({ format = "landscape" }: { format?: OgFormat }) {
  const square = format === "square";
  const civic = SHARE_CIVIC;
  const label = cn("m-0 font-mono tracking-widest uppercase", square ? "text-[26px]" : "text-xl");
  return (
    <div
      data-theme="light"
      data-testid="og-card"
      className={cn(
        "flex size-full flex-col bg-background font-sans text-foreground",
        square ? "p-20" : "px-16 py-12",
      )}
    >
      <div className="flex items-start justify-between gap-6">
        <div className="grid gap-3">
          <p className={label}>Civic record · {civic.kind}</p>
          <p
            className={cn(
              "m-0 font-heading leading-none font-semibold tracking-tight",
              square ? "text-[72px]" : "text-[60px]",
            )}
          >
            {civic.title}
          </p>
        </div>
        <SealMark id={civic.id} size={square ? 96 : 76} className="rounded-none" />
      </div>
      <p className={cn("m-0 mt-4 text-muted-foreground", square ? "text-[34px]" : "text-[26px]")}>
        {civic.scope}. Counted {civic.counted}. Each tier is counted on its own.
      </p>
      <ol
        className={cn(
          "m-0 mt-5 grid list-none border-t-2 border-foreground p-0",
          square && "mt-10",
        )}
      >
        {civic.tiers.map((tier) => (
          <li
            key={tier.key}
            className={cn(
              "grid grid-cols-[1fr_auto] items-baseline gap-x-6 border-b border-border",
              square ? "gap-y-4 py-7" : "gap-y-2 py-3",
            )}
          >
            <span className={square ? "text-[36px]" : "text-[28px]"}>
              {tier.name}
              <span className="ms-3 font-mono text-muted-foreground tabular-nums">
                {num(tier.ballots)}
              </span>
            </span>
            <span
              className={cn(
                "font-heading font-semibold tabular-nums",
                square ? "text-[44px]" : "text-[34px]",
              )}
            >
              {pct1(tier.yes)} yes
            </span>
            <span
              aria-hidden="true"
              className={cn("col-span-2 block bg-muted", square ? "h-4" : "h-2.5")}
            >
              <span
                className="block h-full bg-foreground"
                style={{ width: `${tier.yes * 100}%` }}
              />
            </span>
          </li>
        ))}
      </ol>
      <div className="flex-1" />
      <div className={cn("flex items-baseline justify-between gap-6", square ? "pt-8" : "pt-4")}>
        <p className={cn("m-0 font-mono", square ? "text-[32px]" : "text-[26px]")}>
          {shortLink(civic.id)}
        </p>
        <p className={label}>Anyone can recount it</p>
      </div>
    </div>
  );
}

/** og:title and og:description for a poll: the text a chat shows under the image. */
export function ogMeta(poll: SharePoll): { title: string; description: string } {
  const lead = leadOf(poll);
  const who = `Asked by ${poll.askedBy} in ${poll.place}.`;
  const count =
    poll.state === "sealed"
      ? `${num(poll.answers)} answers so far; results are sealed until it closes on ${poll.closesDay}.`
      : poll.state === "closed"
        ? `Closed ${poll.closesDay}. ${lead?.sentence ?? ""}`
        : `${num(poll.answers)} answers so far. ${lead?.sentence ?? ""}`;
  return {
    title: poll.title,
    description: `${who} ${count} Anyone can check the count.`,
  };
}

/** A card at its real size, scaled to the width it is given. */
export function OgPreview({
  poll,
  format = "landscape",
  civic = false,
  caption,
  className,
}: {
  poll?: SharePoll;
  format?: OgFormat;
  civic?: boolean;
  caption: string;
  className?: string;
}) {
  const size = OG_SIZE[format];
  return (
    <figure className={cn("m-0 grid gap-3", className)}>
      <div className="overflow-hidden border border-border">
        <ScaleToFit width={size.width} height={size.height}>
          {civic || poll === undefined ? (
            <CivicOgCard format={format} />
          ) : (
            <OgCard poll={poll} format={format} />
          )}
        </ScaleToFit>
      </div>
      <figcaption className="text-sm text-muted-foreground">{caption}</figcaption>
    </figure>
  );
}

/**
 * How the card arrives in a chat: the sender's words and link, then the
 * unfurl (image, site, title, description) at the width the chat gives it.
 */
export function ChatUnfurl({
  poll,
  message,
  width,
}: {
  poll: SharePoll;
  message: string;
  /** The unfurl's width in a chat: about 600px on a desktop, 300px in a narrow list. */
  width: 300 | 600;
}) {
  const meta = ogMeta(poll);
  return (
    <div
      className={cn(
        "grid w-full gap-2 bg-muted p-3",
        width === 600 ? "max-w-[600px]" : "max-w-[300px]",
      )}
    >
      <p className="m-0 px-1 text-base">{message}</p>
      <a
        href={shortHref(poll.id)}
        className="px-1 text-base break-all underline underline-offset-4"
      >
        {shortHref(poll.id)}
      </a>
      <div className="overflow-hidden border border-border bg-background">
        <ScaleToFit width={1200} height={630}>
          <OgCard poll={poll} />
        </ScaleToFit>
        <div className="grid gap-1 border-t border-border p-3">
          <p className="m-0 text-sm text-muted-foreground">{WEB_HOST}</p>
          <p className="m-0 text-base font-semibold text-pretty">{meta.title}</p>
          <p
            className="m-0 line-clamp-3 text-sm text-muted-foreground"
            data-testid="og-description"
          >
            {meta.description}
          </p>
        </div>
      </div>
    </div>
  );
}
