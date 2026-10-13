import { cn } from "@abolishus/ui";
import { useId, useRef } from "react";

import type { Snapshot, TierKey } from "./fixtures.ts";
import { num, pct, useWidth } from "./poll-parts.tsx";

export interface TurnoutSeries {
  tier: TierKey;
  short: string;
  name: string;
  eligible: number;
}

const STYLE: Record<TierKey, { dash?: string; className: string }> = {
  tier2: { className: "text-recorded" },
  tier1: { dash: "6 4", className: "text-foreground" },
  tier0: { dash: "1.5 4", className: "text-foreground" },
};

/**
 * Turnout over the voting window, one step line per tier, as a share of
 * that tier's eligible members: the tiers sit on one scale without ever
 * being added. Only the snapshots up to `through` are drawn, so scrolling
 * reveals real counts at real times and never an interpolated value.
 */
export function TurnoutChart({
  timeline,
  series,
  through,
  focus,
  closedLabel,
}: {
  timeline: readonly Snapshot[];
  series: readonly TurnoutSeries[];
  /** Index of the last snapshot to draw. */
  through: number;
  /** A tier to bring forward, or none. */
  focus: TierKey | null;
  closedLabel: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box, 320);
  const narrow = width < 480;
  const height = Math.round(Math.min(400, Math.max(240, width * 0.62)));
  const m = { top: 20, right: narrow ? 64 : 92, bottom: 36, left: 44 };
  const plotW = Math.max(40, width - m.left - m.right);
  const plotH = height - m.top - m.bottom;
  const last = timeline.at(-1);
  const span = last === undefined || last.hour === 0 ? 1 : last.hour;
  const x = (hour: number) => m.left + (hour / span) * plotW;
  const y = (share: number) => m.top + (1 - share) * plotH;
  const shown = Math.min(Math.max(0, through), timeline.length - 1);
  const asOf = timeline[shown];
  const revealX = x(asOf?.hour ?? 0);

  // Direct labels at each line's revealed end, nudged apart where tiers run close.
  const ends = series
    .map((s) => {
      const share = (asOf?.ballots[s.tier] ?? 0) / s.eligible;
      return { s, share, y: y(share) };
    })
    .toSorted((a, b) => a.y - b.y);
  const GAP = 30;
  for (let i = 1; i < ends.length; i++) {
    const prev = ends[i - 1];
    const cur = ends[i];
    if (prev !== undefined && cur !== undefined && cur.y - prev.y < GAP) cur.y = prev.y + GAP;
  }

  const clipId = `turnout-clip-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div ref={box} className="w-full [contain:inline-size]">
      <svg
        aria-hidden="true"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="block overflow-visible font-mono"
      >
        <defs>
          <clipPath id={clipId}>
            <rect
              x={0}
              y={0}
              height={height}
              style={{ width: `${revealX + 1}px` }}
              className="motion-safe:transition-[width] motion-safe:duration-500 motion-safe:ease-out"
            />
          </clipPath>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={m.left}
              x2={m.left + plotW}
              y1={y(t)}
              y2={y(t)}
              className={cn("stroke-current", t === 0 ? "text-foreground" : "text-border")}
              strokeWidth={t === 0 ? 1.5 : 1}
            />
            <text
              x={m.left - 8}
              y={y(t)}
              dy="0.32em"
              textAnchor="end"
              className="fill-current text-[11px] text-muted-foreground"
            >
              {t * 100}%
            </text>
          </g>
        ))}
        {timeline.map((snap, i) => {
          if (narrow && i % 2 === 1 && i !== timeline.length - 1) return null;
          return (
            <text
              key={snap.hour}
              x={x(snap.hour)}
              y={m.top + plotH + 20}
              textAnchor={i === 0 ? "start" : i === timeline.length - 1 ? "end" : "middle"}
              className={cn(
                "fill-current text-[11px]",
                i <= shown ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {snap.label}
            </text>
          );
        })}
        {last !== undefined && shown === timeline.length - 1 ? (
          <g>
            <line
              x1={x(last.hour)}
              x2={x(last.hour)}
              y1={m.top - 8}
              y2={m.top + plotH}
              strokeDasharray="2 3"
              className="stroke-current text-foreground"
            />
            <text
              x={x(last.hour) - 6}
              y={m.top - 2}
              textAnchor="end"
              className="fill-current text-[11px] text-foreground"
            >
              {closedLabel}
            </text>
          </g>
        ) : null}
        <g clipPath={`url(#${clipId})`}>
          {series.map((s) => {
            const style = STYLE[s.tier];
            const dimmed = focus !== null && focus !== s.tier;
            let d = "";
            timeline.forEach((snap, i) => {
              const px = x(snap.hour);
              const py = y(snap.ballots[s.tier] / s.eligible);
              d += i === 0 ? `M${px},${py}` : `H${px}V${py}`;
            });
            return (
              <path
                key={s.tier}
                d={d}
                fill="none"
                strokeDasharray={style.dash}
                strokeWidth={focus === s.tier ? 3.5 : 2.25}
                strokeLinejoin="round"
                className={cn(
                  "stroke-current motion-safe:transition-opacity motion-safe:duration-300",
                  style.className,
                  dimmed && "opacity-35",
                )}
              />
            );
          })}
        </g>
        {series.map((s) =>
          timeline
            .slice(0, shown + 1)
            .map((snap) => (
              <rect
                key={`${s.tier}-${snap.hour}`}
                x={x(snap.hour) - 3}
                y={y(snap.ballots[s.tier] / s.eligible) - 3}
                width={6}
                height={6}
                className={cn(
                  "fill-current",
                  STYLE[s.tier].className,
                  focus !== null && focus !== s.tier && "opacity-35",
                )}
              />
            )),
        )}
        {ends.map(({ s, share, y: ly }) => {
          const dimmed = focus !== null && focus !== s.tier;
          return (
            <g key={s.tier}>
              <line
                x1={revealX + 6}
                x2={revealX + 12}
                y1={y(share)}
                y2={ly}
                className="stroke-current text-muted-foreground"
              />
              <text
                x={revealX + 14}
                y={ly}
                dy="-0.15em"
                className={cn(
                  "fill-current text-[11px]",
                  dimmed ? "text-muted-foreground" : "text-foreground",
                )}
              >
                {s.short}
              </text>
              <text
                x={revealX + 14}
                y={ly}
                dy="1.05em"
                className={cn(
                  "fill-current text-[11px] font-semibold",
                  dimmed
                    ? "text-muted-foreground"
                    : s.tier === "tier2"
                      ? "text-recorded"
                      : "text-foreground",
                )}
              >
                {pct(share)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** The chart's state in words: what a screen reader hears for the graphic. */
export function describeTurnout(
  snap: Snapshot,
  series: readonly TurnoutSeries[],
  closed: boolean,
): string {
  const parts = series.map(
    (s) =>
      `${s.name}, ${num(snap.ballots[s.tier])} of ${num(s.eligible)} (${pct(snap.ballots[s.tier] / s.eligible)})`,
  );
  return `Turnout by tier as of ${snap.label} UTC${closed ? ", when voting closed" : ""}: ${parts.join("; ")}.`;
}
