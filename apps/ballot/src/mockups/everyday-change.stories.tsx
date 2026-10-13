import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { EverydayBallot } from "./everyday-ballot.tsx";
import { RIVERSIDE } from "./everyday-fixtures.ts";

const meta = {
  title: "Mockups/Ballot/Everyday/Change your answers",
  component: EverydayBallot,
  args: { poll: RIVERSIDE, start: { name: "returning" } },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof EverydayBallot>;

export default meta;
type Story = StoryObj<typeof meta>;

const startFresh: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
    "You've already answered this poll",
  );
  await expect(canvas.getByText(/Your new answers replace all of your earlier ones/)).toBeVisible();
  await expect(canvas.getByText(/only your last answers count/)).toBeVisible();
  await expect(canvas.getByRole("heading", { name: "You'll start fresh" })).toBeVisible();
  // Why, plainly: nothing on the phone shows how they answered.
  await expect(
    canvas.getByText(/no one who picks up your phone can see how you answered/),
  ).toBeVisible();
  await expect(canvas.getByRole("link", { name: "Keep my earlier answers" })).toBeVisible();
  await userEvent.click(canvas.getByRole("button", { name: "Change my answers" }));
  await expect(canvas.getByText("Question 1 of 3")).toBeVisible();
  for (const radio of canvas.getAllByRole("radio")) await expect(radio).not.toBeChecked();
  await expect(canvas.queryByText("Selected")).toBeNull();
};

export const StartFresh: Story = { name: "Start fresh", play: startFresh };

export const Dark: Story = {
  name: "Start fresh, dark",
  parameters: { layout: "fullscreen", theme: "dark" },
  play: startFresh,
};
