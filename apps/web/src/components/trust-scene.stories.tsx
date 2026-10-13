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
  const graphic = canvas.getByTestId("trust-graphic");
  await expect(graphic).toHaveAttribute("aria-hidden", "true");
  await expect(canvasElement.querySelector("[style]")).toBeNull();
};

export const Default: Story = { play };

export const Dark: Story = { parameters: { theme: "dark" }, play };
