import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { StepScene } from "./step-scene.tsx";

const meta = {
  component: StepScene,
  parameters: { layout: "fullscreen" },
  args: {
    label: "Three steps",
    steps: ["First", "Second", "Third"].map((text) => <p key={text}>{text}</p>),
    graphic: (step: number) => <p data-testid="graphic">Showing step {step + 1}</p>,
  },
} satisfies Meta<typeof StepScene>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const scene = within(canvasElement).getByRole("region", { name: "Three steps" });
    await expect(within(scene).getAllByRole("listitem")).toHaveLength(3);
    // The sticky graphic, beside the cards from `lg`; before the reader
    // scrolls it shows the first step.
    const sticky = scene.querySelector<HTMLElement>(":scope > div");
    if (sticky === null) throw new Error("no sticky graphic");
    await expect(within(sticky).getByTestId("graphic")).toHaveTextContent("Showing step 1");
    // Each card also carries its own step's graphic, the one shown below `lg`.
    const inline = within(scene)
      .getAllByRole("listitem")
      .map((step) => within(step).getByTestId("graphic"));
    for (const [index, graphic] of inline.entries())
      await expect(graphic).toHaveTextContent(`Showing step ${index + 1}`);
    // Only one of the two is drawn at any width.
    const wide = window.matchMedia("(min-width: 64rem)").matches;
    await expect(sticky.checkVisibility()).toBe(wide);
    for (const graphic of inline) await expect(graphic.checkVisibility()).toBe(!wide);
  },
};
