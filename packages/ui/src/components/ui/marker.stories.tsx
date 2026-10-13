import type { Meta, StoryObj } from "@storybook/react-vite";
import { LockIcon } from "lucide-react";
import { expect, within } from "storybook/test";

import { Marker, MarkerContent, MarkerIcon } from "./marker.tsx";

const meta = {
  component: Marker,
  args: { variant: "separator" },
  render: (args) => (
    <Marker {...args} role="separator" aria-label="Polls closed">
      <MarkerIcon>
        <LockIcon />
      </MarkerIcon>
      <MarkerContent>Polls closed at 20:00 UTC</MarkerContent>
    </Marker>
  ),
} satisfies Meta<typeof Marker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const marker = within(canvasElement).getByRole("separator", { name: "Polls closed" });
    await expect(marker).toHaveAttribute("data-variant", "separator");
    await expect(marker).toHaveTextContent("Polls closed at 20:00 UTC");
  },
};

export const Border: Story = {
  args: { variant: "border" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("separator")).toHaveAttribute(
      "data-variant",
      "border",
    );
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Polls closed at 20:00 UTC")).toBeVisible();
  },
};
