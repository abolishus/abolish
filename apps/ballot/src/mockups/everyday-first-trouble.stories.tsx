import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { FirstAnswer } from "./everyday-first-ballot.tsx";
import { LIBRARY, TAPPED_LIBRARY } from "./everyday-first-fixtures.ts";

const meta = {
  title: "Mockups/Ballot/Everyday/First time/When something goes wrong",
  component: FirstAnswer,
  args: { poll: LIBRARY, prefill: TAPPED_LIBRARY },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof FirstAnswer>;

export default meta;
type Story = StoryObj<typeof meta>;

// Cloudflare's rare interactive fallback: one extra tap, three in all.
const checkNeeded: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByText("One quick check")).toBeVisible();
  await expect(canvas.getByRole("group", { name: "Cloudflare's check" })).toBeVisible();
  await userEvent.click(canvas.getByRole("button", { name: "Send my answer" }));
  await expect(canvas.getByRole("alert")).toHaveTextContent("Not sent yet");
  await expect(canvas.getByRole("radio", { name: "10:00 to 16:00" })).toBeChecked();
  await userEvent.click(canvas.getByRole("checkbox", { name: "Verify you are human" }));
  await expect(canvas.getByText("This device is set up to answer")).toBeVisible();
  await userEvent.click(canvas.getByRole("button", { name: "Send my answer" }));
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
    "Your answer is sealed and ready to go",
  );
};

export const CheckNeeded: Story = {
  name: "Bot check asks for a tick",
  args: { setup: "check" },
  play: checkNeeded,
};

export const CheckFailed: Story = {
  name: "Bot check couldn't confirm",
  args: { setup: "failed" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("We couldn't confirm you're a person")).toBeVisible();
    await expect(canvas.getByText(/open this page in another browser/)).toBeVisible();
    await expect(canvas.getByText(/nothing was sent/)).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Try the check again" }));
    await expect(canvas.getByText("This device is set up to answer")).toBeVisible();
  },
};

export const SlowSetup: Story = {
  name: "Setup taking long",
  args: { start: { name: "sending" }, wait: "slow" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Setup is taking longer than usual")).toBeVisible();
    await expect(canvas.getByText(/sealed and safe on this device/)).toBeVisible();
    await expect(canvas.getByRole("list", { name: "Your answer" })).toHaveTextContent(
      "This device joins the people who can answer",
    );
  },
};

export const Offline: Story = {
  name: "Offline mid-way",
  args: { start: { name: "sending" }, wait: "offline" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("You're offline")).toBeVisible();
    await expect(canvas.getByText(/sealed and kept on this device/)).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Try again now" }));
    await expect(canvas.queryByText("You're offline")).toBeNull();
  },
};

export const Dark: Story = {
  name: "Bot check asks for a tick, dark",
  args: { setup: "check" },
  parameters: { layout: "fullscreen", theme: "dark" },
  play: checkNeeded,
};
