import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { Badge } from "./badge.tsx";

const meta = {
  component: Badge,
  render: (args) => (
    <div className="flex gap-2">
      <Badge {...args}>Verified</Badge>
      <Badge variant="secondary">Tier 2</Badge>
      <Badge variant="outline">Pending</Badge>
      <Badge variant="destructive">Rejected</Badge>
    </div>
  ),
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const badge = within(canvasElement).getByText("Verified");
    await expect(badge).toHaveAttribute("data-slot", "badge");
    await expect(within(canvasElement).getByText("Rejected")).toBeVisible();
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Tier 2")).toBeVisible();
  },
};
