import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { Button } from "./button.tsx";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip.tsx";

const meta = {
  component: Tooltip,
  render: (args) => (
    <TooltipProvider>
      <Tooltip {...args}>
        <TooltipTrigger render={<Button variant="outline" />}>Anchored</TooltipTrigger>
        <TooltipContent>The board's latest root is on Ethereum.</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ),
} satisfies Meta<typeof Tooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.hover(within(canvasElement).getByRole("button", { name: "Anchored" }));
    const body = within(canvasElement.ownerDocument.body);
    const tip = await body.findByText("The board's latest root is on Ethereum.");
    await waitFor(() => expect(tip).toBeVisible());
  },
};

export const Dark: Story = {
  args: { defaultOpen: true },
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const tip = await body.findByText("The board's latest root is on Ethereum.");
    await waitFor(() => expect(tip).toBeVisible());
  },
};
