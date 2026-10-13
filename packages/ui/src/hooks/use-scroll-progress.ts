import { type RefObject, useEffect, useState } from "react";

/**
 * How far an element has scrolled through the viewport: 0 when its top
 * reaches the bottom of the viewport, 1 when its bottom leaves the top.
 * Driven by the reader's own scrolling, so it is data, not autonomous motion,
 * and it holds under reduced motion too. 0 on the server.
 */
export function useScrollProgress(ref: RefObject<HTMLElement | null>): number {
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const rect = element.getBoundingClientRect();
      const span = rect.height + window.innerHeight;
      const value = (window.innerHeight - rect.top) / span;
      setProgress(Math.min(1, Math.max(0, value)));
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [ref]);
  return progress;
}
