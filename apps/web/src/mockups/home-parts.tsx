// Sample data and small drawing pieces shared by the Home and How it works
// mockups (Storybook only). Facts come from fixtures.ts; what that file lacks
// (hourly anchors, decryption share times, a sample ciphertext) is invented
// here in the same spirit.
import { cn, Fingerprint } from "@abolishus/ui";
import type { ReactNode } from "react";

import {
  BOARD_ENTRIES,
  LEVY,
  RECEIPT,
  TIERS,
  TRUSTEES,
  type TierInfo,
  type TierKey,
  type TierResult,
} from "./fixtures.ts";

export const fmt = (value: number) => value.toLocaleString("en-US");

export const pct = (part: number, whole: number) =>
  whole === 0 ? "0.0%" : `${((part / whole) * 100).toFixed(1)}%`;

export const pad2 = (value: number) => String(value).padStart(2, "0");

export const shortHex = (hash: string, size = 4) => `${hash.slice(0, size)}…${hash.slice(-size)}`;

/** Groups hex in fours for reading aloud and comparing by eye. */
export const spacedHex = (hash: string, groups = 4) =>
  (hash.match(/.{1,4}/g) ?? []).slice(0, groups).join(" ");

export interface LevyTier {
  info: TierInfo;
  result: TierResult;
  yes: number;
  no: number;
  leader: "yes" | "no";
}

function levyTier(key: TierKey): LevyTier {
  const info = TIERS.find((t) => t.key === key)!;
  const result = LEVY.results.find((r) => r.tier === key)!;
  const yes = result.counts["yes"] ?? 0;
  const no = result.counts["no"] ?? 0;
  return { info, result, yes, no, leader: yes >= no ? "yes" : "no" };
}

/** The levy's count, one entry per tier, strongest first. Never summed. */
export const LEVY_TIERS: readonly LevyTier[] = TIERS.map((t) => levyTier(t.key));

export const tierScope = (t: LevyTier) =>
  `${fmt(t.result.ballots)} ${t.info.name.toLowerCase()} voters`;

/**
 * The board rows the mockups show. The receipt's own row takes the receipt's
 * time, so the stub and the board read the same.
 */
export const LEDGER = BOARD_ENTRIES.map((entry) =>
  entry.index === RECEIPT.entry
    ? { ...entry, time: RECEIPT.recorded.split(", ").at(-1) ?? entry.time }
    : entry,
);

export const SPOILED_ENTRY = LEDGER.find((e) => e.kind === "Spoiled ballot")!;
export const ANCHOR_ENTRY = LEDGER.find((e) => e.kind === "Anchor")!;

/** Hourly anchors around the receipt's entry: the board head written to Ethereum. */
export const ANCHORS = [
  {
    at: "13:00",
    head: "4c1f0a9d2e7b83c6519fa0d4be2c7e18a3f6d9b0c5e2a7f4d1b8e3c6a9f0d2b7",
    tx: "9d3a6e1fb0c47e2a58d9f3b6c1e0a7d4f2b9c8e5a3d6f1b0e7c4a9d2f5b8e1c3",
  },
  {
    at: "14:00",
    head: "a83e5f0c1d9b7246e8f3a0c5d2b9e6f1a4c7d0e3b6f9a2c5d8e1b4f7a0c3d6e9",
    tx: "2f7c9e4a1b6d3f8e0a5c2d7b4e9f1a6c3d8b0e5f2a7c4d9e1b6f3a8c0d5e2b7f",
  },
  { at: "15:00", head: LEVY.boardHead, tx: RECEIPT.anchorTx },
  {
    at: "16:00",
    head: "d2b8f4a1e7c3095b6d1f8a4e2c7b9036f5a1d8e4c2b7f9a0e3d6c1b8f5a2e7d4",
    tx: "6a1d4f8b2e9c5073a6f1d8b4e2c9a7f0d5b3e8c1a6f4d9b2e7c0a5f3d8b1e6c4",
  },
] as const;

/** The anchor that first covered the receipt's entry. */
export const RECEIPT_ANCHOR = 2;

/** A ballot ciphertext as it leaves the phone (sample bytes). */
export const CIPHERTEXT = "8a1fe3c07b5d92e46f0a1c8b3d7e5f9204b6a8c1e3d5f7092b4d6f8a0c2e4b6d";

/** Decryption shares in the order they reached the board after polls closed. */
export const SHARES = TRUSTEES.map((trustee, i) => ({
  trustee,
  at: ["20:12", "20:19", "20:33", "20:41"][i],
})).filter((s) => s.trustee.status === "Share published");

export const THRESHOLD = 4;

/**
 * How far the scene has moved through one of its steps, from the scene's
 * scroll progress: 0 as the step reaches the middle of the viewport, 1 as it
 * leaves. ScrollScene's steps are 80svh each, and below its wide layout the
 * 55svh graphic sits in the flow above them.
 */
export function stepProgress(progress: number, step: number, steps: number) {
  const wide = typeof window !== "undefined" && window.matchMedia("(min-width: 64rem)").matches;
  const lead = wide ? 0 : 0.55;
  const span = 0.8 * steps + lead + 1;
  const value = (progress * span - 0.5 - lead) / 0.8 - step;
  return Math.min(1, Math.max(0, value));
}

/** The frame around every scroll-scene graphic: what it shows and where the scene stands. */
export function Stage({
  testId,
  step,
  total,
  title,
  children,
  className,
}: {
  testId: string;
  step: number;
  total: number;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div data-testid={testId} data-step={step} className={cn("grid w-full gap-5", className)}>
      <div className="grid gap-2">
        <p className="m-0 flex items-baseline justify-between gap-4 font-mono text-xs tracking-wide text-muted-foreground uppercase">
          <span>{title}</span>
          <span className="shrink-0 tabular-nums">
            {pad2(step + 1)} / {pad2(total)}
          </span>
        </p>
        <div
          aria-hidden="true"
          className="grid gap-1"
          style={{ gridTemplateColumns: `repeat(${total}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: total }, (_, i) => (
            <span
              key={i}
              className={cn(
                "h-0.5 transition-colors duration-300 ease-out motion-reduce:transition-none",
                i === step ? "bg-primary" : i < step ? "bg-foreground" : "bg-border",
              )}
            />
          ))}
        </div>
      </div>
      {children}
    </div>
  );
}

/**
 * One tier's two-option result as a single ruled bar: Yes from the start
 * edge, No from the end, the leader in emerald. Position and the words carry
 * the meaning, never the colour alone.
 */
export function TierSplit({
  tier,
  className,
  headingLevel,
}: {
  tier: LevyTier;
  className?: string;
  headingLevel?: "h3" | "p";
}) {
  const Name = headingLevel ?? "p";
  const yesShare = tier.yes / tier.result.ballots;
  return (
    <div className={cn("grid gap-2", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4">
        <Name className="m-0 text-sm font-semibold">
          <span className="font-mono text-xs font-normal tracking-wide text-muted-foreground uppercase">
            {tier.info.short}
          </span>{" "}
          {tier.info.name}
        </Name>
        <p className="m-0 font-mono text-xs text-muted-foreground tabular-nums">
          {fmt(tier.result.ballots)} ballots
        </p>
      </div>
      <div aria-hidden="true" className="flex h-3 gap-px">
        <span
          className={cn(tier.leader === "yes" ? "bg-primary" : "bg-foreground/35")}
          style={{ width: `${yesShare * 100}%` }}
        />
        <span className={cn("flex-1", tier.leader === "no" ? "bg-primary" : "bg-foreground/35")} />
      </div>
      <p className="m-0 flex justify-between gap-4 text-sm tabular-nums">
        <span className={cn(tier.leader === "yes" && "font-semibold")}>
          Yes {pct(tier.yes, tier.result.ballots)}
        </span>
        <span className={cn(tier.leader === "no" && "font-semibold")}>
          No {pct(tier.no, tier.result.ballots)}
        </span>
      </p>
    </div>
  );
}

/** A board row drawn small, for diagrams. */
export function MiniRow({
  entry,
  mine = false,
  fingerprintLabel,
}: {
  entry: { index: number; time: string; kind: string; hash: string };
  mine?: boolean;
  fingerprintLabel?: string;
}) {
  return (
    <li
      className={cn(
        "grid grid-cols-[3.5rem_minmax(0,1fr)_auto] items-center gap-3 border-b border-border py-1.5 ps-2 motion-safe:animate-in motion-safe:duration-300 motion-safe:fade-in motion-safe:slide-in-from-bottom-1",
        mine ? "border-s-2 border-s-primary" : "border-s-2 border-s-transparent",
      )}
    >
      <span className="font-mono text-xs tabular-nums">{fmt(entry.index)}</span>
      <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
        {entry.time}
        <span className="hidden sm:inline"> · {entry.kind}</span>
        {mine ? <span className="text-recorded"> · your receipt</span> : null}
      </span>
      <span className="flex items-center gap-2">
        <Fingerprint
          value={entry.hash}
          label={fingerprintLabel ?? `Fingerprint of entry ${fmt(entry.index)}`}
          size={24}
        />
        <code className="hidden font-mono text-xs sm:inline">{shortHex(entry.hash)}</code>
      </span>
    </li>
  );
}
