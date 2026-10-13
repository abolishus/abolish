import { cn } from "cn";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import { useI18n } from "../i18n/context.tsx";
import { formatMessage, type Message } from "../i18n/format.ts";
import {
  blockOf,
  cellPosition,
  layoutBoard,
  type BoardLayout,
  type PlacedBlock,
} from "../lib/board-layout.ts";
import type { EntryRange } from "../lib/board-tree.ts";
import { Count } from "./count.tsx";

/**
 * What an entry is, as the map draws it: its payload's record type folded
 * into four marks (docs/spec/board.md, Allowed payloads). `ballot` is
 * `0x0002`; `spoiled` a spoiled-ballot opening, `0x0003`; `trustee` the
 * trustees' records (ceremony transcript, tally opening, share receipt and
 * complaint, destruction statement); `event` a contract event, `0x0008`.
 */
export const BOARD_KINDS = ["ballot", "spoiled", "trustee", "event"] as const;
export type BoardEntryKind = (typeof BOARD_KINDS)[number];

/** The kind code `BoardMap` takes for a payload's record type. */
export function boardKindCode(recordType: number): number {
  switch (recordType) {
    case 0x0002:
      return 0;
    case 0x0003:
      return 1;
    case 0x0008:
      return 3;
    case 0x0005:
    case 0x0006:
    case 0x000c:
    case 0x000e:
    case 0x000f:
      return 2;
    default:
      throw new RangeError(`record type ${recordType} is never on the board`);
  }
}

export interface BoardMapSegment {
  /** The anchoring period `s`. */
  segment: number;
  /** Index of its first entry; segments are contiguous and in order. */
  first: number;
  /** Its entries; a segment on the map is never empty. */
  size: number;
  /** When its period began, formatted by the caller ("14:00"). */
  label: string;
  /** A grouping such as the day ("3 Nov"); a new group starts a new line. */
  group?: string;
  /** Its checkpoint's anchor on Ethereum, or null while it has none. */
  anchor: { at: string; block: number } | null;
}

export interface BoardMapLabels {
  /** The figure's caption, with the board's scope and when it is as of. */
  caption: string;
  /** What the drawing shows, for assistive technology; the facts are in the text around it. */
  description: string;
  kinds: Record<BoardEntryKind, string>;
  /** Legend words for a segment whose checkpoint is anchored ("Anchored to Ethereum"). */
  anchored: string;
  /** Legend words for a segment not anchored yet; shown only when the map has one. */
  unanchored: string;
  /** The label at the reader's entry, with an `{index}` placeholder ("Your entry, {index}"). */
  mine?: Message | undefined;
  /**
   * The reader's place in words, under the map. Placeholders: `{index}`,
   * `{total}`, `{segment}` (its label), `{anchor}` and `{block}`.
   */
  position?: Message | undefined;
  /** The same for a segment not anchored yet: `{index}`, `{total}` and `{segment}`. */
  positionPending?: Message | undefined;
  /** The text equivalent: every segment's counts and anchor, in a disclosure. */
  table?:
    | {
        summary: string;
        caption: string;
        segment: string;
        entries: string;
        anchor: string;
        notAnchored: string;
        /** How a segment's non-ballot entries are listed: `{count}` and `{kind}`. */
        breakdown: Message;
        /** Its anchor in a cell: `{at}` and `{block}`. */
        anchorCell: Message;
      }
    | undefined;
}

export interface BoardMapProps {
  /** One kind code (an index into `BOARD_KINDS`) per entry, in index order. */
  kinds: Uint8Array;
  segments: readonly BoardMapSegment[];
  labels: BoardMapLabels;
  /** The reader's entry, marked in the primary colour with its label and a leader line. */
  mine?: number;
  /** The entries to show; the whole board when left out. */
  range?: EntryRange;
  /** The height to stay within if the board allows it, in CSS pixels. */
  maxHeight?: number;
  /** The largest cell, in CSS pixels. */
  maxCell?: number;
  /** Whether to list the kinds with their counts under the map. */
  legend?: boolean;
  className?: string;
}

interface Palette {
  foreground: string;
  muted: string;
  primary: string;
  background: string;
  border: string;
  mono: string;
}

const LANES = { label: 18, rule: 6, group: 20, mine: 26, between: 10 };

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function readPalette(element: HTMLElement): Palette {
  const style = getComputedStyle(element);
  const token = (name: string) => style.getPropertyValue(name).trim() || "#000";
  return {
    foreground: token("--foreground"),
    muted: token("--muted-foreground"),
    primary: token("--primary"),
    background: token("--background"),
    border: token("--border"),
    mono: style.fontFamily,
  };
}

/** Counts of each kind, per segment. */
function countKinds(kinds: Uint8Array, segments: readonly BoardMapSegment[]) {
  const perSegment = segments.map((s) => {
    const counts = [0, 0, 0, 0];
    for (let i = s.first; i < s.first + s.size; i++) counts[kinds[i] ?? 0]!++;
    return counts;
  });
  return { perSegment };
}

function validate(kinds: Uint8Array, segments: readonly BoardMapSegment[], mine?: number) {
  let next = 0;
  for (const s of segments) {
    if (s.first !== next || s.size < 1)
      throw new RangeError("segments must be contiguous, in order and non-empty");
    next += s.size;
  }
  if (next !== kinds.length) throw new RangeError("every entry needs a kind, and no more");
  if (mine !== undefined && !(mine >= 0 && mine < kinds.length))
    throw new RangeError("the reader's entry must be on the board");
}

/** The legend's swatch for a kind: the mark the map draws once cells are big enough. */
export function KindSwatch({ kind, className }: { kind: BoardEntryKind; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 12 12"
      className={cn("size-3 shrink-0 text-foreground", className)}
    >
      {kind === "ballot" && <rect width={12} height={12} fill="currentColor" opacity={0.82} />}
      {kind === "spoiled" && (
        <rect
          x={1}
          y={1}
          width={10}
          height={10}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
        />
      )}
      {kind === "trustee" && (
        <>
          <rect x={0.5} y={0.5} width={11} height={11} fill="none" stroke="currentColor" />
          <polygon points="0,0 0,12 12,12" fill="currentColor" />
        </>
      )}
      {kind === "event" && (
        <>
          <rect x={0.5} y={0.5} width={11} height={11} fill="none" stroke="currentColor" />
          <rect x={4} y={4} width={4} height={4} fill="currentColor" />
        </>
      )}
    </svg>
  );
}

/** The anchor mark: Ethereum's diamond over the segment's rule. */
export function AnchorMark({
  pending = false,
  className,
}: {
  pending?: boolean;
  className?: string;
}) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 12" className={cn("h-3 w-4 shrink-0", className)}>
      <line
        x1={0}
        x2={16}
        y1={2}
        y2={2}
        stroke="currentColor"
        strokeDasharray={pending ? "2 2" : undefined}
      />
      {pending ? null : (
        <polygon points="12,3 15,7 12,11 9,7" fill="none" stroke="currentColor" strokeWidth={1.2} />
      )}
    </svg>
  );
}

function paint(
  canvas: HTMLCanvasElement,
  layout: BoardLayout,
  dpr: number,
  width: number,
  palette: Palette,
  kinds: Uint8Array,
  segments: readonly BoardMapSegment[],
  mine: number | undefined,
) {
  const context = canvas.getContext("2d");
  if (context === null) return;
  canvas.width = width;
  canvas.height = Math.max(1, layout.height);
  const ctx = context;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const { pitch, cell } = layout;
  const shapes = cell >= 5;
  const line = Math.max(1, Math.round(dpr));

  // Entries, one pass per kind so each pass sets its style once.
  const alpha = shapes ? [0.82, 0.9, 0.82, 0.9] : [0.82, 0.28, 0.5, 0.5];
  ctx.fillStyle = palette.foreground;
  ctx.strokeStyle = palette.foreground;
  ctx.lineWidth = line;
  for (let kind = 0; kind < 4; kind++) {
    ctx.globalAlpha = alpha[kind]!;
    for (const block of layout.blocks) {
      for (let i = block.first; i < block.first + block.size; i++) {
        if (kinds[i] !== kind || i === mine) continue;
        const { x, y } = cellPosition(layout, block, i);
        if (!shapes || kind === 0) ctx.fillRect(x, y, cell, cell);
        else if (kind === 1) ctx.strokeRect(x + line / 2, y + line / 2, cell - line, cell - line);
        else if (kind === 2) {
          ctx.strokeRect(x + line / 2, y + line / 2, cell - line, cell - line);
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x, y + cell);
          ctx.lineTo(x + cell, y + cell);
          ctx.closePath();
          ctx.fill();
        } else {
          ctx.strokeRect(x + line / 2, y + line / 2, cell - line, cell - line);
          const dot = Math.max(1, Math.round(cell / 3));
          ctx.fillRect(x + (cell - dot) / 2, y + (cell - dot) / 2, dot, dot);
        }
      }
    }
  }
  ctx.globalAlpha = 1;

  // Each block's rule: solid once its checkpoint is anchored, dashed before;
  // Ethereum's diamond and the period's label where they fit.
  ctx.font = `${Math.round(11 * dpr)}px ${palette.mono}`;
  ctx.textBaseline = "alphabetic";
  for (const block of layout.blocks) {
    const segment = segments[block.segment]!;
    const ruleY = block.y + layout.rows * pitch + Math.round(3 * dpr) + 0.5;
    ctx.strokeStyle = palette.muted;
    ctx.lineWidth = line;
    ctx.setLineDash(segment.anchor === null ? [2 * dpr, 2 * dpr] : []);
    ctx.beginPath();
    ctx.moveTo(block.x, ruleY);
    ctx.lineTo(block.x + Math.max(block.width, line), ruleY);
    ctx.stroke();
    ctx.setLineDash([]);
    const diamond = 4 * dpr;
    const labelled = layout.lines[block.line]!.labelled;
    const room = labelled && block.width >= diamond * 3;
    if (segment.anchor !== null && room) {
      const cx = block.x + block.width - diamond;
      ctx.beginPath();
      ctx.moveTo(cx, ruleY + 1 * dpr);
      ctx.lineTo(cx + diamond * 0.75, ruleY + 1 * dpr + diamond);
      ctx.lineTo(cx, ruleY + 1 * dpr + diamond * 2);
      ctx.lineTo(cx - diamond * 0.75, ruleY + 1 * dpr + diamond);
      ctx.closePath();
      ctx.stroke();
    }
    const text = block.first === segment.first ? segment.label : "";
    if (labelled && text !== "" && ctx.measureText(text).width + diamond * 4 <= block.width) {
      ctx.fillStyle = palette.muted;
      ctx.fillText(text, block.x, ruleY + 12 * dpr);
    }
  }

  // Group names above the line that starts each group.
  ctx.fillStyle = palette.muted;
  for (const l of layout.lines) {
    if (l.group === undefined) continue;
    ctx.fillText(l.group.toUpperCase(), 0, l.blocksTop - 6 * dpr);
  }

  if (mine === undefined) return;
  const block = blockOf(layout, mine);
  if (block === undefined) return;
  const several = layout.blocks.length > 1;
  if (several) {
    // Frame the reader's segment, so the eye finds the hour before the entry.
    const pad = Math.round(2 * dpr) + 0.5;
    ctx.strokeStyle = palette.foreground;
    ctx.lineWidth = line;
    ctx.strokeRect(
      block.x - pad,
      block.y - pad,
      block.width + pad * 2,
      layout.rows * pitch + pad * 2,
    );
  }
  const { x, y } = cellPosition(layout, block, mine);
  const mark = Math.max(cell, Math.round(6 * dpr));
  const mx = Math.round(x + cell / 2 - mark / 2);
  const my = Math.round(y + cell / 2 - mark / 2);
  // The leader line, from the label's lane down to the mark.
  const lane = layout.lines[block.line]!;
  ctx.strokeStyle = palette.foreground;
  ctx.beginPath();
  ctx.moveTo(Math.round(x + cell / 2) + 0.5, lane.top + (LANES.mine - 4) * dpr);
  ctx.lineTo(Math.round(x + cell / 2) + 0.5, my);
  ctx.stroke();
  ctx.fillStyle = palette.background;
  ctx.fillRect(mx - line, my - line, mark + line * 2, mark + line * 2);
  ctx.fillStyle = palette.primary;
  ctx.fillRect(mx, my, mark, mark);
  ctx.strokeStyle = palette.foreground;
  ctx.strokeRect(mx + line / 2, my + line / 2, mark - line, mark - line);
}

/**
 * The whole public board at a glance: every entry one square cell, in order,
 * each anchoring segment a block of them with its period and its Ethereum
 * anchor, the reader's own entry marked. Drawn on a canvas sized to the
 * device's pixels, so a board of 160,000 entries draws in one pass; the
 * caption, the legend with its counts, the sentence placing the reader's
 * entry and the table of every segment carry the same facts in text.
 *
 * Every mark is an entry: cells are never sampled or merged. Below about four
 * device pixels a cell can't show a shape, so the kinds fall back to tones,
 * which the legend's counts back up.
 */
export function BoardMap({
  kinds,
  segments,
  labels,
  mine,
  range,
  maxHeight = 520,
  maxCell = 14,
  legend = true,
  className,
}: BoardMapProps) {
  validate(kinds, segments, mine);
  const { locale } = useI18n();
  const captionId = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [frame, setFrame] = useState<{ width: number; dpr: number } | null>(null);
  const [repaint, setRepaint] = useState(0);
  const from = range?.from ?? 0;
  const to = range?.to ?? kinds.length;
  const shown = useMemo(() => ({ from, to }), [from, to]);

  useIsomorphicLayoutEffect(() => {
    const element = wrap.current;
    if (element === null) return;
    const measure = () => {
      const width = element.clientWidth;
      const dpr = window.devicePixelRatio || 1;
      setFrame((f) => (f?.width === width && f.dpr === dpr ? f : { width, dpr }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Colours and the evidence face come from the theme, so a change of theme
  // or a late font repaints.
  useEffect(() => {
    const bump = () => setRepaint((n) => n + 1);
    const observer = new MutationObserver(bump);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class"],
    });
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", bump);
    void document.fonts?.ready.then(bump);
    return () => {
      observer.disconnect();
      scheme.removeEventListener("change", bump);
    };
  }, []);

  const layout = useMemo(() => {
    if (frame === null || frame.width < 1) return null;
    const d = frame.dpr;
    const lane = (v: number) => Math.round(v * d);
    return layoutBoard({
      segments: segments.map((s) => ({ first: s.first, size: s.size, group: s.group })),
      range: shown,
      width: Math.floor(frame.width * d),
      maxHeight: maxHeight * d,
      maxPitch: maxCell * d,
      minRows: 3,
      labelWidth: lane(48),
      gap: lane(6),
      lanes: {
        label: lane(LANES.label),
        rule: lane(LANES.rule),
        group: lane(LANES.group),
        mine: lane(LANES.mine),
        between: lane(LANES.between),
      },
      mine,
    });
  }, [frame, segments, shown, maxHeight, maxCell, mine]);

  useEffect(() => {
    const element = canvas.current;
    if (element === null || layout === null || frame === null || wrap.current === null) return;
    paint(
      element,
      layout,
      frame.dpr,
      Math.floor(frame.width * frame.dpr),
      readPalette(wrap.current),
      kinds,
      segments,
      mine,
    );
  }, [layout, frame, kinds, segments, mine, repaint]);

  const counts = useMemo(() => countKinds(kinds, segments), [kinds, segments]);
  const shownCounts = useMemo(() => {
    const total = [0, 0, 0, 0];
    for (let i = shown.from; i < shown.to; i++) total[kinds[i] ?? 0]!++;
    return total;
  }, [kinds, shown]);
  const mineSegment =
    mine === undefined
      ? undefined
      : segments.find((s) => mine >= s.first && mine < s.first + s.size);
  const format = (message: Message, params: Record<string, string | number>) =>
    formatMessage(locale, message, params);

  let position: string | undefined;
  if (mine !== undefined && mineSegment !== undefined) {
    const base = { index: mine, total: kinds.length, segment: mineSegment.label };
    if (mineSegment.anchor !== null && labels.position !== undefined)
      position = format(labels.position, {
        ...base,
        anchor: mineSegment.anchor.at,
        block: mineSegment.anchor.block,
      });
    else if (mineSegment.anchor === null && labels.positionPending !== undefined)
      position = format(labels.positionPending, base);
  }

  // The label rides above the reader's entry, sliding so it never leaves the map.
  let label: { style: CSSProperties; text: string } | undefined;
  if (layout !== null && frame !== null && mine !== undefined && labels.mine !== undefined) {
    const block: PlacedBlock | undefined = blockOf(layout, mine);
    if (block !== undefined) {
      const { x } = cellPosition(layout, block, mine);
      const centre = (x + layout.cell / 2) / frame.dpr;
      const share = Math.min(1, Math.max(0, centre / frame.width));
      label = {
        text: format(labels.mine, { index: mine }),
        style: {
          left: centre,
          top: layout.lines[block.line]!.top / frame.dpr,
          transform: `translateX(-${share * 100}%)`,
        },
      };
    }
  }

  const height = layout === null || frame === null ? 0 : layout.height / frame.dpr;
  const pending = segments.some((s) => s.anchor === null);
  const groups = new Set(segments.map((s) => s.group)).size > 1;
  return (
    <figure
      data-slot="board-map"
      aria-labelledby={captionId}
      data-pitch={layout?.pitch}
      data-from={shown.from}
      data-to={shown.to}
      className={cn("m-0 grid min-w-0 gap-4", className)}
    >
      <figcaption
        id={captionId}
        className="font-mono text-xs tracking-wide text-muted-foreground uppercase"
      >
        {labels.caption}
      </figcaption>
      <div ref={wrap} className="relative min-w-0 font-mono" style={{ height }}>
        <canvas
          ref={canvas}
          role="img"
          aria-label={labels.description}
          className="absolute inset-0 block"
          style={{ width: "100%", height }}
        />
        {label === undefined ? null : (
          <span
            aria-hidden="true"
            data-testid="board-map-mine"
            className="absolute flex items-center gap-1.5 bg-background pe-1 text-xs whitespace-nowrap text-foreground"
            style={label.style}
          >
            <span className="size-2.5 shrink-0 border border-foreground bg-primary" />
            {label.text}
          </span>
        )}
      </div>
      {position === undefined ? null : (
        <p className="m-0 max-w-prose text-sm text-pretty" data-testid="board-map-position">
          {position}
        </p>
      )}
      {legend ? (
        <ul className="m-0 flex list-none flex-wrap gap-x-6 gap-y-2 p-0 text-xs text-muted-foreground">
          {BOARD_KINDS.map((kind, k) =>
            shownCounts[k] === 0 ? null : (
              <li key={kind} className="flex items-center gap-2">
                <KindSwatch kind={kind} />
                <span>
                  {labels.kinds[kind]}{" "}
                  <span className="font-mono text-foreground">
                    <Count value={shownCounts[k]!} />
                  </span>
                </span>
              </li>
            ),
          )}
          <li className="flex items-center gap-2">
            <AnchorMark className="text-muted-foreground" />
            <span>{labels.anchored}</span>
          </li>
          {pending ? (
            <li className="flex items-center gap-2">
              <AnchorMark pending className="text-muted-foreground" />
              <span>{labels.unanchored}</span>
            </li>
          ) : null}
        </ul>
      ) : null}
      {labels.table === undefined ? null : (
        <details className="border-y border-border">
          <summary className="flex min-h-12 cursor-pointer items-center text-sm font-medium">
            {labels.table.summary}
          </summary>
          <table className="mb-4 w-full border-collapse text-sm">
            <caption className="pb-3 text-start font-mono text-xs tracking-wide text-muted-foreground uppercase">
              {labels.table.caption}
            </caption>
            <thead>
              <tr className="border-y border-foreground">
                <th scope="col" className="py-2 pe-3 text-start font-medium">
                  {labels.table.segment}
                </th>
                <th scope="col" className="py-2 pe-3 text-end font-medium">
                  {labels.table.entries}
                </th>
                <th scope="col" className="py-2 text-start font-medium">
                  {labels.table.anchor}
                </th>
              </tr>
            </thead>
            <tbody>
              {segments.map((s, i) => {
                const per = counts.perSegment[i]!;
                const others = BOARD_KINDS.slice(1)
                  .map((kind, k) => ({ kind, count: per[k + 1]! }))
                  .filter((o) => o.count > 0);
                const holdsMine = mine !== undefined && s === mineSegment;
                return (
                  <tr
                    key={s.segment}
                    aria-current={holdsMine ? "true" : undefined}
                    className={cn("border-b border-border align-top", holdsMine && "bg-muted")}
                  >
                    <th scope="row" className="py-1.5 pe-3 text-start font-mono font-normal">
                      {groups && s.group !== undefined ? `${s.group} ${s.label}` : s.label}
                    </th>
                    <td className="py-1.5 pe-3 text-end font-mono">
                      <Count value={s.size} />
                      {others.map((o) => (
                        <span
                          key={o.kind}
                          className={cn(
                            "block text-xs",
                            holdsMine ? "text-foreground" : "text-muted-foreground",
                          )}
                        >
                          {format(labels.table!.breakdown, {
                            count: o.count,
                            kind: labels.kinds[o.kind],
                          })}
                        </span>
                      ))}
                    </td>
                    <td className="py-1.5 font-mono text-xs">
                      {s.anchor === null
                        ? labels.table!.notAnchored
                        : format(labels.table!.anchorCell, {
                            at: s.anchor.at,
                            block: s.anchor.block,
                          })}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </details>
      )}
    </figure>
  );
}
