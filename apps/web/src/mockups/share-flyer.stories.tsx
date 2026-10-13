import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { SHARE_LIVE, SHARE_MULTI } from "./share-data.ts";
import { FlyerPage } from "./share-flyer.tsx";

const meta = {
  title: "Mockups/Sharing/Flyer",
  component: FlyerPage,
  args: { poll: SHARE_LIVE },
} satisfies Meta<typeof FlyerPage>;

export default meta;
type Story = StoryObj<typeof meta>;

const flyerPlay =
  (code: string, page: string): NonNullable<Story["play"]> =>
  async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const flyer = canvas.getByTestId("flyer");
    // Everything fits on the sheet: nothing is cut off at the bottom.
    await expect(flyer.scrollHeight).toBeLessThanOrEqual(flyer.clientHeight);
    await expect(flyer).toHaveTextContent(`abolish.us/p/${code}`);
    await expect(flyer).toHaveTextContent("Closes 15 November 2026, 12:00 UTC");
    await expect(flyer).toHaveTextContent("How to answer");
    await expect(flyer).toHaveTextContent("Anyone can check the count");
    await expect(flyer).toHaveTextContent(
      `open abolish.ch or abolishus.eth and enter the code ${code}`,
    );
    await expect(
      within(flyer).getByRole("img", { name: /\(placeholder, not scannable\)$/ }),
    ).toBeVisible();
    await expect(within(flyer).getByRole("list", { name: "Tear-off tabs" }).children).toHaveLength(
      7,
    );
    await expect(canvas.getByRole("button", { name: "Print this flyer" })).toBeVisible();
    const css = canvasElement.querySelector("style")?.textContent ?? "";
    await expect(css).toContain(`@page { size: ${page}; margin: 0; }`);
    await expect(css).toContain("@media print");
  };

export const A4: Story = {
  name: "A4, colour",
  play: flyerPlay("3j55dw1", "A4"),
};

export const BlackAndWhite: Story = {
  name: "A4, black and white",
  args: { mono: true },
  play: async (context) => {
    await flyerPlay("3j55dw1", "A4")(context);
    // No emerald anywhere, so a mono printer or a photocopy loses nothing.
    await expect(
      within(context.canvasElement).getByTestId("flyer").querySelector('[class*="primary"]'),
    ).toBeNull();
  },
};

export const Letter: Story = {
  name: "US Letter, several questions",
  args: { poll: SHARE_MULTI, paper: "letter" },
  play: async (context) => {
    await flyerPlay("p6kh40x", "letter")(context);
    await expect(within(context.canvasElement).getByTestId("flyer")).toHaveTextContent(
      "3 short questions, about a minute.",
    );
  },
};
