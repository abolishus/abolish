import { cn } from "cn";
import type { ReactNode } from "react";

export interface StatFigureProps {
  /** The figure itself, usually a `Count` or a formatted share. */
  value: ReactNode;
  /** What it counts, translated by the caller. */
  label: string;
  /** Its scope ("document-verified voters, as of 14:00 UTC"), in the evidence face. */
  scope?: string;
  className?: string;
}

/** One headline number with its label and scope, ruled above like a ledger total. */
export function StatFigure({ value, label, scope, className }: StatFigureProps) {
  return (
    <div
      data-slot="stat-figure"
      className={cn("reveal grid gap-1 border-t-2 border-foreground pt-3", className)}
    >
      <p className="m-0 font-heading text-4xl font-semibold tabular-nums sm:text-5xl">{value}</p>
      <p className="m-0 text-sm">{label}</p>
      {scope === undefined ? null : (
        <p className="m-0 font-mono text-xs text-muted-foreground">{scope}</p>
      )}
    </div>
  );
}
