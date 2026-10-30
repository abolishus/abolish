import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { FollowResultsError, type NoticeChoicesClient } from "../account/follow-results.ts";
import { type PushClient, PushError, type PushState } from "../account/push.ts";
import { AccountNotices } from "./account-notices.tsx";

/**
 * A stand-in for this browser's push subscription: starts in `state`, and
 * each change succeeds unless told to fail, counting the calls.
 */
function fakePush(
  state: PushState,
  fails?: PushError,
): PushClient & { enabled: number; disabled: number } {
  let now = state;
  const client = {
    enabled: 0,
    disabled: 0,
    state: async () => now,
    async enable() {
      client.enabled += 1;
      if (fails !== undefined) throw fails;
      now = "on";
    },
    async disable() {
      client.disabled += 1;
      if (fails !== undefined) throw fails;
      now = "off";
    },
  };
  return client;
}

/**
 * A stand-in for the account's results choice: starts at `results`, and
 * each change succeeds unless told to fail, recording what was set.
 */
function fakeChoices(
  results: boolean,
  fails?: FollowResultsError,
): NoticeChoicesClient & { set: boolean[] } {
  let now = results;
  const client = {
    set: [] as boolean[],
    results: async () => now,
    async setResults(on: boolean) {
      client.set.push(on);
      if (fails !== undefined) throw fails;
      now = on;
    },
  };
  return client;
}

const meta = {
  component: AccountNotices,
  args: { index: "04", push: fakePush("off"), choices: fakeChoices(true), onSignedOut: fn() },
} satisfies Meta<typeof AccountNotices>;

export default meta;
type Story = StoryObj<typeof meta>;

const toggle = (canvas: ReturnType<typeof within>) =>
  canvas.getByRole("switch", { name: /Also notify this browser/ });

const resultsToggle = (canvas: ReturnType<typeof within>) =>
  canvas.getByRole("switch", { name: /Results of a poll you follow/ });

const resultsUsable = async (canvas: ReturnType<typeof within>) =>
  waitFor(() => expect(resultsToggle(canvas)).not.toHaveAttribute("aria-disabled", "true"));

/** This browser's row's status line. */
const pushStatus = (canvas: ReturnType<typeof within>) =>
  canvas.getAllByRole("status")[1] as HTMLElement;

/** The results row's status line. */
const resultsStatus = (canvas: ReturnType<typeof within>) =>
  canvas.getAllByRole("status")[0] as HTMLElement;

// Base UI's switch is a span, disabled by `aria-disabled`, not the attribute.
const usable = async (canvas: ReturnType<typeof within>) =>
  waitFor(() => expect(toggle(canvas)).not.toHaveAttribute("aria-disabled", "true"));

/** The moderation notice, which can't be turned off, the results choice, and what an e-mail says. */
const tells = async (canvas: ReturnType<typeof within>) => {
  await expect(canvas.getByRole("heading", { name: "What we tell you about" })).toBeVisible();
  const kinds = canvas.getAllByRole("listitem");
  await expect(kinds).toHaveLength(3);
  await expect(kinds[0]).toHaveTextContent("Always sent, so that you can appeal");
  await expect(kinds[1]).toHaveTextContent("only the e-mail is left out");
  // The results choice and this browser's switch; moderation has none.
  await expect(canvas.getAllByRole("switch")).toHaveLength(2);
  await expect(canvas.queryByRole("checkbox")).toBeNull();
  await expect(canvas.getByText(/says only that there's a decision or results/)).toBeVisible();
  // T-76: the switch says who delivers a notification and what they learn.
  await expect(canvas.getByText(/learns that you use Abolish/)).toBeVisible();
};

/** Off on this browser; turning it on subscribes it, and says so. */
export const TurnOn: Story = {
  args: { push: fakePush("off") },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await tells(canvas);
    await usable(canvas);
    await expect(toggle(canvas)).not.toBeChecked();
    await expect(pushStatus(canvas)).toHaveTextContent("This browser won't be notified.");
    await userEvent.click(toggle(canvas));
    await waitFor(() => expect(toggle(canvas)).toBeChecked());
    await expect(pushStatus(canvas)).toHaveTextContent("This browser will be notified.");
    await expect(canvas.queryByRole("alert")).toBeNull();
    await expect((args.push as ReturnType<typeof fakePush>).enabled).toBe(1);
  },
};

export const TurnOnDark: Story = {
  args: { push: fakePush("off") },
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await tells(canvas);
    await usable(canvas);
  },
};

/** On on this browser; turning it off takes the subscription away. */
export const TurnOff: Story = {
  args: { push: fakePush("on") },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(toggle(canvas)).toBeChecked());
    await userEvent.click(toggle(canvas));
    await waitFor(() => expect(toggle(canvas)).not.toBeChecked());
    await expect(pushStatus(canvas)).toHaveTextContent("This browser won't be notified.");
    await expect((args.push as ReturnType<typeof fakePush>).disabled).toBe(1);
  },
};

/** The person refused the browser's prompt: still off, and why. */
export const Refused: Story = {
  args: { push: fakePush("off", new PushError("denied")) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await usable(canvas);
    await userEvent.click(toggle(canvas));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "Notifications weren't allowed",
    );
    await expect(toggle(canvas)).not.toBeChecked();
  },
};

/** The session ended meanwhile: the page is told, and the person to sign in. */
export const SignedOut: Story = {
  args: { push: fakePush("off", new PushError("signedOut")) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await usable(canvas);
    await userEvent.click(toggle(canvas));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("You've been signed out.");
    await expect(args.onSignedOut).toHaveBeenCalled();
  },
};

/** States with no switch to use, each said in words: the switch stays off and disabled. */
const fixed = (state: "unsupported" | "unavailable" | "denied", words: RegExp): Story => ({
  args: { push: fakePush(state) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(pushStatus(canvas)).toHaveTextContent(words));
    await expect(toggle(canvas)).toHaveAttribute("aria-disabled", "true");
    await expect(toggle(canvas)).not.toBeChecked();
  },
});

export const Unsupported = fixed("unsupported", /can't show notifications/);

export const Unavailable = fixed("unavailable", /doesn't send browser notifications yet/);

export const Blocked = fixed("denied", /blocks notifications from this site/);

/** Results are on until turned off; turning them off sets the account's choice, and says so. */
export const ResultsOff: Story = {
  args: { choices: fakeChoices(true) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await resultsUsable(canvas);
    await expect(resultsToggle(canvas)).toBeChecked();
    await expect(resultsStatus(canvas)).toHaveTextContent(
      "We'll e-mail you when a poll you follow",
    );
    await userEvent.click(resultsToggle(canvas));
    await waitFor(() => expect(resultsToggle(canvas)).not.toBeChecked());
    await expect(resultsStatus(canvas)).toHaveTextContent("We won't e-mail you about results.");
    await expect(canvas.queryByRole("alert")).toBeNull();
    await expect((args.choices as ReturnType<typeof fakeChoices>).set).toEqual([false]);
    // This browser's switch is its own, and untouched.
    await expect((args.push as ReturnType<typeof fakePush>).enabled).toBe(0);
  },
};

/** Turned off before, on another device: shown off here too, and turned back on. */
export const ResultsOn: Story = {
  args: { choices: fakeChoices(false) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await resultsUsable(canvas);
    await expect(resultsToggle(canvas)).not.toBeChecked();
    await userEvent.click(resultsToggle(canvas));
    await waitFor(() => expect(resultsToggle(canvas)).toBeChecked());
    await expect((args.choices as ReturnType<typeof fakeChoices>).set).toEqual([true]);
  },
};

/** The change failed: the switch shows the choice as read again, and says so. */
export const ResultsFailed: Story = {
  args: { choices: fakeChoices(true, new FollowResultsError("failed")) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await resultsUsable(canvas);
    await userEvent.click(resultsToggle(canvas));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("That didn't work.");
    await waitFor(() => expect(resultsToggle(canvas)).toBeChecked());
  },
};

/** The session ended meanwhile: the page is told, as for this browser's switch. */
export const ResultsSignedOut: Story = {
  args: { choices: fakeChoices(true, new FollowResultsError("signedOut")) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await resultsUsable(canvas);
    await userEvent.click(resultsToggle(canvas));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("You've been signed out.");
    await expect(args.onSignedOut).toHaveBeenCalled();
  },
};
