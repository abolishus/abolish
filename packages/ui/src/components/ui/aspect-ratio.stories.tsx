import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { AspectRatio } from "./aspect-ratio.tsx";

const meta = {
  component: AspectRatio,
  args: { ratio: 16 / 9 },
  render: (args) => (
    <div className="w-80">
      <AspectRatio {...args} role="img" aria-label="Polling place map" className="bg-muted" />
    </div>
  ),
} satisfies Meta<typeof AspectRatio>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const { width, height } = within(canvasElement)
      .getByRole("img", { name: "Polling place map" })
      .getBoundingClientRect();
    await expect(width / height).toBeCloseTo(16 / 9, 1);
  },
};

export const Square: Story = {
  args: { ratio: 1 },
  play: async ({ canvasElement }) => {
    const { width, height } = within(canvasElement).getByRole("img").getBoundingClientRect();
    await expect(width).toBeCloseTo(height, 0);
  },
};
