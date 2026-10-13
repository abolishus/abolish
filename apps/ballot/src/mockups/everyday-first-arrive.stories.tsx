import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { FirstAnswer } from "./everyday-first-ballot.tsx";
import {
  LIBRARY,
  RIVERSIDE_FIRST,
  TAPPED_LIBRARY,
  TAPPED_RIVERSIDE,
} from "./everyday-first-fixtures.ts";

const meta = {
  title: "Mockups/Ballot/Everyday/First time/Arrive",
  component: FirstAnswer,
  args: { poll: LIBRARY, prefill: TAPPED_LIBRARY },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof FirstAnswer>;

export default meta;
type Story = StoryObj<typeof meta>;

const WEBSITE_NOTE = "You chose this on the website — change it if you like";

// Tap 1 was the answer on the website's card; Send is tap 2, and the last.
const oneQuestion: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(LIBRARY.title);
  // The same wordmark and seal as the website, and the app's own address.
  await expect(canvas.getByText("Abolish")).toBeVisible();
  await expect(canvas.getByText("abolish.ch")).toBeVisible();
  await expect(
    canvas.getAllByRole("img", { name: /^Seal of this poll, c3f9 a1d2/ })[0],
  ).toBeVisible();
  // One question: no progress bar, and Send right here.
  await expect(canvas.queryByText(/Question 1 of/)).toBeNull();
  const ten = canvas.getByRole("radio", { name: "10:00 to 16:00" });
  await expect(ten).toBeChecked();
  await expect(ten).toHaveAccessibleDescription(WEBSITE_NOTE);
  await expect(ten.closest("label")).toHaveTextContent("Selected");
  await expect(canvas.getByText(/Nothing is sent until you tap Send/)).toBeVisible();
  // First visit: one slim line, and setup as one still line beside Send.
  await expect(canvas.getByText("First time here?")).toBeVisible();
  await expect(canvas.getByText("Setting up this device to answer")).toBeVisible();
  await userEvent.click(canvas.getByRole("button", { name: "Send my answer" }));
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
    "Your answer is sealed and ready to go",
  );
  const trail = canvas.getByRole("list", { name: "Your answer" });
  await expect(trail).toHaveTextContent("Sealed on this device");
  await expect(trail).toHaveTextContent("This device joins the people who can answer");
  // The backup is offered only now, after the answer.
  await expect(canvas.getByRole("button", { name: "Back up with a passkey" })).toBeVisible();
  await expect(canvas.getByRole("button", { name: "Not now" })).toBeVisible();
};

export const OneQuestion: Story = { name: "One question: two taps", play: oneQuestion };

export const ThreeQuestions: Story = {
  name: "Three questions: seven taps",
  args: { poll: RIVERSIDE_FIRST, prefill: TAPPED_RIVERSIDE },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Tap 1 was question 1's answer on the website.
    await expect(canvas.getByText("Question 1 of 3")).toBeVisible();
    await expect(canvas.getByRole("radio", { name: "Public toilets open all year" })).toBeChecked();
    await expect(canvas.getByText("First time here?")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Next question" })); // 2
    await userEvent.click(canvas.getByText("A Saturday farmers' market")); // 3
    await userEvent.click(canvas.getByRole("button", { name: "Next question" })); // 4
    await userEvent.click(canvas.getByText("Not very safe")); // 5
    await userEvent.click(canvas.getByRole("button", { name: "Check your answers" })); // 6
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("Check your answers");
    await expect(canvas.getByText("Setting up this device to answer")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Send my answers" })); // 7
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Your answers are sealed and ready to go",
    );
  },
};

export const SetUp: Story = {
  name: "Setup finished before Send",
  args: { setup: "ready" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("This device is set up to answer")).toBeVisible();
    await expect(canvas.queryByText("Setting up this device to answer")).toBeNull();
  },
};

export const NewDevice: Story = {
  name: "New device, no backup",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText("First time here?"));
    await expect(canvas.getByText(/this device starts as someone new/)).toBeVisible();
    await expect(canvas.getByText(/It isn't tied to an account/)).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Use my passkey backup" }));
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Use your passkey backup",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Back to the question" }));
    await expect(canvas.getByRole("radio", { name: "10:00 to 16:00" })).toBeChecked();
  },
};

export const Dark: Story = {
  name: "One question, dark",
  parameters: { layout: "fullscreen", theme: "dark" },
  play: oneQuestion,
};
