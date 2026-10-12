import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { ModerationLog } from "./moderation-log.tsx";

const meta = {
  component: ModerationLog,
  args: {
    log: {
      entries: [
        {
          seq: "1",
          electionId: "ab".repeat(32),
          action: "delist",
          reason: "spam",
          decidedAt: "2026-09-30T08:15:00.000Z",
        },
        {
          seq: "4",
          electionId: "cd".repeat(32),
          action: "hide",
          reason: "personal-data",
          decidedAt: "2026-10-01T12:00:00.000Z",
        },
        {
          seq: "9",
          electionId: "cd".repeat(32),
          action: "restore",
          reason: "appeal-upheld",
          decidedAt: "2026-10-03T17:45:30.250Z",
        },
      ],
    },
    next: undefined,
  },
} satisfies Meta<typeof ModerationLog>;

export default meta;
type Story = StoryObj<typeof meta>;

const play: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getAllByRole("row")).toHaveLength(4);
  await expect(canvas.getByRole("cell", { name: "Appeal upheld" })).toBeVisible();
  await expect(canvas.getAllByRole("link", { name: /^cdcdcdcd/ })[0]).toHaveAttribute(
    "href",
    `/polls/${"cd".repeat(32)}`,
  );
  await expect(canvas.getByText("October 1, 2026 at 12:00 PM UTC")).toBeVisible();
  await expect(canvas.queryByRole("link", { name: "Later decisions" })).toBeNull();
};

export const Default: Story = { play };

export const Dark: Story = { parameters: { theme: "dark" }, play };

export const WithMore: Story = {
  args: { next: "9" },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("link", { name: "Later decisions" }),
    ).toHaveAttribute("href", "/moderation?after=9");
  },
};

export const Empty: Story = {
  args: { log: { entries: [] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("No decisions yet.")).toBeVisible();
    await expect(canvas.queryByRole("table")).toBeNull();
  },
};
