import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { ToggleGroup, ToggleGroupItem } from "./toggle-group.tsx";

const meta = {
  component: ToggleGroup,
  args: { "aria-label": "Verification tier", defaultValue: ["all"], variant: "outline" },
  render: (args) => (
    <ToggleGroup {...args}>
      <ToggleGroupItem value="all">All voters</ToggleGroupItem>
      <ToggleGroupItem value="verified">Verified</ToggleGroupItem>
      <ToggleGroupItem value="resident">Residents</ToggleGroupItem>
    </ToggleGroup>
  ),
} satisfies Meta<typeof ToggleGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const group = within(canvasElement).getByRole("group", { name: "Verification tier" });
    const verified = within(group).getByRole("button", { name: "Verified" });
    await userEvent.click(verified);
    await expect(verified).toHaveAttribute("aria-pressed", "true");
    await expect(within(group).getByRole("button", { name: "All voters" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button", { name: "All voters" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  },
};
