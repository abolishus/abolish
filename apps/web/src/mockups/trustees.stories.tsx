import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, waitFor, within } from "storybook/test";

import { TrusteesPage } from "./trustees-page.tsx";

const meta = {
  title: "Mockups/Web/Trustees",
  component: TrusteesPage,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof TrusteesPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const diagram = canvas.getByTestId("opening-diagram");
    await expect(diagram).toHaveAttribute("data-shares", "0");

    const scene = canvas.getByRole("region", { name: "How a tally is opened" });
    const steps = within(scene).getAllByRole("listitem");
    steps[2]?.scrollIntoView({ block: "center" });
    await waitFor(() => expect(diagram).toHaveAttribute("data-shares", "3"));

    // The two offline trustees don't stop the count: the last step opens it.
    steps.at(-1)?.scrollIntoView({ block: "center" });
    await waitFor(() => expect(diagram).toHaveAttribute("data-shares", "4"));
    await expect(within(diagram).getByText(/^4 of 4/)).toBeVisible();
    await expect(steps.at(-1)).toHaveAttribute("data-active");
    window.scrollTo(0, 0);
  },
};

export const Dark: Story = {
  parameters: { layout: "fullscreen", theme: "dark" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const register = canvas.getByRole("region", { name: "Who holds the shares" });
    await expect(within(register).getAllByRole("heading", { level: 3 })).toHaveLength(7);
    await expect(
      canvas.getByRole("img", { name: /^Fingerprint of the joint public key/ }),
    ).toBeVisible();
  },
};
