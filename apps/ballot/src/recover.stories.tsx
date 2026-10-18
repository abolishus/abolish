import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";

import type { Backer } from "./backup-offer.tsx";
import { RecoverIntro, RecoverRestored, RecoverStopped, RecoverWorking } from "./recover.tsx";

// The recovery screens (recover.tsx), one at a time, with `recover`'s steps
// left out: they are tested in tests/recovery.test.ts; the flow through the
// screens is in open.stories.tsx.

const POLL = {
  definitionHash: "3f8a0c51d2e4b69788a1c0d3e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718",
  name: "Riverside Residents' Association",
  closes: "Fri 17 Oct",
};

const meta = {
  title: "Ballot/Recover",
  component: RecoverIntro,
  parameters: { layout: "fullscreen" },
  args: { poll: POLL, onStart: fn(), onBack: fn() },
} satisfies Meta<typeof RecoverIntro>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Intro: Story = {
  name: "Recovering: what comes back, before any prompt",
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Recover your voting identity",
    );
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveFocus();
    await expect(canvas.getByRole("heading", { name: "What doesn't come back" })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Use my passkey" }));
    await expect(args.onStart).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByRole("button", { name: "Back" }));
    await expect(args.onBack).toHaveBeenCalledOnce();
  },
};

export const IntroDark: Story = {
  name: "Recovering, dark",
  parameters: { layout: "fullscreen", theme: "dark" },
};

export const Working: Story = {
  name: "Recovering: nothing to press",
  render: () => <RecoverWorking poll={POLL} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("status")).toHaveTextContent(/passkey prompt/);
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};

const onRestored = fn();

export const Restored: Story = {
  name: "Recovered: the area named, one device per poll",
  render: () => <RecoverRestored poll={POLL} region={3} syncable backedUp onBack={onRestored} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Your voting identity is on this device",
    );
    await expect(canvas.getByText(/counts it in area 3/)).toBeVisible();
    await expect(canvas.getByText(/If area 3 isn't where you registered/)).toBeVisible();
    await expect(canvas.getByText("Answer each poll from one device")).toBeVisible();
    // A synced passkey: no warning about it.
    await expect(canvas.queryByText(/isn't on your other devices yet/)).toBeNull();
    await expect(canvas.queryByText(/can't be copied/)).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Back to the poll" }));
    await expect(onRestored).toHaveBeenCalledOnce();
  },
};

export const RestoredWithAPasskeyThatCantSync: Story = {
  name: "Recovered with a passkey that can't sync",
  render: () => (
    <RecoverRestored poll={POLL} region={0} syncable={false} backedUp={false} onBack={fn()} />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText("This passkey can't be copied to your other devices"),
    ).toBeVisible();
    await expect(canvas.queryByText(/isn't on your other devices yet/)).toBeNull();
  },
};

export const RestoredWithTheBackupRenewed: Story = {
  name: "Recovered: the backup offered again, and renewed",
  render: () => (
    <RecoverRestored
      poll={POLL}
      region={3}
      syncable
      backedUp
      onBack={fn()}
      backer={{
        // Recovery keeps the passkey with no stored time, so the offer shows.
        credential: fn<Backer["credential"]>(() =>
          Promise.resolve({
            kind: "found",
            credential: { credentialId: new Uint8Array(16).fill(7), backedUp: true },
          }),
        ),
        backUp: fn<Backer["backUp"]>(() =>
          Promise.resolve({ kind: "stored", syncable: true, backedUp: true }),
        ),
        now: () => 1_760_000_000_000,
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Back up with a passkey" }));
    await expect(await canvas.findByText("Backed up with your passkey")).toBeVisible();
  },
};

export const RestoredDark: Story = {
  name: "Recovered, dark",
  parameters: { layout: "fullscreen", theme: "dark" },
  render: () => <RecoverRestored poll={POLL} region={3} syncable backedUp={false} onBack={fn()} />,
};

const onRetry = fn();
const onBack = fn();

export const NoBackup: Story = {
  name: "Stopped: no backup for this passkey, another asked for",
  render: () => (
    <RecoverStopped poll={POLL} problem="no-backup" onRetry={onRetry} onBack={onBack} />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "There's no backup for this passkey",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Try another passkey" }));
    await expect(onRetry).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByRole("button", { name: "Back" }));
    await expect(onBack).toHaveBeenCalledOnce();
  },
};

export const NotRegisteredYet: Story = {
  name: "Stopped: the identity isn't on a list yet",
  render: () => (
    <RecoverStopped poll={POLL} problem="not-registered" onRetry={fn()} onBack={fn()} />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/try again later/)).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Try again" })).toBeVisible();
  },
};

export const Unwritable: Story = {
  name: "Stopped: the browser won't keep it, with no retry",
  render: () => <RecoverStopped poll={POLL} problem="unwritable" onRetry={fn()} onBack={fn()} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "This browser won't keep a voting identity",
    );
    await expect(canvas.queryByRole("button", { name: /Try/ })).toBeNull();
    await expect(canvas.getByRole("button", { name: "Back" })).toBeVisible();
  },
};

export const StoppedDark: Story = {
  name: "Stopped, dark",
  parameters: { layout: "fullscreen", theme: "dark" },
  render: () => <RecoverStopped poll={POLL} problem="damaged" onRetry={fn()} onBack={fn()} />,
};
