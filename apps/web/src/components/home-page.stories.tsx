import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { NO_TAGS, type PollView } from "../poll.ts";
import type { StreamCard } from "../stream.ts";
import { HomePage } from "./home-page.tsx";
import { SiteLayout } from "./site-layout.tsx";

const poll = (electionId: string, overrides: Partial<PollView> = {}): PollView => ({
  electionId,
  definitionHash: "a4555c67fbc57b7ed42f873f73f36360baba11fa0de1f0ba0f104780a4071750",
  version: 5,
  illFormed: undefined,
  counting: "questions",
  questions: [{ optionCount: 3, minSelections: 0, maxSelections: 1 }],
  electorate: [{ tier: 0, groupSize: "5000" }],
  threshold: 1,
  panelSize: 1,
  opensAt: { seconds: "1767225600", iso: "2026-01-01T00:00:00.000Z" },
  closesAt: { seconds: "1767830400", iso: "2026-01-08T00:00:00.000Z" },
  ...overrides,
});

const LIBRARY = "10".repeat(32);
const RIVERSIDE = "20".repeat(32);
const BUS = "30".repeat(32);

const cards: StreamCard[] = [
  {
    kind: "poll",
    poll: poll(LIBRARY),
    text: {
      language: "en",
      heading: "Library hours",
      question: "When should the main library open on Sundays?",
      options: ["At 10", "At noon", "Stay closed"],
    },
    tags: { topic: "culture", place: "Eastside" },
  },
  {
    kind: "poll",
    poll: poll(RIVERSIDE, {
      questions: [
        { optionCount: 4, minSelections: 0, maxSelections: 1 },
        { optionCount: 5, minSelections: 0, maxSelections: 1 },
      ],
      closesAt: { seconds: "1768435200", iso: "2026-01-15T00:00:00.000Z" },
    }),
    text: {
      language: "en",
      heading: "Riverside park",
      question: "Which one improvement matters most to you?",
      options: ["Better lighting", "Public toilets", "Basketball courts", "Street trees"],
    },
    tags: { topic: undefined, place: "Riverside Park" },
    askedBy: { handle: "k7qa2mzr5xw3bn4d", name: "Riverside Neighbours" },
  },
  {
    kind: "poll",
    poll: poll(BUS, { version: 1, counting: "plurality" }),
    text: {
      language: "en",
      heading: "Should the 23 bus run until midnight?",
      question: undefined,
      options: ["Yes", "No"],
    },
    tags: NO_TAGS,
  },
];

const meta = {
  component: HomePage,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <SiteLayout current="/">
        <Story />
      </SiteLayout>
    ),
  ],
  args: { newest: { cards, ballot: "https://ballot.example/" } },
} satisfies Meta<typeof HomePage>;

export default meta;
type Story = StoryObj<typeof meta>;

const play: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const main = within(canvas.getByRole("main"));
  await expect(main.getByRole("heading", { level: 1 })).toHaveTextContent(
    "Ask anything. Anyone can answer. Anyone can check the count.",
  );
  // Asking signs a visitor in for it, then opens a new poll's form; browsing
  // is the stream, not the register.
  await expect(main.getByRole("link", { name: "Ask a question" })).toHaveAttribute(
    "href",
    "/account?next=new-poll",
  );
  await expect(main.getByRole("link", { name: "Browse questions" })).toHaveAttribute(
    "href",
    "/discover",
  );
  // The newest questions by their words, each answerable from its card.
  const newest = within(main.getByRole("list", { name: "What people are asking" }));
  await expect(newest.getAllByRole("article")).toHaveLength(3);
  await expect(newest.getByRole("heading", { name: "Library hours" })).toBeVisible();
  await expect(newest.getByRole("link", { name: "At noon" })).toHaveAttribute(
    "href",
    `https://ballot.example/#election=${LIBRARY}&pick=1`,
  );
  await expect(main.getByRole("link", { name: "See all questions" })).toHaveAttribute(
    "href",
    "/discover",
  );
  // What choosing an answer does is said once, above the cards; a card of
  // several questions says only which one its answers are for.
  await expect(main.getAllByText(/Nothing is sent until you cast your ballot/)).toHaveLength(1);
  await expect(main.getByText(/The newest open questions\. Choose an answer/)).toBeVisible();
  await expect(newest.getByText("These answers are for question 1 of 2.")).toBeVisible();
  // The civic register's words and the ID lookup stay on the poll register.
  await expect(main.queryByRole("textbox")).toBeNull();
  await expect(canvas.getByRole("main")).not.toHaveTextContent(/server|64-character|Poll ID/);
  await expect(
    main.getByRole("heading", { name: "Why you can trust a casual poll" }),
  ).toBeVisible();
};

export const Default: Story = { play };

export const Dark: Story = { parameters: { theme: "dark" }, play };

/**
 * On a small phone both ways in are on the first screen, under the frame's
 * header: by 568px, a 320 by 568 screen's height, where iteration 1's
 * "Browse questions" ended at 577px at this width.
 */
export const Phone: Story = {
  globals: { viewport: { value: "phone", isRotated: false } },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.ownerDocument.documentElement.clientWidth).toBe(360);
    const main = within(within(canvasElement).getByRole("main"));
    for (const name of ["Ask a question", "Browse questions"])
      await expect(
        main.getByRole("link", { name }).getBoundingClientRect().bottom,
      ).toBeLessThanOrEqual(568);
    // Where the cards stack, the first follows the lede with nothing between,
    // and "See all questions" comes after the last, where iteration 3 put it
    // between the lede and the first card.
    const lede = main.getByText(/^The newest open questions\./).getBoundingClientRect();
    const cards = main.getAllByRole("article").map((card) => card.getBoundingClientRect());
    await expect(cards[0]?.top).toBeLessThanOrEqual(lede.bottom + 32);
    await expect(
      main.getByRole("link", { name: "See all questions" }).getBoundingClientRect().top,
    ).toBeGreaterThan(cards.at(-1)?.bottom ?? Infinity);
  },
};

/** No open questions: the page says so, and the ways to ask and browse stay. */
export const Empty: Story = {
  args: { newest: { cards: [], ballot: "https://ballot.example/" } },
  play: async ({ canvasElement }) => {
    const main = within(within(canvasElement).getByRole("main"));
    await expect(main.getByText(/No questions are open just now/)).toBeVisible();
    // With no card to answer from, the lede says nothing about answering.
    await expect(main.queryByText(/Choose an answer/)).toBeNull();
    await expect(main.queryByRole("list", { name: "What people are asking" })).toBeNull();
    await expect(main.getByRole("link", { name: "Ask a question" })).toBeVisible();
  },
};

/** The API didn't answer: only the newest questions are left out, and nothing says why (T-67). */
export const Unavailable: Story = {
  args: { newest: undefined },
  play: async ({ canvasElement }) => {
    const main = within(within(canvasElement).getByRole("main"));
    await expect(main.getByText(/couldn't be loaded just now/)).toBeVisible();
    await expect(main.queryByRole("article")).toBeNull();
    await expect(main.getByRole("link", { name: "See all questions" })).toBeVisible();
  },
};
