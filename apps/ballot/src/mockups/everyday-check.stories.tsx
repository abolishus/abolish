import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { EverydayBallot } from "./everyday-ballot.tsx";
import { ANSWERED, RIVERSIDE } from "./everyday-fixtures.ts";

const meta = {
  title: "Mockups/Ballot/Everyday/Check",
  component: EverydayBallot,
  args: { poll: RIVERSIDE, start: { name: "check" }, answers: ANSWERED },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof EverydayBallot>;

export default meta;
type Story = StoryObj<typeof meta>;

const allAnswered: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("Check your answers");
  const questions = [...canvas.getByRole("list", { name: "Your answers" }).children];
  await expect(questions).toHaveLength(3);
  await expect(questions[0]).toHaveTextContent("Public toilets open all year");
  await expect(questions[1]).toHaveTextContent("A Saturday farmers' market");
  await expect(questions[1]).toHaveTextContent("Monthly river clean-up");
  await expect(questions[2]).toHaveTextContent("Not very safe");
  await expect(canvas.queryByText(/You skipped/)).toBeNull();
  await expect(canvas.getByRole("button", { name: "Send my answers" })).toBeVisible();
  await expect(canvas.getByRole("button", { name: "Check the encryption first" })).toBeVisible();
  // Change returns to that question, with the answers kept, and back here.
  await userEvent.click(canvas.getByRole("button", { name: "Change your answer to question 2" }));
  await expect(canvas.getByText("Question 2 of 3")).toBeVisible();
  await expect(canvas.getByRole("checkbox", { name: "A Saturday farmers' market" })).toBeChecked();
  await userEvent.click(canvas.getByText("Monthly river clean-up"));
  await userEvent.click(canvas.getByText("Free concerts in the bandstand"));
  await userEvent.click(canvas.getByRole("button", { name: "Check your answers" }));
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("Check your answers");
  await expect(canvas.getByText("Free concerts in the bandstand")).toBeVisible();
  await expect(canvas.queryByText("Monthly river clean-up")).toBeNull();
};

export const AllAnswered: Story = { name: "All answered", play: allAnswered };

export const WithASkip: Story = {
  name: "With a skipped question",
  args: { answers: { ...ANSWERED, events: [] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("You skipped question 2")).toBeVisible();
    await expect(canvas.getByText("Skipped: counts as no answer")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Change your answer to question 2" }));
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Which events would you go to?",
    );
    await expect(canvas.getAllByRole("status")[0]).toHaveTextContent("0 of 2 chosen");
  },
};

export const CheckTheEncryption: Story = {
  name: "Check the encryption first",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText(/can never be counted, so you then send a fresh one/),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Check the encryption first" }));
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Your sealed answers, opened",
    );
    await expect(canvas.getByText("This is what you chose")).toBeVisible();
    await expect(canvas.getByText("Public toilets open all year")).toBeVisible();
    await expect(canvas.getByText(/entry 2,429/)).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "Send my answers" })).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Back to my answers" }));
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("Check your answers");
  },
};

export const Dark: Story = {
  name: "All answered, dark",
  parameters: { layout: "fullscreen", theme: "dark" },
  play: allAnswered,
};
