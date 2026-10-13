import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { EverydayBallot } from "./everyday-ballot.tsx";
import { ANSWERED, RIVERSIDE } from "./everyday-fixtures.ts";

const meta = {
  title: "Mockups/Ballot/Everyday/Sending",
  component: EverydayBallot,
  args: { poll: RIVERSIDE, start: { name: "sending" }, answers: ANSWERED },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof EverydayBallot>;

export default meta;
type Story = StoryObj<typeof meta>;

const sending: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("Sending your answers");
  const steps = within(canvas.getByRole("list", { name: "Your answers" })).getAllByRole("listitem");
  await expect(steps.map((li) => li.querySelector(".sr-only")?.textContent)).toEqual([
    "Sealed on this device, done",
    "Sent to the public board, in progress",
    "Counted, not yet",
  ]);
  await expect(steps[1]).toHaveAttribute("aria-current", "step");
  // A still, brief screen: nothing to press, and no spinner.
  await expect(canvas.queryByRole("button")).toBeNull();
  await expect(canvasElement.querySelector(".animate-spin")).toBeNull();
};

export const Sending: Story = { play: sending };

export const Dark: Story = {
  parameters: { layout: "fullscreen", theme: "dark" },
  play: sending,
};
