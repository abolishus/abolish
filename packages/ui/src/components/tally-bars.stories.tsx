import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { TallyBars } from "./tally-bars.tsx";

const meta = {
  component: TallyBars,
  args: {
    caption: "Among 40,112 document-verified voters",
    total: 40112,
    highlight: "yes",
    rows: [
      { key: "yes", label: "Yes, renew the levy", count: 23425 },
      { key: "no", label: "No", count: 16687 },
    ],
  },
} satisfies Meta<typeof TallyBars>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const figure = canvas.getByRole("figure", { name: "Among 40,112 document-verified voters" });
    const rows = within(figure).getAllByRole("listitem");
    await expect(rows).toHaveLength(2);
    await expect(rows[0]).toHaveTextContent("58.4%");
    await expect(rows[0]).toHaveTextContent("23,425");
  },
};

export const HalfDrawn: Story = {
  args: { progress: 0.5 },
  play: async ({ canvasElement }) => {
    // Bars follow progress; the figures beside them never change.
    await expect(within(canvasElement).getAllByRole("listitem")[1]).toHaveTextContent("41.6%");
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getAllByRole("listitem")).toHaveLength(2);
  },
};
