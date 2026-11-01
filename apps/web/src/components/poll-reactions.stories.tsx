import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { expectTextFocus } from "./focus-text.ts";

import {
  type Reaction,
  REACTIONS,
  type ReactionsClient,
  ReactionsError,
  type ReactionsFailure,
} from "../account/reactions.ts";
import { PollReactions } from "./poll-reactions.tsx";

const ELECTION = "101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f";

/**
 * The reactions handler in memory, for one poll: others' reactions as
 * `counts`, this account's as `own` (none while signed out), each call
 * kept. `refuse` refuses every change; `refuseRead` every read of the counts.
 */
function fakeReactions({
  counts = { heart: 12, laugh: 3, wow: 0, thinking: 7, sad: 0, clap: 1 },
  own,
  refuse,
  refuseRead,
}: {
  counts?: Record<Reaction, number>;
  own?: Reaction[];
  refuse?: ReactionsFailure;
  refuseRead?: ReactionsFailure;
} = {}): ReactionsClient & { calls: string[] } {
  const tally = { ...counts };
  const mine = own === undefined ? undefined : new Set(own);
  const calls: string[] = [];
  const view = () => {
    if (mine === undefined) throw new ReactionsError("signedOut");
    return { counts: { ...tally }, own: REACTIONS.filter((r) => mine.has(r)) };
  };
  return {
    calls,
    counts: async () => {
      calls.push("counts");
      if (refuseRead !== undefined) throw new ReactionsError(refuseRead);
      return { ...tally };
    },
    own: async () => {
      calls.push("own");
      return view();
    },
    set: async (electionId, reaction, on) => {
      calls.push(`${on ? "set" : "take back"} ${reaction} on ${electionId.slice(0, 8)}`);
      if (refuse !== undefined) throw new ReactionsError(refuse);
      if (mine !== undefined && mine.has(reaction) !== on) {
        tally[reaction] += on ? 1 : -1;
        if (on) mine.add(reaction);
        else mine.delete(reaction);
      }
      return view();
    },
  };
}

const calls = (client: ReactionsClient) => (client as ReturnType<typeof fakeReactions>).calls;

/** Asks to react, as a visitor does before the toggles show. */
async function join(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole("button", { name: "React to this poll" }));
}

const meta = {
  component: PollReactions,
  args: { electionId: ELECTION, client: fakeReactions({ own: ["thinking"] }) },
} satisfies Meta<typeof PollReactions>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Before the visitor asks: the counts for anyone, read without the session
 * (T-11), and a button to react.
 */
export const Counts: Story = {
  args: { client: fakeReactions({ own: ["thinking"] }) },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "Reactions" })).toBeVisible();
    const list = await canvas.findByRole("list", { name: "Reactions to this poll" });
    await expect(within(list).getAllByRole("listitem")).toHaveLength(6);
    await expect(within(list).getByText("Heart: 12 people")).toBeInTheDocument();
    await expect(within(list).getByText("Clap: 1 person")).toBeInTheDocument();
    await expect(canvas.getByText(/Only you can see which reactions are yours/)).toBeVisible();
    await expect(canvas.getByRole("button", { name: "React to this poll" })).toBeVisible();
    await expect(calls(args.client)).toEqual(["counts"]);
  },
};

/** Signed in and verified: each reaction a toggle, the account's own pressed. */
export const SignedIn: Story = {
  args: { client: fakeReactions({ own: ["thinking"] }) },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await join(canvasElement);
    const heart = await canvas.findByRole("button", { name: "Heart: 12 people" });
    // The asking button is gone, so focus moves to the first toggle.
    await expect(heart).toHaveFocus();
    await expect(heart).toHaveAttribute("aria-pressed", "false");
    await expect(canvas.getByRole("button", { name: "Thinking: 7 people" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(canvas.queryByRole("button", { name: "React to this poll" })).toBeNull();

    await userEvent.click(heart);
    await expect(await canvas.findByRole("button", { name: "Heart: 13 people" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Thinking: 7 people" }));
    await expect(await canvas.findByRole("button", { name: "Thinking: 6 people" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(calls(args.client)).toEqual([
      "counts",
      "own",
      "set heart on 10111213",
      "take back thinking on 10111213",
    ]);
    await expect(canvas.queryByRole("alert")).toBeNull();
  },
};

/** Dark, with nothing reacted yet. */
export const Dark: Story = {
  parameters: { theme: "dark" },
  args: {
    client: fakeReactions({
      counts: { heart: 0, laugh: 0, wow: 0, thinking: 0, sad: 0, clap: 0 },
      own: [],
    }),
  },
  play: async ({ canvasElement }) => {
    await join(canvasElement);
    await expect(
      await within(canvasElement).findByRole("button", { name: "Wow: 0 people" }),
    ).toHaveAttribute("aria-pressed", "false");
  },
};

/** Signed out: asking to react says how, and the counts stay. */
export const SignedOut: Story = {
  args: { client: fakeReactions() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await join(canvasElement);
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "Reacting needs a signed-in account.",
    );
    await expect(canvas.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/account");
    await expect(canvas.getByText("Heart: 12 people")).toBeInTheDocument();
    await expect(canvas.queryByRole("button", { pressed: false })).toBeNull();
  },
};

/** An account with no verified address: the counts stay, and the page says what's missing. */
export const Unverified: Story = {
  args: { client: fakeReactions({ own: [], refuse: "unverified" }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await join(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Sad: 0 people" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "Reacting needs a verified e-mail address.",
    );
    await expect(canvas.getByRole("link", { name: "Verify your e-mail" })).toHaveAttribute(
      "href",
      "/account/verify",
    );
    await expectTextFocus(canvas.getByRole("link", { name: "Verify your e-mail" }));
    await expect(canvas.getByRole("button", { name: "Sad: 0 people" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  },
};

/** Past the hour's limit (T-52). */
export const TooManyThisHour: Story = {
  args: { client: fakeReactions({ own: [], refuse: "tooManyThisHour" }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await join(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Laugh: 3 people" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "as often as you can this hour",
    );
  },
};

/** A session that ended since the toggles showed: they go, and the page says why. */
export const SessionEnded: Story = {
  args: { client: fakeReactions({ own: [], refuse: "signedOut" }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await join(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Heart: 12 people" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("signed-in account");
    await expect(canvas.queryByRole("button", { pressed: false })).toBeNull();
    await expect(canvas.getByRole("button", { name: "React to this poll" })).toBeVisible();
  },
};

/** Hidden since the page loaded: no counts, and no toggles (T-68). */
export const Hidden: Story = {
  args: { client: fakeReactions({ refuseRead: "hidden" }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText("This poll is hidden, so its reactions are too."),
    ).toBeVisible();
    await expect(canvas.queryByRole("button")).toBeNull();
    await expect(canvas.queryByText(/people/)).toBeNull();
  },
};

/** The counts couldn't be read. */
export const Unread: Story = {
  args: { client: fakeReactions({ refuseRead: "failed" }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Reactions couldn't be loaded just now.")).toBeVisible();
  },
};
