import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { Button } from "./button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./collapsible.tsx";

const meta = {
  component: Collapsible,
  render: (args) => (
    <Collapsible {...args}>
      <CollapsibleTrigger render={<Button variant="outline" />}>
        How is my ballot counted?
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2 text-sm">
        Your ballot is encrypted on your device, recorded on the board, then counted with every
        other entry.
      </CollapsibleContent>
    </Collapsible>
  ),
} satisfies Meta<typeof Collapsible>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("button", { name: "How is my ballot counted?" });
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(trigger);
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(canvas.getByText(/encrypted on your device/)).toBeVisible();
  },
};

export const Dark: Story = {
  args: { defaultOpen: true },
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText(/encrypted on your device/)).toBeVisible();
  },
};
