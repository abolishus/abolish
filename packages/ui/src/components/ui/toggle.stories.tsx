import type { Meta, StoryObj } from "@storybook/react-vite";
import { BookmarkIcon } from "lucide-react";
import { expect, userEvent, within } from "storybook/test";

import { Toggle } from "./toggle.tsx";

const meta = {
  component: Toggle,
  args: { "aria-label": "Follow this poll", variant: "outline" },
  render: (args) => (
    <Toggle {...args}>
      <BookmarkIcon aria-hidden="true" />
      Follow
    </Toggle>
  ),
} satisfies Meta<typeof Toggle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const toggle = within(canvasElement).getByRole("button", { name: "Follow this poll" });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
  },
};

export const Dark: Story = {
  args: { defaultPressed: true },
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button")).toHaveAttribute("aria-pressed", "true");
  },
};
