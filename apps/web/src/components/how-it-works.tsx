import { buttonVariants, cn, ScrollScene, SectionMark, useTranslate } from "@abolishus/ui";
import type { ComponentType } from "react";

import { catalogs, type Messages } from "../messages.ts";
import {
  ChallengeDiagram,
  CountedDiagram,
  RecordedDiagram,
  SEATS,
  SecrecyDiagram,
  SurvivesDiagram,
  THRESHOLD,
  TiersDiagram,
} from "./how-it-works-diagrams.tsx";

type Key = keyof Messages;

// Every claim here is checked against docs/spec and docs/adr as they stand;
// anything not yet built says "planned" (docs/status/P2-19.md, part 3). The
// launch panel's wording follows [[0027-trustee-panels-and-live-results]],
// Part 3: every page says that, for now, ballots are not secret from us.

interface Chapter {
  id: string;
  mark: Key;
  title: Key;
  intro: Key;
  steps: readonly (readonly [Key, Key])[];
  Diagram: ComponentType<{ step: number; total: number }>;
}

const CHAPTERS: readonly Chapter[] = [
  {
    id: "tiers",
    mark: "howTiersMark",
    title: "howTiersTitle",
    intro: "howTiersIntro",
    steps: [
      ["howTiers1Title", "howTiers1Body"],
      ["howTiers2Title", "howTiers2Body"],
      ["howTiers3Title", "howTiers3Body"],
      ["howTiers4Title", "howTiers4Body"],
    ],
    Diagram: TiersDiagram,
  },
  {
    id: "secrecy",
    mark: "howSecrecyMark",
    title: "howSecrecyTitle",
    intro: "howSecrecyIntro",
    steps: [
      ["howSecrecy1Title", "howSecrecy1Body"],
      ["howSecrecy2Title", "howSecrecy2Body"],
      ["howSecrecy3Title", "howSecrecy3Body"],
      ["howSecrecy4Title", "howSecrecy4Body"],
    ],
    Diagram: SecrecyDiagram,
  },
  {
    id: "cast-as-intended",
    mark: "howChallengeMark",
    title: "howChallengeTitle",
    intro: "howChallengeIntro",
    steps: [
      ["howChallenge1Title", "howChallenge1Body"],
      ["howChallenge2Title", "howChallenge2Body"],
      ["howChallenge3Title", "howChallenge3Body"],
      ["howChallenge4Title", "howChallenge4Body"],
    ],
    Diagram: ChallengeDiagram,
  },
  {
    id: "recorded-as-cast",
    mark: "howRecordedMark",
    title: "howRecordedTitle",
    intro: "howRecordedIntro",
    steps: [
      ["howRecorded1Title", "howRecorded1Body"],
      ["howRecorded2Title", "howRecorded2Body"],
      ["howRecorded3Title", "howRecorded3Body"],
      ["howRecorded4Title", "howRecorded4Body"],
    ],
    Diagram: RecordedDiagram,
  },
  {
    id: "counted-as-recorded",
    mark: "howCountedMark",
    title: "howCountedTitle",
    intro: "howCountedIntro",
    steps: [
      ["howCounted1Title", "howCounted1Body"],
      ["howCounted2Title", "howCounted2Body"],
      ["howCounted3Title", "howCounted3Body"],
      ["howCounted4Title", "howCounted4Body"],
    ],
    Diagram: CountedDiagram,
  },
  {
    id: "takedown",
    mark: "howSurvivesMark",
    title: "howSurvivesTitle",
    intro: "howSurvivesIntro",
    steps: [
      ["howSurvives1Title", "howSurvives1Body"],
      ["howSurvives2Title", "howSurvives2Body"],
      ["howSurvives3Title", "howSurvives3Body"],
      ["howSurvives4Title", "howSurvives4Body"],
    ],
    Diagram: SurvivesDiagram,
  },
];

/** The known limits, each with the threat entries that describe it (docs/threats/). */
const WEAK_POINTS = [
  { id: "Panel", threats: ["T-14", "T-11", "T-69"] },
  { id: "Sybil", threats: ["T-01"] },
  { id: "Documents", threats: ["T-03"] },
  { id: "Watch", threats: ["T-45", "T-46"] },
  { id: "Collude", threats: ["T-14"] },
  { id: "Device", threats: ["T-42", "T-44"] },
  { id: "Anchor", threats: ["T-23", "T-26"] },
  { id: "Network", threats: ["T-11"] },
  { id: "Turnout", threats: [] },
] as const satisfies readonly { id: string; threats: readonly string[] }[];

const WEAK_ID = "weak-points";

const pad2 = (n: number) => String(n).padStart(2, "0");

const heading =
  "m-0 font-heading text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-5xl lg:col-span-7";

function ChapterSection({ chapter, index }: { chapter: Chapter; index: number }) {
  const t = useTranslate(catalogs);
  const params = { threshold: THRESHOLD, seats: SEATS };
  const { Diagram } = chapter;
  const total = chapter.steps.length;
  return (
    <section
      id={chapter.id}
      aria-labelledby={`${chapter.id}-title`}
      className="grid scroll-mt-4 gap-10 border-t border-border pt-16"
    >
      <SectionMark index={pad2(index + 1)}>{t(chapter.mark)}</SectionMark>
      <div className="grid gap-6 lg:grid-cols-12 lg:gap-x-6">
        <h2 id={`${chapter.id}-title`} className={heading}>
          {t(chapter.title)}
        </h2>
        <p className="m-0 max-w-prose text-lg text-pretty lg:col-span-5">{t(chapter.intro)}</p>
      </div>
      <ScrollScene
        label={t("howSceneLabel", { section: t(chapter.mark) })}
        side={index % 2 === 0 ? "end" : "start"}
        steps={chapter.steps.map(([title, body], i) => (
          <div key={title} className="grid gap-3">
            <p className="m-0 font-mono text-xs tracking-widest text-muted-foreground uppercase tabular-nums">
              {t("howStep", { step: pad2(i + 1) })}
            </p>
            <h3 className="m-0 font-heading text-2xl leading-tight font-semibold">
              {t(title, params)}
            </h3>
            <p className="m-0 text-base text-pretty">{t(body, params)}</p>
          </div>
        ))}
        graphic={(step) => <Diagram step={step} total={total} />}
      />
    </section>
  );
}

function WeakPoints() {
  const t = useTranslate(catalogs);
  const index = CHAPTERS.length + 1;
  return (
    <section
      id={WEAK_ID}
      aria-labelledby={`${WEAK_ID}-title`}
      className="grid scroll-mt-4 gap-10 border-t border-border pt-16"
    >
      <SectionMark index={pad2(index)}>{t("howWeakMark")}</SectionMark>
      <div className="grid gap-6 lg:grid-cols-12 lg:gap-x-6">
        <h2 id={`${WEAK_ID}-title`} className={heading}>
          {t("howWeakTitle")}
        </h2>
        <p className="m-0 max-w-prose text-lg text-pretty lg:col-span-5">{t("howWeakIntro")}</p>
      </div>
      <ol className="m-0 grid list-none border-t-2 border-foreground p-0">
        {WEAK_POINTS.map((w, i) => (
          <li
            key={w.id}
            className="grid gap-3 border-b border-border py-6 lg:grid-cols-12 lg:gap-x-6"
          >
            <div className="grid content-start gap-2 lg:col-span-4">
              <h3 className="m-0 flex gap-3 font-heading text-xl leading-snug font-semibold">
                <span className="font-mono text-sm font-normal text-muted-foreground tabular-nums">
                  {index}.{i + 1}
                </span>
                {t(`howWeak${w.id}Title`)}
              </h3>
              {w.threats.length === 0 ? null : (
                <p className="m-0 font-mono text-xs text-muted-foreground">
                  <span className="sr-only">{t("howWeakThreats")} </span>
                  {w.threats.join(", ")}
                </p>
              )}
            </div>
            <p className="m-0 text-base lg:col-span-4">{t(`howWeak${w.id}Means`)}</p>
            <p className="m-0 text-base text-muted-foreground lg:col-span-4">
              <span className="sr-only">{t("howWeakLimit")} </span>
              {t(`howWeak${w.id}Limit`)}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Contents() {
  const t = useTranslate(catalogs);
  const entries = [
    ...CHAPTERS.map((c) => ({ id: c.id, mark: c.mark })),
    { id: WEAK_ID, mark: "howWeakMark" as const },
  ];
  return (
    <nav aria-label={t("howContents")} className="border-t-2 border-foreground pt-4">
      <ol className="m-0 grid list-none gap-x-6 p-0 sm:grid-cols-2 lg:grid-cols-4">
        {entries.map((e, i) => (
          <li key={e.id} className="border-b border-border">
            <a
              href={`#${e.id}`}
              className="flex min-h-12 items-baseline gap-3 py-3 text-sm underline-offset-4 hover:underline"
            >
              <span className="font-mono text-xs text-muted-foreground tabular-nums">
                {pad2(i + 1)}
              </span>
              {t(e.mark)}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** `/how-it-works`: the long-form explainer, one sticky diagram per chapter. */
export function HowItWorks() {
  const t = useTranslate(catalogs);
  return (
    <div className="grid gap-16">
      <header className="grid gap-8 pt-2 md:pt-10">
        <p className="m-0 font-mono text-xs tracking-widest text-muted-foreground uppercase">
          {t("howEyebrow", { count: CHAPTERS.length + 1 })}
        </p>
        <h1 className="m-0 max-w-5xl font-heading text-5xl leading-none font-semibold tracking-tight text-balance sm:text-7xl">
          {t("howTitle")}
        </h1>
        <p className="m-0 max-w-prose text-xl text-pretty">{t("howLede")}</p>
        <Contents />
      </header>
      {CHAPTERS.map((chapter, i) => (
        <ChapterSection key={chapter.id} chapter={chapter} index={i} />
      ))}
      <WeakPoints />
      <div className="grid justify-items-start gap-6 border-t border-border pt-16">
        {/* The verify page says first what the verifier can't find yet
            (P4-1), so the link promises the how, not a result. It wraps:
            the Spanish words outgrow a phone's width with the text doubled. */}
        <a
          href="/verify"
          className={cn(buttonVariants({ size: "lg" }), "h-auto min-h-14 py-3 whitespace-normal")}
        >
          {t("howVerify")}
        </a>
        {/* Text, not a link: pages link only to this site (tests/ssr.test.ts). */}
        <p className="m-0 max-w-prose text-lg text-pretty">{t("howSource")}</p>
      </div>
    </div>
  );
}
