import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { PollResults } from "./poll-results.tsx";

const electionId = "101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f";

const meta = {
  component: PollResults,
  args: {
    poll: {
      electionId,
      questions: [
        { optionCount: 3, minSelections: 0, maxSelections: 1 },
        { optionCount: 2, minSelections: 0, maxSelections: 2 },
      ],
    },
    results: {
      kind: "read",
      tiers: [
        {
          tier: 0,
          counted: 1234,
          questions: [
            ["700", "434", "100"],
            ["600", "600"],
          ],
        },
        { tier: 2, counted: 40, questions: undefined },
      ],
    },
    status: "closed",
    words: {
      language: "en",
      title: "Riverside Park",
      questions: [
        { question: "Should the park stay open late?", options: ["Yes", "No", "Abstain"] },
        { question: "Which days should the café open?", options: ["Saturdays", "Sundays"] },
      ],
    },
    phoneVerification: false,
  },
} satisfies Meta<typeof PollResults>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Sentences first, then every answer's share and count, tier by tier, question by question. */
const play: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 2, name: "Results" })).toBeVisible();
  // Two questions, each counted on its own and never matched up (ADR 0026).
  await expect(canvas.getByText(/^Each question is counted on its own\./)).toBeVisible();
  const tier = within(canvas.getByRole("region", { name: "Tier 0 (verified e-mail)" }));
  await expect(tier.getByText("1,234 people answered")).toBeVisible();
  await expect(tier.getByText("Most picked: ⁨Yes⁩, by 56.7% of those who answered.")).toBeVisible();
  await expect(
    tier.getByText(
      "Tied for most picked: ⁨Saturdays⁩ and ⁨Sundays⁩, each by 48.6% of those who answered.",
    ),
  ).toBeVisible();
  await expect(tier.getByText("434 people")).toBeVisible();
  // Each question on its own, under its own words.
  await expect(
    tier.getByRole("heading", { name: "Which days should the café open?" }),
  ).toBeVisible();
  // A tier with a cell unopened has no counts yet.
  const pending = within(canvas.getByRole("region", { name: "Tier 2 (document-verified)" }));
  await expect(pending.getByText("40 people answered")).toBeVisible();
  await expect(pending.getByRole("status")).toHaveTextContent(/isn't published yet/);
  // The board's results, with the way to check them (T-34).
  await expect(canvas.getByText(/Nothing on this page checks them for you/)).toBeVisible();
  await expect(canvas.getByRole("link", { name: "Check the count on the board" })).toHaveAttribute(
    "href",
    `/polls/${electionId}/board`,
  );
  await expect(canvas.getByRole("link", { name: "See the full results" })).toHaveAttribute(
    "href",
    `/polls/${electionId}/results`,
  );
};

export const Default: Story = { play };

export const Dark: Story = { parameters: { theme: "dark" }, play };

/** A hidden poll's results, by number: its words are withheld, its count never is. */
export const ByNumber: Story = {
  args: {
    poll: { electionId, questions: [{ optionCount: 3, minSelections: 0, maxSelections: 1 }] },
    results: { kind: "read", tiers: [{ tier: 0, counted: 3, questions: [["0", "3", "0"]] }] },
    words: undefined,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText("Most picked: ⁨Answer 2⁩, by 100% of those who answered."),
    ).toBeVisible();
    await expect(canvas.getByText("Answer 3")).toBeVisible();
    // One question needs no number.
    await expect(canvas.queryByText("Question 1")).toBeNull();
    // Nor the line about several questions.
    await expect(canvas.queryByText(/^Each question is counted on its own/)).toBeNull();
  },
};

/** Answered, but nothing picked; and a tier where nobody answered shows no bars. */
export const NothingPicked: Story = {
  args: {
    poll: { electionId, questions: [{ optionCount: 2, minSelections: 0, maxSelections: 1 }] },
    results: {
      kind: "read",
      tiers: [
        { tier: 0, counted: 2, questions: [["0", "0"]] },
        { tier: 2, counted: 0, questions: [["0", "0"]] },
      ],
    },
    words: undefined,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("No answer was picked.")).toBeVisible();
    await expect(canvas.getByText("No one answered.")).toBeVisible();
    await expect(canvas.getAllByRole("list")).toHaveLength(1);
  },
};

/** Open, nothing counted yet: answers stay sealed until the poll closes. */
export const Sealed: Story = {
  args: { results: { kind: "unopened" }, status: "open" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "Answers stay sealed while the poll is open.",
    );
    // How the questions will be counted holds before any count does.
    await expect(canvas.getByText(/^Each question is counted on its own\./)).toBeVisible();
  },
};

/** Closed, its count not published yet. */
export const Counting: Story = {
  args: { results: { kind: "unopened" } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("status")).toHaveTextContent(
      "The results appear here once its answers are counted.",
    );
  },
};

/** This server counts no results of the poll; the board can still be counted. */
export const NotCounted: Story = {
  args: { results: { kind: "not-counted" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("status")).toHaveTextContent(
      /doesn't publish this poll's results/,
    );
    await expect(canvas.getByRole("link", { name: "Check the count on the board" })).toBeVisible();
  },
};

/** A read that failed, timed out or didn't fit the poll. */
export const Unavailable: Story = {
  args: { results: { kind: "unavailable" } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("status")).toHaveTextContent(
      "The results couldn't be loaded just now.",
    );
  },
};
