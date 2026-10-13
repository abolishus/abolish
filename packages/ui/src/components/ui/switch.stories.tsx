import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { Switch } from "./switch.tsx";

const meta = {
  component: Switch,
  render: (args) => (
    <label className="flex items-center gap-3 text-sm">
      <Switch {...args} />
      Email me my receipt
    </label>
  ),
} satisfies Meta<typeof Switch>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const toggle = within(canvasElement).getByRole("switch", { name: "Email me my receipt" });
    await expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);
    await expect(toggle).toBeChecked();
  },
};

export const Dark: Story = {
  args: { defaultChecked: true },
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("switch")).toBeChecked();
  },
};
