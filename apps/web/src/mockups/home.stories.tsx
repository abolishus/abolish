import {
  buttonVariants,
  cn,
  Count,
  Fingerprint,
  ReceiptStub,
  ScrollScene,
  SectionMark,
  StatFigure,
} from "@abolishus/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArrowRight, CalendarClock, CircleCheck, CircleDot, Hourglass } from "lucide-react";
import { expect, waitFor, within } from "storybook/test";

import {
  COUNCIL,
  type Election,
  ELECTIONS,
  ENTRY_POINTS,
  LEVY,
  PARKS,
  RECEIPT,
  TRUSTEES,
} from "./fixtures.ts";
import { JOURNEY, JourneyGraphic, JourneyStep } from "./home-journey.tsx";
import { fmt, LEDGER, LEVY_TIERS, MiniRow, shortHex, spacedHex, TierSplit } from "./home-parts.tsx";
import { TiersSection } from "./home-tiers.tsx";
import { Frame, MockShell } from "./shell.tsx";

const AS_OF = "12 November 2026, 15:00 UTC";
const COUNTRIES = new Set(TRUSTEES.map((t) => t.jurisdiction)).size;

function Hero() {
  const entries = LEVY.entries + PARKS.entries + COUNCIL.entries;
  const tier2 = LEVY_TIERS[0]!;
  return (
    <section aria-labelledby="home-title">
      <Frame className="grid gap-12 pt-12 pb-16 md:pt-20 lg:grid-cols-12 lg:gap-x-6">
        <div className="grid content-start gap-8 lg:col-span-7">
          <p className="m-0 font-mono text-xs tracking-widest text-muted-foreground uppercase">
            Non-binding · Citizen-run · Publicly auditable
          </p>
          <h1
            id="home-title"
            className="m-0 font-heading text-5xl leading-[0.98] font-semibold tracking-tight text-balance sm:text-7xl"
          >
            A public vote that anyone can recount.
          </h1>
          <p className="m-0 max-w-prose text-lg text-pretty">
            Abolish holds advisory votes on public questions. Every ballot is encrypted on the
            voter’s own device, posted to a public board and anchored to Ethereum, so the count can
            be checked by anyone, including the people who disagree with it.
          </p>
          <div className="flex flex-wrap gap-3">
            <a href="#open-now" className={buttonVariants({ size: "lg" })}>
              See open polls
            </a>
            <a href="/how-it-works" className={buttonVariants({ size: "lg", variant: "outline" })}>
              How it works
            </a>
          </div>
        </div>
        <article
          aria-labelledby="latest-kicker latest-title"
          className="grid content-start gap-5 border border-foreground p-5 sm:p-6 lg:col-span-5"
        >
          <header className="grid gap-2">
            <p className="m-0 flex items-center justify-between gap-4 font-mono text-xs tracking-wide text-muted-foreground uppercase">
              <span id="latest-kicker">Latest count</span>
              <span>Closed 3 Nov, 20:00 UTC</span>
            </p>
            <h2 id="latest-title" className="m-0 font-heading text-2xl leading-tight font-semibold">
              {LEVY.title}
            </h2>
            <p className="m-0 text-sm text-muted-foreground">{LEVY.question}</p>
          </header>
          <div className="grid gap-5 border-t-2 border-foreground pt-4">
            {LEVY_TIERS.map((tier) => (
              <TierSplit key={tier.info.key} tier={tier} />
            ))}
          </div>
          <p className="m-0 border-t border-border pt-4 text-sm">
            Each tier is counted and reported on its own. They are never added together.
          </p>
          <footer className="flex items-center gap-3">
            <Fingerprint
              value={LEVY.definitionHash}
              label={`Fingerprint of the poll definition ${LEVY.definitionHash.slice(0, 8)}`}
              size={36}
            />
            <p className="m-0 min-w-0 flex-1 font-mono text-xs text-muted-foreground">
              definition {shortHex(LEVY.definitionHash)}
            </p>
            <a
              href={`/polls/${LEVY.slug}`}
              className="inline-flex min-h-12 items-center gap-1 text-sm underline underline-offset-4"
            >
              Full result
              <ArrowRight aria-hidden="true" className="size-4" />
            </a>
          </footer>
        </article>
      </Frame>
      <Frame className="grid gap-4 pb-16">
        <h2 className="m-0 font-mono text-xs tracking-widest text-muted-foreground uppercase">
          The record, as of {AS_OF}
        </h2>
        <div className="grid gap-x-6 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
          <StatFigure
            value={<Count value={entries} />}
            label="Entries on the public board"
            scope="3 polls; ballots, spoiled ballots and anchors"
          />
          <StatFigure
            value={<Count value={tier2.result.ballots} />}
            label="Document-verified voters in the latest count"
            scope={`${LEVY.title}, Tier 2`}
          />
          <StatFigure
            value={`4 of ${TRUSTEES.length}`}
            label="Trustees needed to decrypt a count"
            scope={`${TRUSTEES.length} organisations in ${COUNTRIES} countries`}
          />
          <StatFigure
            value="15:00"
            label="Latest anchor to Ethereum"
            scope="12 Nov 2026, UTC; one every hour"
          />
        </div>
      </Frame>
    </section>
  );
}

function Journey() {
  return (
    <section aria-labelledby="journey-title" className="border-t border-border pt-16">
      <Frame className="grid gap-10">
        <SectionMark index="01">One ballot</SectionMark>
        <div className="grid gap-6 lg:grid-cols-12 lg:gap-x-6">
          <h2
            id="journey-title"
            className="m-0 font-heading text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-5xl lg:col-span-6"
          >
            From a phone to a counted result, in public
          </h2>
          <p className="m-0 max-w-prose text-lg text-pretty lg:col-span-6">
            Follow one ballot in the {LEVY.title} through the six steps every ballot takes. Each
            step leaves evidence that anyone can check, and none of it shows how the voter voted.
          </p>
        </div>
        <ScrollScene
          label="One ballot, from a phone to a counted result"
          steps={JOURNEY.map((step, i) => (
            <JourneyStep key={step.title} index={i} />
          ))}
          graphic={(step, progress) => <JourneyGraphic step={step} progress={progress} />}
        />
      </Frame>
    </section>
  );
}

const STATUS: Record<
  Election["status"],
  {
    icon: typeof CircleDot;
    word: (e: Election) => string;
    action: string;
    href: (e: Election) => string;
  }
> = {
  Open: {
    icon: CircleDot,
    word: (e) => `Open until ${e.closes.replace(" 2026,", ",")}`,
    action: "Vote in the ballot client",
    href: (e) => `/polls/${e.slug}/vote`,
  },
  Scheduled: {
    icon: CalendarClock,
    word: (e) => `Opens ${e.opens.replace(" 2026,", ",")}`,
    action: "Read the question",
    href: (e) => `/polls/${e.slug}`,
  },
  Closed: {
    icon: Hourglass,
    word: () => "Closed; trustees are decrypting",
    action: "Follow the count",
    href: (e) => `/polls/${e.slug}`,
  },
  Counted: {
    icon: CircleCheck,
    word: () => "Counted, by tier",
    action: "Read the result",
    href: (e) => `/polls/${e.slug}`,
  },
};

const ORDER: Election["status"][] = ["Open", "Scheduled", "Closed", "Counted"];

function OpenNow() {
  const polls = [...ELECTIONS].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
  return (
    <section id="open-now" aria-labelledby="open-title" className="border-t border-border pt-16">
      <Frame className="grid gap-10">
        <SectionMark index="02">On the board</SectionMark>
        <div className="grid gap-6 lg:grid-cols-12 lg:gap-x-6">
          <h2
            id="open-title"
            className="m-0 font-heading text-4xl leading-[1.05] font-semibold tracking-tight sm:text-5xl lg:col-span-6"
          >
            Open now, and lately
          </h2>
          <p className="m-0 max-w-prose text-lg text-pretty lg:col-span-6">
            Each poll’s definition is fixed and hashed before it opens: the question, the options,
            who may vote and how it is counted. The fingerprint beside each poll is drawn from that
            hash.
          </p>
        </div>
        <ol className="m-0 grid list-none border-t-2 border-foreground p-0">
          {polls.map((poll) => {
            const status = STATUS[poll.status];
            const Icon = status.icon;
            return (
              <li
                key={poll.id}
                className="grid gap-4 border-b border-border py-8 md:grid-cols-12 md:gap-x-6"
              >
                <div className="grid content-start gap-2 md:col-span-3">
                  <p className="m-0 flex items-center gap-2 text-sm font-semibold">
                    <Icon aria-hidden="true" className="size-4 shrink-0" />
                    {poll.status}
                  </p>
                  <p className="m-0 text-sm text-muted-foreground">{status.word(poll)}</p>
                </div>
                <div className="grid content-start gap-2 md:col-span-9 lg:col-span-6">
                  <p className="m-0 font-mono text-xs tracking-wide text-muted-foreground uppercase">
                    {poll.kind} · {poll.method}
                  </p>
                  <h3 className="m-0 font-heading text-2xl leading-tight font-semibold">
                    <a href={`/polls/${poll.slug}`} className="underline-offset-4 hover:underline">
                      {poll.title}
                    </a>
                  </h3>
                  <p className="m-0 text-base text-pretty">{poll.question}</p>
                  <p className="m-0 text-sm text-muted-foreground">Who may vote: {poll.scope}</p>
                </div>
                <div className="flex flex-wrap content-start items-center gap-3 md:col-span-9 md:col-start-4 lg:col-span-3 lg:col-start-auto lg:grid">
                  <div className="flex items-center gap-3">
                    <Fingerprint
                      value={poll.id}
                      label={`Fingerprint of the ${poll.title} definition, ${poll.id.slice(0, 8)}`}
                      size={40}
                    />
                    <p className="m-0 font-mono text-xs text-muted-foreground tabular-nums">
                      {fmt(poll.entries)} board entries
                    </p>
                  </div>
                  <a
                    href={status.href(poll)}
                    className={cn(
                      buttonVariants({ variant: poll.status === "Open" ? "default" : "outline" }),
                      "justify-between",
                    )}
                  >
                    {status.action}
                    <ArrowRight aria-hidden="true" />
                  </a>
                </div>
              </li>
            );
          })}
        </ol>
      </Frame>
    </section>
  );
}

function VerifyBand() {
  const around = LEDGER.filter((e) => Math.abs(e.index - RECEIPT.entry) <= 1);
  return (
    <section aria-labelledby="verify-title" className="mt-16 border-t-2 border-foreground pt-16">
      <Frame className="grid gap-10">
        <SectionMark index="04">Verify it yourself</SectionMark>
        <div className="grid gap-6 lg:grid-cols-12 lg:gap-x-6">
          <h2
            id="verify-title"
            className="m-0 font-heading text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-5xl lg:col-span-6"
          >
            Check the count without trusting us
          </h2>
          <p className="m-0 max-w-prose text-lg text-pretty lg:col-span-6">
            Nothing on this site has to be taken on faith. Find your ballot on the board, compare
            the fingerprints, and recount any result from Ethereum and IPFS with the open-source
            verifier.
          </p>
        </div>
        <ol className="m-0 grid list-none gap-10 p-0 lg:grid-cols-3 lg:gap-6">
          <li className="grid content-start gap-4 border-t border-foreground pt-4">
            <h3 className="m-0 font-heading text-xl font-semibold">
              <span className="font-mono text-sm text-muted-foreground">1 </span>Keep your receipt
            </h3>
            <p className="m-0 text-sm">
              The ballot client gives you a receipt when you cast. It proves your ballot is on the
              board; it never shows how you voted.
            </p>
            <ReceiptStub
              title="Your receipt"
              hash={RECEIPT.hash}
              entry={RECEIPT.entry}
              recordedAt={new Date("2026-11-03T14:02:12Z")}
              labels={{
                hash: "Receipt hash",
                fingerprint: `Fingerprint of receipt ${RECEIPT.hash.slice(0, 8)}`,
                entry: "Board entry",
                recordedAt: "Recorded",
              }}
            />
          </li>
          <li className="grid content-start gap-4 border-t border-foreground pt-4">
            <h3 className="m-0 font-heading text-xl font-semibold">
              <span className="font-mono text-sm text-muted-foreground">2 </span>Find it on the
              board
            </h3>
            <p className="m-0 text-sm">
              Look up entry {fmt(RECEIPT.entry)}. If the glyph differs from your receipt’s, that is
              conclusive: report it. If it matches, the hash beside it settles the rest.
            </p>
            <ol className="m-0 grid list-none border-t border-foreground p-0">
              {around.map((entry) => (
                <MiniRow key={entry.index} entry={entry} mine={entry.index === RECEIPT.entry} />
              ))}
            </ol>
          </li>
          <li className="grid content-start gap-4 border-t border-foreground pt-4">
            <h3 className="m-0 font-heading text-xl font-semibold">
              <span className="font-mono text-sm text-muted-foreground">3 </span>Recount it
            </h3>
            <p className="m-0 text-sm">
              The verifier reads the anchors on Ethereum and the board’s archive on IPFS. It works
              when our servers don’t.
            </p>
            <code className="block border border-foreground p-3 font-mono text-xs break-all">
              abolish-verify {spacedHex(LEVY.id, 2)} --from ethereum,ipfs
            </code>
            <ul className="m-0 grid list-none gap-1 p-0 text-sm">
              {ENTRY_POINTS.map((e) => (
                <li key={e.name} className="flex flex-wrap gap-x-2">
                  <span className="font-mono">{e.name}</span>
                </li>
              ))}
            </ul>
          </li>
        </ol>
        <div className="flex flex-wrap gap-3">
          <a href="/verify" className={buttonVariants({ size: "lg" })}>
            Open the verifier
          </a>
          <a href="/board" className={buttonVariants({ size: "lg", variant: "outline" })}>
            Browse the board
          </a>
        </div>
      </Frame>
    </section>
  );
}

function HomePage() {
  return (
    <MockShell current="/">
      <Hero />
      <Journey />
      <OpenNow />
      <TiersSection />
      <VerifyBand />
    </MockShell>
  );
}

const meta = {
  title: "Mockups/Web/Home",
  component: HomePage,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof HomePage>;

export default meta;
type Story = StoryObj<typeof meta>;

function journeySteps(canvasElement: HTMLElement) {
  const scene = within(canvasElement).getByRole("region", {
    name: "One ballot, from a phone to a counted result",
  });
  return [...scene.querySelectorAll<HTMLElement>(":scope > ol > li")];
}

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "A public vote that anyone can recount.",
    );
    // The hero's latest count shows each tier on its own, never one blended figure.
    const latest = canvas.getByRole("article", { name: /Latest count/ });
    await expect(within(latest).getAllByText(/\d ballots$/)).toHaveLength(3);
    await expect(canvas.getByText("Entries on the public board")).toBeVisible();

    const graphic = () => canvas.getByTestId("journey-graphic");
    await expect(graphic()).toHaveAttribute("data-step", "0");
    await expect(within(graphic()).getByText("Never leaves")).toBeVisible();

    const steps = journeySteps(canvasElement);
    await expect(steps).toHaveLength(6);
    steps[2]!.scrollIntoView({ block: "center" });
    await waitFor(() => expect(graphic()).toHaveAttribute("data-step", "2"));
    await expect(within(graphic()).getByText(/your receipt/)).toBeVisible();

    steps[5]!.scrollIntoView({ block: "center" });
    await waitFor(() => expect(graphic()).toHaveAttribute("data-step", "5"));
    await expect(
      within(graphic()).getByText("Matches the published result, tier by tier."),
    ).toBeVisible();
  },
};

export const Dark: Story = {
  parameters: { layout: "fullscreen", theme: "dark" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toBeVisible();
    // Three tiers, each with its own heading and count; no "all tiers" total anywhere.
    const tiers = canvas.getByRole("region", { name: "Three tiers, counted apart" });
    await expect(within(tiers).getAllByRole("heading", { level: 3 })).toHaveLength(3);
    await expect(canvas.queryByText(/all tiers/i)).toBeNull();
    // The turnout columns follow the reader: scrolled past, they show the close.
    tiers.scrollIntoView({ block: "end" });
    await waitFor(() =>
      expect(canvas.getByTestId("turnout-tier2")).toHaveTextContent("By 20:00 UTC, 40,112"),
    );
  },
};
