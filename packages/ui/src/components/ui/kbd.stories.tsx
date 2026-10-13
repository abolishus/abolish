import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { Kbd, KbdGroup } from "./kbd.tsx";

const meta = {
  component: Kbd,
  render: () => (
    <p className="text-sm">
      Copy the receipt hash with{" "}
      <KbdGroup>
        <Kbd>Ctrl</Kbd>
        <Kbd>C</Kbd>
      </KbdGroup>
    </p>
  ),
} satisfies Meta<typeof Kbd>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const key = within(canvasElement).getByText("Ctrl");
    await expect(key.tagName).toBe("KBD");
    await expect(key.closest("[data-slot=kbd-group]")).toHaveTextContent("CtrlC");
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("C")).toBeVisible();
  },
};
