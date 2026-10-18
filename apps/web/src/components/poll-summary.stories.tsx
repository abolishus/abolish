import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import type { PollView } from "../poll.ts";
import { PollSummary } from "./poll-summary.tsx";

const poll: PollView = {
  electionId: "101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f",
  definitionHash: "a4555c67fbc57b7ed42f873f73f36360baba11fa0de1f0ba0f104780a4071750",
  version: 1,
  illFormed: undefined,
  counting: "plurality",
  questions: [{ optionCount: 3, minSelections: 0, maxSelections: 1 }],
  electorate: [
    { tier: 0, groupSize: "5000" },
    { tier: 2, groupSize: "1" },
  ],
  threshold: 4,
  panelSize: 7,
  opensAt: { seconds: "1767225600", iso: "2026-01-01T00:00:00.000Z" },
  closesAt: { seconds: "18446744073709551615", iso: undefined },
};

/** Between the poll's opening and its close. */
const OPEN_AT = { seconds: "1767571200", iso: "2026-01-05T00:00:00.000Z" };

const board = { treeSize: "1234", chainHead: "1f".repeat(32), root: "2e".repeat(32) };

const meta = {
  component: PollSummary,
  args: { poll, board, moderation: { state: "visible" }, asOf: OPEN_AT, code: "mhanrsz" },
} satisfies Meta<typeof PollSummary>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Opens "How do we know this is real?", where the definition and board facts are. */
async function openEvidence(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const summary = canvas.getByRole("heading", { name: "How do we know this is real?" });
  // Closed, the evidence is in the page but not shown.
  const details = canvasElement.querySelector("details");
  await expect(details).not.toHaveAttribute("open");
  await expect(canvas.getByText(/^Definition hash/, { selector: "figcaption" })).not.toBeVisible();
  await userEvent.click(summary);
  await expect(details).toHaveAttribute("open");
  await expect(canvas.getByRole("figure", { name: /^Definition hash/ })).toBeVisible();
}

const play: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
    "Poll 1011121314151617…",
  );
  // The surface: where the poll stands, who can vote, when, and how answering works.
  await expect(canvas.getByText("Open for answers")).toBeVisible();
  await expect(canvas.getByText("3 options")).toBeVisible();
  await expect(canvas.getByRole("heading", { name: "Answering" })).toBeVisible();
  await expect(canvas.getByText(/only in the ballot app, never on this website/)).toBeVisible();
  await openEvidence(canvasElement);
  await expect(canvas.getByText(/what our server says about this poll/)).toBeVisible();
  await expect(canvas.getByRole("figure", { name: "Poll ID" })).toBeVisible();
  await expect(
    canvas.getByRole("img", { name: "Fingerprint of definition a4555c67" }),
  ).toBeVisible();
  await expect(canvas.getByText("4 of 7")).toBeVisible();
  await expect(canvas.getByText("5,000 members")).toBeVisible();
  // A singular plural, and an instant past what Date holds shown as seconds.
  await expect(canvas.getByText("1 member")).toBeVisible();
  // On the surface and in the evidence.
  await expect(canvas.getAllByText("18446744073709551615")).toHaveLength(2);
  await expect(canvas.getByRole("figure", { name: "Chain head" })).toBeVisible();
  await expect(canvas.queryByRole("note")).toBeNull();
  await expect(canvas.getByRole("link", { name: "/p/mhanrsz" })).toHaveAttribute(
    "href",
    "/p/mhanrsz",
  );
};

export const Default: Story = { play };

export const Dark: Story = { parameters: { theme: "dark" }, play };

/** Before `opens_at`: not open yet, with its opening time on the surface. */
export const Scheduled: Story = {
  args: { asOf: { seconds: "1767225599", iso: "2025-12-31T23:59:59.000Z" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Not open yet")).toBeVisible();
    await expect(canvas.queryByText("Open for answers")).toBeNull();
  },
};

/** Past `closes_at`: closed, and answering says the board stays public. */
export const Closed: Story = {
  args: {
    poll: { ...poll, closesAt: { seconds: "1767830400", iso: "2026-01-08T00:00:00.000Z" } },
    asOf: { seconds: "1767830401", iso: "2026-01-08T00:00:01.000Z" },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Closed")).toBeVisible();
    await expect(canvas.getByText(/This poll has closed/)).toBeVisible();
    await expect(canvas.queryByText(/only in the ballot app/)).toBeNull();
  },
};

/** No registration recorded yet: no code resolves, so none is printed. */
export const NoShortCode: Story = {
  args: { code: undefined },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await openEvidence(canvasElement);
    await expect(canvas.queryByText("Short link")).toBeNull();
    await expect(canvas.queryByRole("link")).toBeNull();
  },
};

export const EmptyBoard: Story = {
  args: { board: { treeSize: "0", chainHead: "00".repeat(32), root: "00".repeat(32) } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await openEvidence(canvasElement);
    await expect(canvas.getByText("No entries yet.")).toBeVisible();
    // An empty board's all-zero head is never shown as if it were one.
    await expect(canvas.queryByRole("figure", { name: "Chain head" })).toBeNull();
  },
};

export const Hidden: Story = {
  args: {
    moderation: {
      state: "hidden",
      latest: {
        seq: "7",
        action: "hide",
        reason: "personal-data",
        decidedAt: "2026-10-01T12:00:00.000Z",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const note = within(canvasElement).getByRole("note");
    await expect(within(canvasElement).getByText("Text hidden")).toBeVisible();
    await expect(note).toHaveTextContent("withheld (Personal data)");
    await expect(
      within(note).getByRole("link", { name: "See the moderation log" }),
    ).toHaveAttribute("href", "/moderation");
  },
};

export const Delisted: Story = {
  parameters: { theme: "dark" },
  args: {
    moderation: {
      state: "delisted",
      latest: { seq: "3", action: "delist", reason: "spam", decidedAt: "2026-10-01T12:00:00.000Z" },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("note")).toHaveTextContent(
      "left out of discovery and search (Spam)",
    );
    await expect(within(canvasElement).getByText("Delisted")).toBeVisible();
  },
};

export const IllFormed: Story = {
  args: {
    poll: { ...poll, counting: "approval", illFormed: { rule: "panel", question: undefined } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("alert")).toHaveTextContent("(trustee panel)");
    await expect(canvas.getAllByText("Approve any number")[0]).toBeVisible();
  },
};

/** Version 5: each question's limits, worded as the ballot client words them. */
const questions: PollView = {
  ...poll,
  version: 5,
  counting: "questions",
  questions: [
    { optionCount: 3, minSelections: 0, maxSelections: 1 },
    { optionCount: 5, minSelections: 0, maxSelections: 5 },
    { optionCount: 4, minSelections: 0, maxSelections: 2 },
    { optionCount: 6, minSelections: 3, maxSelections: 3 },
    { optionCount: 4, minSelections: 1, maxSelections: 4 },
    { optionCount: 5, minSelections: 2, maxSelections: 3 },
  ],
};

const questionsPlay: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getAllByText("Question by question")[0]).toBeVisible();
  await expect(canvas.getByText("6 questions, 27 options")).toBeVisible();
  await openEvidence(canvasElement);
  // The term's row holds the list; `getByText` would have thrown without it.
  const row = canvas.getByText("Questions", { selector: "dt" }).parentElement!;
  const items = within(row).getAllByRole("listitem");
  await expect(items.map((li) => li.textContent)).toEqual([
    "Question 1: Pick one, from 3 options; 0 to 1 selections",
    "Question 2: Pick any, from 5 options; 0 to 5 selections",
    "Question 3: Pick up to 2, from 4 options; 0 to 2 selections",
    "Question 4: Pick exactly 3, from 6 options; 3 to 3 selections",
    "Question 5: Pick at least 1, from 4 options; 1 to 4 selections",
    "Question 6: Pick 2 to 3, from 5 options; 2 to 3 selections",
  ]);
  await expect(canvas.getByText("Options", { selector: "dt" }).nextSibling).toHaveTextContent("27");
  await expect(canvas.queryByText("Selections per ballot")).toBeNull();
};

export const Questions: Story = { args: { poll: questions }, play: questionsPlay };

export const QuestionsDark: Story = {
  args: { poll: questions },
  parameters: { theme: "dark" },
  play: questionsPlay,
};

/** A rule broken in one question names the question, counted from 1. */
export const IllFormedQuestion: Story = {
  args: { poll: { ...questions, illFormed: { rule: "selections", question: 3 } } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("alert")).toHaveTextContent(
      "(selection limits) in question 4",
    );
  },
};
