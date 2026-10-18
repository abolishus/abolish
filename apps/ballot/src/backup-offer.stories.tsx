import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";

import type { BackupOutcome } from "./backup.ts";
import { type Backer, BackupOffer } from "./backup-offer.tsx";
import { EverydayFrame } from "./frame.tsx";
import type { BackupCredentialRead } from "./identity.ts";

// The passkey backup's offer and outcomes (backup-offer.tsx), in the frame
// of the registration screens it sits on, with `backUp`'s steps left out:
// they are tested in tests/backup.test.ts.

const POLL = {
  definitionHash: "3f8a0c51d2e4b69788a1c0d3e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718",
  name: "Riverside Residents' Association",
  closes: "Fri 17 Oct",
};

const CREDENTIAL_ID = new Uint8Array(16).fill(7);
const NOW = 1_760_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

/**
 * A backer whose device keeps `held`, and whose backups give `outcomes` in
 * turn (the last repeats).
 */
function backer(held: BackupCredentialRead, ...outcomes: BackupOutcome[]): Backer {
  let given = 0;
  return {
    credential: fn<Backer["credential"]>(() => Promise.resolve(held)),
    backUp: fn<Backer["backUp"]>(() =>
      Promise.resolve(outcomes[Math.min(given++, outcomes.length - 1)] as BackupOutcome),
    ),
    now: () => NOW,
  };
}

const STORED: BackupOutcome = { kind: "stored", syncable: true, backedUp: true };

const meta = {
  title: "Ballot/Backup",
  component: BackupOffer,
  parameters: { layout: "fullscreen" },
  args: { backer: backer({ kind: "none" }, STORED) },
  render: (args) => (
    <EverydayFrame poll={POLL}>
      <BackupOffer {...args} />
    </EverydayFrame>
  ),
} satisfies Meta<typeof BackupOffer>;

export default meta;
type Story = StoryObj<typeof meta>;

const START = { name: "Back up with a passkey" };

export const Offered: Story = {
  name: "Offered, then backed up",
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", { name: "Back up with a passkey?" }),
    ).toBeVisible();
    await expect(canvas.getByText(/A new device would start as someone new/)).toBeVisible();
    // A double tap runs one backup: the first tap replaces the button.
    await userEvent.dblClick(canvas.getByRole("button", START));
    await expect(await canvas.findByText("Backed up with your passkey")).toBeVisible();
    await expect(args.backer.backUp).toHaveBeenCalledOnce();
    await expect(canvas.getByRole("status")).toHaveTextContent(/only your passkey opens it/);
    // The pressed button is gone: focus is on the outcome, not the page.
    await expect(canvas.getByRole("status")).toHaveFocus();
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};

export const OfferedDark: Story = {
  name: "Offered, dark",
  parameters: { layout: "fullscreen", theme: "dark" },
};

export const NotNow: Story = {
  name: "Not now: nothing is asked of the passkey",
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Not now" }));
    await expect(canvas.getByRole("status")).toHaveTextContent(/No backup for now/);
    await expect(canvas.queryByRole("button", START)).toBeNull();
    await expect(args.backer.backUp).not.toHaveBeenCalled();
  },
};

export const CantSync: Story = {
  name: "Stored, but the passkey can't sync (BE clear)",
  args: { backer: backer({ kind: "none" }, { kind: "stored", syncable: false, backedUp: false }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", START));
    await expect(
      await canvas.findByText("This passkey can't be copied to your other devices"),
    ).toBeVisible();
    // Never told it is backed up.
    await expect(canvas.queryByText("Backed up with your passkey")).toBeNull();
  },
};

export const NotSyncedYet: Story = {
  name: "Stored, not synced yet (BS clear), then checked again",
  args: {
    backer: backer({ kind: "none" }, { kind: "stored", syncable: true, backedUp: false }, STORED),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", START));
    await expect(
      await canvas.findByText("Your passkey isn't on your other devices yet"),
    ).toBeVisible();
    await expect(canvas.queryByText("Backed up with your passkey")).toBeNull();
    // Checking again runs the backup again, which reads BS anew.
    await userEvent.click(canvas.getByRole("button", { name: "Check again" }));
    await expect(await canvas.findByText("Backed up with your passkey")).toBeVisible();
    await expect(args.backer.backUp).toHaveBeenCalledTimes(2);
  },
};

export const KeptAndSynced: Story = {
  name: "A later visit: backed up, nothing offered",
  args: {
    backer: backer({
      kind: "found",
      credential: { credentialId: CREDENTIAL_ID, backedUp: true, storedAt: NOW - DAY },
    }),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Backed up with your passkey")).toBeVisible();
    await expect(canvas.queryByRole("button")).toBeNull();
    await expect(args.backer.backUp).not.toHaveBeenCalled();
  },
};

export const KeptNotSynced: Story = {
  name: "A later visit: stored, the passkey last seen not synced",
  args: {
    backer: backer(
      {
        kind: "found",
        credential: { credentialId: CREDENTIAL_ID, backedUp: false, storedAt: NOW - DAY },
      },
      STORED,
    ),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    // The warning stands on every visit until a check finds the passkey synced.
    await expect(
      await canvas.findByText("Your passkey isn't on your other devices yet"),
    ).toBeVisible();
    await expect(args.backer.backUp).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole("button", { name: "Check again" }));
    await expect(await canvas.findByText("Backed up with your passkey")).toBeVisible();
  },
};

export const KeptLongAgo: Story = {
  name: "A later visit: stored over 18 months ago, offered again to renew",
  args: {
    backer: backer(
      {
        kind: "found",
        credential: { credentialId: CREDENTIAL_ID, backedUp: true, storedAt: NOW - 550 * DAY },
      },
      STORED,
    ),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    // The route drops an envelope after 24 months unrewritten (T-66): never shown as backed up.
    await userEvent.click(await canvas.findByRole("button", START));
    await expect(await canvas.findByText("Backed up with your passkey")).toBeVisible();
    await expect(args.backer.backUp).toHaveBeenCalledOnce();
  },
};

export const KeptWithoutBackup: Story = {
  name: "A passkey kept with nothing stored: offered again",
  args: {
    backer: backer(
      { kind: "found", credential: { credentialId: CREDENTIAL_ID, backedUp: true } },
      STORED,
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("button", START)).toBeVisible();
  },
};

export const RecordUnreadable: Story = {
  name: "A backup record this device can't read: nothing offered",
  args: { backer: backer({ kind: "unreadable" }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("There's no voting identity to back up")).toBeVisible();
    await expect(canvas.queryByRole("button")).toBeNull();
    await expect(args.backer.backUp).not.toHaveBeenCalled();
  },
};

export const Cancelled: Story = {
  name: "The prompt closed: try again",
  args: { backer: backer({ kind: "none" }, { kind: "stopped", problem: "cancelled" }, STORED) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", START));
    await expect(await canvas.findByText("The passkey prompt was closed")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Try again" }));
    await expect(await canvas.findByText("Backed up with your passkey")).toBeVisible();
  },
};

export const NoPrf: Story = {
  name: "The passkey can't hold a backup (no PRF)",
  args: { backer: backer({ kind: "none" }, { kind: "stopped", problem: "no-prf" }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", START));
    await expect(await canvas.findByText("This passkey can't hold a backup")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Try again" })).toBeVisible();
  },
};

export const NotKept: Story = {
  name: "Accepted but not given back: not counted as backed up",
  args: { backer: backer({ kind: "none" }, { kind: "stopped", problem: "not-kept" }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", START));
    await expect(
      await canvas.findByText("The backup service didn't keep the backup"),
    ).toBeVisible();
    await expect(canvas.queryByText("Backed up with your passkey")).toBeNull();
  },
};

export const Rejected: Story = {
  name: "Refused by the service: no retry",
  args: { backer: backer({ kind: "none" }, { kind: "stopped", problem: "rejected" }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", START));
    await expect(await canvas.findByText("The backup service refused this backup")).toBeVisible();
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};

export const Throws: Story = {
  name: "A backup that throws is reported, not left spinning",
  args: {
    backer: {
      credential: () => Promise.resolve({ kind: "none" }),
      backUp: () => Promise.reject(new Error("worker gone")),
      now: () => NOW,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", START));
    await expect(await canvas.findByText("The backup didn't finish")).toBeVisible();
  },
};
