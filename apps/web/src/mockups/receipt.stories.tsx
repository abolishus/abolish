import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { RECEIPT } from "./fixtures.ts";
import { ReceiptPage } from "./receipt-page.tsx";

const meta = {
  title: "Mockups/Web/Find your receipt",
  component: ReceiptPage,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ReceiptPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The receipt as printed: groups of four, upper case, as people tend to copy it. */
const PRINTED = RECEIPT.hash.toUpperCase().match(/.{4}/g)?.join(" ") ?? RECEIPT.hash;
const UNKNOWN = "4e07408562bedb8b60ce05c1decfe3ad16b72230967de01f640b7e4729b49fce";

async function lookUp(canvasElement: HTMLElement, text: string) {
  const canvas = within(canvasElement);
  const field = canvas.getByRole("textbox", { name: "Receipt hash" });
  await userEvent.clear(field);
  await userEvent.type(field, text);
  await userEvent.click(canvas.getByRole("button", { name: "Look up" }));
  return canvas;
}

const found: Story["play"] = async ({ canvasElement }) => {
  const canvas = await lookUp(canvasElement, PRINTED);
  const heading = canvas.getByRole("heading", { level: 2, name: "Your ballot is on the board" });
  await waitFor(() => expect(heading).toHaveFocus());
  await expect(canvas.getByRole("group", { name: "Your receipt" })).toHaveTextContent("1,203");
  const trail = canvas.getByRole("list", { name: "Your ballot" });
  await expect(within(trail).getByText("Anchored to Ethereum: done")).toBeInTheDocument();
  await expect(within(trail).getByText("Counted: waiting")).toBeInTheDocument();
  const mine = canvas
    .getByRole("table", { name: /entries 1,199–1,207/ })
    .querySelector('[aria-current="true"]');
  await expect(mine).toHaveTextContent("1,203");
  await expect(canvas.getByRole("figure", { name: "From your receipt" })).toBeVisible();
  await expect(canvas.getByRole("figure", { name: "On the board" })).toBeVisible();
};

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await lookUp(canvasElement, "1bdd ad59 2bb3");
    const field = canvas.getByRole("textbox", { name: "Receipt hash" });
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(canvas.getByRole("alert")).toHaveTextContent("What you entered has 12.");
    await expect(field).toHaveAccessibleDescription(/has 12/);
    await userEvent.click(canvas.getByRole("button", { name: "Scan the QR code" }));
    await expect(canvas.getByRole("button", { name: "Scan the QR code" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  },
};

export const Found: Story = { play: found };

export const NotFound: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await lookUp(canvasElement, UNKNOWN);
    const heading = canvas.getByRole("heading", {
      level: 2,
      name: "No entry with this hash is on the board yet",
    });
    await waitFor(() => expect(heading).toHaveFocus());
    await expect(canvas.getByRole("img", { name: /hash you entered, 4e07 4085/ })).toBeVisible();
    await expect(canvas.getByRole("heading", { name: "Submit it directly" })).toBeVisible();
    await expect(canvas.getByText("abolishus.eth", { selector: "li.font-mono" })).toBeVisible();
    await expect(canvas.queryByRole("table")).toBeNull();
  },
};

export const Dark: Story = { parameters: { layout: "fullscreen", theme: "dark" }, play: found };

export const DarkNotFound: Story = {
  parameters: { layout: "fullscreen", theme: "dark" },
  play: async ({ canvasElement }) => {
    const canvas = await lookUp(canvasElement, UNKNOWN);
    await expect(canvas.getByRole("heading", { name: "What it doesn’t mean" })).toBeVisible();
  },
};
