import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { Fingerprint } from "./fingerprint.tsx";

const value = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

const meta = {
  component: Fingerprint,
  args: { value, label: "Fingerprint of receipt 9f86 d081" },
} satisfies Meta<typeof Fingerprint>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const glyph = within(canvasElement).getByRole("img", {
      name: "Fingerprint of receipt 9f86 d081",
    });
    await expect(glyph).toHaveAttribute("width", "96");
    // The frame plus one shape per non-empty cell.
    await expect(glyph.children.length).toBeGreaterThan(1);
  },
};

export const Mirrored: Story = {
  play: async ({ canvasElement }) => {
    const glyph = within(canvasElement).getByRole("img");
    // Every shape has a twin reflected about the glyph's centre line.
    const shapes = [...glyph.querySelectorAll("rect, circle, polygon")].slice(1);
    const box = (el: Element) => {
      const b = (el as SVGGraphicsElement).getBBox();
      return { left: b.x, right: b.x + b.width, top: b.y };
    };
    const boxes = shapes.map(box);
    for (const b of boxes) {
      const twin = boxes.find(
        (o) => Math.abs(o.left - (8 - b.right)) < 1e-6 && Math.abs(o.top - b.top) < 1e-6,
      );
      await expect(twin).toBeDefined();
    }
  },
};

export const Large: Story = {
  args: { size: 160 },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("img")).toHaveAttribute("height", "160");
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("img")).toBeVisible();
  },
};
