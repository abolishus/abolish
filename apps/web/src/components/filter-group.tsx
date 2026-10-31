import { useTranslate } from "@abolishus/ui";
import { useId } from "react";

import { catalogs } from "../messages.ts";

const CHIP =
  "inline-flex min-h-12 cursor-pointer items-center gap-2 border border-input px-4 text-sm has-checked:border-foreground has-checked:bg-foreground has-checked:text-background has-focus-visible:ring-3 has-focus-visible:ring-ring";

/**
 * One group of filters, as native radio buttons in a plain GET form, so it
 * works before the page's script loads, or without it (the kit's toggle group
 * and radio group need the script, and the toggle group sets an inline style
 * the CSP refuses). One value per group keeps each filter a single search
 * parameter, which the router keeps as sent. Each option says how many
 * items on this page it matches.
 */
export function FilterGroup<T extends string>({
  name,
  legend,
  options,
  checked,
  count,
  label,
}: {
  name: string;
  legend: string;
  options: readonly T[];
  checked: T | undefined;
  count: (option: T | "all") => number;
  label: (option: T) => string;
}) {
  const t = useTranslate(catalogs);
  const legendId = useId();
  return (
    <div
      role="radiogroup"
      aria-labelledby={legendId}
      className="grid gap-3 border-t border-border pt-4 md:grid-cols-12 md:items-center md:gap-x-6"
    >
      <span
        id={legendId}
        className="font-mono text-xs tracking-widest text-muted-foreground uppercase md:col-span-2"
      >
        {legend}
      </span>
      <div className="flex flex-wrap gap-2 md:col-span-10">
        {(["all", ...options] as const).map((option) => (
          <label key={option} className={CHIP}>
            <input
              type="radio"
              name={name}
              value={option}
              defaultChecked={option === "all" ? checked === undefined : checked === option}
              className="size-4 accent-current"
            />
            {option === "all" ? t("filterAll") : label(option)}
            <span className="font-mono text-xs tabular-nums opacity-80">{count(option)}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
