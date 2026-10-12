import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { LookupForm } from "./lookup-form.tsx";

const meta = { component: LookupForm } satisfies Meta<typeof LookupForm>;

export default meta;
type Story = StoryObj<typeof meta>;

const play: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const input = canvas.getByRole("textbox", { name: "Poll ID" });
  await expect(input).toHaveAccessibleDescription(/64-character ID/);
  await expect(input).not.toHaveAttribute("aria-invalid");
  await userEvent.type(input, "0xABCD");
  await expect(input).toHaveValue("0xABCD");
  await expect(canvas.getByRole("button", { name: "Open poll" })).toHaveAttribute("type", "submit");
};

export const Default: Story = { play };

export const Dark: Story = { parameters: { theme: "dark" }, play };

export const Invalid: Story = {
  args: { invalid: "not-an-id" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByRole("textbox", { name: "Poll ID" });
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(input).toHaveValue("not-an-id");
    await expect(input).toHaveAccessibleDescription(/64 hexadecimal characters/);
    await expect(canvas.getByRole("alert")).toBeVisible();
  },
};
