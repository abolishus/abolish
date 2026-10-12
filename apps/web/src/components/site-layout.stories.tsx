import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { Failed, NotFound, SiteLayout } from "./site-layout.tsx";

const meta = {
  component: SiteLayout,
  args: { children: <NotFound /> },
} satisfies Meta<typeof SiteLayout>;

export default meta;
type Story = StoryObj<typeof meta>;

const play: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const nav = canvas.getByRole("navigation", { name: "Abolish" });
  await expect(within(nav).getByRole("link", { name: "Moderation log" })).toHaveAttribute(
    "href",
    "/moderation",
  );
  await expect(canvas.getByRole("main")).toBeVisible();
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("Not found");
};

export const Default: Story = { play };

export const Dark: Story = { parameters: { theme: "dark" }, play };

export const Error: Story = {
  args: { children: <Failed /> },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("heading", { level: 1 })).toHaveTextContent(
      "Something went wrong",
    );
  },
};
