import { cn, useActiveStep } from "@abolishus/ui";
import { type ReactNode, useRef } from "react";

/**
 * Scrollytelling in the everyday register: a sticky graphic beside
 * step cards. The graphic follows the step at the middle of the viewport, so
 * it moves only with the reader's own scrolling.
 *
 * Below `lg` there is no column beside the cards, and a sticky graphic above
 * them sat under the step it drew whenever that step was active, so there
 * each card carries its own graphic instead and nothing is sticky.
 */
export function StepScene({
  label,
  steps,
  graphic,
  className,
}: {
  label: string;
  steps: readonly ReactNode[];
  graphic: (step: number) => ReactNode;
  className?: string;
}) {
  const refs = useRef<(HTMLElement | null)[]>([]);
  const active = useActiveStep(refs);
  return (
    <section aria-label={label} className={cn("relative grid gap-x-12 lg:grid-cols-12", className)}>
      <div className="sticky top-0 z-0 hidden bg-background lg:order-last lg:col-span-7 lg:flex lg:h-svh lg:items-center">
        <div className="w-full">{graphic(active)}</div>
      </div>
      <ol className="relative z-10 m-0 grid list-none gap-6 p-0 lg:col-span-5 lg:gap-0">
        {steps.map((step, index) => (
          <li
            key={index}
            ref={(element) => {
              refs.current[index] = element;
            }}
            data-active={index === active ? "" : undefined}
            className="lg:flex lg:min-h-[70svh] lg:items-center lg:py-10"
          >
            <div className="grid w-full gap-6 border border-border bg-background p-6 transition-colors duration-300 in-data-active:border-primary motion-reduce:transition-none">
              {step}
              <div className="lg:hidden">{graphic(index)}</div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
