import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { PollScheduledPage } from "./poll-scheduled-page.tsx";

const meta = {
  title: "Mockups/Web/Poll scheduled",
  component: PollScheduledPage,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof PollScheduledPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Should the state issue $4.2 billion in bonds for regional rail and bus rapid transit?",
    );
    await expect(canvas.getByText("Scheduled")).toBeVisible();
    // The opening time is stated plainly; nothing counts down.
    await expect(canvas.getAllByText("8 December 2026, 06:00 UTC").length).toBeGreaterThan(0);
    await expect(canvas.queryByText(/days? (left|to go)|remaining/i)).toBeNull();

    // Each tier's registered electorate, with its weekly snapshots.
    const electorate = canvas.getByRole("region", { name: "Who is registered, tier by tier" });
    await expect(electorate).toHaveTextContent("412,880registered document-verified voters");
    await expect(
      within(electorate).getByRole("figure", { name: "Registered passkey-only voters, weekly" }),
    ).toHaveTextContent("12 Oct: 1,102,540");

    // The ceremony trail runs complete, then one in progress, then not started.
    const trail = canvas.getByRole("list", { name: "Key ceremony" });
    await expect(
      within(trail).getByText("Commitments posted to the board, in progress"),
    ).toBeInTheDocument();
    await expect(canvas.getByRole("heading", { name: "Commitments: 6 of 7 posted" })).toBeVisible();
    await expect(canvas.getByRole("link", { name: "Start document verification" })).toHaveAttribute(
      "href",
      "/account/verify",
    );
  },
};

export const Dark: Story = {
  parameters: { layout: "fullscreen", theme: "dark" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("img", { name: /^Fingerprint of ceremony transcript a8e2 f05c$/ }),
    ).toBeVisible();
    await expect(canvas.getByText("Awaiting")).toBeVisible();
  },
};
