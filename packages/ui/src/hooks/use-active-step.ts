import { type RefObject, useEffect, useState } from "react";

/**
 * The index of the step nearest the middle of the viewport, among the
 * elements in `steps`. 0 until a step crosses the middle band, and on the
 * server.
 */
export function useActiveStep(steps: RefObject<(HTMLElement | null)[]>): number {
  const [active, setActive] = useState(0);
  useEffect(() => {
    const elements = (steps.current ?? []).filter((e): e is HTMLElement => e !== null);
    if (elements.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const index = elements.indexOf(entry.target as HTMLElement);
          if (index >= 0) setActive(index);
        }
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );
    for (const element of elements) observer.observe(element);
    return () => observer.disconnect();
  }, [steps]);
  return active;
}
