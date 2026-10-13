import { cn, Count, Fingerprint, groupHex, SectionMark } from "@abolishus/ui";
import type { LucideIcon } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useId, useState } from "react";

import { Frame } from "./shell.tsx";

const PERCENT = new Intl.NumberFormat("en-US", {
  style: "percent",
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const NUMBER = new Intl.NumberFormat("en-US");
const COMPACT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 2,
});

export const pct = (share: number) => PERCENT.format(share);
export const num = (value: number) => NUMBER.format(value);

/** The element's content width in CSS pixels, so a chart draws at real size. */
export function useWidth(ref: RefObject<HTMLElement | null>, fallback: number): number {
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** A small evidence label, in the evidence face. */
export function Evidence({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn("font-mono text-xs tracking-wide text-muted-foreground uppercase", className)}
    >
      {children}
    </span>
  );
}

/**
 * A hash beside its fingerprint, at evidence size. Like `Hash`, the groups are
 * spaced by margin so a copy yields the exact value.
 */
export function EvidenceHash({
  label,
  value,
  subject,
  size = 56,
  className,
}: {
  label: string;
  value: string;
  /** What the fingerprint is of, for its accessible name ("election"). */
  subject: string;
  size?: number;
  className?: string;
}) {
  const labelId = useId();
  return (
    <figure
      aria-labelledby={labelId}
      className={cn("m-0 flex min-w-0 items-start gap-4", className)}
    >
      <Fingerprint
        value={value}
        label={`Fingerprint of ${subject} ${value.slice(0, 4)} ${value.slice(4, 8)}`}
        size={size}
      />
      <div className="grid min-w-0 gap-1">
        <figcaption id={labelId}>
          <Evidence>{label}</Evidence>
        </figcaption>
        <code translate="no" className="font-mono text-xs/relaxed break-all">
          {groupHex(value).map((group, i) => (
            <span key={i} className="mr-[0.5ch] last:mr-0">
              {group}
            </span>
          ))}
        </code>
      </div>
    </figure>
  );
}

/** The poll's status, in words with its own icon; colour only on the icon. */
export function StatusMark({
  icon: Icon,
  tone = "neutral",
  children,
}: {
  icon: LucideIcon;
  tone?: "recorded" | "pending" | "neutral";
  children: ReactNode;
}) {
  return (
    <span className="inline-flex min-h-8 items-center gap-2 border border-foreground px-3 font-mono text-xs tracking-widest uppercase">
      <Icon
        aria-hidden="true"
        className={cn(
          "size-4",
          tone === "recorded" && "text-recorded",
          tone === "pending" && "text-pending",
        )}
        strokeWidth={2.5}
      />
      {children}
    </span>
  );
}

/** A row of facts under a heavy rule, like the head of a printed notice. */
export function FactStrip({
  facts,
  className,
}: {
  facts: readonly { term: string; value: ReactNode }[];
  className?: string;
}) {
  return (
    <dl
      className={cn(
        "m-0 grid grid-cols-1 border-t-2 border-foreground sm:grid-cols-2 lg:grid-cols-4",
        className,
      )}
    >
      {facts.map((fact) => (
        <div
          key={fact.term}
          className="grid content-start gap-1 border-b border-border py-4 sm:pe-6 lg:border-b-0"
        >
          <dt>
            <Evidence>{fact.term}</Evidence>
          </dt>
          <dd className="m-0 text-base text-pretty">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Definition facts as a ruled two-column register. */
export function FactList({ facts }: { facts: readonly { term: string; value: ReactNode }[] }) {
  return (
    <dl className="m-0 border-b border-border">
      {facts.map((fact) => (
        <div
          key={fact.term}
          className="grid gap-1 border-t border-border py-3 sm:grid-cols-[14rem_1fr] sm:gap-6"
        >
          <dt className="text-sm text-muted-foreground">{fact.term}</dt>
          <dd className="m-0 text-sm">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The page's statement that what it shows is a server's claim, with where to check it. */
export function ClaimNote({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 max-w-prose border-l-2 border-foreground ps-4 text-sm text-pretty text-muted-foreground">
      {children}
    </p>
  );
}

/**
 * A numbered section of the record: hairline above, `SectionMark`, an h2 and
 * a lede. `split` puts the heading in the left third of the grid; `stacked`
 * puts it above full-width content (scroll scenes, tile maps).
 */
export function PollSection({
  id,
  index,
  mark,
  title,
  lede,
  layout = "split",
  children,
}: {
  id: string;
  index: string;
  mark: string;
  title: string;
  lede?: ReactNode;
  layout?: "split" | "stacked";
  children: ReactNode;
}) {
  const headingId = `${id}-title`;
  return (
    <section id={id} aria-labelledby={headingId} className="border-t border-border">
      <Frame
        className={cn(
          "grid gap-10 py-16 md:py-24",
          layout === "split" && "lg:grid-cols-12 lg:gap-x-12",
        )}
      >
        <header
          className={cn(
            "grid content-start gap-4",
            layout === "split" ? "lg:col-span-4" : "max-w-3xl",
          )}
        >
          <SectionMark index={index}>{mark}</SectionMark>
          <h2
            id={headingId}
            className="m-0 font-heading text-3xl leading-tight font-semibold tracking-tight text-balance sm:text-4xl"
          >
            {title}
          </h2>
          {lede === undefined ? null : (
            <div className="m-0 grid max-w-prose gap-3 text-base text-pretty text-muted-foreground">
              {lede}
            </div>
          )}
        </header>
        <div className={cn("min-w-0", layout === "split" && "lg:col-span-8")}>{children}</div>
      </Frame>
    </section>
  );
}

/** A count with its unit, for prose. */
export function N({ value }: { value: number }) {
  return <Count value={value} />;
}

/**
 * Columns for a short run of real snapshots, each labelled with its value,
 * so the chart is its own text equivalent. Columns settle in as they scroll
 * into view.
 */
export function SnapshotColumns({
  caption,
  points,
  emphasise = "last",
  compact = false,
  className,
}: {
  caption: string;
  points: readonly { label: string; note?: string; value: number }[];
  emphasise?: "last" | "none";
  /** Shows values as "1.1M" for narrow columns; the exact value stays for screen readers. */
  compact?: boolean;
  className?: string;
}) {
  const max = Math.max(...points.map((p) => p.value), 1);
  const captionId = useId();
  return (
    <figure aria-labelledby={captionId} className={cn("m-0 grid gap-2", className)}>
      <figcaption id={captionId} className="sr-only">
        {caption}
      </figcaption>
      <ol
        className="m-0 grid h-36 list-none items-end gap-2 border-b border-foreground p-0"
        style={{ gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))` }}
      >
        {points.map((point, i) => (
          <li key={point.label} className="flex h-full flex-col justify-end gap-1">
            <span className="sr-only">
              {point.label}
              {point.note ? `, ${point.note}` : ""}: {compact ? num(point.value) : null}
            </span>
            <span
              aria-hidden={compact ? "true" : undefined}
              className="text-center font-mono text-xs tabular-nums"
            >
              {compact ? COMPACT.format(point.value) : num(point.value)}
            </span>
            <span
              aria-hidden="true"
              className={cn(
                "reveal block w-full",
                emphasise === "last" && i === points.length - 1
                  ? "bg-recorded"
                  : "bg-foreground/60",
              )}
              style={{ height: `${(point.value / max) * 70}%` }}
            />
          </li>
        ))}
      </ol>
      <div
        aria-hidden="true"
        className="grid gap-2"
        style={{ gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))` }}
      >
        {points.map((point) => (
          <span key={point.label} className="grid text-center font-mono text-xs">
            <span>{point.label}</span>
            {point.note ? <span className="text-muted-foreground">{point.note}</span> : null}
          </span>
        ))}
      </div>
    </figure>
  );
}

/**
 * The question and options exactly as the ballot client will show them, as
 * a still facsimile: ballots never move.
 */
export function BallotPreview({
  question,
  options,
  instruction,
  single = false,
}: {
  question: string;
  options: readonly { key: string; label: string }[];
  instruction: string;
  /** One choice only: round marks, as on a paper ballot. */
  single?: boolean;
}) {
  return (
    <figure
      aria-label="Ballot preview"
      className="m-0 grid max-w-xl gap-0 border border-foreground"
    >
      <figcaption className="flex flex-wrap items-baseline justify-between gap-2 border-b border-foreground px-5 py-3">
        <span className="font-mono text-xs tracking-widest uppercase">Ballot preview</span>
        <span className="font-mono text-xs text-muted-foreground">{options.length} options</span>
      </figcaption>
      <div className="grid gap-5 p-5 sm:p-8">
        <p className="m-0 font-heading text-xl font-semibold text-pretty">{question}</p>
        <p className="m-0 border-y border-border py-3 text-sm">{instruction}</p>
        <ol className="m-0 grid list-none gap-3 p-0">
          {options.map((o, i) => (
            <li
              key={o.key}
              className="grid min-h-14 grid-cols-[auto_1fr_auto] items-center gap-4 border border-border px-4"
            >
              <span
                aria-hidden="true"
                className={cn("size-6 border-2 border-foreground", single && "rounded-full")}
              />
              <span className="text-base">{o.label}</span>
              <span className="font-mono text-xs text-muted-foreground">
                <span className="sr-only">Option </span>
                {i + 1}
              </span>
            </li>
          ))}
        </ol>
        <p className="m-0 text-sm text-muted-foreground">
          The client shows your choices again on a review screen before you cast.
        </p>
      </div>
    </figure>
  );
}
