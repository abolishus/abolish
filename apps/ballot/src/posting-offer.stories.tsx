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

export const OfferedTheWallet: Story = {
  name: "Once the relay fell back, the voter's own wallet is offered with what it costs",
  args: { failed: true, relayed: true, onWallet: fn() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Post from your own wallet")).toBeVisible();
    // The cost is said before the choice: the paying address beside the
    // ballot and its re-votes, and how to choose one (rule 6; T-13).
    await expect(canvas.getByText(/published for good beside this ballot/)).toBeVisible();
    await expect(canvas.getByText(/use a fresh address funded privately/)).toBeVisible();
    await expect(canvas.getByText(/see the missing parts before the public record/)).toBeVisible();
    // And that forcing it through Ethereum is a second request, paid there
    // from the same address (Own wallet, Forced through L1).
    await expect(canvas.getByText(/force it through Ethereum from the same address/)).toBeVisible();
    // Beside the other choices, never above them: after the relay's, and
    // never the frame's primary action, which stays trying again.
    const buttons = canvas.getAllByRole("button").map((b) => b.textContent);
    await expect(buttons.indexOf("Post from my wallet, then send")).toBeGreaterThan(
      buttons.indexOf("Post publicly, then send"),
    );
    await expect(buttons.indexOf("Post publicly, then send")).toBeGreaterThanOrEqual(0);
    await userEvent.click(canvas.getByRole("button", { name: "Post from my wallet, then send" }));
    await expect(args.onWallet).toHaveBeenCalledOnce();
    await expect(args.onPost).not.toHaveBeenCalled();
  },
};

export const OfferedWithoutTheWallet: Story = {
  name: "Before the relay fell back, no wallet is offered",
  args: { failed: false, onWallet: undefined },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText("Post from your own wallet")).toBeNull();
    await expect(
      canvas.queryByRole("button", { name: "Post from my wallet, then send" }),
    ).toBeNull();
  },
};

export const WalletSentNotRecorded: Story = {
  name: "Parts the wallet sent but the board doesn't show yet are never called unposted",
  args: { failed: true, onWallet: fn(), wallet: "sent" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Your wallet's posting isn't on the board yet")).toBeVisible();
    await expect(canvas.getByText(/count them as posted/)).toBeVisible();
    await expect(canvas.queryByText(/Nothing was posted/)).toBeNull();
  },
};

export const WalletForced: Story = {
  name: "Parts the wallet forced through Ethereum are counted as posted, with the page kept open",
  args: { failed: true, handed: true, onWallet: fn(), wallet: "forced" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Your wallet forced the posting through Ethereum")).toBeVisible();
    await expect(canvas.getByText(/Count the missing parts as posted/)).toBeVisible();
    await expect(canvas.getByText(/Keep this page open/)).toBeVisible();
    await expect(canvas.queryByText(/Nothing was posted/)).toBeNull();
    // Its own note says they were given, so the handed note isn't repeated.
    await expect(canvas.queryByText("The missing parts may still reach the board")).toBeNull();
  },
};

export const WalletRelayedThenRejected: Story = {
  name: "A request declined in the wallet after the relay had the parts says both",
  args: { failed: true, relayed: true, onWallet: fn(), wallet: "rejected" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Your wallet didn't send anything")).toBeVisible();
    // The relay still had them (T-15).
    await expect(canvas.getByText("The posting isn't on the board yet")).toBeVisible();
  },
};

export const WalletRefusedAfterSending: Story = {
  name: "A refusal after an earlier run sent the parts still says they may reach the board",
  args: { failed: true, handed: true, onWallet: fn(), wallet: "refused" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("The board won't take this posting")).toBeVisible();
    // The earlier run's parts may still land (T-15).
    await expect(canvas.getByText("The missing parts may still reach the board")).toBeVisible();
  },
};

export const WalletProblems: Story = {
  name: "Each thing the wallet can meet has its own words",
  args: { failed: true, onWallet: fn() },
  render: (args) => (
    <div>
      {(["refused", "wrong-chain", "no-wallet", "late", "failed"] as const).map((wallet) => (
        <PostingOffer key={wallet} {...args} wallet={wallet} />
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const title of [
      "The board won't take this posting",
      "Your wallet is on another network",
      "No wallet in this browser",
      "The time for posting has passed",
      "Your wallet didn't answer",
    ])
      await expect(canvas.getByText(title)).toBeVisible();
    // A wallet that may have had the parts says so, never "nothing posted" (T-15).
    await expect(canvas.getByText(/count them as given/)).toBeVisible();
    await expect(canvas.queryByText(/Nothing was posted/)).toBeNull();
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
