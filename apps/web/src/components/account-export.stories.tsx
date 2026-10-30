import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { type ExportClient, ExportError } from "../account/export.ts";
import { AccountExport } from "./account-export.tsx";

/** A stand-in for the export handler: answers each download as told, counting them. */
function fakeExport(
  answer: "saved" | ExportError | "hang" = "saved",
): ExportClient & { calls: number } {
  const client = {
    calls: 0,
    async download() {
      client.calls += 1;
      if (answer === "hang") return new Promise<never>(() => {});
      if (answer instanceof ExportError) throw answer;
    },
  };
  return client;
}

const meta = {
  component: AccountExport,
  args: { index: "06", onSignedOut: fn() },
} satisfies Meta<typeof AccountExport>;

export default meta;
type Story = StoryObj<typeof meta>;

const button = (canvas: ReturnType<typeof within>) =>
  canvas.getByRole("button", { name: "Download your data" });

/** What the file holds and never holds, then a download, announced. */
export const Download: Story = {
  args: { client: fakeExport() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "Download your data" })).toBeVisible();
    await expect(canvas.getAllByRole("listitem")).toHaveLength(7);
    await expect(
      canvas.getByText(/never holds your answers, receipts or voting identity/),
    ).toBeVisible();
    await userEvent.click(button(canvas));
    await expect(await canvas.findByRole("status")).toHaveTextContent("Your data is downloading.");
    await expect(canvas.queryByRole("alert")).toBeNull();
    // The disabled button lost focus: it goes back to the section's heading.
    await waitFor(() =>
      expect(canvas.getByRole("heading", { name: "Download your data" })).toHaveFocus(),
    );
    await expect((args.client as ReturnType<typeof fakeExport>).calls).toBe(1);
  },
};

export const DownloadDark: Story = {
  args: { client: fakeExport() },
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(button(within(canvasElement))).toBeEnabled();
  },
};

/** While the file is made, the button can't be pressed again. */
export const Preparing: Story = {
  args: { client: fakeExport("hang") },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(button(canvas));
    const busy = await canvas.findByRole("button", { name: "Preparing your file…" });
    await expect(busy).toBeDisabled();
    await expect((args.client as ReturnType<typeof fakeExport>).calls).toBe(1);
  },
};

/** An ended session says so, and the page is told, so it can show the sign-in. */
export const SignedOut: Story = {
  args: { client: fakeExport(new ExportError("signedOut")) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(button(canvas));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "You've been signed out. Sign in again to download your data.",
    );
    await expect(args.onSignedOut).toHaveBeenCalledOnce();
  },
};

/** A failure says to try again, and the button stays to do it. */
export const Failed: Story = {
  args: { client: fakeExport(new ExportError("failed")) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(button(canvas));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "Your data couldn't be downloaded. Try again.",
    );
    await expect(canvas.getByRole("status")).toBeEmptyDOMElement();
    await expect(args.onSignedOut).not.toHaveBeenCalled();
    await userEvent.click(button(canvas));
    await waitFor(() => expect((args.client as ReturnType<typeof fakeExport>).calls).toBe(2));
  },
};
