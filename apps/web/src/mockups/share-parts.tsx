import { cn, Fingerprint } from "@abolishus/ui";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

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
