import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { AskOthers } from "./ask-others.tsx";

// "Ask others" after answering (ask-others.tsx): the poll's link and first
// question, nothing of the voter's (docs/design/sharing.md, Share sheet).

const URL = "https://abolish.us/p/3j55dw1";
const TITLE = "Which improvement matters most to you?";
const SEAL = "3f8a0c51d2e4b69788a1c0d3e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718";

// Drawing waits for the fonts and encodes a 1080-pixel PNG, which can take
// longer than `waitFor`'s default second on a busy runner.
const DRAWN = { timeout: 10_000 };

const meta = {
  title: "Ballot/Ask others",
  component: AskOthers,
  args: { share: { url: URL, title: TITLE }, seal: SEAL, canShare: true },
} satisfies Meta<typeof AskOthers>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Replaces `navigator[name]` for one story; the returned function puts it back. */
function stub(name: "clipboard" | "share", value: unknown): () => void {
  Object.defineProperty(navigator, name, { configurable: true, value });
  return () => void Reflect.deleteProperty(navigator, name);
}

const shares: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const part = within(canvas.getByRole("region", { name: "Ask others" }));
  await expect(part.getByTestId("never-your-answer")).toHaveTextContent(
    "Share the question, not your answer.",
  );
  await expect(part.getByRole("textbox", { name: "Link to this poll" })).toHaveValue(URL);
  const writes: string[] = [];
  const shared: ShareData[] = [];
  const restore = [
    stub("clipboard", { writeText: async (text: string) => void writes.push(text) }),
    stub("share", async (data: ShareData) => void shared.push(data)),
  ];
  try {
    await userEvent.click(part.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(part.getByRole("button", { name: "Link copied" })).toBeVisible());
    await expect(part.getByRole("status")).toHaveTextContent("Link copied. Paste it anywhere.");
    await expect(writes).toEqual([URL]);
    await userEvent.click(part.getByRole("button", { name: "Share…" }));
    // The question and the link, nothing about this voter or their answers.
    await expect(shared).toEqual([{ title: TITLE, url: URL }]);
  } finally {
    for (const put of restore) put();
  }
  await expect(part.queryByTestId("no-web-share")).toBeNull();
  // The flyer is the website's page for the same link, in a new tab.
  const flyer = part.getByRole("link", { name: /^Print a flyer/ });
  await expect(flyer).toHaveAttribute("href", `${URL}/flyer`);
  await expect(flyer).toHaveAttribute("target", "_blank");
  await expect(flyer).toHaveAttribute("rel", "noopener noreferrer");
  await expect(flyer).toHaveAccessibleName("Print a flyer (opens the website in a new tab)");
  // The QR code is drawn only when asked for.
  const toggle = part.getByRole("button", { name: "Show a QR code" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(part.queryByRole("img")).toBeNull();
  await userEvent.click(toggle);
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const qr = part.getByRole("img", { name: "QR code for abolish.us/p/3j55dw1" });
  // The upper-case link fits alphanumeric mode at version 2: 25 modules and the quiet zone.
  await expect(qr).toHaveAttribute("viewBox", "0 0 33 33");
  await userEvent.click(toggle);
  await expect(part.queryByRole("img")).toBeNull();
};

export const Default: Story = { name: "After answering", play: shares };

export const Dark: Story = {
  name: "After answering, dark",
  parameters: { theme: "dark" },
  play: shares,
};

export const NoShareMenu: Story = {
  name: "A browser without a share menu",
  args: { canShare: false },
  play: async ({ canvasElement }) => {
    const part = within(within(canvasElement).getByRole("region", { name: "Ask others" }));
    await expect(part.queryByRole("button", { name: "Share…" })).toBeNull();
    await expect(part.getByTestId("no-web-share")).toHaveTextContent(
      "This browser doesn't have a share menu.",
    );
    await expect(part.getByRole("link", { name: "Email the link" })).toHaveAttribute(
      "href",
      `mailto:?subject=${encodeURIComponent(TITLE)}&body=${encodeURIComponent(URL)}`,
    );
  },
};

export const CopyFails: Story = {
  name: "Copying fails",
  play: async ({ canvasElement }) => {
    const part = within(within(canvasElement).getByRole("region", { name: "Ask others" }));
    const restore = stub("clipboard", {
      writeText: () => Promise.reject(new DOMException("denied", "NotAllowedError")),
    });
    try {
      await userEvent.click(part.getByRole("button", { name: "Copy link" }));
      await waitFor(() =>
        expect(part.getByRole("status")).toHaveTextContent(
          "Couldn't copy. Select the link above and copy it.",
        ),
      );
      await expect(part.getByRole("button", { name: "Copy link" })).toBeVisible();
    } finally {
      restore();
    }
  },
};

export const Card: Story = {
  name: "The \u201cI answered\u201d card, asked for",
  play: async ({ canvasElement }) => {
    const part = within(within(canvasElement).getByRole("region", { name: "Ask others" }));
    // Drawn only when asked for, like the QR code.
    const toggle = part.getByRole("button", { name: "Make an \u201cI answered\u201d card" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(part.queryByRole("img")).toBeNull();
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(
      part.getByRole("img", {
        name: `Card: I answered this poll. ${TITLE} Answer it too at abolish.us/p/3j55dw1. Anyone can check the count.`,
      }),
    ).toBeVisible();
    await waitFor(
      () => expect(part.getByRole("button", { name: "Save the card" })).toBeEnabled(),
      DRAWN,
    );
    await userEvent.click(toggle);
    await expect(part.queryByRole("img")).toBeNull();
  },
};
