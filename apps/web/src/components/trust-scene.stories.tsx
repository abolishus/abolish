import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { TrustScene } from "./trust-scene.tsx";

const meta = {
  component: TrustScene,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof TrustScene>;

export default meta;
type Story = StoryObj<typeof meta>;

const play: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(
    canvas.getByRole("heading", { level: 2, name: "Why you can trust a casual poll" }),
  ).toBeVisible();
  const scene = canvas.getByRole("region", { name: "What happens to an answer" });
  await expect(within(scene).getAllByRole("listitem")).toHaveLength(4);
  await expect(
    within(scene).getByRole("heading", { name: "Counted again by anyone" }),
  ).toBeInTheDocument();
  // The launch panel is ours: the step says so plainly ([[0027-trustee-panels-and-live-results]]).
  await expect(scene).toHaveTextContent("every seat is run by Abolish");
  await expect(scene).toHaveTextContent("it takes 4 of the 7 seats");
  // The diagram is decoration beside the text, and draws without inline styles (CSP).
  for (const graphic of canvas.getAllByTestId("trust-graphic"))
    await expect(graphic).toHaveAttribute("aria-hidden", "true");
  await expect(canvasElement.querySelector("[style]")).toBeNull();
};

export const Default: Story = { play };

export const Dark: Story = { parameters: { theme: "dark" }, play };

/**
 * On a phone each step's card draws its own diagram, under its words, and
 * nothing is sticky: the sticky diagram above the cards sat under the card
 * of the step it drew whenever that step was active.
 */
export const Phone: Story = {
  globals: { viewport: { value: "phone", isRotated: false } },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.ownerDocument.documentElement.clientWidth).toBe(360);
    const scene = within(canvasElement).getByRole("region", { name: "What happens to an answer" });
    await expect(scene.querySelector(":scope > div")).not.toBeVisible();
    const steps = within(scene).getAllByRole("listitem");
    await expect(steps).toHaveLength(4);
    for (const [index, step] of steps.entries()) {
      const graphic = within(step).getByTestId("trust-graphic");
      await expect(graphic).toBeVisible();
      await expect(graphic).toHaveAttribute("data-step", String(index));
      const heading = within(step).getByRole("heading").getBoundingClientRect();
      await expect(graphic.getBoundingClientRect().top).toBeGreaterThan(heading.bottom);
    }
  },
};
