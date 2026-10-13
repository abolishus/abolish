import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { Failed, NotFound, SiteLayout } from "./site-layout.tsx";

const meta = {
  component: SiteLayout,
  parameters: { layout: "fullscreen" },
  args: { children: <NotFound /> },
} satisfies Meta<typeof SiteLayout>;

export default meta;
type Story = StoryObj<typeof meta>;

const play: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const nav = canvas.getByRole("navigation", { name: "Site" });
  await expect(within(nav).getByRole("link", { name: "Moderation log" })).toHaveAttribute(
    "href",
    "/moderation",
  );
  await expect(canvas.getByRole("main")).toBeVisible();
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
    "There is no page at this address",
  );
  const ways = canvas.getByRole("navigation", { name: "Other places to go" });
  await expect(within(ways).getByRole("link", { name: /^Polls/ })).toHaveAttribute(
    "href",
    "/polls",
  );
  await userEvent.tab();
  await expect(canvas.getByRole("link", { name: "Skip to content" })).toHaveFocus();
};

export const Default: Story = { play };

export const Dark: Story = { parameters: { theme: "dark" }, play };

export const Current: Story = {
  args: { current: "/polls" },
  play: async ({ canvasElement }) => {
    const nav = within(canvasElement).getByRole("navigation", { name: "Site" });
    await expect(within(nav).getByRole("link", { name: "Polls" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(within(nav).getByRole("link", { name: "Moderation log" })).not.toHaveAttribute(
      "aria-current",
    );
  },
};

export const Error: Story = {
  args: { children: <Failed /> },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Something went wrong on our side",
    );
    // Says nothing about the error itself: no codes, traces or request IDs.
    await expect(canvasElement.querySelector("main")?.textContent ?? "").not.toMatch(
      /\b(5\d\d|stack|exception|request id|trace)\b/i,
    );
    await expect(canvas.getByRole("button", { name: "Try again" })).toBeEnabled();
  },
};
