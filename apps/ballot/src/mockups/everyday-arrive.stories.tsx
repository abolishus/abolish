import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { EverydayBallot } from "./everyday-ballot.tsx";
import { RIVERSIDE, TAPPED } from "./everyday-fixtures.ts";

const meta = {
  title: "Mockups/Ballot/Everyday/Arrive",
  component: EverydayBallot,
  args: { poll: RIVERSIDE, prefill: TAPPED },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof EverydayBallot>;

export default meta;
type Story = StoryObj<typeof meta>;

const WEBSITE_NOTE = "You chose this on the website — change it if you like";

const fromATap: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
    "Which one improvement matters most to you?",
  );
  await expect(canvas.getByText("Question 1 of 3")).toBeVisible();
  await expect(canvas.getByText(RIVERSIDE.title, { exact: false })).toBeVisible();
  // The tapped answer arrives chosen, and says it was the person's own choice.
  const toilets = canvas.getByRole("radio", { name: "Public toilets open all year" });
  await expect(toilets).toBeChecked();
  await expect(toilets).toHaveAccessibleDescription(WEBSITE_NOTE);
  await expect(toilets.closest("label")).toHaveTextContent("Selected");
  await expect(
    canvas.getByRole("radio", { name: "Resurfaced basketball courts" }),
  ).not.toBeChecked();
  const [status] = canvas.getAllByRole("status");
  await expect(status).toHaveTextContent("You chose: Public toilets open all year.");
  // One plain check, the evidence one tap away.
  await expect(
    canvas.getByRole("figure", { name: "The poll's registered fingerprint" }),
  ).not.toBeVisible();
  await userEvent.click(canvas.getByText("This is the real poll, checked"));
  await expect(
    canvas.getByRole("figure", { name: "The poll's registered fingerprint" }),
  ).toBeVisible();
  await expect(canvas.getByText(/During launch, Abolish alone holds the key/)).toBeVisible();
  await expect(canvas.getByText(/Riverside Library Friends/)).toBeVisible();
  // And it can be changed.
  await userEvent.click(canvas.getByText("Better lighting on the river path"));
  const lights = canvas.getByRole("radio", { name: "Better lighting on the river path" });
  await expect(lights).toBeChecked();
  await expect(lights).not.toHaveAccessibleDescription(WEBSITE_NOTE);
  await expect(toilets).not.toBeChecked();
  await expect(canvas.queryByText(WEBSITE_NOTE)).toBeNull();
  await expect(status).toHaveTextContent("You chose: Better lighting on the river path.");
};

export const FromATap: Story = { name: "From a tap", play: fromATap };

export const NoTap: Story = {
  name: "No tap",
  args: { prefill: {} },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Which one improvement matters most to you?",
    );
    // Nothing is chosen for the person.
    for (const radio of canvas.getAllByRole("radio")) await expect(radio).not.toBeChecked();
    await expect(canvas.queryByText("Selected")).toBeNull();
    await expect(canvas.getAllByRole("status")[0]).toHaveTextContent("Nothing chosen yet.");
    await expect(canvas.getByText("This is the real poll, checked")).toBeVisible();
  },
};

export const Dark: Story = {
  name: "From a tap, dark",
  parameters: { layout: "fullscreen", theme: "dark" },
  play: fromATap,
};
