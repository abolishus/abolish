import { cn, Fingerprint } from "@abolishus/ui";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

import { qrPlaceholder, shortCode, shortLink } from "./share-data.ts";

/**
 * A fixed-size surface (a 1200×630 card, an A4 page) drawn at its real size
 * and scaled down to fit its container, so it never pushes a phone sideways.
 */
export function ScaleToFit({
  width,
  height,
  children,
  className,
}: {
  width: number;
  height: number;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const fit = () => setScale(Math.min(1, element.clientWidth / width));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [width]);
  return (
    <div
      ref={ref}
      data-scaled=""
      className={cn("relative w-full overflow-hidden print:overflow-visible", className)}
      style={{ aspectRatio: `${width} / ${height}`, maxWidth: width }}
    >
      <div
        className="absolute start-0 top-0 origin-top-left print:static print:transform-none!"
        style={{ width, height, transform: `scale(${scale})` }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * A clearly labelled placeholder QR code: the shape of the real thing, drawn
 * from the poll id, encoding nothing. A real encoder replaces it.
 */
export function QrPlaceholder({
  id,
  size = 160,
  caption = true,
  className,
}: {
  id: string;
  size?: number;
  /** Show "Placeholder" under the code. */
  caption?: boolean;
  className?: string;
}) {
  const grid = qrPlaceholder(id);
  const n = grid.length;
  return (
    <span className={cn("inline-grid justify-items-center gap-1", className)}>
      <svg
        role="img"
        aria-label={`QR code for ${shortLink(id)} (placeholder, not scannable)`}
        viewBox={`-2 -2 ${n + 4} ${n + 4}`}
        width={size}
        height={size}
        shapeRendering="crispEdges"
        className="shrink-0 bg-white text-black"
      >
        <rect x={-2} y={-2} width={n + 4} height={n + 4} fill="white" />
        {grid.flatMap((row, y) =>
          row.map((on, x) =>
            on ? (
              <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill="currentColor" />
            ) : null,
          ),
        )}
      </svg>
      {caption ? (
        <span aria-hidden="true" className="text-xs text-muted-foreground">
          Placeholder QR · {shortCode(id)}
        </span>
      ) : null}
    </span>
  );
}

/** The poll's seal: its fingerprint in a ring, sized for the surface. */
export function SealMark({
  id,
  size,
  className,
}: {
  id: string;
  size: number;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex shrink-0", className)}>
      <Fingerprint
        value={id}
        label={`Seal of this poll, ${id.slice(0, 4)} ${id.slice(4, 8)}`}
        size={size}
      />
    </span>
  );
}

export type CopyState = "idle" | "copied" | "failed";

/** Copy text to the clipboard; the state says what happened, in words. */
export function useCopy() {
  const [state, setState] = useState<CopyState>("idle");
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  };
  return { state, copy };
}
