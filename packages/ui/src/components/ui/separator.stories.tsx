import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { Separator } from "./separator.tsx";

const meta = {
  component: Separator,
  render: (args) => (
    <div className="flex flex-col gap-3 text-sm">
      <p>Library levy</p>
      <Separator {...args} />
      <div className="flex h-5 items-center gap-3">
        <span>Board</span>
        <Separator orientation="vertical" />
        <span>Trustees</span>
      </div>
    </div>
  ),
} satisfies Meta<typeof Separator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const [horizontal, vertical] = within(canvasElement).getAllByRole("separator");
    await expect(horizontal).toHaveAttribute("aria-orientation", "horizontal");
    await expect(vertical).toHaveAttribute("aria-orientation", "vertical");
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getAllByRole("separator")).toHaveLength(2);
  },
};
