import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { expectTextFocus } from "./focus-text.ts";

import { type FollowsClient, FollowsError, type FollowsFailure } from "../account/follows.ts";
import { PollFollow } from "./poll-follow.tsx";

const ELECTION = "101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f";

/**
 * The follows handler in memory, for one account: each call kept, every
 * change refused with `refuse`, or with `refuseAfter` once the first landed.
 */
function fakeFollows({
  refuse,
  refuseAfter,
}: { refuse?: FollowsFailure; refuseAfter?: FollowsFailure } = {}): FollowsClient & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    set: async (electionId, on) => {
      calls.push(`${on ? "follow" : "stop"} ${electionId.slice(0, 8)}`);
      if (refuse !== undefined) throw new FollowsError(refuse);
      if (refuseAfter !== undefined && calls.length > 1) throw new FollowsError(refuseAfter);
      return on;
    },
  };
}

const calls = (client: FollowsClient) => (client as ReturnType<typeof fakeFollows>).calls;

const follow = async (canvasElement: HTMLElement) =>
  userEvent.click(within(canvasElement).getByRole("button", { name: "Follow this poll" }));

const meta = {
  component: PollFollow,
  args: { electionId: ELECTION, client: fakeFollows() },
} satisfies Meta<typeof PollFollow>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Before the visitor asks: a button, and nothing read (T-11). */
export const Offered: Story = {
  args: { client: fakeFollows() },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "Follow" })).toBeVisible();
    await expect(canvas.getByText(/Following isn't answering/)).toBeVisible();
    await expect(canvas.getByText(/No one sees how many people do/)).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Follow this poll" })).toBeEnabled();
    await expect(canvas.queryByRole("status")).toBeNull();
    await expect(calls(args.client)).toEqual([]);
  },
};

/** Following, then stopping: the button offers the opposite change and keeps focus. */
export const FollowAndStop: Story = {
  args: { client: fakeFollows() },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await follow(canvasElement);
    await expect(await canvas.findByRole("status")).toHaveTextContent(
      "You're following this poll.",
    );
    const stop = canvas.getByRole("button", { name: "Stop following" });
    await expect(stop).toHaveFocus();
    await userEvent.click(stop);
    await expect(await canvas.findByText("You've stopped following this poll.")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Follow this poll" })).toHaveFocus();
    await expect(calls(args.client)).toEqual(["follow 10111213", "stop 10111213"]);
    await expect(canvas.queryByRole("alert")).toBeNull();
  },
};

/** Dark, following. */
export const Dark: Story = {
  parameters: { theme: "dark" },
  args: { client: fakeFollows() },
  play: async ({ canvasElement }) => {
    await follow(canvasElement);
    await expect(
      await within(canvasElement).findByRole("button", { name: "Stop following" }),
    ).toBeVisible();
  },
};

/** Signed out: following says how. */
export const SignedOut: Story = {
  args: { client: fakeFollows({ refuse: "signedOut" }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await follow(canvasElement);
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "Following needs a signed-in account.",
    );
    await expect(canvas.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/account");
    await expect(canvas.getByRole("button", { name: "Follow this poll" })).toHaveFocus();
  },
};

/** An account with no verified address, where its notices would go. */
export const Unverified: Story = {
  args: { client: fakeFollows({ refuse: "unverified" }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await follow(canvasElement);
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "Following needs a verified e-mail address",
    );
    await expect(canvas.getByRole("link", { name: "Verify your e-mail" })).toHaveAttribute(
      "href",
      "/account/verify",
    );
    await expectTextFocus(canvas.getByRole("link", { name: "Verify your e-mail" }));
    await expect(canvas.queryByRole("status")).toBeNull();
  },
};

/** Past the hour's limit (T-52): the follow stands, and the page says why it didn't stop. */
export const TooManyThisHour: Story = {
  args: { client: fakeFollows({ refuseAfter: "tooManyThisHour" }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await follow(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Stop following" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "as often as you can this hour",
    );
    await expect(canvas.getByRole("status")).toHaveTextContent("You're following this poll.");
  },
};

/** A session that ended since following: what it follows is unknown again. */
export const SessionEnded: Story = {
  args: { client: fakeFollows({ refuseAfter: "signedOut" }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await follow(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Stop following" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("signed-in account");
    await expect(canvas.queryByRole("status")).toBeNull();
    await expect(canvas.getByRole("button", { name: "Follow this poll" })).toBeVisible();
  },
};

/** Hidden since the page loaded: it takes no new followers (T-68). */
export const Hidden: Story = {
  args: { client: fakeFollows({ refuse: "hidden" }) },
  play: async ({ canvasElement }) => {
    await follow(canvasElement);
    await expect(await within(canvasElement).findByRole("alert")).toHaveTextContent(
      "This poll is hidden, so it can't be followed.",
    );
  },
};

/** The server or the network failed. */
export const Failed: Story = {
  args: { client: fakeFollows({ refuse: "failed" }) },
  play: async ({ canvasElement }) => {
    await follow(canvasElement);
    await expect(await within(canvasElement).findByRole("alert")).toHaveTextContent(
      "That didn't go through.",
    );
  },
};
