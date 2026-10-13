import {
  BoardLedger,
  Button,
  cn,
  Count,
  ScrollScene,
  SectionMark,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TallyBars,
  TierSwitcher,
} from "@abolishus/ui";
import { Input } from "@abolishus/ui/ui/input";
import { Check, Clock } from "lucide-react";
import type { ReactNode } from "react";

import {
  BOARD_ENTRIES,
  ENTRY_POINTS,
  LEVY,
  type TierKey,
  type TierResult,
  TRUSTEES,
} from "./fixtures.ts";
import { LEVY_DECRYPTING, LEVY_RECORD, TIER_VOTERS, tierInfo } from "./poll-data.ts";
import {
  ClaimNote,
  Evidence,
  EvidenceHash,
  FactStrip,
  N,
  num,
  pct,
  PollSection,
  StatusMark,
} from "./poll-parts.tsx";
import { describeTurnout, TurnoutChart, type TurnoutSeries } from "./poll-turnout-chart.tsx";
import { MockShell, PageHead } from "./shell.tsx";

/** `counted`: the tally is decrypted. `decrypting`: voting closed, shares still arriving. */
export type ResultsStage = "counted" | "decrypting";

const POLL = LEVY;
const SERIES: readonly TurnoutSeries[] = POLL.results.map((r) => {
  const info = tierInfo(r.tier);
  return { tier: r.tier, short: info.short, name: info.name, eligible: r.eligible };
});

function result(tier: TierKey): TierResult {
  const r = POLL.results.find((x) => x.tier === tier);
  if (r === undefined) throw new RangeError(`no result for ${tier}`);
  return r;
}

function leader(r: TierResult) {
  const ranked = POLL.options.toSorted((a, b) => (r.counts[b.key] ?? 0) - (r.counts[a.key] ?? 0));
  const top = ranked[0];
  if (top === undefined) throw new RangeError("a result needs options");
  return { option: top, share: (r.counts[top.key] ?? 0) / r.ballots };
}

export function PollResultsPage({ stage = "counted" }: { stage?: ResultsStage }) {
  const counted = stage === "counted";
  return (
    <MockShell current="/polls">
      <article>
        <Hero counted={counted} />
        <TierResults counted={counted} />
        <CountGrew />
        <Regions counted={counted} />
        <Record counted={counted} />
        <VerifyIt counted={counted} />
      </article>
    </MockShell>
  );
}

function Hero({ counted }: { counted: boolean }) {
  return (
    <PageHead eyebrow={`${POLL.kind} · ${POLL.title}`} title={POLL.question} className="pb-16">
      <div className="flex flex-wrap items-center gap-3">
        {counted ? (
          <StatusMark icon={Check} tone="recorded">
            Counted
          </StatusMark>
        ) : (
          <StatusMark icon={Clock} tone="pending">
            Closed, decrypting
          </StatusMark>
        )}
        <span className="text-sm text-muted-foreground">
          {counted
            ? `Tally decrypted ${LEVY_RECORD.decryptedAt}`
            : `${LEVY_DECRYPTING.shares} of 7 trustee shares published, 4 needed`}
        </span>
      </div>
      <FactStrip
        className="mt-4"
        facts={[
          { term: "Who could vote", value: POLL.scope },
          { term: "Voting", value: "3 November 2026, 06:00 to 20:00 UTC" },
          { term: "Counting", value: `${POLL.method}: one choice per ballot` },
          {
            term: "Ballots on the board",
            value: (
              <>
                <N value={LEVY_RECORD.ballots} />, in three tiers
              </>
            ),
          },
        ]}
      />
      <div className="grid gap-8 md:grid-cols-2">
        <EvidenceHash label="Election ID" value={POLL.id} subject="election" />
        <EvidenceHash label="Definition hash" value={POLL.definitionHash} subject="definition" />
      </div>
      <ClaimNote>
        Everything below is what our server says about this poll. The verifier checks it against
        Ethereum and IPFS, without us;{" "}
        <a className="text-foreground underline underline-offset-4" href="#verify">
          section 05
        </a>{" "}
        shows how.
      </ClaimNote>
    </PageHead>
  );
}

function TierResults({ counted }: { counted: boolean }) {
  const tiers = POLL.results.map((r) => {
    const info = tierInfo(r.tier);
    return { value: r.tier, label: info.name, scope: `${info.short} · ${num(r.ballots)} voters` };
  });
  return (
    <PollSection
      id="result"
      index="01"
      mark={counted ? "Result by tier" : "Ballots by tier"}
      title={
        counted ? "The result, one tier at a time" : "Voting has closed; the tally is still sealed"
      }
      layout="stacked"
      lede={
        counted ? (
          <p className="m-0">
            Each verification tier is counted and reported on its own. There is no combined figure:
            adding passkey-only accounts, which anyone can open in numbers, to verified voters would
            hide how much weight each kind of voter carries.
          </p>
        ) : (
          <p className="m-0">
            The tally is decrypted once 4 of the 7 trustees publish their shares. As of{" "}
            {LEVY_DECRYPTING.at}, {LEVY_DECRYPTING.shares} have. Until then, the board shows how
            many ballots each tier cast, but not what they say.
          </p>
        )
      }
    >
      <div className="grid gap-16">
        <TierSwitcher label="Verification tier" tiers={tiers}>
          {(tier) => <TierPanel tier={tier.value as TierKey} counted={counted} />}
        </TierSwitcher>
        <SideBySide counted={counted} />
      </div>
    </PollSection>
  );
}

function TierPanel({ tier, counted }: { tier: TierKey; counted: boolean }) {
  const r = result(tier);
  const info = tierInfo(tier);
  const turnout = r.ballots / r.eligible;
  const scope = `${num(r.ballots)} ${TIER_VOTERS[tier]}`;
  const lead = leader(r);
  return (
    <div className="grid gap-10 pt-6 lg:grid-cols-12 lg:gap-x-12">
      <div className="grid content-start gap-8 lg:col-span-5">
        {counted ? (
          <p className="m-0 grid gap-3">
            <span className="font-heading text-7xl leading-none font-semibold tracking-tight tabular-nums sm:text-8xl">
              {pct(lead.share)}
            </span>
            <span className="text-lg text-pretty">
              chose “{lead.option.label}” among {scope}.
            </span>
          </p>
        ) : (
          <p className="m-0 grid gap-3">
            <span className="font-heading text-7xl leading-none font-semibold tracking-tight tabular-nums sm:text-8xl">
              <Count value={r.ballots} />
            </span>
            <span className="text-lg text-pretty">
              {TIER_VOTERS[tier]} cast a ballot. What they chose is not yet decrypted.
            </span>
          </p>
        )}
        <div className="grid gap-2">
          <div className="flex items-baseline justify-between gap-4 text-sm">
            <span>Turnout</span>
            <span className="font-mono tabular-nums">
              {pct(turnout)} of <Count value={r.eligible} /> eligible
            </span>
          </div>
          <span aria-hidden="true" className="block h-2 bg-muted">
            <span
              className="draw-x block h-full bg-foreground"
              style={{ width: `${turnout * 100}%` }}
            />
          </span>
        </div>
        <p className="m-0 border-t border-border pt-4 text-sm text-muted-foreground">
          <span className="text-foreground">
            {info.short}, {info.name.toLowerCase()}.
          </span>{" "}
          {info.description}
        </p>
      </div>
      <div className="lg:col-span-7">
        {counted ? (
          <TallyBars
            caption={`Among ${scope}`}
            total={r.ballots}
            highlight={lead.option.key}
            rows={POLL.options.map((o) => ({
              key: o.key,
              label: o.label,
              count: r.counts[o.key] ?? 0,
            }))}
          />
        ) : (
          <div className="grid gap-3">
            <Evidence>Among {scope}</Evidence>
            <ol className="m-0 grid list-none border-t border-foreground p-0">
              {POLL.options.map((o) => (
                <li
                  key={o.key}
                  className="grid grid-cols-[1fr_auto] items-center gap-4 border-b border-border py-3"
                >
                  <span className="text-sm">{o.label}</span>
                  <span className="font-mono text-xs text-muted-foreground">Sealed</span>
                </li>
              ))}
            </ol>
            <p className="m-0 text-sm text-muted-foreground">
              Counts appear here when the fourth trustee share is published and checked.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function SideBySide({ counted }: { counted: boolean }) {
  return (
    <div className="grid gap-4">
      <h3 className="m-0 font-heading text-xl font-semibold">The three tiers side by side</h3>
      <Table>
        <TableCaption className="pb-3 text-start text-sm text-muted-foreground">
          One row per tier. There is no total row: the tiers are never added together.
        </TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Tier</TableHead>
            <TableHead scope="col" className="text-end">
              Ballots
            </TableHead>
            <TableHead scope="col" className="hidden text-end sm:table-cell">
              Eligible
            </TableHead>
            <TableHead scope="col" className={cn("text-end", counted && "hidden md:table-cell")}>
              Turnout
            </TableHead>
            {counted
              ? POLL.options.map((o) => (
                  <TableHead key={o.key} scope="col" className="text-end">
                    {o.key === "yes" ? "Yes" : "No"}
                  </TableHead>
                ))
              : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {POLL.results.map((r) => {
            const info = tierInfo(r.tier);
            const lead = leader(r);
            return (
              <TableRow key={r.tier}>
                <TableHead scope="row" className="font-normal">
                  <span className="block">{info.short}</span>
                  <span className="hidden text-muted-foreground sm:block">{info.name}</span>
                </TableHead>
                <TableCell className="text-end font-mono">
                  <Count value={r.ballots} />
                </TableCell>
                <TableCell className="hidden text-end font-mono sm:table-cell">
                  <Count value={r.eligible} />
                </TableCell>
                <TableCell className={cn("text-end font-mono", counted && "hidden md:table-cell")}>
                  {pct(r.ballots / r.eligible)}
                </TableCell>
                {counted
                  ? POLL.options.map((o) => (
                      <TableCell
                        key={o.key}
                        className={cn(
                          "text-end font-mono",
                          o.key === lead.option.key && "font-semibold",
                        )}
                      >
                        {pct((r.counts[o.key] ?? 0) / r.ballots)}
                      </TableCell>
                    ))
                  : null}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

const STEPS: readonly { through: number; focus: TierKey | null }[] = [
  { through: 1, focus: "tier2" },
  { through: 3, focus: null },
  { through: 5, focus: "tier1" },
  { through: 7, focus: null },
  { through: 7, focus: "tier0" },
];

function at(index: number) {
  const snap = POLL.timeline[index];
  if (snap === undefined) throw new RangeError(`no snapshot ${index}`);
  const t = (tier: TierKey) => {
    const r = result(tier);
    return {
      n: num(snap.ballots[tier]),
      p: pct(snap.ballots[tier] / r.eligible),
      e: num(r.eligible),
    };
  };
  return { snap, t2: t("tier2"), t1: t("tier1"), t0: t("tier0") };
}

function StepText({ time, children }: { time: string; children: ReactNode }) {
  return (
    <div className="grid gap-3">
      <Evidence>{time}</Evidence>
      <p className="m-0 text-lg text-pretty">{children}</p>
    </div>
  );
}

function CountGrew() {
  const a = at(1);
  const b = at(3);
  const c = at(5);
  const d = at(7);
  const steps = [
    <StepText key="a" time={`${a.snap.label} UTC · two hours in`}>
      {a.t2.n} document-verified voters had cast a ballot: {a.t2.p} of the {a.t2.e} who were
      eligible.
    </StepText>,
    <StepText key="b" time={`${b.snap.label} UTC · midday`}>
      The tiers moved at similar rates through the morning: {b.t2.p} of document-verified voters,{" "}
      {b.t1.p} of vouched voters and {b.t0.p} of passkey-only accounts.
    </StepText>,
    <StepText key="c" time={`${c.snap.label} UTC`}>
      Vouched voters kept pace with document-verified ones all afternoon: {c.t1.n} ballots, {c.t1.p}{" "}
      of {c.t1.e} eligible, against {c.t2.p} in Tier 2.
    </StepText>,
    <StepText key="d" time={`${d.snap.label} UTC · voting closed`}>
      Voting closed with {d.t2.n} document-verified, {d.t1.n} vouched and {d.t0.n} passkey-only
      ballots on the board. Each tier is counted on its own.
    </StepText>,
    <StepText key="e" time="Reading the tiers">
      Passkey-only turnout reached {d.t0.p} of {d.t0.e} accounts, well above both verified tiers.
      Anyone can open many such accounts, so this tier is shown apart and never added to the others.
    </StepText>,
  ];
  return (
    <section id="growth" aria-labelledby="growth-title" className="border-t border-border">
      <div className="mx-auto grid max-w-6xl gap-4 px-4 pt-16 md:pt-24">
        <PollSectionHead
          id="growth-title"
          index="02"
          mark="Turnout"
          title="How the count grew"
          lede="Hourly snapshots from the board, as each tier's share of its own eligible members. Scroll to move through the day."
        />
        <ScrollScene
          label="Turnout through the voting day"
          steps={steps}
          graphic={(step) => {
            const s = STEPS[step] ?? STEPS[0]!;
            const snap = POLL.timeline[s.through] ?? POLL.timeline[0]!;
            const closed = s.through === POLL.timeline.length - 1;
            return (
              <div
                role="img"
                aria-label={describeTurnout(snap, SERIES, closed)}
                data-testid="turnout-graphic"
                data-through={snap.label}
                data-focus={s.focus ?? "all"}
                className="grid gap-4 py-4"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-foreground pb-2">
                  <span className="font-heading text-base font-semibold">
                    Turnout, share of eligible
                  </span>
                  <Evidence className="text-foreground">As of {snap.label} UTC</Evidence>
                </div>
                <TurnoutChart
                  timeline={POLL.timeline}
                  series={SERIES}
                  through={s.through}
                  focus={s.focus}
                  closedLabel="Closed 20:00"
                />
                <p
                  aria-hidden="true"
                  className="m-0 flex flex-wrap gap-x-5 gap-y-1 font-mono text-xs"
                >
                  <LegendKey className="border-recorded" label="Tier 2" />
                  <LegendKey className="border-dashed border-foreground" label="Tier 1" />
                  <LegendKey className="border-dotted border-foreground" label="Tier 0" />
                </p>
              </div>
            );
          }}
        />
        <Snapshots />
      </div>
    </section>
  );
}

function LegendKey({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className={cn("inline-block w-6 border-t-2", className)} />
      {label}
    </span>
  );
}

/** A section head for sections that lay out their own frame. */
function PollSectionHead({
  id,
  index,
  mark,
  title,
  lede,
}: {
  id: string;
  index: string;
  mark: string;
  title: string;
  lede: string;
}) {
  return (
    <header className="grid max-w-3xl gap-4">
      <SectionMark index={index}>{mark}</SectionMark>
      <h2
        id={id}
        className="m-0 font-heading text-3xl leading-tight font-semibold tracking-tight text-balance sm:text-4xl"
      >
        {title}
      </h2>
      <p className="m-0 max-w-prose text-base text-pretty text-muted-foreground">{lede}</p>
    </header>
  );
}

function Snapshots() {
  return (
    <div className="grid gap-4 pt-8">
      <h3 className="m-0 font-heading text-xl font-semibold">Every snapshot</h3>
      <Table>
        <TableCaption className="pb-3 text-start text-sm text-muted-foreground">
          Ballots on the board at each hourly snapshot, and the share of the tier's eligible members
          they make up.
        </TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">UTC</TableHead>
            {SERIES.map((s) => (
              <TableHead key={s.tier} scope="col" className="text-end">
                {s.short}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {POLL.timeline.map((snap) => (
            <TableRow key={snap.hour}>
              <TableHead scope="row" className="font-mono font-normal">
                {snap.label}
              </TableHead>
              {SERIES.map((s) => (
                <TableCell key={s.tier} className="text-end font-mono">
                  <span className="block">
                    <Count value={snap.ballots[s.tier]} />
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {pct(snap.ballots[s.tier] / s.eligible)}
                  </span>
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function Regions({ counted }: { counted: boolean }) {
  const tier2 = result("tier2");
  const named = POLL.regions.filter((r) => r.key !== "other");
  const rest = POLL.regions.find((r) => r.key === "other");
  return (
    <PollSection
      id="regions"
      index="03"
      mark="Geography"
      title="Where the ballots came from"
      layout="stacked"
      lede={
        <>
          <p className="m-0">
            Document-verified ballots by region of residence, which the same credential proves. The
            other tiers carry no region. Every region gets an equal tile, whatever its size, so no
            area outweighs another on the page.
          </p>
          <p className="m-0">
            {counted
              ? "The bar is the region's yes share; the mark is the halfway line."
              : "The bar is the region's share of all Tier 2 ballots."}
          </p>
        </>
      }
    >
      <ul className="m-0 grid list-none grid-cols-1 border-t border-l border-border p-0 min-[400px]:grid-cols-2 lg:grid-cols-4">
        {named.map((region) => {
          const share = region.ballots / tier2.ballots;
          const bar = counted ? region.yesShare : share;
          return (
            <li
              key={region.key}
              className="grid content-between gap-6 border-r border-b border-border p-5"
            >
              <h3 className="m-0 text-sm font-medium">{region.name}</h3>
              <div className="reveal grid gap-3">
                <p className="m-0 font-heading text-4xl leading-none font-semibold tabular-nums">
                  {counted ? pct(region.yesShare) : <Count value={region.ballots} />}
                  <span className="ms-2 text-sm font-normal">{counted ? "yes" : "ballots"}</span>
                </p>
                <span aria-hidden="true" className="relative block h-2 bg-muted">
                  <span
                    className={cn(
                      "draw-x block h-full",
                      counted && region.yesShare >= 0.5 ? "bg-foreground" : "bg-foreground/60",
                    )}
                    style={{ width: `${bar * 100}%` }}
                  />
                  {counted ? (
                    <span className="absolute -top-1 left-1/2 h-4 w-0.5 bg-foreground" />
                  ) : null}
                </span>
                <p className="m-0 font-mono text-xs text-muted-foreground">
                  {counted ? (
                    <>
                      <Count value={region.ballots} /> ballots · {pct(share)} of Tier 2
                    </>
                  ) : (
                    <>{pct(share)} of Tier 2 ballots</>
                  )}
                </p>
              </div>
            </li>
          );
        })}
        {rest === undefined ? null : (
          <li className="grid content-between gap-6 border-r border-b border-border p-5 outline-1 -outline-offset-8 outline-border outline-dashed">
            <h3 className="m-0 text-sm font-medium">Other regions</h3>
            <div className="grid gap-2">
              <p className="m-0 font-heading text-4xl leading-none font-semibold tabular-nums">
                <Count value={rest.ballots} />
                <span className="ms-2 text-sm font-normal">ballots</span>
              </p>
              <p className="m-0 text-xs text-pretty text-muted-foreground">
                Regions with fewer than 500 ballots are folded together, so a small place's vote
                can't be singled out.
                {counted ? ` Together, ${pct(rest.yesShare)} yes.` : ""}
              </p>
            </div>
          </li>
        )}
      </ul>
    </PollSection>
  );
}

function Record({ counted }: { counted: boolean }) {
  const shares = counted ? 4 : LEVY_DECRYPTING.shares;
  const published = (i: number) =>
    counted ? TRUSTEES[i]?.status === "Share published" : i < LEVY_DECRYPTING.shares;
  return (
    <PollSection
      id="record"
      index="04"
      mark="The record"
      title="What the board holds"
      layout="stacked"
      lede={
        <p className="m-0">
          The board is append-only and public. Its head is anchored to Ethereum, so a later board
          that doesn't extend this one is evidence of tampering.
        </p>
      }
    >
      <div className="grid gap-16">
        <div className="grid gap-12 md:grid-cols-2 md:gap-x-16">
          <div className="grid content-start gap-6">
            <h3 className="m-0 font-heading text-xl font-semibold">Board</h3>
            <dl className="m-0 grid grid-cols-2 gap-6">
              <div className="grid gap-1 border-t-2 border-foreground pt-3">
                <dt className="text-sm">Entries</dt>
                <dd className="m-0 font-heading text-3xl font-semibold tabular-nums">
                  <Count value={POLL.entries} />
                </dd>
              </div>
              <div className="grid gap-1 border-t-2 border-foreground pt-3">
                <dt className="text-sm">Counted ballots</dt>
                <dd className="m-0 font-heading text-3xl font-semibold tabular-nums">
                  <Count value={LEVY_RECORD.ballots} />
                </dd>
              </div>
            </dl>
            <p className="m-0 text-sm text-pretty text-muted-foreground">
              The other {num(POLL.entries - LEVY_RECORD.ballots)} entries are the definition,
              spoiled ballots, hourly anchors and the trustees' records.
            </p>
            <EvidenceHash label="Board head" value={POLL.boardHead} subject="board head" />
            <EvidenceHash
              label={`Last Ethereum anchor · ${LEVY_RECORD.lastAnchor.at}`}
              value={LEVY_RECORD.lastAnchor.tx}
              subject="anchor transaction"
            />
            <p className="m-0 font-mono text-xs text-muted-foreground">
              Block <Count value={LEVY_RECORD.lastAnchor.block} /> · registry {LEVY_RECORD.registry}
            </p>
          </div>
          <div className="grid content-start gap-6">
            <h3 className="m-0 font-heading text-xl font-semibold">Trustees' decryption</h3>
            <p className="m-0 text-base">
              <span className="font-heading text-3xl font-semibold tabular-nums">
                {shares} of 7
              </span>{" "}
              shares published; any 4 decrypt the tally.
            </p>
            <div aria-hidden="true" className="flex items-stretch gap-1">
              {TRUSTEES.map((t, i) => (
                <span key={t.key} className="contents">
                  <span
                    className={cn(
                      "h-8 flex-1 border",
                      published(i) ? "border-recorded bg-recorded" : "border-border bg-muted",
                    )}
                  />
                  {i === 3 ? <span className="mx-1 w-0.5 bg-foreground" /> : null}
                </span>
              ))}
            </div>
            <ol className="m-0 grid list-none border-t border-foreground p-0 text-sm">
              {TRUSTEES.map((t, i) => (
                <li
                  key={t.key}
                  className="grid grid-cols-[1fr_auto] gap-x-4 border-b border-border py-2"
                >
                  <span className="min-w-0">
                    <span className="block">{t.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {t.kind}, {t.jurisdiction} · <code className="font-mono">{t.key}</code>
                    </span>
                  </span>
                  <span className="flex items-center gap-1.5 self-center text-xs">
                    {published(i) ? (
                      <>
                        <Check aria-hidden="true" className="size-4 text-recorded" />
                        Share published
                      </>
                    ) : (
                      <span className="text-muted-foreground">
                        {counted ? "Not needed" : "Not yet"}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </div>
        <div className="grid gap-4">
          <BoardLedger
            caption={`Entries ${num(BOARD_ENTRIES[0]?.index ?? 0)} to ${num(BOARD_ENTRIES.at(-1)?.index ?? 0)} of ${num(POLL.entries)}`}
            columns={{ index: "Entry", time: "Recorded", kind: "Kind", hash: "Entry hash" }}
            fingerprintLabel={(e) => `Fingerprint of entry ${num(Number(e.index))}`}
            entries={BOARD_ENTRIES}
          />
          <a className="justify-self-start text-sm underline underline-offset-4" href="/board">
            Open the full board
          </a>
        </div>
      </div>
    </PollSection>
  );
}

function VerifyIt({ counted }: { counted: boolean }) {
  const short = `${POLL.id.slice(0, 16)}`;
  const tally = counted
    ? POLL.results
        .map((r) => {
          const info = tierInfo(r.tier);
          return `${info.short}  yes ${num(r.counts["yes"] ?? 0).padStart(6)}  no ${num(r.counts["no"] ?? 0).padStart(6)}  (${num(r.ballots)} ballots)`;
        })
        .join("\n")
    : "Tally sealed: 3 of 4 required decryption shares published";
  const cli = `$ abolish-verify recount ${short}… \\
    --from ethereum,ipfs

Board: ${num(POLL.entries)} entries, head ${POLL.boardHead.slice(0, 8)}… matches anchor
${tally}
${counted ? "Decryption proofs: 4 of 7 shares, all valid\nResult matches the published tally." : "Ballot proofs: all valid"}`;
  return (
    <PollSection
      id="verify"
      index="05"
      mark="Verify it yourself"
      title="Check it without trusting us"
      layout="stacked"
      lede={
        <p className="m-0">
          This page is a convenience. The record lives on Ethereum and IPFS, and the verifier
          recounts it on your own machine.
        </p>
      }
    >
      <ol className="m-0 grid list-none gap-px border border-border bg-border p-0 lg:grid-cols-[1fr_minmax(0,1.7fr)_1fr]">
        <li className="grid content-start gap-4 bg-background p-6">
          <Evidence>Step 1</Evidence>
          <h3 className="m-0 font-heading text-xl font-semibold">Find your receipt</h3>
          <p className="m-0 text-sm text-muted-foreground">
            Your receipt shows that your ballot is on the board, not how you voted.
          </p>
          <form
            role="search"
            aria-label="Find your receipt"
            className="grid gap-2"
            onSubmit={(e) => e.preventDefault()}
          >
            <label htmlFor="receipt" className="text-sm">
              Receipt hash, or its first 8 digits
            </label>
            <Input id="receipt" name="receipt" className="h-12 font-mono text-sm md:text-sm" />
            <Button type="submit" variant="outline" className="justify-self-start">
              Find on the board
            </Button>
          </form>
        </li>
        <li className="grid min-w-0 content-start gap-4 bg-background p-6">
          <Evidence>Step 2</Evidence>
          <h3 className="m-0 font-heading text-xl font-semibold">Recount with the verifier</h3>
          <pre
            tabIndex={0}
            aria-label="Verifier command and its output"
            className="m-0 overflow-x-auto bg-muted p-4 font-mono text-xs/relaxed"
          >
            <code>{cli}</code>
          </pre>
        </li>
        <li className="grid content-start gap-4 bg-background p-6">
          <Evidence>Step 3</Evidence>
          <h3 className="m-0 font-heading text-xl font-semibold">Works without our servers</h3>
          <p className="m-0 text-sm text-muted-foreground">
            The verifier reads Ethereum and any IPFS gateway. If this site goes away, the result can
            still be recounted.
          </p>
          <ul className="m-0 grid list-none gap-2 p-0 text-sm">
            {ENTRY_POINTS.map((e) => (
              <li key={e.name} className="border-t border-border pt-2">
                <span className="font-mono">{e.name}</span>
              </li>
            ))}
            <li className="border-t border-border pt-2">
              <span className="block">Verifier on IPFS</span>
              <code className="font-mono text-xs break-all text-muted-foreground">
                {LEVY_RECORD.verifierCid}
              </code>
            </li>
          </ul>
          <a className="text-sm underline underline-offset-4" href="/verify">
            How verification works
          </a>
        </li>
      </ol>
    </PollSection>
  );
}
