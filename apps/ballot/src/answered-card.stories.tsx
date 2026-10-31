import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { AnsweredCard } from "./answered-card.tsx";

// The "I answered" card (answered-card.tsx): drawn on the device from the
// poll's question, link and seal, and shared or saved only by the voter
// (docs/design/sharing.md, The "I answered" card).

const URL = "https://abolish.us/p/3j55dw1";
const TITLE = "Which improvement matters most to you?";
const SEAL = "3f8a0c51d2e4b69788a1c0d3e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718";

// Drawing waits for the fonts and encodes a 1080-pixel PNG, which can take
// longer than `waitFor`'s default second on a busy runner.
const DRAWN = { timeout: 10_000 };

const meta = {
  title: "Ballot/I answered card",
  component: AnsweredCard,
  args: { share: { url: URL, title: TITLE }, seal: SEAL, canShare: true },
} satisfies Meta<typeof AnsweredCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Replaces `navigator.share` for one story; the returned function puts it back. */
function stubShare(value: unknown): () => void {
  Object.defineProperty(navigator, "share", { configurable: true, value });
  return () => void Reflect.deleteProperty(navigator, "share");
}

/** The card's pixels at (`x`, `y`) of its 1080-pixel square, as RGBA. */
function pixel(canvas: HTMLCanvasElement, x: number, y: number): number[] {
  return [...(canvas.getContext("2d")?.getImageData(x, y, 1, 1).data ?? [])];
}

const drawn: Story["play"] = async ({ canvasElement }) => {
  const root = within(canvasElement);
  const card = root.getByRole("img", {
    name: `Card: I answered this poll. ${TITLE} Answer it too at abolish.us/p/3j55dw1. Anyone can check the count.`,
  });
  await expect(card).toHaveAttribute("width", "1080");
  await expect(card).toHaveAttribute("height", "1080");
  await expect(root.getByTestId("card-note")).toHaveTextContent(
    "The card says you answered, never how.",
  );
  const shared: ShareData[] = [];
  const restore = stubShare(async (data: ShareData) => void shared.push(data));
  try {
    const button = await root.findByRole("button", { name: "Share the card…" }, DRAWN);
    // Always the light palette: the emerald band at the top and white paper.
    await expect(pixel(card as HTMLCanvasElement, 540, 8)).toEqual([4, 120, 87, 255]);
    await expect(pixel(card as HTMLCanvasElement, 30, 540)).toEqual([255, 255, 255, 255]);
    await userEvent.click(button);
    // The picture, the question and the link: nothing about this voter.
    await waitFor(() => expect(shared).toHaveLength(1));
    const [data] = shared;
    await expect(Object.keys(data ?? {}).sort()).toEqual(["files", "title", "url"]);
    await expect(data?.title).toBe(TITLE);
    await expect(data?.url).toBe(URL);
    const file = data?.files?.[0];
    await expect(file?.name).toBe("answered-3j55dw1.png");
    await expect(file?.type).toBe("image/png");
  } finally {
    restore();
  }
  await expect(root.getByRole("button", { name: "Save the card" })).toBeEnabled();
};

export const Default: Story = { name: "Drawn", play: drawn };

export const Dark: Story = {
  name: "Drawn, in the dark theme (the card stays light)",
  parameters: { theme: "dark" },
  play: drawn,
};

export const NoFileShare: Story = {
  name: "A share menu that won't take a picture",
  args: { canShare: false },
  play: async ({ canvasElement }) => {
    const root = within(canvasElement);
    await waitFor(
      () => expect(root.getByRole("button", { name: "Save the card" })).toBeEnabled(),
      DRAWN,
    );
    await expect(root.queryByRole("button", { name: "Share the card…" })).toBeNull();
  },
};

export const LongQuestion: Story = {
  name: "A question too long for the card",
  args: {
    share: {
      url: URL,
      title:
        "Should the neighbourhood association spend this year's surplus on new benches along the river path, longer library hours on weekends, a second community garden near the school, or keep it in reserve for repairs to the hall's roof next winter?",
    },
  },
  play: async ({ canvasElement }) => {
    // The label keeps the whole question, though the picture cuts it short.
    await expect(within(canvasElement).getByRole("img")).toHaveAccessibleName(/roof next winter\?/);
    await waitFor(
      () =>
        expect(within(canvasElement).getByRole("button", { name: "Save the card" })).toBeEnabled(),
      DRAWN,
    );
  },
};

export const LongCode: Story = {
  name: "A poll with the longest code",
  args: { share: { url: `https://abolish.us/p/${"3j55dw1k".repeat(6)}3j55`, title: TITLE } },
  play: async ({ canvasElement }) => {
    // The link is never cut: the label and the picture carry all of it.
    await expect(within(canvasElement).getByRole("img")).toHaveAccessibleName(
      new RegExp(`abolish\\.us/p/${"3j55dw1k".repeat(6)}3j55\\.`),
    );
    await waitFor(
      () =>
        expect(within(canvasElement).getByRole("button", { name: "Save the card" })).toBeEnabled(),
      DRAWN,
    );
  },
};
