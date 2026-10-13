// Pieces shared by the polls, board, receipt and verify mockups.

import { Button, cn, SectionMark } from "@abolishus/ui";
import { Check, Copy } from "lucide-react";
import { type ReactNode, useId, useState } from "react";

/** A numbered section on the page's hairline grid, labelled by its own heading. */
export function Section({
  index,
  mark,
  title,
  lede,
  children,
  className,
  id,
}: {
  index: string;
  mark: string;
  title: string;
  lede?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  const generated = useId();
  const headingId = id ?? generated;
  return (
    <section aria-labelledby={headingId} className={cn("border-t border-border", className)}>
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-16 md:py-24">
        <div className="grid gap-5 md:grid-cols-12">
          <SectionMark index={index} className="md:col-span-12">
            {mark}
          </SectionMark>
          <h2
            id={headingId}
            className="m-0 font-heading text-3xl leading-tight font-semibold tracking-tight text-balance sm:text-4xl md:col-span-7"
          >
            {title}
          </h2>
          {lede === undefined ? null : (
            <div className="m-0 max-w-prose text-base text-pretty text-muted-foreground md:col-span-5 md:pt-2">
              {lede}
            </div>
          )}
        </div>
        {children}
      </div>
    </section>
  );
}

/** A mono micro-label, the voice of column heads and evidence labels. */
export function Micro({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn("font-mono text-xs tracking-widest text-muted-foreground uppercase", className)}
    >
      {children}
    </span>
  );
}

/**
 * A command to copy, in the evidence face. Long arguments wrap rather than
 * scroll, so a 64-digit hash never pushes the page sideways on a phone.
 */
export function CopyBlock({ label, command }: { label: string; command: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const labelId = useId();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setState("copied");
    } catch {
      setState("failed");
    }
  };
  return (
    <figure aria-labelledby={labelId} className="m-0 grid border border-foreground">
      <figcaption
        id={labelId}
        className="flex items-center justify-between gap-4 border-b border-border ps-4"
      >
        <Micro>{label}</Micro>
        <span className="flex items-center gap-2">
          <span aria-live="polite" className="font-mono text-xs text-muted-foreground">
            {state === "copied" ? "Copied" : state === "failed" ? "Select the text to copy" : ""}
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Copy: ${label}`}
            onClick={() => void copy()}
          >
            {state === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          </Button>
        </span>
      </figcaption>
      <pre className="m-0 p-4 font-mono text-sm leading-relaxed break-all whitespace-pre-wrap">
        <code translate="no">{command}</code>
      </pre>
    </figure>
  );
}
