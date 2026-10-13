import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { Input } from "./input.tsx";

const meta = {
  component: Input,
  args: { "aria-label": "Poll code", placeholder: "e.g. LIB-2026" },
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const input = within(canvasElement).getByRole("textbox", { name: "Poll code" });
    await userEvent.type(input, "LIB-2026");
    await expect(input).toHaveValue("LIB-2026");
  },
};

export const Disabled: Story = {
  args: { disabled: true, defaultValue: "LIB-2026" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("textbox", { name: "Poll code" })).toBeDisabled();
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    const input = within(canvasElement).getByRole("textbox", { name: "Poll code" });
    await userEvent.type(input, "PARK");
    await expect(input).toHaveValue("PARK");
  },
};
