import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import type { PollView } from "../poll.ts";
import type { StreamCard } from "../stream.ts";
import { StreamPage, streamHref } from "./stream.tsx";

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
const UNREADABLE = "40".repeat(32);
const NEXT = "50".repeat(32);
const BALLOT = "https://ballot.example/";

const cards: StreamCard[] = [
  {
    kind: "poll",
    poll: poll(LIBRARY),
    text: {
      language: "en",
      heading: "Library hours",
      question: "When should the main library open on Sundays?",
    },
  },
  {
    kind: "poll",
    poll: poll(RIVERSIDE, {
      questions: [
        { optionCount: 4, minSelections: 0, maxSelections: 1 },
        { optionCount: 4, minSelections: 0, maxSelections: 4 },
        { optionCount: 5, minSelections: 0, maxSelections: 1 },
      ],
      closesAt: { seconds: "1768435200", iso: "2026-01-15T00:00:00.000Z" },
    }),
    text: { language: "en", heading: "Riverside park", question: undefined },
  },
  {
    kind: "poll",
    poll: poll(BUS, { version: 1, counting: "plurality" }),
    text: {
      language: "es-419",
      heading: "¿Debería el autobús 23 circular hasta la medianoche?",
      question: undefined,
    },
  },
  { kind: "unavailable", electionId: UNREADABLE, problem: "text" },
];

const meta = {
  component: StreamPage,
  args: {
    stream: { kind: "stream", cards, next: NEXT },
    sort: "new",
    ballot: BALLOT,
  },
} satisfies Meta<typeof StreamPage>;

export default meta;
type Story = StoryObj<typeof meta>;

const questions = (root: HTMLElement) =>
  within(within(root).getByRole("list", { name: "Questions" }));

const play: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
    "What people are asking",
  );
  const list = questions(canvasElement);
  await expect(list.getAllByRole("article")).toHaveLength(4);

  // Each card's heading names the poll's page; the asker's words keep their own language.
  const library = list.getByRole("heading", { name: "Library hours" });
  await expect(within(library).getByRole("link")).toHaveAttribute("href", `/polls/${LIBRARY}`);
  await expect(list.getByText("When should the main library open on Sundays?")).toBeVisible();
  await expect(
    list.getByRole("heading", { name: "¿Debería el autobús 23 circular hasta la medianoche?" }),
  ).toHaveAttribute("lang", "es-419");

  // Answering opens the ballot client, with the poll in the fragment only.
  const answers = list.getAllByRole("link", { name: /^Answer/ });
  await expect(answers.map((a) => a.getAttribute("href"))).toEqual([
    `${BALLOT}#election=${LIBRARY}`,
    `${BALLOT}#election=${RIVERSIDE}`,
    `${BALLOT}#election=${BUS}`,
  ]);
  await expect(answers[0]).toHaveAccessibleName("Answer the question");
  await expect(answers[0]).toHaveAccessibleDescription("Library hours");
  await expect(answers[1]).toHaveAccessibleName("Answer 3 questions");
  await expect(list.getByText("3 questions")).toBeVisible();
  await expect(list.getAllByText(/^Closes/)[0]).toHaveTextContent("Closes January 8, 2026");

  // A poll whose text failed its checks shows none, and can't be answered from here.
  await expect(list.getByText(/text can't be shown here/)).toBeVisible();

  // The order is a link like the others; more comes only when asked for.
  const order = canvas.getByRole("navigation", { name: "Order" });
  await expect(within(order).getByRole("link", { name: "New" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(within(order).getByRole("link", { name: "Closing soon" })).toHaveAttribute(
    "href",
    "/discover?sort=closing",
  );
  await expect(canvas.getByRole("link", { name: "More questions" })).toHaveAttribute(
    "href",
    `/discover?after=${NEXT}`,
  );
  // No engagement counts.
  await expect(canvas.queryByText(/viewing now|streak/i)).toBeNull();
};

export const Default: Story = { play };

export const Dark: Story = { parameters: { theme: "dark" }, play };

/** Without a ballot client configured, a card says so and links only to the poll's page. */
export const NoBallotClient: Story = {
  args: { ballot: null },
  play: async ({ canvasElement }) => {
    const list = questions(canvasElement);
    await expect(list.queryByRole("link", { name: /^Answer/ })).toBeNull();
    await expect(list.getAllByText(/isn't set up on this site yet/)).toHaveLength(3);
  },
};

export const MostAnswered: Story = {
  args: { sort: "answered" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("link", { name: "Most answered this week" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(canvas.getByText(/each person once/)).toBeVisible();
    await expect(canvas.getByRole("link", { name: "More questions" })).toHaveAttribute(
      "href",
      streamHref("answered", NEXT),
    );
  },
};

export const SortUnavailable: Story = {
  args: { sort: "answered", stream: { kind: "sort-unavailable" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "This order isn't available just now" }),
    ).toBeVisible();
    await expect(canvas.queryByRole("link", { name: "More questions" })).toBeNull();
  },
};

export const CursorLost: Story = {
  args: { sort: "closing", stream: { kind: "cursor-not-found" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "That page has moved on" })).toBeVisible();
    await expect(canvas.getByRole("link", { name: "Start from the top" })).toHaveAttribute(
      "href",
      "/discover?sort=closing",
    );
  },
};

export const Empty: Story = {
  args: { stream: { kind: "stream", cards: [], next: undefined } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "No open questions just now" })).toBeVisible();
    await expect(canvas.queryByRole("list", { name: "Questions" })).toBeNull();
  },
};
