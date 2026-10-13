import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { SectionMark } from "./section-mark.tsx";

const meta = {
  component: SectionMark,
  args: { index: "02", children: "Turnout by tier" },
} satisfies Meta<typeof SectionMark>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Turnout by tier")).toBeVisible();
    await expect(within(canvasElement).getByText("02")).toBeVisible();
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Turnout by tier")).toBeVisible();
  },
};
