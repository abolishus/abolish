import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArrowRight } from "lucide-react";
import { expect, fn, userEvent, within } from "storybook/test";

import { Button, buttonVariants } from "./button.tsx";

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
    // The button ignores pointer events while disabled; dispatch the click anyway.
    await userEvent.setup({ pointerEventsCheck: 0 }).click(button);
    await expect(args.onClick).not.toHaveBeenCalled();
  },
};

/** A link drawn as a button takes the size's text, not the base's 12px. */
export const AsLink: Story = {
  render: () => (
    <a href="#next" className={buttonVariants({ size: "lg" })}>
      Continue
    </a>
  ),
  play: async ({ canvasElement }) => {
    const link = within(canvasElement).getByRole("link", { name: "Continue" });
    await expect(getComputedStyle(link).fontSize).toBe("16px");
  },
};

export const Outline: Story = {
  args: { variant: "outline" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button", { name: "Continue" })).toBeEnabled();
  },
};

export const Link: Story = {
  args: { variant: "link" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button", { name: "Continue" })).toBeEnabled();
  },
};

export const Secondary: Story = {
  args: { variant: "secondary" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button", { name: "Continue" })).toBeEnabled();
  },
};

export const Ghost: Story = {
  args: { variant: "ghost" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button", { name: "Continue" })).toBeEnabled();
  },
};

export const Destructive: Story = {
  args: { variant: "destructive", children: "Delete" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button", { name: "Delete" })).toBeEnabled();
  },
};

export const Large: Story = {
  args: { size: "lg" },
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole("button", { name: "Continue" });
    await expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(56);
  },
};

// The brief's "generous targets": every size is at least 48px both ways.
export const TargetSize: Story = {
  args: { children: "Go" },
  play: async ({ canvasElement }) => {
    const { height, width } = within(canvasElement)
      .getByRole("button", { name: "Go" })
      .getBoundingClientRect();
    await expect(height).toBeGreaterThanOrEqual(48);
    await expect(width).toBeGreaterThanOrEqual(48);
  },
};

export const IconOnly: Story = {
  args: { size: "icon", children: <ArrowRight aria-hidden="true" />, "aria-label": "Next" },
  play: async ({ canvasElement }) => {
    const { height, width } = within(canvasElement)
      .getByRole("button", { name: "Next" })
      .getBoundingClientRect();
    await expect(height).toBeGreaterThanOrEqual(48);
    await expect(width).toBeGreaterThanOrEqual(48);
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

export const DarkOutline: Story = {
  args: { variant: "outline" },
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button", { name: "Continue" })).toBeVisible();
  },
};

export const DarkLink: Story = {
  args: { variant: "link" },
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button", { name: "Continue" })).toBeVisible();
  },
};

export const DarkDestructive: Story = {
  args: { variant: "destructive", children: "Delete" },
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button", { name: "Delete" })).toBeVisible();
  },
};

export const DarkSecondary: Story = {
  args: { variant: "secondary" },
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button", { name: "Continue" })).toBeVisible();
  },
};

export const DarkGhost: Story = {
  args: { variant: "ghost" },
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button", { name: "Continue" })).toBeVisible();
  },
};
