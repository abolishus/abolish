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
        {
          seq: "12",
          handle: "k7qa2mzr5xw3bn4d",
          action: "hide",
          reason: "impersonation",
          decidedAt: "2026-10-04T09:30:00.000Z",
        },
        {
          seq: "14",
          electionId: "ef".repeat(32),
          action: "refile",
          reason: "misfiled",
          decidedAt: "2026-10-05T10:00:00.000Z",
          topic: "housing",
          place: "changed",
        },
        {
          seq: "15",
          electionId: "ef".repeat(32),
          action: "refile",
          reason: "personal-data",
          decidedAt: "2026-10-05T11:00:00.000Z",
          topic: null,
          place: "cleared",
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
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("never on results");
  const reach = canvas.getByRole("region", { name: "What moderation can reach" });
  await expect(within(reach).getByText("The count and the result")).toBeVisible();
  const log = canvas.getByRole("list", { name: "Decisions, oldest first" });
  const rows = within(log).getAllByRole("listitem");
  await expect(rows).toHaveLength(6);
  // Each row names its cells for assistive technology, whatever the width shows.
  await expect(within(rows[2]!).getByText("Ground")).toBeInTheDocument();
  await expect(within(log).getByText("Appeal upheld")).toBeVisible();
  await expect(within(log).getAllByRole("link", { name: /^cdcdcdcd/ })[0]).toHaveAttribute(
    "href",
    `/polls/${"cd".repeat(32)}`,
  );
  // A profile's row names it by handle alone, never its name, linking its page.
  await expect(within(rows[3]!).getByText("Profile")).toBeInTheDocument();
  await expect(within(rows[3]!).getByRole("link", { name: "k7qa2mzr5xw3bn4d" })).toHaveAttribute(
    "href",
    "/by/k7qa2mzr5xw3bn4d",
  );
  await expect(within(rows[3]!).getByText("Profile hidden")).toBeVisible();
  // A refiling links its poll and says what it changed, never the place itself.
  await expect(within(rows[4]!).getByRole("link", { name: /^efefefef/ })).toBeVisible();
  await expect(within(rows[4]!).getByText("Refiled")).toBeVisible();
  await expect(within(rows[4]!).getByText("Topic now Housing · Place changed")).toBeVisible();
  await expect(within(rows[4]!).getByText("Misfiled")).toBeVisible();
  await expect(within(rows[5]!).getByText("No topic · No place")).toBeVisible();
  // The fingerprint is a seal beside the link, not a second name for the poll.
  await expect(within(log).queryByRole("img")).toBeNull();
  await expect(canvas.getByText("October 1, 2026 at 12:00 PM UTC")).toBeVisible();
  await expect(canvas.queryByRole("link", { name: "Later decisions" })).toBeNull();
  const grounds = canvas.getByRole("region", { name: "The only seven grounds" });
  await expect(within(grounds).getAllByRole("heading", { level: 3 })).toHaveLength(9);
  await expect(within(grounds).getByText("personal-data")).toBeVisible();
  await expect(
    within(grounds).getByText("The poll's result or turnout, actual or expected"),
  ).toBeVisible();
  // Nothing on the page sets an inline style: the CSP refuses one.
  await expect(canvasElement.querySelector("[style]")).toBeNull();
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
    await expect(canvas.queryByRole("list", { name: "Decisions, oldest first" })).toBeNull();
  },
};
