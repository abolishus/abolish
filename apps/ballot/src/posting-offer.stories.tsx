import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";

import { Declined, PostingOffer } from "./posting-offer.tsx";

// The posting offer and the decline (posting-offer.tsx), with the worker and
// the network left out: each story is one screen as the voter meets it.

const POLL = {
  definitionHash: "3f8a0c51d2e4b69788a1c0d3e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718",
  name: "Riverside Residents' Association",
  closes: "Fri 17 Oct",
};
const CODE = "c0de5eed0123456789abcdef0123456789abcdef0123456789abcdef01234567";

const meta = {
  title: "Ballot/Posting offer",
  component: PostingOffer,
  parameters: { layout: "fullscreen" },
  args: {
    poll: POLL,
    trackingCode: CODE,
    missing: 1,
    onRetry: fn(),
    onDecline: fn(),
    onPost: fn(),
  },
} satisfies Meta<typeof PostingOffer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Offered: Story = {
  name: "One trustee didn't take its part: try again, post it publicly, or leave the ballot",
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Some trustees haven't taken your ballot",
    );
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveFocus();
    await expect(canvas.getByText(/and one didn't take theirs/)).toBeVisible();
    // The cost is said beside the choice, before it can be made (Client rule 4; T-15).
    await expect(canvas.getByText(/lose their long-term protection/)).toBeVisible();
    await expect(canvas.getByText(/read your whole ballot/)).toBeVisible();
    // Leaving says what still happens to the ballot the relay holds (T-25).
    await expect(canvas.getByText(/replace your earlier ballot without counting/)).toBeVisible();
    await expect(canvas.queryByText("The posting didn't go through")).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Try the trustees again" }));
    await expect(args.onRetry).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByRole("button", { name: "Post publicly, then send" }));
    await expect(args.onPost).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByRole("button", { name: "Leave this ballot" }));
    await expect(args.onDecline).toHaveBeenCalledOnce();
  },
};

export const OfferedForSeveral: Story = {
  name: "Several trustees didn't take theirs, after a posting that didn't go through",
  args: { missing: 3, failed: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/and 3 didn't take theirs/)).toBeVisible();
    await expect(canvas.getByText("The posting didn't go through")).toBeVisible();
    await expect(canvas.getByText(/Nothing was posted or sent to the board/)).toBeVisible();
  },
};

export const OfferedAfterRelaying: Story = {
  name: "A posting the relay had but the board doesn't show yet is never called unposted",
  args: { missing: 1, failed: true, relayed: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("The posting isn't on the board yet")).toBeVisible();
    // Who has them is said plainly: the operator's relay (T-15).
    await expect(canvas.getByText(/Our posting relay, run by the poll's operator/)).toBeVisible();
    await expect(canvas.getByText(/count them as posted/)).toBeVisible();
    await expect(canvas.queryByText(/Nothing was posted/)).toBeNull();
  },
};

export const OfferedWithoutPosting: Story = {
  name: "A build with no contract path offers only trying again or leaving the ballot",
  render: (args) => <PostingOffer {...args} onPost={undefined} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("button", { name: "Post publicly, then send" })).toBeNull();
    await expect(canvas.queryByText(/lose their long-term protection/)).toBeNull();
    await expect(canvas.getAllByRole("button")).toHaveLength(2);
  },
};

export const OfferedDark: Story = {
  name: "The offer, dark",
  parameters: { layout: "fullscreen", theme: "dark" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Some trustees haven't taken your ballot",
    );
  },
};

const onAgain = fn();

export const Left: Story = {
  name: "The ballot was left: it won't count, answer again",
  render: () => <Declined poll={POLL} onAgain={onAgain} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "This ballot won't count",
    );
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveFocus();
    onAgain.mockClear();
    await userEvent.click(canvas.getByRole("button", { name: "Answer again" }));
    await expect(onAgain).toHaveBeenCalledOnce();
  },
};
