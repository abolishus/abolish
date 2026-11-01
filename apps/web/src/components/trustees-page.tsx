import { StatFigure, useTranslate } from "@abolishus/ui";

import { catalogs, type Messages } from "../messages.ts";
import { SEATS, THRESHOLD } from "./how-it-works-diagrams.tsx";
import { PageHeader, Section } from "./page-parts.tsx";

type Key = keyof Messages;

// `/trustees`, from the `trustees-page.tsx` mockup, on what is true today:
// the launch panel of [[0027-trustee-panels-and-live-results]], Part 3, all
// of whose seats are ours (T-14). The mockup's named trustees, jurisdictions,
// key ceremony transcript and sample opening wait on independent trustees
// ([[P1-7]]), so the page says that rather than showing invented ones
// (docs/status/P2-19.md, part 55). The panel's shape and its label are tied
// to the ADR in tests/trustees-page.test.ts.

const FIGURES = [
  { value: SEATS, label: "keysFigureSeats", scope: "keysFigureSeatsScope" },
  { value: THRESHOLD, label: "keysFigureThreshold", scope: "keysFigureThresholdScope" },
  { value: 0, label: "keysFigureAlone", scope: "keysFigureAloneScope" },
  { value: 0, label: "keysFigureOthers", scope: "keysFigureOthersScope" },
] as const satisfies readonly { value: number; label: Key; scope: Key }[];

/** What the threshold means, in the order a reader needs it: alone, enough, and the same enough. */
const SEAT_POINTS = [1, 2, 3] as const;

/** What every seat being ours exposes (the ADR's "What that exposes"; T-14, T-11, T-69). */
const OURS = ["Could", "Shows", "Compel", "Polls"] as const;

/** The ADR's rules 3, 4 and 1, each with what can be checked of it. */
const PROMISES = [1, 2, 3] as const;

/** The handover, author panels ([[P2-16]]) and named trustees ([[P1-7]]). */
const NEXT = [1, 2, 3] as const;

export const SECTIONS = [
  { id: "seats", mark: "keysSeatsMark" },
  { id: "ours", mark: "keysOursMark" },
  { id: "promises", mark: "keysPromiseMark" },
  { id: "next", mark: "keysNextMark" },
] as const satisfies readonly { id: string; mark: Key }[];

const pad2 = (n: number) => String(n).padStart(2, "0");

function Contents() {
  const t = useTranslate(catalogs);
  return (
    <nav aria-label={t("howContents")} className="border-t-2 border-foreground pt-4">
      <ol className="m-0 grid list-none gap-x-6 p-0 sm:grid-cols-2 lg:grid-cols-4">
        {SECTIONS.map((s, i) => (
          <li key={s.id} className="border-b border-border">
            <a
              href={`#${s.id}`}
              className="flex min-h-12 items-baseline gap-3 py-3 text-sm underline-offset-4 hover:underline"
            >
              <span className="font-mono text-xs text-muted-foreground tabular-nums">
                {pad2(i + 1)}
              </span>
              {t(s.mark)}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function Seats() {
  const t = useTranslate(catalogs);
  const params = { threshold: THRESHOLD, seats: SEATS, fewer: THRESHOLD - 1 };
  return (
    <Section
      id="seats"
      index="01"
      mark={t("keysSeatsMark")}
      title={t("keysSeatsTitle", params)}
      lede={t("keysSeatsLede")}
    >
      <ol className="m-0 grid list-none border-t-2 border-foreground p-0 md:grid-cols-3 md:gap-x-6">
        {SEAT_POINTS.map((n) => (
          <li key={n} className="grid content-start gap-2 border-b border-border py-6">
            <h3 className="m-0 flex gap-3 font-heading text-xl leading-snug font-semibold">
              <span className="font-mono text-sm font-normal text-muted-foreground tabular-nums">
                {n}
              </span>
              {t(`keysSeat${n}Title`, params)}
            </h3>
            <p className="m-0 text-base text-pretty">{t(`keysSeat${n}Body`, params)}</p>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function Ours() {
  const t = useTranslate(catalogs);
  return (
    <Section
      id="ours"
      index="02"
      mark={t("keysOursMark")}
      title={t("keysOursTitle")}
      lede={t("keysOursLede")}
    >
      <dl className="m-0 grid border-t-2 border-foreground">
        {OURS.map((id) => (
          <div
            key={id}
            className="grid gap-2 border-b border-border py-5 md:grid-cols-12 md:gap-x-6"
          >
            <dt className="font-heading text-lg font-semibold md:col-span-4">
              {t(`keysOurs${id}`)}
            </dt>
            <dd className="m-0 text-base text-pretty md:col-span-8">{t(`keysOurs${id}Means`)}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function Promises() {
  const t = useTranslate(catalogs);
  return (
    <Section
      id="promises"
      index="03"
      mark={t("keysPromiseMark")}
      title={t("keysPromiseTitle")}
      lede={t("keysPromiseLede")}
    >
      <ol className="m-0 grid list-none border-t-2 border-foreground p-0 md:grid-cols-3 md:gap-x-6">
        {PROMISES.map((n) => (
          <li key={n} className="grid content-start gap-3 border-b border-border py-6">
            <h3 className="m-0 font-heading text-xl leading-snug font-semibold">
              {t(`keysPromise${n}Title`)}
            </h3>
            <p className="m-0 text-base text-pretty">
              {t(`keysPromise${n}Body`, { threshold: THRESHOLD })}
            </p>
            {/* What can be checked sits apart from the promise, so neither
                reads as the other ([[language]], Show your work). */}
            <p className="m-0 border-s-2 border-border ps-3 text-sm text-pretty text-muted-foreground">
              {t(`keysPromise${n}Check`)}
            </p>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function Next() {
  const t = useTranslate(catalogs);
  return (
    <Section
      id="next"
      index="04"
      mark={t("keysNextMark")}
      title={t("keysNextTitle")}
      lede={t("keysNextLede")}
    >
      <dl className="m-0 grid border-t-2 border-foreground">
        {NEXT.map((n) => (
          <div
            key={n}
            className="grid gap-2 border-b border-border py-5 md:grid-cols-12 md:gap-x-6"
          >
            <dt className="font-heading text-lg font-semibold md:col-span-4">
              {t(`keysNext${n}Title`)}
            </dt>
            <dd className="m-0 text-base text-pretty md:col-span-8">{t(`keysNext${n}Body`)}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

/** `/trustees`: who holds the keys during launch, what that exposes, what we promise and what ends it. */
export function TrusteesPage() {
  const t = useTranslate(catalogs);
  return (
    <div className="grid gap-16">
      <PageHeader eyebrow={t("keysEyebrow")} title={t("keysTitle")} lede={t("keysLede")}>
        <div className="grid grid-cols-2 gap-x-6 gap-y-10 lg:grid-cols-4">
          {/* Still: on a phone the figures straddle the first screen's edge,
              where the scroll reveal left the lower ones faint, below
              WCAG's contrast (axe, tests/a11y.e2e.ts). */}
          {FIGURES.map((f) => (
            <StatFigure
              className="animate-none"
              key={f.label}
              value={String(f.value)}
              label={t(f.label)}
              scope={t(f.scope, { threshold: THRESHOLD, seats: SEATS })}
            />
          ))}
        </div>
        <Contents />
      </PageHeader>
      <Seats />
      <Ours />
      <Promises />
      <Next />
      <div className="grid max-w-prose gap-3 border-t border-border pt-16 text-lg">
        <p className="m-0 text-pretty">{t("keysMore")}</p>
        <ul className="m-0 grid list-none gap-2 p-0">
          <li>
            <a className="underline underline-offset-4" href="/how-it-works#weak-points">
              {t("keysMoreWeak")}
            </a>
          </li>
          <li>
            <a className="underline underline-offset-4" href="/verify">
              {t("navVerify")}
            </a>
          </li>
        </ul>
      </div>
    </div>
  );
}
