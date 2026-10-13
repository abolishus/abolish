import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { Spinner } from "./spinner.tsx";

const meta = {
  component: Spinner,
  args: { "aria-label": "Recording your ballot" },
} satisfies Meta<typeof Spinner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const spinner = within(canvasElement).getByRole("status", { name: "Recording your ballot" });
    await expect(spinner).toHaveClass("animate-spin");
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("status")).toBeVisible();
  },
};
