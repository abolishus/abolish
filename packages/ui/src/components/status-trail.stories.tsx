import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { StatusTrail } from "./status-trail.tsx";

const stateLabels = { complete: "done", pending: "in progress", upcoming: "not yet" };

const meta = {
  component: StatusTrail,
  args: {
    label: "Your ballot",
    stateLabels,
    stepTemplate: "{step}, {state}",
    steps: [
      { label: "Encrypted on this device", state: "complete" },
      { label: "Recorded on the board", state: "complete", detail: "Entry 40,112" },
      { label: "Anchored to Ethereum", state: "pending", detail: "Next anchor within the hour" },
      { label: "Counted", state: "upcoming" },
    ],
  },
} satisfies Meta<typeof StatusTrail>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const trail = within(canvasElement).getByRole("list", { name: "Your ballot" });
    const steps = within(trail).getAllByRole("listitem");
    await expect(steps).toHaveLength(4);
    // Each step's state is in words, not only in its colour and icon, and
    // a screen reader hears exactly the template's text.
    const heard = steps.map((step) => step.querySelector(".sr-only")?.textContent);
    await expect(heard).toEqual([
      "Encrypted on this device, done",
      "Recorded on the board, done",
      "Anchored to Ethereum, in progress",
      "Counted, not yet",
    ]);
    await expect(steps[2]).toHaveAttribute("aria-current", "step");
    await expect(steps[3]).toHaveTextContent("Counted, not yet");
  },
};

export const Counted: Story = {
  args: {
    steps: [
      { label: "Encrypted on this device", state: "complete" },
      { label: "Recorded on the board", state: "complete" },
      { label: "Anchored to Ethereum", state: "complete" },
      { label: "Counted", state: "complete" },
    ],
  },
  play: async ({ canvasElement }) => {
    const trail = within(canvasElement).getByRole("list");
    await expect(trail.querySelector("[aria-current]")).toBeNull();
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("list")).toBeVisible();
  },
};

export const LocaleTemplate: Story = {
  args: { stepTemplate: "{step} \u2014 {state}" },
  play: async ({ canvasElement }) => {
    const first = within(canvasElement).getAllByRole("listitem")[0];
    // The joining punctuation is the caller's, never hard-coded.
    await expect(first?.querySelector(".sr-only")?.textContent).toBe(
      "Encrypted on this device \u2014 done",
    );
  },
};
