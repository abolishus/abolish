import { cn } from "cn";
import { useId } from "react";

import { useI18n } from "../i18n/context.tsx";
import { Count } from "./count.tsx";

export interface TallyRow {
  key: string;
  /** The option's text, as the definition commits to it. */
  label: string;
  count: number;
}

export interface TallyBarsProps {
  /**
   * The caption, with the result's scope in it ("Among 40,112
   * document-verified voters"), translated by the caller. A tally never
   * appears without its tier.
   */
  caption: string;
  rows: readonly TallyRow[];
  /** The count the shares are out of: ballots, or voters for approval. */
  total: number;
  /** The key of the row to emphasise, usually the leader. */
  highlight?: string;
  /**
   * 0 to 1, how much of each bar to draw, for a tally tied to scrolling. When
   * left out, bars draw in as they scroll into view.
   */
  progress?: number;
  className?: string;
}

/**
 * Result bars on the board's ruled grid: each option's share and exact count
 * in tabular figures. The bar is decoration for the numbers beside it.
 */
export function TallyBars({
  caption,
  rows,
  total,
  highlight,
  progress,
  className,
}: TallyBarsProps) {
  const { locale } = useI18n();
  const captionId = useId();
  const percent = new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const drawn = progress === undefined ? 1 : Math.min(1, Math.max(0, progress));
  return (
    <figure
      data-slot="tally-bars"
      aria-labelledby={captionId}
      className={cn("m-0 grid gap-3", className)}
    >
      <figcaption
        id={captionId}
        className="font-mono text-xs tracking-wide text-muted-foreground uppercase"
      >
        {caption}
      </figcaption>
      <ol className="m-0 grid list-none border-t border-foreground p-0">
        {rows.map((row) => {
          const share = total > 0 ? row.count / total : 0;
          const emphasised = row.key === highlight;
          return (
            <li
              key={row.key}
              className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-2 border-b border-border py-3 sm:grid-cols-[minmax(8rem,14rem)_1fr_4.5rem_6rem]"
            >
              <span className={cn("text-sm", emphasised && "font-semibold")}>{row.label}</span>
              <span
                aria-hidden="true"
                className="col-span-2 row-start-2 h-3 self-center bg-muted sm:col-span-1 sm:row-start-auto"
              >
                <span
                  className={cn(
                    "block h-full transition-[width] duration-500 ease-out motion-reduce:transition-none",
                    emphasised ? "bg-primary" : "bg-foreground/70",
                    progress === undefined && "draw-x",
                  )}
                  style={{ width: `${share * drawn * 100}%` }}
                />
              </span>
              <span className="text-end font-mono text-sm tabular-nums">
                {percent.format(share)}
              </span>
              <span className="hidden text-end text-sm text-muted-foreground sm:block">
                <Count value={row.count} />
              </span>
            </li>
          );
        })}
      </ol>
    </figure>
  );
}
