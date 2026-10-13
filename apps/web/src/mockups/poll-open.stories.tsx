import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { PollOpenPage } from "./poll-open-page.tsx";

const meta = {
  title: "Mockups/Web/Poll open",
  component: PollOpenPage,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof PollOpenPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Which improvements should the Riverside neighbourhood association ask the city for?",
    );
    // The ballot preview lists the options in the definition's order.
    const ballot = canvas.getByRole("figure", { name: /Ballot preview/ });
    await expect(
      within(ballot)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      "Better lighting on the river pathOption 1",
      "Public toilets open all yearOption 2",
      "Resurfaced basketball courtsOption 3",
      "Two hundred new street treesOption 4",
    ]);
    // Participation is per tier, each with its scope and as-of time; no running tally.
    const participation = canvas.getByRole("region", { name: "Ballots so far, tier by tier" });
    await expect(participation).toHaveTextContent(
      "document-verified voters have voted: 0.4% of 148,210 eligible.",
    );
    await expect(
      within(participation).getAllByText(/^As of 4 November 2026, 09:00 UTC$/),
    ).toHaveLength(3);
    await expect(canvas.queryByRole("note")).toBeNull();
    await expect(canvas.getByRole("link", { name: "Vote in the ballot client" })).toBeVisible();
  },
};

export const Dark: Story = {
  parameters: { layout: "fullscreen", theme: "dark" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("img", { name: /^Fingerprint of ballot client 723b 32ae$/ }),
    ).toBeVisible();
  },
};

export const Delisted: Story = {
  args: { delisted: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const notice = canvas.getByRole("note");
    await expect(notice).toHaveTextContent("This poll is delisted");
    await expect(notice).toHaveTextContent("Reason: Duplicate.");
    await expect(
      within(notice).getByRole("link", { name: "See the moderation log" }),
    ).toHaveAttribute("href", "/moderation");
    // Delisting changes where the poll is listed, not whether people can vote.
    await expect(canvas.getByRole("link", { name: "Vote in the ballot client" })).toBeVisible();
  },
};

export const DelistedDark: Story = {
  args: { delisted: true },
  parameters: { layout: "fullscreen", theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("note")).toBeVisible();
  },
};
