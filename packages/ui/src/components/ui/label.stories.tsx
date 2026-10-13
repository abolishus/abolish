import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { Label } from "./label.tsx";

const meta = {
  component: Label,
  render: (args) => (
    <div className="flex flex-col gap-2">
      <Label {...args} htmlFor="postcode">
        Postcode
      </Label>
      <input id="postcode" className="h-12 border border-input bg-transparent px-3" />
    </div>
  ),
} satisfies Meta<typeof Label>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText("Postcode"));
    await expect(canvas.getByRole("textbox", { name: "Postcode" })).toHaveFocus();
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Postcode")).toBeVisible();
  },
};
