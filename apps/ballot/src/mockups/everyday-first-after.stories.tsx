import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { FirstAnswer } from "./everyday-first-ballot.tsx";
import { LIBRARY, RIVERSIDE_FIRST, TAPPED_LIBRARY } from "./everyday-first-fixtures.ts";

const meta = {
  title: "Mockups/Ballot/Everyday/First time/After the first answer",
  component: FirstAnswer,
  args: { poll: LIBRARY, answers: TAPPED_LIBRARY, start: { name: "done" } },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof FirstAnswer>;

export default meta;
type Story = StoryObj<typeof meta>;

const offer = async (canvasElement: HTMLElement) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("Your answer is in");
  await expect(canvas.getByRole("img", { name: /^Seal of your receipt/ })).toBeVisible();
  await expect(canvas.getByRole("heading", { name: "Back up with a passkey?" })).toBeVisible();
  await expect(
    canvas.getByText(/change your answers, and keep answering, from your other devices/),
  ).toBeVisible();
  await expect(canvas.getByText(/A new device would start as someone new/)).toBeVisible();
  await expect(canvas.getByRole("link", { name: "Back to the poll's page" })).toHaveAttribute(
    "href",
    "https://abolish.us/polls/library-hours#from=voting-app",
  );
};

export const Done: Story = {
  name: "Done, with the backup offer",
  play: async ({ canvasElement }) => {
    await offer(canvasElement);
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Back up with a passkey" }));
    await expect(canvas.getByText("Backed up with your passkey")).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "Not now" })).toBeNull();
  },
};

export const NotNow: Story = {
  name: "Not now",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Not now" }));
    await expect(canvas.getByText(/No backup for now/)).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "Back up with a passkey" })).toBeNull();
    // The answer and receipt are untouched by skipping.
    await expect(canvas.getByRole("button", { name: "Save receipt" })).toBeVisible();
  },
};

export const NoPrf: Story = {
  name: "Passkey can't hold a backup",
  args: { prf: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Back up with a passkey" }));
    await expect(canvas.getByText("This passkey can't hold a backup")).toBeVisible();
    await expect(canvas.getByText(/You can keep answering on this device/)).toBeVisible();
  },
};

export const WhileWaiting: Story = {
  name: "Offered while the device joins",
  args: { start: { name: "sending" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Your answer is sealed and ready to go",
    );
    await expect(canvas.getByText(/Leave this open/)).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Back up with a passkey" }));
    await expect(canvas.getByText("Backed up with your passkey")).toBeVisible();
  },
};

export const ThreeQuestions: Story = {
  name: "Done, three questions",
  args: { poll: RIVERSIDE_FIRST, answers: {}, backup: "saved" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Your answers are in",
    );
    await expect(canvas.getByText("Backed up with your passkey")).toBeVisible();
  },
};

export const Dark: Story = {
  name: "Done, dark",
  parameters: { layout: "fullscreen", theme: "dark" },
  play: async ({ canvasElement }) => offer(canvasElement),
};
