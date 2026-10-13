import { buttonVariants, ScrollScene, SectionMark } from "@abolishus/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { expect, waitFor, within } from "storybook/test";

import { LEVY, TRUSTEES } from "./fixtures.ts";
import { pad2, THRESHOLD } from "./home-parts.tsx";
import {
  CHALLENGE_STEPS,
  ChallengeDiagram,
  type ChapterStep,
  COUNTED_STEPS,
  CountedDiagram,
  RECORDED_STEPS,
  RecordedDiagram,
  SECRECY_STEPS,
  SecrecyDiagram,
  SURVIVES_STEPS,
  SurvivesDiagram,
  TIER_STEPS,
  TiersDiagram,
} from "./how-it-works-diagrams.tsx";
import { Frame, MockShell, PageHead } from "./shell.tsx";

interface Chapter {
  id: string;
  mark: string;
  title: string;
  intro: ReactNode;
  scene: string;
  steps: ChapterStep[];
  graphic: (step: number, progress: number) => ReactNode;
}

const CHAPTERS: Chapter[] = [
  {
    id: "tiers",
    mark: "Identity tiers",
    title: "Who is counted, and how sure we are",
    intro: (
      <>
        Abolish can’t check everyone the same way, so it says how each voter was checked and reports
        every result once per tier. The tiers are never added together.
      </>
    ),
    scene: "Identity tiers, step by step",
    steps: TIER_STEPS,
    graphic: (step) => <TiersDiagram step={step} />,
  },
  {
    id: "secrecy",
    mark: "Ballot secrecy",
    title: "Your choice never leaves your phone",
    intro: (
      <>
        Secrecy doesn’t rest on our servers behaving. The ballot is sealed on the device that shows
        it to you, before any network is involved.
      </>
    ),
    scene: "Ballot secrecy, step by step",
    steps: SECRECY_STEPS,
    graphic: (step) => <SecrecyDiagram step={step} />,
  },
  {
    id: "cast-as-intended",
    mark: "Cast as intended",
    title: "Checking the phone sealed what you chose",
    intro: (
      <>
        Encryption hides the choice from everyone, including you. A challenge lets you open a ballot
        and see what the phone really sealed, at the cost of that one ballot.
      </>
    ),
    scene: "Cast as intended, step by step",
    steps: CHALLENGE_STEPS,
    graphic: (step) => <ChallengeDiagram step={step} />,
  },
  {
    id: "recorded-as-cast",
    mark: "Recorded as cast",
    title: "Finding your ballot on the board",
    intro: (
      <>
        The board is public and append-only. Your receipt names the entry that holds your sealed
        ballot, and the fingerprint lets you compare the two at a glance.
      </>
    ),
    scene: "Recorded as cast, step by step",
    steps: RECORDED_STEPS,
    graphic: (step) => <RecordedDiagram step={step} />,
  },
  {
    id: "counted-as-recorded",
    mark: "Counted as recorded",
    title: `Counting without opening a ballot, ${THRESHOLD} of ${TRUSTEES.length}`,
    intro: (
      <>
        The count is arithmetic on sealed ballots, and the only secret involved is split between
        independent trustees. Every step of it publishes a proof.
      </>
    ),
    scene: "Counted as recorded, step by step",
    steps: COUNTED_STEPS,
    graphic: (step, progress) => <CountedDiagram step={step} progress={progress} />,
  },
  {
    id: "takedown",
    mark: "If abolish.us is taken down",
    title: "What survives without us",
    intro: (
      <>
        A record that disappears with its publisher isn’t much of a record. Voting, the board and
        the count are built to outlast our domain, our servers and us.
      </>
    ),
    scene: "What survives a takedown, step by step",
    steps: SURVIVES_STEPS,
    graphic: (step) => <SurvivesDiagram step={step} />,
  },
];

const WEAK_POINTS = [
  {
    title: "Tier 0 can be faked at scale",
    means:
      "Anyone can open many passkey accounts. Tier 0 results describe what accounts said, not what people think.",
    limit: "It is always reported on its own and labelled as such, never blended into a total.",
  },
  {
    title: "Someone can watch you vote",
    means:
      "A receipt proves inclusion, not choice, so it can’t be sold as proof of a vote. But nothing stops a person standing over the screen.",
    limit: "Open. This version has no protection against coercion in the room.",
  },
  {
    title: "Trustees could collude",
    means: `Any ${THRESHOLD} trustees acting together could decrypt single ballots, not only totals.`,
    limit: `The ${TRUSTEES.length} trustees are named, independent organisations in five countries, and every share they release is public and proved.`,
  },
  {
    title: "A compromised phone",
    means: "Malware on the voter’s device could change a choice before it is sealed.",
    limit:
      "Challenges catch a cheating client, but only if people use them. Most voters won’t, so the protection is statistical.",
  },
  {
    title: "The hour before an anchor",
    means:
      "Between anchors, new entries live only on our board and its mirrors. An entry could be dropped before the next anchor fixes the board.",
    limit:
      "Voters keep their receipts. A receipt missing from the next anchored board is evidence anyone can publish.",
  },
  {
    title: "Turnout is self-selected",
    means:
      "Voters choose to take part, so a result describes who voted, not the population. Results are advisory and bind no one.",
    limit: "Every result carries its scope and its turnout against the eligible group.",
  },
  {
    title: "Documents exclude people",
    means:
      "Tier 2 needs a passport or licence with a readable chip. Many eligible people don’t have one.",
    limit: "Vouching (Tier 1) exists for them, and each tier’s result is shown in full.",
  },
];

function ChapterStepBlock({ index, step }: { index: number; step: ChapterStep }) {
  return (
    <div className="grid gap-3">
      <p className="m-0 font-mono text-xs tracking-widest text-muted-foreground uppercase tabular-nums">
        Step {pad2(index + 1)}
      </p>
      <h3 className="m-0 font-heading text-2xl leading-tight font-semibold">{step.title}</h3>
      <p className="m-0 text-base text-pretty">{step.body}</p>
    </div>
  );
}

function ChapterSection({ chapter, index }: { chapter: Chapter; index: number }) {
  return (
    <section
      id={chapter.id}
      aria-labelledby={`${chapter.id}-title`}
      className="scroll-mt-4 border-t border-border pt-16"
    >
      <Frame className="grid gap-10">
        <SectionMark index={pad2(index + 1)}>{chapter.mark}</SectionMark>
        <div className="grid gap-6 lg:grid-cols-12 lg:gap-x-6">
          <h2
            id={`${chapter.id}-title`}
            className="m-0 font-heading text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-5xl lg:col-span-7"
          >
            {chapter.title}
          </h2>
          <p className="m-0 max-w-prose text-lg text-pretty lg:col-span-5">{chapter.intro}</p>
        </div>
        <ScrollScene
          label={chapter.scene}
          side={index % 2 === 0 ? "end" : "start"}
          steps={chapter.steps.map((step, i) => (
            <ChapterStepBlock key={step.title} index={i} step={step} />
          ))}
          graphic={chapter.graphic}
        />
      </Frame>
    </section>
  );
}

function WeakPoints() {
  const index = CHAPTERS.length + 1;
  return (
    <section
      id="weak-points"
      aria-labelledby="weak-points-title"
      className="scroll-mt-4 border-t border-border pt-16"
    >
      <Frame className="grid gap-10">
        <SectionMark index={pad2(index)}>What remains open</SectionMark>
        <div className="grid gap-6 lg:grid-cols-12 lg:gap-x-6">
          <h2
            id="weak-points-title"
            className="m-0 font-heading text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-5xl lg:col-span-7"
          >
            Where it is weak, stated plainly
          </h2>
          <p className="m-0 max-w-prose text-lg text-pretty lg:col-span-5">
            No voting system is safe against everything. These are the limits we know of today. Each
            has a public threat entry, and this list changes as they do.
          </p>
        </div>
        <ol className="m-0 grid list-none border-t-2 border-foreground p-0">
          {WEAK_POINTS.map((w, i) => (
            <li
              key={w.title}
              className="grid gap-3 border-b border-border py-6 lg:grid-cols-12 lg:gap-x-6"
            >
              <h3 className="m-0 flex gap-3 font-heading text-xl leading-snug font-semibold lg:col-span-4">
                <span className="font-mono text-sm font-normal text-muted-foreground tabular-nums">
                  {index}.{i + 1}
                </span>
                {w.title}
              </h3>
              <p className="m-0 text-base lg:col-span-4">{w.means}</p>
              <p className="m-0 text-base text-muted-foreground lg:col-span-4">
                <span className="sr-only">What limits it: </span>
                {w.limit}
              </p>
            </li>
          ))}
        </ol>
      </Frame>
    </section>
  );
}

function Contents() {
  const entries = [
    ...CHAPTERS.map((c) => ({ id: c.id, mark: c.mark })),
    { id: "weak-points", mark: "What remains open" },
  ];
  return (
    <nav aria-label="On this page" className="border-t-2 border-foreground pt-4">
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
              {e.mark}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function HowItWorksPage() {
  return (
    <MockShell current="/how-it-works">
      <PageHead
        eyebrow="How it works · 7 sections · about 12 minutes"
        title="How a ballot stays secret, gets recorded and is counted in public"
        lede={
          <>
            Abolish is built so that you don’t have to trust it. This page follows the {LEVY.title}{" "}
            through every stage, says what each step proves and what it doesn’t, and ends with the
            weaknesses we haven’t solved.
          </>
        }
      >
        <Contents />
      </PageHead>
      {CHAPTERS.map((chapter, i) => (
        <ChapterSection key={chapter.id} chapter={chapter} index={i} />
      ))}
      <WeakPoints />
      <Frame className="flex flex-wrap gap-3 pt-16">
        <a href="/verify" className={buttonVariants({ size: "lg" })}>
          Verify a result yourself
        </a>
        <a
          href="https://github.com/abolishus/abolish"
          className={buttonVariants({ size: "lg", variant: "outline" })}
        >
          Read the protocol and source
        </a>
      </Frame>
    </MockShell>
  );
}

const meta = {
  title: "Mockups/Web/How it works",
  component: HowItWorksPage,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof HowItWorksPage>;

export default meta;
type Story = StoryObj<typeof meta>;

function sceneSteps(canvasElement: HTMLElement, name: string) {
  const scene = within(canvasElement).getByRole("region", { name });
  return [...scene.querySelectorAll<HTMLElement>(":scope > ol > li")];
}

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "How a ballot stays secret, gets recorded and is counted in public",
    );
    const main = canvas.getByRole("main");
    const sections = within(main).getAllByRole("heading", { level: 2 });
    await expect(sections.map((h) => h.textContent)).toEqual([
      ...CHAPTERS.map((c) => c.title),
      "Where it is weak, stated plainly",
    ]);
    await expect(
      within(canvas.getByRole("navigation", { name: "On this page" })).getAllByRole("link"),
    ).toHaveLength(7);

    // The count's diagram redraws as each step reaches the middle of the viewport.
    const counted = () => canvas.getByTestId("diagram-counted");
    await expect(counted()).toHaveAttribute("data-step", "0");
    await expect(within(counted()).queryByTestId("share-count")).toBeNull();
    const steps = sceneSteps(canvasElement, "Counted as recorded, step by step");
    steps[3]!.scrollIntoView({ block: "center" });
    await waitFor(() => expect(counted()).toHaveAttribute("data-step", "3"));
    await expect(within(counted()).getByTestId("share-count")).toHaveTextContent(
      `${THRESHOLD} of ${THRESHOLD} shares needed`,
    );
    await expect(within(counted()).getByText("Yes 23,425")).toBeVisible();
  },
};

export const Dark: Story = {
  parameters: { layout: "fullscreen", theme: "dark" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toBeVisible();
    // A mismatched receipt draws a different glyph and says so in words.
    const steps = sceneSteps(canvasElement, "Recorded as cast, step by step");
    steps[2]!.scrollIntoView({ block: "center" });
    await waitFor(() => expect(canvas.getByTestId("comparison")).toHaveTextContent("Same glyph"));
    steps[3]!.scrollIntoView({ block: "center" });
    await waitFor(() =>
      expect(canvas.getByTestId("comparison")).toHaveTextContent("Different glyph: report it"),
    );
    // When abolish.us and then our servers go, the public layers stay up.
    const takedown = sceneSteps(canvasElement, "What survives a takedown, step by step");
    takedown[3]!.scrollIntoView({ block: "center" });
    await waitFor(() =>
      expect(canvas.getByTestId("diagram-survives")).toHaveAttribute("data-step", "3"),
    );
    const survives = canvas.getByTestId("diagram-survives");
    await expect(survives.querySelectorAll("[data-down]")).toHaveLength(5);
    await expect(within(survives).getByText("Ethereum")).toBeVisible();
  },
};
