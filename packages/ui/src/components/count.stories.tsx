import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { Count } from "./count.tsx";

const meta = {
  component: Count,
  args: { value: 40112 },
} satisfies Meta<typeof Count>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const count = canvasElement.querySelector("data");
    await expect(count).toHaveTextContent("40,112");
    await expect(count).toHaveAttribute("value", "40112");
  },
};

export const GermanGrouping: Story = {
  parameters: { locale: "de-DE" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("40.112")).toHaveAttribute("value", "40112");
  },
};

export const BeyondSafeIntegers: Story = {
  args: { value: 12345678901234567890n },
  play: async ({ canvasElement }) => {
    const count = canvasElement.querySelector("data");
    await expect(count).toHaveTextContent("12,345,678,901,234,567,890");
    await expect(count).toHaveAttribute("value", "12345678901234567890");
  },
};
