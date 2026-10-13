import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { Count } from "./count.tsx";
import { StatFigure } from "./stat-figure.tsx";

const meta = {
  component: StatFigure,
  args: {
    value: <Count value={40112} />,
    label: "Ballots recorded",
    scope: "Document-verified voters, as of 14:00 UTC",
  },
} satisfies Meta<typeof StatFigure>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("40,112")).toBeVisible();
    await expect(canvas.getByText("Document-verified voters, as of 14:00 UTC")).toBeVisible();
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Ballots recorded")).toBeVisible();
  },
};
