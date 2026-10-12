import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { ReceiptStub } from "./receipt-stub.tsx";

const hash = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

const meta = {
  component: ReceiptStub,
  args: {
    title: "Your receipt",
    hash,
    labels: {
      hash: "Receipt hash",
      fingerprint: "Fingerprint of receipt 9f86 d081",
      entry: "Board entry",
      recordedAt: "Recorded",
    },
    entry: 40112,
    recordedAt: new Date("2026-11-03T14:05:09Z"),
  },
} satisfies Meta<typeof ReceiptStub>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const stub = within(canvasElement).getByRole("group", { name: "Your receipt" });
    const evidence = within(stub);
    await expect(evidence.getByRole("figure", { name: "Receipt hash" })).toHaveTextContent(hash);
    await expect(
      evidence.getByRole("img", { name: "Fingerprint of receipt 9f86 d081" }),
    ).toBeVisible();
    await expect(stub.querySelector("data")).toHaveAttribute("value", "40112");
    await expect(evidence.getByText("40,112")).toBeVisible();
    // The board's time, in UTC, with its exact instant in `dateTime`.
    const time = stub.querySelector("time");
    await expect(time).toHaveAttribute("datetime", "2026-11-03T14:05:09.000Z");
    await expect(time).toHaveTextContent("Nov 3, 2026, 2:05:09 PM UTC");
  },
};

export const LocalTime: Story = {
  args: { timeZone: "America/Chicago" },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector("time")).toHaveTextContent("8:05:09 AM CST");
  },
};

export const French: Story = {
  parameters: { locale: "fr-FR" },
  play: async ({ canvasElement }) => {
    // Grouped for the locale with a narrow no-break space.
    await expect(canvasElement.querySelector("data")?.textContent).toBe("40\u202f112");
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("group", { name: "Your receipt" })).toBeVisible();
  },
};
