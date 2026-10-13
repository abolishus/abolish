import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { Slider } from "./slider.tsx";

const meta = {
  component: Slider,
  args: { defaultValue: [5], min: 0, max: 10, "aria-labelledby": "agreement-label" },
  render: (args) => (
    <div className="flex w-64 flex-col gap-3 text-sm">
      <span id="agreement-label">How strongly do you agree?</span>
      <Slider {...args} />
    </div>
  ),
} satisfies Meta<typeof Slider>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const thumb = within(canvasElement).getByRole("slider", { name: "How strongly do you agree?" });
    await expect(thumb).toHaveAttribute("aria-valuenow", "5");
    thumb.focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect(thumb).toHaveAttribute("aria-valuenow", "6");
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("slider")).toBeInTheDocument();
  },
};
