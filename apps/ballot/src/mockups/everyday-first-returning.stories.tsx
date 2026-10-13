import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { FirstAnswer } from "./everyday-first-ballot.tsx";
import { LIBRARY, TAPPED_LIBRARY } from "./everyday-first-fixtures.ts";

const meta = {
  title: "Mockups/Ballot/Everyday/First time/Returning",
  component: FirstAnswer,
  args: { poll: LIBRARY, prefill: TAPPED_LIBRARY, visitor: "returning" },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof FirstAnswer>;

export default meta;
type Story = StoryObj<typeof meta>;

const sameDevice: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  // Already set up: straight to the question, nothing about setup.
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(LIBRARY.title);
  await expect(canvas.queryByText("First time here?")).toBeNull();
  await expect(canvas.queryByText(/Setting up this device/)).toBeNull();
  await expect(canvas.getByRole("radio", { name: "10:00 to 16:00" })).toBeChecked();
  await userEvent.click(canvas.getByRole("button", { name: "Send my answer" }));
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("Sending your answer");
  const trail = canvas.getByRole("list", { name: "Your answer" });
  await expect(trail).not.toHaveTextContent("joins the people who can answer");
  await expect(canvas.queryByRole("button", { name: "Back up with a passkey" })).toBeNull();
};

export const SameDevice: Story = { name: "Same device", play: sameDevice };

export const SameDeviceDone: Story = {
  name: "Same device, done",
  args: { start: { name: "done" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("Your answer is in");
    // Offered once, on the first answer; not on every one after.
    await expect(canvas.queryByRole("heading", { name: "Back up with a passkey?" })).toBeNull();
  },
};

export const Dark: Story = {
  name: "Same device, dark",
  parameters: { layout: "fullscreen", theme: "dark" },
  play: sameDevice,
};
