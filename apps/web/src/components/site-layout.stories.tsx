import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { Failed, NotFound, Offline, SiteLayout } from "./site-layout.tsx";

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
  // Where an everyday visitor finds a shared poll again, by its question.
  await expect(within(ways).getByRole("link", { name: /^Discover/ })).toHaveAttribute(
    "href",
    "/discover",
  );
  await expect(within(ways).getAllByRole("link")).toHaveLength(4);
  await expect(canvas.getByRole("main")).not.toHaveTextContent(/64-character|board entries/);
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

const offline: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("You're offline");
  await expect(canvas.getByText(/keeps only this page and its fonts/)).toBeVisible();
  // Served with no script, trying again is a link to the address in the bar
  // (tests/ssr.test.ts has the served page's own, empty, `href`).
  await expect(canvas.getByRole("link", { name: "Try again" })).toHaveAttribute(
    "href",
    "/polls?after=3",
  );
  await expect(canvas.queryByRole("button")).toBeNull();
  // Offline, every other page fails as this one did, so it offers none.
  await expect(canvas.queryByRole("navigation", { name: "Other places to go" })).toBeNull();
  await expect(getComputedStyle(canvas.getByRole("link", { name: "Try again" })).fontSize).toBe(
    "16px",
  );
};

/** What the offline shell shows when a page can't be fetched (src/app/offline.ts). */
export const OfflinePage: Story = {
  args: { children: <Offline retry="/polls?after=3" /> },
  play: offline,
};

export const OfflineDark: Story = {
  args: { children: <Offline retry="/polls?after=3" /> },
  parameters: { theme: "dark" },
  play: offline,
};
