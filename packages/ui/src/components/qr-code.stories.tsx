import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { QrCode } from "./qr-code.tsx";

const meta = {
  component: QrCode,
  args: {
    value: "HTTPS://ABOLISH.US/P/3J55DW1",
    label: "QR code for abolish.us/p/3j55dw1",
  },
} satisfies Meta<typeof QrCode>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Dark modules on a light ground, whatever the theme. */
async function expectLightGround(svg: Element) {
  await expect(svg.querySelector("rect")).toHaveAttribute("fill", "#ffffff");
  await expect(svg.querySelector("path")).toHaveAttribute("fill", "#000000");
}

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const code = within(canvasElement).getByRole("img", {
      name: "QR code for abolish.us/p/3j55dw1",
    });
    await expect(code).toHaveAttribute("width", "192");
    await expect(code).toHaveAttribute("shape-rendering", "crispEdges");
    // The short link fits version 2 (25 modules) with the 4-module quiet zone.
    await expect(code).toHaveAttribute("viewBox", "0 0 33 33");
    await expect(code.querySelectorAll("path")).toHaveLength(1);
    await expectLightGround(code);
  },
};

export const Print: Story = {
  args: { level: "Q", size: 288 },
  play: async ({ canvasElement }) => {
    const code = within(canvasElement).getByRole("img");
    await expect(code).toHaveAttribute("height", "288");
    // Q, for print, still fits the short link in version 2.
    await expect(code).toHaveAttribute("viewBox", "0 0 33 33");
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    const code = within(canvasElement).getByRole("img");
    await expect(code).toBeVisible();
    await expectLightGround(code);
  },
};
