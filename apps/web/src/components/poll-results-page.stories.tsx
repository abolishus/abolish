import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import type { CellResults } from "../results.ts";
import { PollResultsPage } from "./poll-results-page.tsx";

const electionId = "101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f";

// Tier 0 in three cells (two large regions and the small ones folded), Tier 2 in one.
const cells: readonly CellResults[] = [
  {
    cell: { tier: 0, members: "5000", regions: [0] },
    counted: 900,
    state: "opened",
    questions: [
      ["500", "300", "100"],
      ["450", "450"],
    ],
  },
  {
    cell: { tier: 0, members: "1200", regions: [1] },
    counted: 300,
    state: "opened",
    questions: [
      ["180", "120", "0"],
      ["130", "130"],
    ],
  },
  {
    cell: { tier: 0, members: "1020", regions: [2, 3] },
    counted: 34,
    state: "opened",
    questions: [
      ["20", "14", "0"],
      ["20", "20"],
    ],
  },
  {
    cell: { tier: 2, members: "120", regions: [0] },
    counted: 40,
    state: "missing",
    questions: undefined,
  },
];

const meta = {
  component: PollResultsPage,
  parameters: { layout: "padded" },
  args: {
    poll: {
      electionId,
      questions: [
        { optionCount: 3, minSelections: 0, maxSelections: 1 },
        { optionCount: 2, minSelections: 0, maxSelections: 2 },
      ],
    },
    heading: "Riverside Park",
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
    cells,
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
} satisfies Meta<typeof PollResultsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A tab per tier, its sentences and bars first, then its cells; the tiers
 * side by side with no total row; and the way to check them (T-16, T-34).
 */
const play: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("Riverside Park");
  const tabs = canvas.getByRole("tablist", { name: "Results by group" });
  const tier0 = within(tabs).getByRole("tab", { name: /Tier 0 \(verified e-mail\)/ });
  await expect(tier0).toHaveAttribute("aria-selected", "true");
  await expect(tier0).toHaveTextContent("1,234 people answered");
  const panel = within(canvas.getByRole("tabpanel"));
  await expect(panel.getByText("Most picked: ⁨Yes⁩, by 56.7% of those who answered.")).toBeVisible();
  // Each cell on its own, with its regions and members.
  await expect(panel.getByRole("heading", { name: "Part by part" })).toBeVisible();
  await expect(panel.getAllByText("region 3 and region 4 · 1,020 members")).toHaveLength(2);
  await expect(panel.getAllByRole("table")).toHaveLength(2);

  // The tiers side by side, never added together.
  const side = within(canvas.getByRole("region", { name: "The groups side by side" }));
  await expect(side.getAllByRole("table")).toHaveLength(2);
  await expect(side.getAllByText("Not all published yet")).toHaveLength(2);

  // Another tier is a tap away; it has no counts yet and one cell, so no parts.
  await userEvent.click(within(tabs).getByRole("tab", { name: /Tier 2/ }));
  await waitFor(() =>
    expect(within(canvas.getByRole("tabpanel")).getByRole("status")).toHaveTextContent(
      /isn't published yet/,
    ),
  );
  await expect(within(canvas.getByRole("tabpanel")).queryByText("Part by part")).toBeNull();

  await expect(canvas.getByRole("link", { name: "Check the count on the board" })).toHaveAttribute(
    "href",
    `/polls/${electionId}/board`,
  );
  await expect(canvas.getByRole("link", { name: "How to count it yourself" })).toHaveAttribute(
    "href",
    "/verify",
  );
  await expect(canvas.getByRole("link", { name: "Back to the poll" })).toHaveAttribute(
    "href",
    `/polls/${electionId}`,
  );
};

export const Default: Story = { play };

export const Dark: Story = { parameters: { theme: "dark" }, play };

/** A hidden poll's results, by number: its words are withheld, its count never is. */
export const ByNumber: Story = {
  args: {
    poll: { electionId, questions: [{ optionCount: 3, minSelections: 0, maxSelections: 1 }] },
    heading: undefined,
    results: { kind: "read", tiers: [{ tier: 0, counted: 3, questions: [["0", "3", "0"]] }] },
    cells: [
      {
        cell: { tier: 0, members: "50", regions: undefined },
        counted: 3,
        state: "opened",
        questions: [["0", "3", "0"]],
      },
    ],
    words: undefined,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Poll 1011121314151617…",
    );
    await expect(
      canvas.getByText("Most picked: ⁨Answer 2⁩, by 100% of those who answered."),
    ).toBeVisible();
    // One tier: nothing to set side by side; one cell: no parts.
    await expect(canvas.queryByRole("region", { name: "The groups side by side" })).toBeNull();
    await expect(canvas.queryByText("Part by part")).toBeNull();
  },
};

/** A cell whose openings failed the board's check, beside one not yet opened. */
export const CellFailed: Story = {
  args: {
    results: {
      kind: "read",
      tiers: [{ tier: 0, counted: 1234, questions: undefined }],
    },
    cells: [
      cells[0]!,
      { ...cells[1]!, state: "failed", questions: undefined },
      { ...cells[2]!, state: "missing", questions: undefined },
    ],
  },
  play: async ({ canvasElement }) => {
    const panel = within(within(canvasElement).getByRole("tabpanel"));
    await expect(panel.getAllByText("Didn't pass the board's check")).toHaveLength(2);
    await expect(panel.getAllByText("Not published yet")).toHaveLength(2);
  },
};

/** Cells that don't add up to their tier: the tier's results stand, the cells aren't shown. */
export const CellsUnavailable: Story = {
  args: { cells: undefined },
  play: async ({ canvasElement }) => {
    const panel = within(within(canvasElement).getByRole("tabpanel"));
    await expect(panel.getByText("This group's parts couldn't be shown just now.")).toBeVisible();
    await expect(
      panel.getByText("Most picked: ⁨Yes⁩, by 56.7% of those who answered."),
    ).toBeVisible();
  },
};

/** Open, nothing counted yet. */
export const Sealed: Story = {
  args: { results: { kind: "unopened" }, status: "open" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "Answers stay sealed while the poll is open.",
    );
    await expect(canvas.queryByRole("tablist")).toBeNull();
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
