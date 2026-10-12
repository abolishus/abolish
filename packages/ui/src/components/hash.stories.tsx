import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { Hash } from "./hash.tsx";

const value = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

const meta = {
  component: Hash,
  args: { value, label: "Receipt hash" },
} satisfies Meta<typeof Hash>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const figure = within(canvasElement).getByRole("figure", { name: "Receipt hash" });
    const code = figure.querySelector("code");
    // Grouping is visual only: the text a voter copies is the exact value.
    await expect(code?.textContent).toBe(value);
    await expect(code).toHaveAttribute("translate", "no");
    await expect(code?.children).toHaveLength(16);
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("figure", { name: "Receipt hash" })).toBeVisible();
  },
};
