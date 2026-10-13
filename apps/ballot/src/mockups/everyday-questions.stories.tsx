import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { EverydayBallot } from "./everyday-ballot.tsx";
import { RIVERSIDE, RIVERSIDE_EXACTLY } from "./everyday-fixtures.ts";

const meta = {
  title: "Mockups/Ballot/Everyday/Questions",
  component: EverydayBallot,
  args: { poll: RIVERSIDE, answers: { priority: ["toilets"] } },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof EverydayBallot>;

export default meta;
type Story = StoryObj<typeof meta>;

const pickOne: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByText("Question 1 of 3")).toBeVisible();
  await expect(canvas.getAllByText("Choose one.")[0]).toBeVisible();
  await userEvent.click(canvas.getByText("Two hundred new street trees"));
  await expect(canvas.getByRole("radio", { name: "Two hundred new street trees" })).toBeChecked();
  await expect(
    canvas.getByRole("radio", { name: "Public toilets open all year" }),
  ).not.toBeChecked();
  await userEvent.click(canvas.getByRole("button", { name: "Next question" }));
  await expect(canvas.getByText("Question 2 of 3")).toBeVisible();
  await userEvent.click(canvas.getByRole("button", { name: "Back" }));
  await expect(canvas.getByRole("radio", { name: "Two hundred new street trees" })).toBeChecked();
};

export const PickOne: Story = { name: "Question 1 of 3, pick one", play: pickOne };

const upToTwo: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
    "Which events would you go to?",
  );
  await expect(canvas.getAllByText("Choose up to two.")[0]).toBeVisible();
  const count = canvas.getAllByRole("status")[0];
  await expect(count).toHaveTextContent("0 of 2 chosen");
  await userEvent.click(canvas.getByText("A Saturday farmers' market"));
  await expect(count).toHaveTextContent("1 of 2 chosen");
  await userEvent.click(canvas.getByText("Monthly river clean-up"));
  await expect(count).toHaveTextContent("2 of 2 chosen");
  // A third is refused in words, and nothing already chosen changes.
  await userEvent.click(canvas.getByText("Outdoor cinema in summer"));
  await expect(canvas.getByText("You've already chosen two")).toBeVisible();
  await expect(canvas.getByText(/To choose “Outdoor cinema in summer”/)).toBeVisible();
  await expect(
    canvas.getByRole("checkbox", { name: "Outdoor cinema in summer" }),
  ).not.toBeChecked();
  await expect(canvas.getByRole("checkbox", { name: "A Saturday farmers' market" })).toBeChecked();
  await expect(canvas.getByRole("checkbox", { name: "Monthly river clean-up" })).toBeChecked();
  await expect(count).toHaveTextContent("2 of 2 chosen");
  await userEvent.click(canvas.getByText("Monthly river clean-up"));
  await expect(count).toHaveTextContent("1 of 2 chosen");
  await expect(canvas.queryByText("You've already chosen two")).toBeNull();
};

export const UpToTwo: Story = {
  name: "Question 2 of 3, pick up to two",
  args: { start: { name: "question", index: 1 } },
  play: upToTwo,
};

export const Scale: Story = {
  name: "Question 3 of 3, a five-point scale",
  args: { start: { name: "question", index: 2 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Question 3 of 3")).toBeVisible();
    await expect(canvas.getByText(/from very safe at the top/)).toBeVisible();
    const names = canvas.getAllByRole("radio").map((r) => r.closest("label")?.textContent);
    await expect(names).toEqual([
      "Very safe",
      "Mostly safe",
      "Not sure",
      "Not very safe",
      "I avoid it",
    ]);
    await expect(canvas.queryByRole("slider")).toBeNull();
    await userEvent.click(canvas.getByText("Not very safe"));
    await expect(canvas.getByRole("radio", { name: "Not very safe" })).toBeChecked();
    await expect(canvas.getByRole("button", { name: "Check your answers" })).toBeVisible();
  },
};

export const Skip: Story = {
  name: "Skipping a question",
  args: { start: { name: "question", index: 1 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Going on with nothing chosen asks first, in plain words.
    await userEvent.click(canvas.getByRole("button", { name: "Next question" }));
    await expect(canvas.getByText("Skip this question?")).toBeVisible();
    await expect(canvas.getByText(/A skipped question counts as no answer/)).toBeVisible();
    await expect(canvas.getByText("Question 2 of 3")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Keep answering" }));
    await expect(canvas.queryByText("Skip this question?")).toBeNull();
    // Skipping on purpose leads to the same note, then on.
    await userEvent.click(canvas.getByRole("button", { name: "Skip this question" }));
    await expect(canvas.getByText(/A skipped question counts as no answer/)).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Skip and go on" }));
    await expect(canvas.getByText("Question 3 of 3")).toBeVisible();
  },
};

export const ExactlyTwo: Story = {
  name: "Pick exactly two, can't be skipped",
  args: { poll: RIVERSIDE_EXACTLY, start: { name: "question", index: 1 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByText("Choose exactly two.")[0]).toBeVisible();
    await expect(canvas.getByText(/This question can't be skipped/)).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "Skip this question" })).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Next question" }));
    await expect(canvas.getByText("This question needs exactly two")).toBeVisible();
    await expect(canvas.queryByText("Skip this question?")).toBeNull();
    await userEvent.click(canvas.getByText("A Saturday farmers' market"));
    await userEvent.click(canvas.getByRole("button", { name: "Next question" }));
    await expect(canvas.getByText(/You've chosen one. Choose one more/)).toBeVisible();
    await expect(canvas.getByText("Question 2 of 3")).toBeVisible();
    await userEvent.click(canvas.getByText("Outdoor cinema in summer"));
    await expect(canvas.getAllByRole("status")[0]).toHaveTextContent("2 of 2 chosen");
    await userEvent.click(canvas.getByRole("button", { name: "Next question" }));
    await expect(canvas.getByText("Question 3 of 3")).toBeVisible();
  },
};

export const Dark: Story = {
  name: "Question 2 of 3, dark",
  args: { start: { name: "question", index: 1 } },
  parameters: { layout: "fullscreen", theme: "dark" },
  play: upToTwo,
};
