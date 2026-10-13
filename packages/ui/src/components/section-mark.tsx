import { cn } from "cn";
import type { ReactNode } from "react";

export interface SectionMarkProps {
  /** The section's number in the record ("01"). */
  index: string;
  children: ReactNode;
  className?: string;
}

/** A numbered, ruled section label, like a clause in a printed record. */
export function SectionMark({ index, children, className }: SectionMarkProps) {
  return (
    <p
      data-slot="section-mark"
      className={cn(
        "m-0 flex items-center gap-3 font-mono text-xs tracking-widest text-muted-foreground uppercase",
        className,
      )}
    >
      <span className="tabular-nums">{index}</span>
      <span>{children}</span>
      <span aria-hidden="true" className="wipe-in h-px flex-1 bg-border" />
    </p>
  );
}
