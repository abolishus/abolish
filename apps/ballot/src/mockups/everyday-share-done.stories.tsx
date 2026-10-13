import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { RIVERSIDE, RIVERSIDE_SEALED } from "./everyday-fixtures.ts";
import { DoneWithShare } from "./everyday-share-sheet.tsx";

const meta = {
  title: "Mockups/Ballot/Everyday/Share",
  component: DoneWithShare,
  args: { poll: RIVERSIDE, canShare: true },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof DoneWithShare>;

export default meta;
type Story = StoryObj<typeof meta>;

const URL = "https://abolish.us/p/p6kh40x";

function stubClipboard() {
  const writes: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => void writes.push(text) },
  });
  return writes;
}

const copies: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const share = canvas.getByRole("region", { name: "Ask others" });
  const part = within(share);
  await expect(part.getByTestId("never-your-answer")).toHaveTextContent(
    "Share the question, not your answer.",
  );
  await expect(part.getByRole("textbox", { name: "Link to this poll" })).toHaveValue(URL);
  const writes = stubClipboard();
  await userEvent.click(part.getByRole("button", { name: "Copy link" }));
  await waitFor(() => expect(part.getByRole("button", { name: "Link copied" })).toBeVisible());
  await expect(part.getByRole("status")).toHaveTextContent("Link copied. Paste it anywhere.");
  await expect(writes).toEqual([URL]);
};

export const Default: Story = {
  name: "After answering",
  play: async (context) => {
    await copies(context);
    const part = within(within(context.canvasElement).getByRole("region", { name: "Ask others" }));
    const shared: ShareData[] = [];
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async (data: ShareData) => void shared.push(data),
    });
    await userEvent.click(part.getByRole("button", { name: "Share…" }));
    // The question and the link, nothing about this person or their answers.
    await expect(shared).toEqual([{ title: RIVERSIDE.title, url: URL }]);
    await expect(part.getByRole("link", { name: /^Print a flyer/ })).toHaveAttribute(
      "href",
      `${URL}/flyer`,
    );
    await expect(part.getByTestId("also-at")).toHaveTextContent(
      "open abolish.ch or abolishus.eth and enter the code p6kh40x",
    );
  },
};

export const NoWebShare: Story = {
  name: "No share menu in this browser",
  args: { canShare: false },
  play: async (context) => {
    await copies(context);
    const part = within(within(context.canvasElement).getByRole("region", { name: "Ask others" }));
    await expect(part.queryByRole("button", { name: "Share…" })).toBeNull();
    await expect(part.getByTestId("no-web-share")).toBeVisible();
    await expect(part.getByRole("link", { name: "Email the link" })).toHaveAttribute(
      "href",
      `mailto:?subject=${encodeURIComponent(RIVERSIDE.title)}&body=${encodeURIComponent(URL)}`,
    );
  },
};

export const QrCode: Story = {
  name: "QR code",
  args: { poll: RIVERSIDE_SEALED },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText("Show a QR code"));
    await expect(
      canvas.getByRole("img", {
        name: "QR code for abolish.us/p/p6kh40x (placeholder, not scannable)",
      }),
    ).toBeVisible();
  },
};

export const Dark: Story = {
  name: "After answering, dark",
  parameters: { layout: "fullscreen", theme: "dark" },
  play: copies,
};
