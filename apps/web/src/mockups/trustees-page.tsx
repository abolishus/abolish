import { Count, Fingerprint, Hash, ScrollScene, SectionMark, StatFigure, cn } from "@abolishus/ui";
import { Check, LockKeyhole, LockKeyholeOpen, WifiOff } from "lucide-react";
import type { ReactNode } from "react";

import { LEVY, TIERS } from "./fixtures.ts";
import { Frame, MockShell, PageHead } from "./shell.tsx";
import {
  ARRIVALS,
  CEREMONY,
  CEREMONY_ANCHOR_TX,
  CEREMONY_CID,
  JOINT_KEY,
  JURISDICTIONS,
  OFFLINE_SEATS,
  THRESHOLD,
  TRUSTEE_RECORDS,
  type TrusteeRecord,
} from "./trustees-data.ts";

const short = (hash: string) => `${hash.slice(0, 8)}…${hash.slice(-8)}`;

function trustee(seat: string): TrusteeRecord {
  const found = TRUSTEE_RECORDS.find((t) => t.seat === seat);
  if (found === undefined) throw new RangeError(`no trustee in seat ${seat}`);
  return found;
}

/** How many shares had arrived by each step of the scene. */
const SHARES_AT_STEP = [0, 1, 3, 3, 4] as const;
const TIME_AT_STEP = ["20:00 UTC", "20:04 UTC", "20:11 UTC", "20:15 UTC", "20:17 UTC"] as const;

function SectionHead({
  index,
  mark,
  title,
  id,
  children,
}: {
  index: string;
  mark: string;
  title: string;
  id: string;
  children?: ReactNode;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-12">
      <SectionMark index={index} className="lg:col-span-12">
        {mark}
      </SectionMark>
      <h2
        id={id}
        className="m-0 font-heading text-3xl leading-tight font-semibold tracking-tight text-balance sm:text-4xl lg:col-span-7"
      >
        {title}
      </h2>
      {children === undefined ? null : (
        <div className="max-w-prose text-base text-pretty lg:col-span-5 lg:pt-2">{children}</div>
      )}
    </div>
  );
}

/** The tally-opening diagram: seven seats around the sealed count. */
function OpeningDiagram({ step }: { step: number }) {
  const received = SHARES_AT_STEP[step] ?? 0;
  const arrived = new Set(ARRIVALS.slice(0, received).map((a) => a.seat));
  const offline = step >= 3 ? new Set<string>(OFFLINE_SEATS) : new Set<string>();
  const opened = received >= THRESHOLD;
  const cx = 160;
  const cy = 150;
  const r = 118;
  const nodes = TRUSTEE_RECORDS.map((t, i) => {
    const angle = (-90 + (i * 360) / TRUSTEE_RECORDS.length) * (Math.PI / 180);
    return { t, x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
  });
  return (
    <div
      data-testid="opening-diagram"
      data-step={step}
      data-shares={received}
      className="mx-auto grid w-full max-w-md gap-4 px-4"
    >
      <svg
        viewBox="0 0 320 300"
        aria-hidden="true"
        className="mx-auto h-auto max-h-[32svh] w-full lg:max-h-[52svh]"
      >
        {nodes.map(({ t, x, y }) => (
          <line
            key={`rule-${t.seat}`}
            x1={x}
            y1={y}
            x2={cx}
            y2={cy}
            className="stroke-border"
            strokeWidth={1}
          />
        ))}
        {nodes.map(({ t, x, y }) => (
          <path
            key={`share-${t.seat}`}
            d={`M ${x} ${y} L ${cx} ${cy}`}
            pathLength={1}
            strokeDasharray="1"
            strokeDashoffset={arrived.has(t.seat) ? 0 : 1}
            className="stroke-primary motion-safe:transition-[stroke-dashoffset] motion-safe:duration-500 motion-safe:ease-out"
            strokeWidth={3}
            fill="none"
          />
        ))}
        <rect
          x={cx - 38}
          y={cy - 38}
          width={76}
          height={76}
          className={cn(
            "stroke-foreground motion-safe:transition-colors motion-safe:duration-300",
            opened ? "fill-primary" : "fill-background",
          )}
          strokeWidth={2}
        />
        <text
          x={cx}
          y={cy + 6}
          textAnchor="middle"
          className={cn(
            "font-mono text-[18px] font-semibold tabular-nums",
            opened ? "fill-primary-foreground" : "fill-foreground",
          )}
        >
          {received}/{THRESHOLD}
        </text>
        <text
          x={cx}
          y={cy + 24}
          textAnchor="middle"
          className={cn(
            "font-mono text-[8px] tracking-widest uppercase",
            opened ? "fill-primary-foreground" : "fill-foreground",
          )}
        >
          {opened ? "Opened" : "Sealed"}
        </text>
        {nodes.map(({ t, x, y }) => {
          const has = arrived.has(t.seat);
          const away = offline.has(t.seat);
          return (
            <g key={`node-${t.seat}`}>
              <rect
                x={x - 22}
                y={y - 15}
                width={44}
                height={30}
                strokeWidth={1.5}
                strokeDasharray={away ? "3 3" : undefined}
                className={cn(
                  "motion-safe:transition-colors motion-safe:duration-300",
                  has ? "fill-foreground stroke-foreground" : "fill-background stroke-foreground",
                )}
              />
              <text
                x={x}
                y={y + 4}
                textAnchor="middle"
                className={cn(
                  "font-mono text-[11px] font-semibold",
                  has ? "fill-background" : "fill-foreground",
                )}
              >
                {t.seat}
              </text>
              {away ? (
                <text
                  x={x}
                  y={y + 28}
                  textAnchor="middle"
                  className="fill-foreground font-mono text-[8px] tracking-widest uppercase"
                >
                  Offline
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <div className="grid grid-cols-[1fr_auto] items-end gap-x-4 border-t-2 border-foreground pt-3">
        <p className="m-0 font-heading text-3xl font-semibold tabular-nums">
          {received} of {THRESHOLD}
          <span className="ms-2 text-base font-normal">shares needed</span>
        </p>
        <p className="m-0 font-mono text-xs tracking-wide">{TIME_AT_STEP[step]}</p>
      </div>
      <ol className="m-0 grid list-none grid-cols-7 gap-1 p-0" aria-hidden="true">
        {TRUSTEE_RECORDS.map((t) => (
          <li
            key={t.seat}
            className={cn(
              "flex h-8 items-center justify-center border font-mono text-[11px]",
              arrived.has(t.seat)
                ? "border-foreground bg-foreground text-background"
                : offline.has(t.seat)
                  ? "border-dashed border-foreground"
                  : "border-border",
            )}
          >
            {t.seat}
          </li>
        ))}
      </ol>
    </div>
  );
}

function SceneStep({
  time,
  title,
  icon,
  children,
}: {
  time: string;
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-3">
      <p className="m-0 flex items-center gap-2 font-mono text-xs tracking-widest uppercase">
        <span aria-hidden="true" className="text-foreground">
          {icon}
        </span>
        {time}
      </p>
      <h3 className="m-0 font-heading text-2xl leading-tight font-semibold">{title}</h3>
      <div className="grid gap-3 text-base text-pretty">{children}</div>
    </div>
  );
}

function OpeningScene() {
  const results = LEVY.results;
  const steps = [
    <SceneStep
      key="sealed"
      time="3 November 2026, 20:00 UTC"
      title="Voting closes. The count is sealed."
      icon={<LockKeyhole className="size-4" />}
    >
      <p className="m-0">
        Every ballot on the board is encrypted to the joint key. Our servers can add the encrypted
        ballots together, so the sealed total for each option exists at once, but nobody can read
        it. No single trustee holds a key that could.
      </p>
      <p className="m-0 font-mono text-xs tracking-wide">0 of 4 shares received</p>
    </SceneStep>,
    <SceneStep
      key="first"
      time="20:04 UTC"
      title="The first share arrives."
      icon={<Check className="size-4" />}
    >
      <p className="m-0">
        {trustee("T1").name} publishes its share of the decryption, with a proof that it used the
        key it committed to at the ceremony. Anyone can check the proof. One share on its own
        reveals nothing.
      </p>
      <p className="m-0 font-mono text-xs tracking-wide">1 of 4 shares received</p>
    </SceneStep>,
    <SceneStep
      key="three"
      time="20:09 and 20:11 UTC"
      title="Three shares. Still sealed."
      icon={<Check className="size-4" />}
    >
      <p className="m-0">
        {trustee("T2").name} and {trustee("T3").name} follow. Three shares are still below the
        threshold, and still reveal nothing about the total or any ballot.
      </p>
      <p className="m-0 font-mono text-xs tracking-wide">3 of 4 shares received</p>
    </SceneStep>,
    <SceneStep
      key="offline"
      time="20:15 UTC"
      title="Two trustees are offline. It doesn’t matter."
      icon={<WifiOff className="size-4" />}
    >
      <p className="m-0">
        {trustee("T6").name} and {trustee("T7").name} don’t answer. The scheme needs any four of the
        seven, not particular ones, so up to three can be unreachable, unwilling or compelled to
        stay silent without stopping a count.
      </p>
      <p className="m-0 font-mono text-xs tracking-wide">3 of 4 shares received, 2 offline</p>
    </SceneStep>,
    <SceneStep
      key="opened"
      time="20:17 UTC"
      title="The fourth share opens the totals, and only the totals."
      icon={<LockKeyholeOpen className="size-4" />}
    >
      <p className="m-0">
        {trustee("T4").name} publishes the fourth share. The four together decrypt the sealed totals
        for each tier, separately. They never decrypt a single ballot: individual ballots are never
        combined with the shares, so no one, us included, can read how anyone voted.
      </p>
      <dl className="m-0 grid gap-0 border-t border-foreground">
        {results.map((r) => {
          const tier = TIERS.find((t) => t.key === r.tier);
          return (
            <div
              key={r.tier}
              className="grid grid-cols-[1fr_auto] gap-4 border-b border-border py-2 text-sm"
            >
              <dt>
                {tier?.short} · {tier?.name}
              </dt>
              <dd className="m-0 font-mono">
                <Count value={r.ballots} /> ballots
              </dd>
            </div>
          );
        })}
      </dl>
      <p className="m-0 font-mono text-xs tracking-wide">4 of 4 shares received</p>
    </SceneStep>,
  ];
  return (
    <ScrollScene
      label="How a tally is opened"
      steps={steps}
      graphic={(step) => <OpeningDiagram step={step} />}
    />
  );
}

export function TrusteesPage() {
  return (
    <MockShell current="/trustees">
      <PageHead
        eyebrow="Trustees · Key ceremony of 14 September 2026"
        title="Seven trustees hold the key. Any four can open a count."
        lede="Ballots are encrypted to a key that no one holds whole. Seven independent organisations each hold a share of it. Four of them, acting together and in public, can open the totals of a poll. None of them, alone or together, can read a ballot."
      />

      <Frame className="pb-16">
        <div className="grid grid-cols-2 gap-x-6 gap-y-10 lg:grid-cols-4">
          <StatFigure value="7" label="Trustees, named and public" scope="5 jurisdictions" />
          <StatFigure value="4" label="Needed to open a count" scope="any four of the seven" />
          <StatFigure value="3" label="Can be unavailable" scope="without stopping a count" />
          <StatFigure value="0" label="Ballots any trustee can read" scope="alone or together" />
        </div>
      </Frame>

      <section aria-labelledby="register-title" className="border-t border-border py-16">
        <Frame className="grid gap-10">
          <SectionHead
            index="01"
            mark="The trustees"
            id="register-title"
            title="Who holds the shares"
          >
            <p className="m-0">
              Each trustee generated its own share at the ceremony and has never revealed it. Its
              public key is on the board and on the L2; compare the fingerprint with the one in the
              transcript below.
            </p>
          </SectionHead>
          <ol className="m-0 grid list-none border-t-2 border-foreground p-0">
            {TRUSTEE_RECORDS.map((t) => (
              <li
                key={t.seat}
                className="reveal grid grid-cols-[3rem_1fr] gap-x-4 gap-y-3 border-b border-border py-5 md:grid-cols-[3rem_minmax(0,1fr)_10rem_minmax(0,16rem)] md:items-center"
              >
                <span className="font-mono text-sm font-semibold">{t.seat}</span>
                <div className="grid gap-1">
                  <h3 className="m-0 text-lg leading-snug font-semibold">{t.name}</h3>
                  <p className="m-0 text-sm text-muted-foreground">{t.kind}</p>
                </div>
                <p className="col-start-2 m-0 text-sm md:col-start-auto">{t.jurisdiction}</p>
                <div className="col-start-2 flex min-w-0 items-center gap-3 md:col-start-auto">
                  <Fingerprint
                    value={t.publicKey}
                    label={`Fingerprint of ${t.name}'s public key ${t.publicKey.slice(0, 8)}`}
                    size={40}
                  />
                  <code className="min-w-0 font-mono text-xs tracking-wide break-all">
                    {short(t.publicKey)}
                  </code>
                </div>
              </li>
            ))}
          </ol>
        </Frame>
      </section>

      <section aria-labelledby="threshold-title" className="border-t border-border py-16">
        <Frame className="grid gap-10">
          <SectionHead
            index="02"
            mark="The threshold"
            id="threshold-title"
            title="Four of seven, in plain terms"
          />
          <ol className="m-0 grid list-none gap-0 border-t-2 border-foreground p-0 md:grid-cols-3">
            {[
              {
                n: "i",
                title: "No one can decrypt alone",
                body: "A single share is useless on its own. Neither we nor any one trustee can open a count early, or at all.",
              },
              {
                n: "ii",
                title: "Any four open the totals",
                body: "Four shares, each published with a proof, decrypt the totals for each tier. A wrong share fails its proof in public.",
              },
              {
                n: "iii",
                title: "Three can be missing",
                body: "If up to three trustees are offline, refuse, or are told to stay silent, the count still opens.",
              },
            ].map((p) => (
              <li
                key={p.n}
                className="reveal grid content-start gap-3 border-b border-border py-6 md:border-e md:border-b-0 md:px-6 md:first:ps-0 md:last:border-e-0"
              >
                <span className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
                  {p.n}
                </span>
                <h3 className="m-0 text-xl font-semibold">{p.title}</h3>
                <p className="m-0 text-base text-pretty">{p.body}</p>
              </li>
            ))}
          </ol>
        </Frame>
      </section>

      <section aria-labelledby="opening-title" className="border-t border-border pt-16">
        <Frame className="grid gap-6">
          <SectionHead
            index="03"
            mark="Opening a count"
            id="opening-title"
            title="How the Alder County levy was opened"
          >
            <p className="m-0">
              The real sequence for one poll, from the record. Scroll to follow the shares as they
              were published.
            </p>
          </SectionHead>
          <OpeningScene />
        </Frame>
      </section>

      <section aria-labelledby="ceremony-title" className="border-t border-border py-16">
        <Frame className="grid gap-10">
          <SectionHead
            index="04"
            mark="Key ceremony"
            id="ceremony-title"
            title="The transcript of 14 September 2026"
          >
            <p className="m-0">
              Every step of the ceremony is an entry on the board. The joint public key below is the
              one every ballot is encrypted to.
            </p>
          </SectionHead>

          <div className="grid gap-8 border-t-2 border-foreground pt-6 lg:grid-cols-12">
            <div className="flex items-start gap-6 lg:col-span-7">
              <Fingerprint
                value={JOINT_KEY}
                label={`Fingerprint of the joint public key ${JOINT_KEY.slice(0, 8)}`}
                size={96}
              />
              <div className="grid min-w-0 gap-3">
                <Hash value={JOINT_KEY} label="Joint public key" />
              </div>
            </div>
            <dl className="m-0 grid content-start gap-3 text-sm lg:col-span-5">
              <div className="grid gap-1">
                <dt className="font-mono text-xs tracking-wide text-muted-foreground uppercase">
                  Transcript on IPFS
                </dt>
                <dd className="m-0 font-mono text-xs break-all">{CEREMONY_CID}</dd>
              </div>
              <div className="grid gap-1">
                <dt className="font-mono text-xs tracking-wide text-muted-foreground uppercase">
                  Recorded on the L2
                </dt>
                <dd className="m-0 font-mono text-xs break-all">{CEREMONY_ANCHOR_TX}</dd>
              </div>
            </dl>
          </div>

          <ol
            aria-label="Ceremony transcript entries"
            className="m-0 grid list-none border-t border-foreground p-0"
          >
            {CEREMONY.map((e) => (
              <li
                key={e.entry}
                className="reveal grid grid-cols-[3rem_1fr] gap-x-4 gap-y-2 border-b border-border py-4 md:grid-cols-[3rem_8rem_minmax(0,1fr)_minmax(0,18rem)] md:items-center"
              >
                <span className="font-mono text-sm tabular-nums">
                  {String(e.entry).padStart(2, "0")}
                </span>
                <span className="font-mono text-xs tracking-wide md:order-none">{e.time}</span>
                <div className="col-start-2 grid gap-0.5 md:col-start-auto">
                  <p className="m-0 font-semibold">
                    {e.event}
                    {e.seat === undefined ? null : (
                      <span className="ms-2 font-mono text-xs font-normal">{e.seat}</span>
                    )}
                  </p>
                  <p className="m-0 text-sm text-muted-foreground">{e.detail}</p>
                </div>
                {e.hash === undefined ? (
                  <span className="hidden md:block" />
                ) : (
                  <div className="col-start-2 flex min-w-0 items-center gap-3 md:col-start-auto">
                    <Fingerprint
                      value={e.hash}
                      label={`Fingerprint of entry ${e.entry}, ${e.hash.slice(0, 8)}`}
                      size={28}
                    />
                    <code className="min-w-0 font-mono text-xs break-all">{short(e.hash)}</code>
                  </div>
                )}
              </li>
            ))}
          </ol>
        </Frame>
      </section>

      <section aria-labelledby="jurisdictions-title" className="border-t border-border py-16">
        <Frame className="grid gap-10">
          <SectionHead
            index="05"
            mark="Jurisdictions"
            id="jurisdictions-title"
            title="No single court can reach four"
          >
            <p className="m-0">
              The trustees sit in five countries. The most in any one is three, below the threshold,
              so no single government can compel a count to open, or to stay shut.
            </p>
          </SectionHead>
          <figure className="m-0 grid gap-4" aria-labelledby="jurisdictions-caption">
            <figcaption
              id="jurisdictions-caption"
              className="font-mono text-xs tracking-wide text-muted-foreground uppercase"
            >
              Trustees per country, of 7. The rule marks the threshold of 4.
            </figcaption>
            <ol className="m-0 grid list-none border-t-2 border-foreground p-0">
              {JURISDICTIONS.map((j) => (
                <li
                  key={j.name}
                  className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 border-b border-border py-4 sm:grid-cols-[minmax(8rem,14rem)_1fr_3rem]"
                >
                  <div className="grid gap-0.5">
                    <span className="font-semibold">{j.name}</span>
                    <span className="text-sm text-muted-foreground">{j.legal}</span>
                  </div>
                  <div
                    aria-hidden="true"
                    className="relative col-span-2 row-start-2 grid grid-cols-7 gap-1 sm:col-span-1 sm:row-start-auto"
                  >
                    {TRUSTEE_RECORDS.map((t, i) => (
                      <span
                        key={t.seat}
                        className={cn(
                          "draw-x flex h-7 items-center justify-center font-mono text-[10px]",
                          i < j.seats.length
                            ? "bg-foreground text-background"
                            : "border border-border",
                        )}
                      >
                        {i < j.seats.length ? j.seats[i] : ""}
                      </span>
                    ))}
                    <span className="pointer-events-none absolute inset-y-[-6px] start-[calc(4/7*100%-2px)] w-0.5 bg-primary" />
                  </div>
                  <span className="text-end font-mono text-sm tabular-nums">
                    {j.seats.length} of 7
                  </span>
                </li>
              ))}
            </ol>
          </figure>
        </Frame>
      </section>
    </MockShell>
  );
}
