import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import type { PollView } from "../poll.ts";
import { PollSummary } from "./poll-summary.tsx";

const poll: PollView = {
  electionId: "101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f",
  definitionHash: "a4555c67fbc57b7ed42f873f73f36360baba11fa0de1f0ba0f104780a4071750",
  illFormed: undefined,
  electionType: "plurality",
  optionCount: 3,
  minSelections: 0,
  maxSelections: 1,
  electorate: [
    { tier: 0, groupSize: "5000" },
    { tier: 2, groupSize: "1" },
  ],
  threshold: 4,
  panelSize: 7,
  opensAt: { seconds: "1767225600", iso: "2026-01-01T00:00:00.000Z" },
  closesAt: { seconds: "18446744073709551615", iso: undefined },
};

const board = { treeSize: "1234", chainHead: "1f".repeat(32), root: "2e".repeat(32) };

const meta = {
  component: PollSummary,
  args: { poll, board, moderation: { state: "visible" } },
} satisfies Meta<typeof PollSummary>;

export default meta;
type Story = StoryObj<typeof meta>;

const play: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("Poll");
  await expect(canvas.getByText("One choice")).toBeVisible();
  await expect(canvas.getByText("4 of 7")).toBeVisible();
  await expect(canvas.getByText("5,000 members")).toBeVisible();
  // A singular plural, and an instant past what Date holds shown as seconds.
  await expect(canvas.getByText("1 member")).toBeVisible();
  await expect(canvas.getByText("18446744073709551615")).toBeVisible();
  await expect(canvas.getByRole("figure", { name: "Chain head" })).toBeVisible();
  await expect(canvas.queryByRole("note")).toBeNull();
};

export const Default: Story = { play };

export const Dark: Story = { parameters: { theme: "dark" }, play };

export const EmptyBoard: Story = {
  args: { board: { treeSize: "0", chainHead: "00".repeat(32), root: "00".repeat(32) } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
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
  },
};

export const IllFormed: Story = {
  args: { poll: { ...poll, electionType: "approval", illFormed: "panel" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("alert")).toHaveTextContent("(trustee panel)");
    await expect(canvas.getByText("Approve any number")).toBeVisible();
  },
};
