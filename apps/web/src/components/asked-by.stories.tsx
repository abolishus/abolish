import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { AskedBy } from "./asked-by.tsx";

const meta = {
  component: AskedBy,
  args: { askedBy: { handle: "k7qa2mzr5xw3bn4d", name: "Riverside Neighbours" } },
} satisfies Meta<typeof AskedBy>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The name, a link to the profile's page. */
const play: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByText(/Asked by/)).toBeVisible();
  await expect(canvas.getByRole("link", { name: "Riverside Neighbours" })).toHaveAttribute(
    "href",
    "/by/k7qa2mzr5xw3bn4d",
  );
};

export const Default: Story = { play };

export const Dark: Story = { parameters: { theme: "dark" }, play };

/** A name in another script keeps its own direction, not the sentence's (T-75). */
export const RightToLeft: Story = {
  args: { askedBy: { handle: "k7qa2mzr5xw3bn4d", name: "جيران حي الزيتون" } },
  play: async ({ canvasElement }) => {
    const link = within(canvasElement).getByRole("link", { name: "جيران حي الزيتون" });
    await expect(link.querySelector("bdi")).toHaveTextContent("جيران حي الزيتون");
  },
};

/** The longest name a profile can have, unbroken, wraps rather than overflowing at 360px. */
export const LongName: Story = {
  args: { askedBy: { handle: "k7qa2mzr5xw3bn4d", name: "W".repeat(60) } },
  play: async ({ canvasElement }) => {
    const link = within(canvasElement).getByRole("link", { name: "W".repeat(60) });
    await expect(link.getBoundingClientRect().right).toBeLessThanOrEqual(
      canvasElement.getBoundingClientRect().right + 1,
    );
  },
};
