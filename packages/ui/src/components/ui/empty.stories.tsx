import type { Meta, StoryObj } from "@storybook/react-vite";
import { InboxIcon } from "lucide-react";
import { expect, within } from "storybook/test";

import { Button } from "./button.tsx";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./empty.tsx";

const meta = {
  component: Empty,
  render: (args) => (
    <Empty {...args} className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <InboxIcon aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>No receipts yet</EmptyTitle>
        <EmptyDescription>Receipts appear here once your ballot is on the board.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button>Browse open polls</Button>
      </EmptyContent>
    </Empty>
  ),
} satisfies Meta<typeof Empty>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("No receipts yet")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Browse open polls" })).toBeEnabled();
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText(/once your ballot is on the board/)).toBeVisible();
  },
};
