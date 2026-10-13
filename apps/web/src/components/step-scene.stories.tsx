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
    // Before the reader scrolls, the graphic shows the first step.
    await expect(within(scene).getByTestId("graphic")).toHaveTextContent("Showing step 1");
  },
};
