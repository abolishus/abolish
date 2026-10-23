import { cn } from "cn";
import { type ReactNode, useRef } from "react";

import { useActiveStep } from "../hooks/use-active-step.ts";
import { useScrollProgress } from "../hooks/use-scroll-progress.ts";

export interface ScrollSceneProps {
  /** Names the scene for assistive technology, translated by the caller. */
  label: string;
  /**
   * The narrative, one block per step. Each step states its facts in words,
   * scope included: the graphic illustrates them and is never the only place
   * a number appears.
   */
  steps: readonly ReactNode[];
  /**
   * The sticky graphic, redrawn for the step nearest the middle of the
   * viewport and the scene's scroll progress (0 to 1).
   */
  graphic: (step: number, progress: number) => ReactNode;
  /** Which side the graphic sits on at wide widths. */
  side?: "start" | "end";
  className?: string;
}

/**
 * Scrollytelling: a graphic that stays in view while the narrative scrolls
 * past it, changing with each step. On narrow screens the graphic pins to the
 * top and the steps scroll over it on the page's ground.
 */
export function ScrollScene({ label, steps, graphic, side = "end", className }: ScrollSceneProps) {
  const scene = useRef<HTMLElement>(null);
  const stepRefs = useRef<(HTMLElement | null)[]>([]);
  const active = useActiveStep(stepRefs);
  const progress = useScrollProgress(scene);
  return (
    <section
      ref={scene}
      aria-label={label}
      data-slot="scroll-scene"
      className={cn("relative grid gap-x-12 lg:grid-cols-2", className)}
    >
      <div
        className={cn(
          // A floor, not a height: text the reader has enlarged grows the
          // graphic past it rather than spilling over the page (1.4.4).
          "sticky top-0 z-0 flex min-h-[55svh] items-center justify-center bg-background lg:min-h-svh",
          side === "end" ? "lg:order-last" : "lg:order-first",
        )}
      >
        <div className="w-full">{graphic(active, progress)}</div>
      </div>
      <ol className="relative z-10 m-0 list-none p-0">
        {steps.map((step, index) => (
          <li
            key={index}
            ref={(element) => {
              stepRefs.current[index] = element;
            }}
            data-active={index === active ? "" : undefined}
            className="flex min-h-[80svh] items-center py-12"
          >
            <div className="w-full border border-border border-l-4 bg-background p-6 transition-colors duration-300 in-data-active:border-l-primary motion-reduce:transition-none">
              {step}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
