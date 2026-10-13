import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { Bubble, BubbleContent, BubbleGroup } from "./bubble.tsx";

const meta = {
  component: Bubble,
  args: { variant: "default" },
  render: (args) => (
    <BubbleGroup>
      <Bubble variant="muted">
        <BubbleContent>When does the library levy poll close?</BubbleContent>
      </Bubble>
      <Bubble {...args} align="end">
        <BubbleContent>3 November at 20:00 UTC.</BubbleContent>
      </Bubble>
    </BubbleGroup>
  ),
} satisfies Meta<typeof Bubble>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const reply = within(canvasElement).getByText("3 November at 20:00 UTC.");
    await expect(reply.closest("[data-slot=bubble]")).toHaveAttribute("data-align", "end");
  },
};

export const Outline: Story = {
  args: { variant: "outline" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("3 November at 20:00 UTC.")).toBeVisible();
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("3 November at 20:00 UTC.")).toBeVisible();
  },
};

export const DarkTinted: Story = {
  args: { variant: "tinted" },
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("3 November at 20:00 UTC.")).toBeVisible();
  },
};
