import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { Skeleton } from "./skeleton.tsx";

const meta = {
  component: Skeleton,
  render: (args) => (
    <div role="status" aria-label="Loading ballot" className="flex w-64 flex-col gap-2">
      <Skeleton {...args} className="h-5 w-3/4" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  ),
} satisfies Meta<typeof Skeleton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const status = within(canvasElement).getByRole("status", { name: "Loading ballot" });
    await expect(status.querySelectorAll("[data-slot=skeleton]")).toHaveLength(3);
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("status")).toBeVisible();
  },
};
