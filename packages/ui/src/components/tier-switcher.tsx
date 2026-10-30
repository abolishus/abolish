import type { ReactNode } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.tsx";

export interface Tier {
  /** A stable identifier ("tier-2"). */
  value: string;
  /** The tier's name, translated by the caller ("Document-verified"). */
  label: string;
  /**
   * Who the tier's results count, translated by the caller with its count
   * ("40,112 voters"): numbers always carry their scope (brief, Voice).
   */
  scope: string;
}

export interface TierSwitcherProps {
  /** The switcher's name, translated by the caller ("Verification tier"). */
  label: string;
  /** Every tier with results, each its own entry. */
  tiers: readonly Tier[];
  /** The tier shown first; the first tier when omitted. */
  defaultValue?: string;
  /** Called with the tier the reader picks. */
  onValueChange?: (value: string) => void;
  /** The results for one tier. */
  children: (tier: Tier) => ReactNode;
}

/**
 * The tier switcher (brief: results show the verification tier as a
 * first-class layer, never a footnote, and tiers are never blended into one
 * headline number; Keep). Each tier is a tab carrying its own name and scope,
 * and each panel renders only that tier's results. There is no "all tiers"
 * tab, and callers must not add one: a blended total would hide Tier 0's
 * Sybil weakness inside the stronger tiers' numbers (T-01, T-13, T-53).
 */
export function TierSwitcher({
  label,
  tiers,
  defaultValue,
  onValueChange,
  children,
}: TierSwitcherProps) {
  const first = tiers[0];
  if (first === undefined) throw new RangeError("a tier switcher needs at least one tier");
  if (new Set(tiers.map((t) => t.value)).size !== tiers.length) {
    throw new RangeError("tier values must be distinct");
  }
  if (defaultValue !== undefined && !tiers.some((t) => t.value === defaultValue)) {
    throw new RangeError("the default tier must be one of the tiers");
  }
  return (
    <Tabs
      defaultValue={defaultValue ?? first.value}
      onValueChange={(value) => onValueChange?.(String(value))}
    >
      <TabsList aria-label={label} variant="line" className="w-full flex-wrap justify-start">
        {tiers.map((tier) => (
          <TabsTrigger
            key={tier.value}
            value={tier.value}
            className="flex-none flex-col items-start gap-0 text-left"
          >
            <span>{tier.label}</span>
            <span className="text-xs font-normal">{tier.scope}</span>
          </TabsTrigger>
        ))}
      </TabsList>
      {tiers.map((tier) => (
        // The panel takes focus after its tab (WAI-ARIA tabs), so it shows it (2.4.7).
        <TabsContent
          key={tier.value}
          value={tier.value}
          className="pt-4 focus-visible:ring-3 focus-visible:ring-ring"
        >
          {children(tier)}
        </TabsContent>
      ))}
    </Tabs>
  );
}
