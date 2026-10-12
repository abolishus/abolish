import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";

import { Button } from "./button.tsx";

const meta = {
  component: Button,
  args: { children: "Continue", onClick: fn() },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ args, canvasElement }) => {
    const button = within(canvasElement).getByRole("button", { name: "Continue" });
    await userEvent.click(button);
    await expect(args.onClick).toHaveBeenCalledOnce();
  },
};

export const KeyboardActivation: Story = {
  play: async ({ args, canvasElement }) => {
    const button = within(canvasElement).getByRole("button", { name: "Continue" });
    await userEvent.tab();
    await expect(button).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    await expect(args.onClick).toHaveBeenCalledTimes(2);
  },
};

export const Disabled: Story = {
  args: { disabled: true },
  play: async ({ args, canvasElement }) => {
    const button = within(canvasElement).getByRole("button", { name: "Continue" });
    await expect(button).toBeDisabled();
    await userEvent.click(button);
    await expect(args.onClick).not.toHaveBeenCalled();
  },
};

export const Secondary: Story = {
  args: { variant: "secondary" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button", { name: "Continue" })).toBeEnabled();
  },
};

export const Quiet: Story = {
  args: { variant: "quiet" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button", { name: "Continue" })).toBeEnabled();
  },
};

export const SubmitsOnlyWhenAsked: Story = {
  play: async ({ canvasElement }) => {
    // A button inside a form must not submit it by accident.
    await expect(within(canvasElement).getByRole("button", { name: "Continue" })).toHaveAttribute(
      "type",
      "button",
    );
  },
};

export const DarkPrimary: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button", { name: "Continue" })).toBeVisible();
  },
};

export const DarkSecondary: Story = {
  args: { variant: "secondary" },
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button", { name: "Continue" })).toBeVisible();
  },
};

export const DarkQuiet: Story = {
  args: { variant: "quiet" },
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button", { name: "Continue" })).toBeVisible();
  },
};
