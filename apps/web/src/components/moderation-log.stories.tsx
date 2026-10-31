import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { ModerationLog } from "./moderation-log.tsx";

const meta = {
  component: ModerationLog,
  args: {
    log: {
      // Newest first, as the API serves every page the website reads.
      entries: [
        {
          seq: "15",
          electionId: "ef".repeat(32),
          action: "refile",
          reason: "personal-data",
          decidedAt: "2026-10-05T11:00:00.000Z",
          topic: null,
          place: "cleared",
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
          seq: "12",
          handle: "k7qa2mzr5xw3bn4d",
          action: "hide",
          reason: "impersonation",
          decidedAt: "2026-10-04T09:30:00.000Z",
        },
        {
          seq: "9",
          electionId: "cd".repeat(32),
          action: "restore",
          reason: "appeal-upheld",
          decidedAt: "2026-10-03T17:45:30.250Z",
        },
        {
          seq: "4",
          electionId: "cd".repeat(32),
          action: "hide",
          reason: "personal-data",
          decidedAt: "2026-10-01T12:00:00.000Z",
        },
        {
          seq: "1",
          electionId: "ab".repeat(32),
          action: "delist",
          reason: "spam",
          decidedAt: "2026-09-30T08:15:00.000Z",
        },
      ],
    },
    before: undefined,
    next: undefined,
    action: undefined,
  },
} satisfies Meta<typeof ModerationLog>;

export default meta;
type Story = StoryObj<typeof meta>;

const play: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("never on results");
  const reach = canvas.getByRole("region", { name: "What moderation can reach" });
  await expect(within(reach).getByText("The count and the result")).toBeVisible();
  const log = canvas.getByRole("list", { name: "Decisions, newest first" });
  const rows = within(log).getAllByRole("listitem");
  await expect(rows).toHaveLength(6);
  // Each row names its cells for assistive technology, whatever the width shows.
  await expect(within(rows[3]!).getByText("Ground")).toBeInTheDocument();
  await expect(within(log).getByText("Appeal upheld")).toBeVisible();
  await expect(within(log).getAllByRole("link", { name: /^cdcdcdcd/ })[0]).toHaveAttribute(
    "href",
    `/polls/${"cd".repeat(32)}`,
  );
  // A profile's row names it by handle alone, never its name, linking its page.
  await expect(within(rows[2]!).getByText("Profile")).toBeInTheDocument();
  await expect(within(rows[2]!).getByRole("link", { name: "k7qa2mzr5xw3bn4d" })).toHaveAttribute(
    "href",
    "/by/k7qa2mzr5xw3bn4d",
  );
  await expect(within(rows[2]!).getByText("Profile hidden")).toBeVisible();
  // A refiling links its poll and says what it changed, never the place itself.
  await expect(within(rows[1]!).getByRole("link", { name: /^efefefef/ })).toBeVisible();
  await expect(within(rows[1]!).getByText("Refiled")).toBeVisible();
  await expect(within(rows[1]!).getByText("Topic now Housing · Place changed")).toBeVisible();
  await expect(within(rows[1]!).getByText("Misfiled")).toBeVisible();
  await expect(within(rows[0]!).getByText("No topic · No place")).toBeVisible();
  // The fingerprint is a seal beside the link, not a second name for the poll.
  await expect(within(log).queryByRole("img")).toBeNull();
  await expect(canvas.getByText("October 1, 2026 at 12:00 PM UTC")).toBeVisible();
  await expect(canvas.queryByRole("link", { name: "Earlier decisions" })).toBeNull();
  // The filter offers every action on the page, a poll's hiding apart from a profile's.
  const filter = canvas.getByRole("radiogroup", { name: "Action" });
  const options = within(filter).getAllByRole("radio");
  await expect(options.map((option) => (option as HTMLInputElement).value)).toEqual([
    "all",
    "delist",
    "hide",
    "hide-profile",
    "restore",
    "refile",
  ]);
  await expect(within(filter).getByRole("radio", { name: "All 6" })).toBeChecked();
  await expect(within(filter).getByRole("radio", { name: "Refiled 2" })).toBeInTheDocument();
  await expect(canvas.queryByText(/decisions on this page took this action/)).toBeNull();
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
      within(canvasElement).getByRole("link", { name: "Earlier decisions" }),
    ).toHaveAttribute("href", "/moderation?before=9");
    // The latest page has no later one to go back to.
    await expect(
      within(canvasElement).queryByRole("link", { name: "Latest decisions" }),
    ).toBeNull();
  },
};

export const Filtered: Story = {
  args: { before: "30", next: "1", action: "hide" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const log = canvas.getByRole("list", { name: "Decisions, newest first" });
    // A poll's text hidden, never a profile hidden.
    const rows = within(log).getAllByRole("listitem");
    await expect(rows).toHaveLength(1);
    await expect(within(rows[0]!).getByText("Text hidden")).toBeVisible();
    await expect(
      canvas.getByText("1 of the 6 decisions on this page took this action."),
    ).toBeVisible();
    const filter = canvas.getByRole("radiogroup", { name: "Action" });
    await expect(within(filter).getByRole("radio", { name: "Text hidden 1" })).toBeChecked();
    // The form keeps the page it filters; the links keep the filter.
    await expect(canvasElement.querySelector('input[type="hidden"][name="before"]')).toHaveValue(
      "30",
    );
    await expect(canvas.getByRole("link", { name: "Clear filters" })).toHaveAttribute(
      "href",
      "/moderation?before=30",
    );
    await expect(canvas.getByRole("link", { name: "Earlier decisions" })).toHaveAttribute(
      "href",
      "/moderation?before=1&action=hide",
    );
    // An earlier page leads back to the latest, keeping the filter.
    await expect(canvas.getByRole("link", { name: "Latest decisions" })).toHaveAttribute(
      "href",
      "/moderation?action=hide",
    );
  },
};

export const FilteredToNone: Story = {
  args: { action: "delist", log: { entries: [meta.args.log.entries[2]!] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText(
        "No decision on this page took this action. Earlier decisions may have some.",
      ),
    ).toBeVisible();
    await expect(canvas.queryByRole("list", { name: "Decisions, newest first" })).toBeNull();
    // The chosen action stays offered, so it can be seen and cleared.
    const filter = canvas.getByRole("radiogroup", { name: "Action" });
    await expect(within(filter).getByRole("radio", { name: "Delisted 0" })).toBeChecked();
    await expect(canvas.getByRole("link", { name: "Clear filters" })).toHaveAttribute(
      "href",
      "/moderation",
    );
  },
};

export const Empty: Story = {
  args: { log: { entries: [] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("No decisions yet.")).toBeVisible();
    await expect(canvas.queryByRole("list", { name: "Decisions, newest first" })).toBeNull();
  },
};
