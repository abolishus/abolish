import { cn } from "cn";
import { useEffect, useState, type ReactNode } from "react";

import { BoardLedger, type BoardLedgerProps } from "./board-ledger.tsx";
import { BoardMap, type BoardMapLabels, type BoardMapSegment } from "./board-map.tsx";
import { Fingerprint } from "./fingerprint.tsx";
import { Hash } from "./hash.tsx";
import { InclusionPath, type InclusionPathProps } from "./inclusion-path.tsx";
import { ScrollScene } from "./scroll-scene.tsx";

/** The views the zoom passes through, one per step, in order. */
export const BOARD_ZOOM_VIEWS = ["board", "segment", "neighbourhood", "entry", "proof"] as const;
export type BoardZoomView = (typeof BOARD_ZOOM_VIEWS)[number];

export interface BoardZoomEntry {
  /** The view's heading ("Entry 95,208"). */
  title: string;
  /** The entry's hash: 64 lowercase hex digits. */
  hash: string;
  hashLabel: string;
  fingerprintLabel: string;
  /** Its facts, translated: segment, time, kind. */
  facts: readonly { label: string; value: string }[];
}

export interface BoardZoomGraphicProps {
  /** The whole board, and the reader's entry on it. */
  board: { kinds: Uint8Array; segments: readonly BoardMapSegment[]; mine: number };
  /** The map's labels in each of its three views. */
  views: { board: BoardMapLabels; segment: BoardMapLabels; neighbourhood: BoardMapLabels };
  /**
   * The neighbourhood: how many entries either side of the reader's to draw,
   * and the ledger rows around it (the reader's row is marked).
   */
  neighbourhood: { span?: number; ledger: Omit<BoardLedgerProps, "highlight" | "className"> };
  entry: BoardZoomEntry;
  /** The inclusion path, as a verifier produced it. */
  proof: Omit<InclusionPathProps, "variant" | "className">;
}

export interface BoardZoomProps extends BoardZoomGraphicProps {
  /** Names the scene, translated by the caller. */
  label: string;
  /**
   * The narrative, one step per view of `BOARD_ZOOM_VIEWS`. Each states the
   * view's facts in words: the drawing is never the only place they appear.
   */
  steps: readonly [ReactNode, ReactNode, ReactNode, ReactNode, ReactNode];
  className?: string;
}

/** How tall the map may be in the scene's sticky frame, from the viewport. */
function useFrame(): { height: number; wide: boolean } {
  const [frame, setFrame] = useState({ height: 360, wide: true });
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 1024px)");
    const measure = () =>
      setFrame({
        height: Math.max(160, Math.round(window.innerHeight * (wide.matches ? 0.6 : 0.3))),
        wide: wide.matches,
      });
    measure();
    window.addEventListener("resize", measure);
    wide.addEventListener("change", measure);
    return () => {
      window.removeEventListener("resize", measure);
      wide.removeEventListener("change", measure);
    };
  }, []);
  return frame;
}

/**
 * One view of the zoom: the whole board, the reader's segment, the entries
 * around theirs, their entry, and the path from it to the anchored root.
 * Every view draws the same data at a closer range; nothing is interpolated
 * between them. A new view settles in with a short zoom, except under
 * reduced motion, where it simply replaces the last.
 */
export function BoardZoomGraphic({
  step,
  board,
  views,
  neighbourhood,
  entry,
  proof,
}: BoardZoomGraphicProps & { step: number }) {
  const { height, wide } = useFrame();
  // The scene's frame holds the drawing; the table and, on a phone, the
  // sentence placing the entry stay with the steps, which state the same facts.
  const fit = (labels: BoardMapLabels): BoardMapLabels => ({
    ...labels,
    table: undefined,
    ...(wide ? {} : { position: undefined, positionPending: undefined }),
  });
  const view = BOARD_ZOOM_VIEWS[Math.min(Math.max(step, 0), BOARD_ZOOM_VIEWS.length - 1)]!;
  const { kinds, segments, mine } = board;
  const segment = segments.find((s) => mine >= s.first && mine < s.first + s.size);
  if (segment === undefined) throw new RangeError("the reader's entry must be on the board");
  const span = neighbourhood.span ?? 36;

  let body: ReactNode;
  switch (view) {
    case "board":
      body = (
        <BoardMap
          kinds={kinds}
          segments={segments}
          mine={mine}
          labels={fit(views.board)}
          maxHeight={height}
        />
      );
      break;
    case "segment":
      body = (
        <BoardMap
          kinds={kinds}
          segments={segments}
          mine={mine}
          range={{ from: segment.first, to: segment.first + segment.size }}
          labels={fit(views.segment)}
          maxHeight={height}
        />
      );
      break;
    case "neighbourhood":
      body = (
        <div className="grid min-w-0 gap-6">
          <BoardMap
            kinds={kinds}
            segments={segments}
            mine={mine}
            range={{ from: Math.max(0, mine - span), to: Math.min(kinds.length, mine + span + 1) }}
            labels={fit(views.neighbourhood)}
            maxHeight={Math.round(height * 0.6)}
            maxCell={18}
          />
          <BoardLedger {...neighbourhood.ledger} highlight={mine} />
        </div>
      );
      break;
    case "entry":
      body = (
        <figure aria-label={entry.title} className="m-0 grid min-w-0 gap-5">
          <div className="flex min-w-0 items-center gap-5 border-t-2 border-foreground pt-4">
            <Fingerprint value={entry.hash} label={entry.fingerprintLabel} size={112} />
            <p className="m-0 font-heading text-3xl leading-tight font-semibold sm:text-4xl">
              {entry.title}
            </p>
          </div>
          <div className="min-w-0 [&_code]:text-sm">
            <Hash value={entry.hash} label={entry.hashLabel} />
          </div>
          <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1 border-t border-border pt-3 text-sm">
            {entry.facts.map((fact) => (
              <div key={fact.label} className="contents">
                <dt className="text-muted-foreground">{fact.label}</dt>
                <dd className="m-0 font-mono">{fact.value}</dd>
              </div>
            ))}
          </dl>
        </figure>
      );
      break;
    case "proof":
      body = <InclusionPath {...proof} variant="compact" />;
      break;
  }
  return (
    <div
      key={view}
      data-testid="board-zoom-view"
      data-view={view}
      className="min-w-0 motion-safe:animate-in motion-safe:duration-300 motion-safe:ease-out motion-safe:fade-in-0 motion-safe:zoom-in-95"
    >
      {body}
    </div>
  );
}

/**
 * "From every entry to yours, and how anyone can check it": a scroll scene
 * that narrows from the whole board to the reader's segment, the entries
 * around theirs, their entry, and its inclusion path up to the checkpoint
 * anchored on Ethereum, one view per step of the narrative.
 */
export function BoardZoom({ label, steps, className, ...graphic }: BoardZoomProps) {
  return (
    <ScrollScene
      label={label}
      steps={steps}
      className={cn(className)}
      graphic={(step) => <BoardZoomGraphic step={step} {...graphic} />}
    />
  );
}
