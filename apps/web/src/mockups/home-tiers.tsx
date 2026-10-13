import { cn, SectionMark, TallyBars, useScrollProgress } from "@abolishus/ui";
import { useRef } from "react";

import { LEVY, type TierKey } from "./fixtures.ts";
import { fmt, LEVY_TIERS, type LevyTier, pct } from "./home-parts.tsx";
import { Frame } from "./shell.tsx";

const FAKING: Record<TierKey, string> = {
  tier2: "Faking one voter takes a forged government-signed document.",
  tier1: "Faking one voter takes verified people willing to vouch for someone who isn’t real.",
  tier0: "Faking one voter takes another passkey, which anyone can make in a minute.",
};

/** Which of the levy's real two-hourly snapshots the reader has scrolled to. */
function snapshotFor(progress: number) {
  const last = LEVY.timeline.length - 1;
  const value = (progress - 0.2) / 0.4;
  return Math.round(Math.min(1, Math.max(0, value)) * last);
}

function Turnout({ tier, upTo }: { tier: LevyTier; upTo: number }) {
  const snapshot = LEVY.timeline[upTo]!;
  const cast = snapshot.ballots[tier.info.key];
  const eligible = tier.result.eligible;
  return (
    <div className="grid gap-3">
      <p className="m-0 font-mono text-xs tracking-wide text-muted-foreground uppercase">
        Turnout, 3 November, UTC
      </p>
      <div aria-hidden="true" className="grid gap-1">
        <div className="relative h-28 border-b border-foreground">
          {[0.25, 0.5, 0.75].map((line) => (
            <span
              key={line}
              className="absolute inset-x-0 border-t border-border"
              style={{ bottom: `${line * 100}%` }}
            />
          ))}
          <div className="absolute inset-0 grid grid-cols-8 items-end gap-1">
            {LEVY.timeline.map((s, i) => {
              const share = s.ballots[tier.info.key] / eligible;
              const drawn = i <= upTo;
              return (
                <span
                  key={s.hour}
                  className={cn(
                    "block transition-[height,background-color] duration-300 ease-out motion-reduce:transition-none",
                    i === upTo ? "bg-primary" : "bg-foreground/45",
                  )}
                  style={{ height: drawn ? `${share * 100}%` : "0%" }}
                />
              );
            })}
          </div>
        </div>
        <div className="flex justify-between font-mono text-xs text-muted-foreground tabular-nums">
          <span>{LEVY.timeline[0]?.label}</span>
          <span>{LEVY.timeline.at(-1)?.label}</span>
        </div>
      </div>
      <p className="m-0 text-sm tabular-nums" data-testid={`turnout-${tier.info.key}`}>
        By {snapshot.label} UTC, <strong className="font-semibold">{fmt(cast)}</strong> of{" "}
        {fmt(eligible)} eligible {tier.info.name.toLowerCase()} voters had voted (
        {pct(cast, eligible)}
        ).
      </p>
    </div>
  );
}

export function TiersSection() {
  const section = useRef<HTMLElement>(null);
  const progress = useScrollProgress(section);
  const upTo = snapshotFor(progress);
  return (
    <section
      ref={section}
      aria-labelledby="tiers-title"
      data-snapshot={upTo}
      className="border-t border-border pt-16 pb-8"
    >
      <Frame className="grid gap-10">
        <SectionMark index="03">Verification tiers</SectionMark>
        <div className="grid gap-6 lg:grid-cols-12 lg:gap-x-6">
          <h2
            id="tiers-title"
            className="m-0 font-heading text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-5xl lg:col-span-6"
          >
            Three tiers, counted apart
          </h2>
          <div className="grid max-w-prose content-start gap-4 text-lg text-pretty lg:col-span-6">
            <p className="m-0">
              Every result is reported once for each tier of identity. A passkey account is easy to
              open many times over; a document-verified voter has proved a government-signed
              passport or licence without revealing it.
            </p>
            <p className="m-0">
              Adding the tiers together would let the weakest hide inside the strongest, so Abolish
              never does. On the levy, they disagreed.
            </p>
          </div>
        </div>
        <ol className="m-0 grid list-none border-t-2 border-foreground p-0">
          {LEVY_TIERS.map((tier) => (
            <li
              key={tier.info.key}
              className="grid gap-8 border-b border-border py-10 lg:grid-cols-12 lg:gap-x-6"
            >
              <div className="grid content-start gap-3 lg:col-span-4">
                <p className="m-0 font-mono text-xs tracking-widest text-muted-foreground uppercase">
                  {tier.info.short}
                </p>
                <h3 className="m-0 font-heading text-3xl leading-tight font-semibold">
                  {tier.info.name}
                </h3>
                <p className="m-0 text-base">{tier.info.description}</p>
                <p className="m-0 text-sm text-muted-foreground">{FAKING[tier.info.key]}</p>
              </div>
              <div className="lg:col-span-3">
                <Turnout tier={tier} upTo={upTo} />
              </div>
              <div className="lg:col-span-5">
                <TallyBars
                  caption={`Final count among ${fmt(tier.result.ballots)} ${tier.info.name.toLowerCase()} voters`}
                  rows={LEVY.options.map((o) => ({
                    key: o.key,
                    label: o.label,
                    count: tier.result.counts[o.key] ?? 0,
                  }))}
                  total={tier.result.ballots}
                  highlight={tier.leader}
                />
              </div>
            </li>
          ))}
        </ol>
        <p className="m-0 max-w-prose text-sm text-muted-foreground">
          {LEVY.title}, closed 3 November 2026 at 20:00 UTC. The turnout columns are the board’s own
          two-hourly counts for each tier; they fill in as you read down the page.
        </p>
      </Frame>
    </section>
  );
}
