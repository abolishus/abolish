import { Check, Circle, Clock } from "lucide-react";
import { cn } from "cn";

import { formatMessage } from "../i18n/format.ts";
import { useI18n } from "../i18n/context.tsx";

/** Where a step stands. */
export type StepState = "complete" | "pending" | "upcoming";

export interface StatusStep {
  /** The step, translated by the caller ("Recorded on the board"). */
  label: string;
  state: StepState;
  /** Optional evidence or time for the step, translated by the caller. */
  detail?: string;
}

export interface StatusTrailProps {
  /** The trail's name, translated by the caller ("Your ballot"). */
  label: string;
  /**
   * In order: for a receipt, encrypted on device, recorded on the board,
   * anchored to Ethereum, counted (brief, signature elements).
   */
  steps: readonly StatusStep[];
  /** The words for each state, translated by the caller and read with each step. */
  stateLabels: Record<StepState, string>;
  /**
   * How a screen reader hears a step and its state, translated by the caller
   * with `{step}` and `{state}` placeholders ("{step}, {state}"), so the
   * joining punctuation is the locale's.
   */
  stepTemplate: string;
}

const icons = { complete: Check, pending: Clock, upcoming: Circle } as const;

/**
 * The receipt's status trail. Each state has its own icon shape and its own
 * words, never colour alone (WCAG 1.4.1), and the colours are the status
 * tokens: recorded (emerald) and pending (amber). A trail that skips ahead
 * would claim more than the board shows (T-53), so the steps must run
 * complete, then at most one pending, then upcoming.
 */
export function StatusTrail({ label, steps, stateLabels, stepTemplate }: StatusTrailProps) {
  const { locale } = useI18n();
  const order: Record<StepState, number> = { complete: 0, pending: 1, upcoming: 2 };
  steps.forEach((step, i) => {
    const previous = steps[i - 1];
    if (previous === undefined) return;
    if (
      order[step.state] < order[previous.state] ||
      (step.state === "pending" && previous.state === "pending")
    ) {
      throw new RangeError("a status trail runs complete, then at most one pending, then upcoming");
    }
  });
  return (
    <ol aria-label={label} className="m-0 flex list-none flex-col gap-0 p-0">
      {steps.map((step, i) => {
        const Icon = icons[step.state];
        return (
          <li
            key={i}
            aria-current={step.state === "pending" ? "step" : undefined}
            className="relative flex gap-3 pb-4 last:pb-0"
          >
            {i < steps.length - 1 && (
              <span
                aria-hidden="true"
                className={cn(
                  "absolute top-7 bottom-0 left-3 w-px -translate-x-1/2",
                  step.state === "complete" ? "bg-recorded" : "bg-border",
                )}
              />
            )}
            <span
              aria-hidden="true"
              className={cn(
                "flex size-6 shrink-0 items-center justify-center border",
                step.state === "complete" && "border-recorded text-recorded",
                step.state === "pending" && "border-pending text-pending",
                step.state === "upcoming" && "border-muted-foreground text-muted-foreground",
              )}
            >
              <Icon className="size-4" strokeWidth={step.state === "complete" ? 3 : 2} />
            </span>
            <span className="flex flex-col">
              <span
                className={cn(
                  "text-sm",
                  step.state === "upcoming" ? "text-muted-foreground" : "text-foreground",
                )}
              >
                <span aria-hidden="true">{step.label}</span>
                <span className="sr-only">
                  {formatMessage(locale, stepTemplate, {
                    step: step.label,
                    state: stateLabels[step.state],
                  })}
                </span>
              </span>
              {step.detail !== undefined && (
                <span className="text-xs text-muted-foreground">{step.detail}</span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
