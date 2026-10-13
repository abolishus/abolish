import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { SHARE_CLOSED, SHARE_LIVE, SHARE_MULTI, SHARE_SEALED } from "./share-data.ts";
import { ChatUnfurl, OgPreview } from "./share-og-card.tsx";

const meta = {
  title: "Mockups/Sharing/Link preview",
  component: OgPreview,
  args: { poll: SHARE_LIVE, caption: "Link preview, 1200 × 630, scaled to fit" },
} satisfies Meta<typeof OgPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

const PERCENT = /\d\s?%/;

/** Every card on the canvas, each checked to fit its fixed size with nothing cut off. */
const card = (canvasElement: HTMLElement) => {
  const cards = within(canvasElement).getAllByTestId("og-card");
  for (const each of cards) {
    if (each.scrollHeight > each.clientHeight) {
      throw new Error(`A card overflows by ${each.scrollHeight - each.clientHeight}px`);
    }
  }
  return cards;
};

export const Live: Story = {
  play: async ({ canvasElement }) => {
    const [first] = card(canvasElement);
    await expect(first).toHaveTextContent("Asked by Riverside Neighbours");
    await expect(first).toHaveTextContent("Better lighting on the river path leads, with 41%.");
    await expect(first).toHaveTextContent("2,418 answers so far · updated 7 Nov");
    await expect(first).toHaveTextContent("abolish.us/p/3j55dw1");
    await expect(
      within(first!).getByRole("img", { name: /^Seal of this poll, 1c8a 56f0$/ }),
    ).toBeInTheDocument();
  },
};

export const LiveSquare: Story = {
  name: "Live, square",
  args: { format: "square", caption: "Square link preview, 1080 × 1080", className: "max-w-xl" },
  play: async ({ canvasElement }) => {
    await expect(card(canvasElement)[0]).toHaveTextContent("leads, with 41%.");
  },
};

const sealedPlay: Story["play"] = async ({ canvasElement }) => {
  const [first] = card(canvasElement);
  await expect(first).toHaveTextContent("Results when it closes on 15 Nov");
  await expect(first).toHaveTextContent("1,206 answers so far");
  // Nothing about what the sealed answers say: no share, no bar, no leader.
  await expect(first!.textContent).not.toMatch(PERCENT);
  await expect(first!.textContent).not.toMatch(/leads|came first/);
};

export const Sealed: Story = {
  args: { poll: SHARE_SEALED },
  play: sealedPlay,
};

export const SealedSquare: Story = {
  name: "Sealed, square",
  args: {
    poll: SHARE_SEALED,
    format: "square",
    caption: "Square link preview, 1080 × 1080",
    className: "max-w-xl",
  },
  play: sealedPlay,
};

export const Closed: Story = {
  args: { poll: SHARE_CLOSED },
  play: async ({ canvasElement }) => {
    const [first] = card(canvasElement);
    await expect(first).toHaveTextContent(
      "Better lighting on the river path came first, with 42%.",
    );
    await expect(first).toHaveTextContent("Final count · 3,152 answers counted");
    await expect(first).toHaveTextContent("Closed 15 Nov");
  },
};

export const MultiQuestion: Story = {
  name: "Several questions",
  args: { poll: SHARE_MULTI },
  play: async ({ canvasElement }) => {
    const [first] = card(canvasElement);
    await expect(first).toHaveTextContent("3 questions");
    await expect(first).toHaveTextContent("Question 1 of 3");
    await expect(first).toHaveTextContent("What should Riverside ask the city for next year?");
  },
};

export const CivicRecord: Story = {
  name: "Civic record",
  args: { civic: true, caption: "Civic record link preview, 1200 × 630" },
  render: (args) => (
    <div className="grid gap-10">
      <OgPreview {...args} />
      <OgPreview
        civic
        format="square"
        caption="Civic record, square, 1080 × 1080"
        className="max-w-xl"
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    for (const each of card(canvasElement)) {
      // One row per tier, each with its own count; never one blended figure.
      await expect(each).toHaveTextContent("Document-verified40,11258.4% yes");
      await expect(each).toHaveTextContent("Vouched8,30157.0% yes");
      await expect(each).toHaveTextContent("Passkey only112,95044.0% yes");
      await expect(each).not.toHaveTextContent("161,363");
    }
  },
};

export const InAChat: Story = {
  name: "Thumbnail in a chat",
  render: () => (
    <div className="grid gap-10">
      <section aria-labelledby="chat-wide" className="grid gap-3">
        <h2 id="chat-wide" className="m-0 text-base font-semibold">
          At 600px, a desktop chat
        </h2>
        <ChatUnfurl poll={SHARE_LIVE} width={600} message="Worth a minute, Riverside:" />
      </section>
      <section aria-labelledby="chat-narrow" className="grid gap-3">
        <h2 id="chat-narrow" className="m-0 text-base font-semibold">
          At 300px, a phone chat or a list
        </h2>
        <div className="flex flex-wrap gap-6">
          <ChatUnfurl poll={SHARE_LIVE} width={300} message="Live one:" />
          <ChatUnfurl poll={SHARE_SEALED} width={300} message="Sealed one:" />
        </div>
      </section>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const descriptions = canvas.getAllByTestId("og-description");
    await expect(descriptions[0]).toHaveTextContent(
      "Asked by Riverside Neighbours in Riverside. 2,418 answers so far. Better lighting on the river path leads, with 41%. Anyone can check the count.",
    );
    // The sealed poll's unfurl text leaks nothing either.
    await expect(descriptions[2]!.textContent).not.toMatch(PERCENT);
    await expect(card(canvasElement)[2]!.textContent).not.toMatch(PERCENT);
  },
};
