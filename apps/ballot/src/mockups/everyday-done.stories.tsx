import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { EverydayBallot } from "./everyday-ballot.tsx";
import { ANSWERED, RIVERSIDE, RIVERSIDE_SEALED } from "./everyday-fixtures.ts";

const meta = {
  title: "Mockups/Ballot/Everyday/Done",
  component: EverydayBallot,
  args: { poll: RIVERSIDE, start: { name: "done" }, answers: ANSWERED },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof EverydayBallot>;

export default meta;
type Story = StoryObj<typeof meta>;

const AUDIENCE = "among 2,418 people with an account";

const resultsView = async (canvasElement: HTMLElement) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("Results so far");
  // When the totals were released, and among whom, before any bar.
  await expect(canvas.getByText(`updated 7 Nov 12:00 UTC · ${AUDIENCE}`)).toBeVisible();
  await expect(canvas.getByText(/Your answers aren't in these totals yet/)).toBeVisible();
  const bars = canvas.getAllByRole("figure", { name: "Among 2,418 people with an account" });
  await expect(bars).toHaveLength(3);
  await expect(
    canvas.getByText("Better lighting on the river path leads, chosen by 41.5%."),
  ).toBeVisible();
  await expect(bars[0]).toHaveTextContent("41.5%");
  await expect(canvas.getByText(/shares add up to more than 100%/)).toBeVisible();
};

const live: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("Your answers are in");
  await expect(canvas.getByRole("img", { name: /^Seal of your receipt/ })).toBeVisible();
  await expect(canvas.getByRole("button", { name: "Save receipt" })).toBeVisible();
  await expect(
    canvas.getByText(
      "You can change your answers until 15 November; only your last answers count.",
    ),
  ).toBeVisible();
  // The full receipt is one tap away.
  await expect(canvas.getByRole("group", { name: "Your receipt" })).not.toBeVisible();
  await userEvent.click(canvas.getByText("Show the full receipt"));
  const stub = within(canvas.getByRole("group", { name: "Your receipt" }));
  await expect(stub.getByRole("figure", { name: "Receipt hash" })).toBeVisible();
  await expect(stub.getByText("2,431")).toBeVisible();
  await expect(canvas.getByText(/During launch, Abolish alone holds the key/)).toBeVisible();
  await userEvent.click(canvas.getByRole("button", { name: "See results so far" }));
  await resultsView(canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: "Back" }));
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("Your answers are in");
};

export const Live: Story = { name: "Live results", play: live };

export const Sealed: Story = {
  name: "Sealed results",
  args: { poll: RIVERSIDE_SEALED },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "When results appear" })).toBeVisible();
    await expect(
      canvas.getByText(/Results stay sealed until the poll closes, 15 November 2026, 12:00 UTC/),
    ).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "See results so far" })).toBeNull();
  },
};

export const Results: Story = {
  name: "Results so far",
  args: { start: { name: "results" } },
  play: async ({ canvasElement }) => resultsView(canvasElement),
};

export const Replacing: Story = {
  name: "Changed answers",
  args: { replacing: true },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(/They replace your earlier answers/),
    ).toBeVisible();
  },
};

export const Dark: Story = {
  name: "Live results, dark",
  parameters: { layout: "fullscreen", theme: "dark" },
  play: live,
};

export const ResultsDark: Story = {
  name: "Results so far, dark",
  args: { start: { name: "results" } },
  parameters: { layout: "fullscreen", theme: "dark" },
  play: async ({ canvasElement }) => resultsView(canvasElement),
};
