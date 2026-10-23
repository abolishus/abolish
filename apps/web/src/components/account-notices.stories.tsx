import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

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

const meta = {
  component: AccountNotices,
  args: { index: "04", push: fakePush("off"), onSignedOut: fn() },
} satisfies Meta<typeof AccountNotices>;

export default meta;
type Story = StoryObj<typeof meta>;

const toggle = (canvas: ReturnType<typeof within>) =>
  canvas.getByRole("switch", { name: /Also notify this browser/ });

// Base UI's switch is a span, disabled by `aria-disabled`, not the attribute.
const usable = async (canvas: ReturnType<typeof within>) =>
  waitFor(() => expect(toggle(canvas)).not.toHaveAttribute("aria-disabled", "true"));

/** The moderation notice, which can't be turned off, and what its e-mail says. */
const tells = async (canvas: ReturnType<typeof within>) => {
  await expect(canvas.getByRole("heading", { name: "What we tell you about" })).toBeVisible();
  const kinds = canvas.getAllByRole("listitem");
  await expect(kinds).toHaveLength(2);
  await expect(kinds[0]).toHaveTextContent("Always sent, so that you can appeal");
  // The optional kinds wait on published results: only this browser's switch.
  await expect(canvas.getAllByRole("switch")).toHaveLength(1);
  await expect(canvas.queryByRole("checkbox")).toBeNull();
  await expect(canvas.getByText(/says only that there was one/)).toBeVisible();
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
    await expect(canvas.getByRole("status")).toHaveTextContent("This browser won't be notified.");
    await userEvent.click(toggle(canvas));
    await waitFor(() => expect(toggle(canvas)).toBeChecked());
    await expect(canvas.getByRole("status")).toHaveTextContent("This browser will be notified.");
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
    await expect(canvas.getByRole("status")).toHaveTextContent("This browser won't be notified.");
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
    await waitFor(() => expect(canvas.getByRole("status")).toHaveTextContent(words));
    await expect(toggle(canvas)).toHaveAttribute("aria-disabled", "true");
    await expect(toggle(canvas)).not.toBeChecked();
  },
});

export const Unsupported = fixed("unsupported", /can't show notifications/);

export const Unavailable = fixed("unavailable", /doesn't send browser notifications yet/);

export const Blocked = fixed("denied", /blocks notifications from this site/);
