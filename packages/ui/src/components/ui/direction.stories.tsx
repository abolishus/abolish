import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { DirectionProvider, useDirection } from "./direction.tsx";

function DirectionReadout() {
  const direction = useDirection();
  return <p>Reading direction: {direction}</p>;
}

const meta = {
  component: DirectionProvider,
  args: { direction: "rtl" },
  render: (args) => (
    <DirectionProvider {...args}>
      <div dir={args.direction}>
        <DirectionReadout />
      </div>
    </DirectionProvider>
  ),
} satisfies Meta<typeof DirectionProvider>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Reading direction: rtl")).toBeVisible();
  },
};

export const LeftToRight: Story = {
  args: { direction: "ltr" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Reading direction: ltr")).toBeVisible();
  },
};
