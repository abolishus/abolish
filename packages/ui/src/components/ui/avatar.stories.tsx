import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount } from "./avatar.tsx";

const meta = {
  component: Avatar,
  render: (args) => (
    <AvatarGroup role="group" aria-label="Trustees">
      <Avatar {...args}>
        <AvatarFallback>AM</AvatarFallback>
      </Avatar>
      <Avatar {...args}>
        <AvatarFallback>JK</AvatarFallback>
      </Avatar>
      <AvatarGroupCount>+3</AvatarGroupCount>
    </AvatarGroup>
  ),
} satisfies Meta<typeof Avatar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const group = within(canvasElement).getByRole("group", { name: "Trustees" });
    await expect(within(group).getByText("AM")).toBeVisible();
    await expect(within(group).getByText("+3")).toBeVisible();
  },
};

export const Large: Story = {
  args: { size: "lg" },
  play: async ({ canvasElement }) => {
    const avatar = canvasElement.querySelector("[data-slot=avatar]");
    await expect(avatar).toHaveAttribute("data-size", "lg");
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("JK")).toBeVisible();
  },
};
