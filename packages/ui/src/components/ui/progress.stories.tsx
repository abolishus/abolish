import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { Progress, ProgressLabel, ProgressValue } from "./progress.tsx";

const meta = {
  component: Progress,
  args: { value: 64 },
  render: (args) => (
    <Progress {...args}>
      <ProgressLabel>Ballots counted</ProgressLabel>
      <ProgressValue />
    </Progress>
  ),
} satisfies Meta<typeof Progress>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const bar = within(canvasElement).getByRole("progressbar", { name: "Ballots counted" });
    await expect(bar).toHaveAttribute("aria-valuenow", "64");
    await expect(bar).toHaveTextContent("64%");
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("progressbar")).toBeVisible();
  },
};
