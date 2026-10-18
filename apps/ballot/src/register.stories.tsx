import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";

import {
  RegisterChallenge,
  RegisterDue,
  RegisterIntro,
  RegisterJoined,
  RegisterMoved,
  RegisterSent,
  RegisterStopped,
  RegisterWaiting,
  RegisterWorking,
} from "./register.tsx";

// The Tier 0 registration screens (register.tsx), one at a time, with the
// frame and the worker left out; the flow through them is in open.stories.tsx.

const POLL = {
  definitionHash: "3f8a0c51d2e4b69788a1c0d3e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718",
  name: "Riverside Residents' Association",
  closes: "Fri 17 Oct",
};

const meta = {
  title: "Ballot/Register",
  component: RegisterIntro,
  parameters: { layout: "fullscreen" },
  args: { poll: POLL, made: false, onStart: fn() },
} satisfies Meta<typeof RegisterIntro>;

export default meta;
type Story = StoryObj<typeof meta>;

export const MakeAnIdentity: Story = {
  name: "Making an identity: what stays on the device",
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Make a voting identity on this device",
    );
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveFocus();
    await expect(canvas.getByRole("heading", { name: "It stays on this device" })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Make my voting identity" }));
    await expect(args.onStart).toHaveBeenCalledOnce();
  },
};

export const MakeAnIdentityDark: Story = {
  name: "Making an identity, dark",
  parameters: { layout: "fullscreen", theme: "dark" },
};

export const MakeAnIdentityOrRecover: Story = {
  name: "Making an identity, with recovery from a backup offered",
  args: { onRecover: fn() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "Made one on another device?" }),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Recover it with a passkey" }));
    await expect(args.onRecover).toHaveBeenCalledOnce();
    await expect(args.onStart).not.toHaveBeenCalled();
  },
};

export const RegisterAKeptIdentity: Story = {
  name: "Registering an identity already on the device",
  args: { made: true },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Register your voting identity",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Register it" }));
    await expect(args.onStart).toHaveBeenCalledOnce();
  },
};

export const Preparing: Story = {
  name: "Making the identity: nothing to press",
  render: () => <RegisterWorking poll={POLL} kind="preparing" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("status")).toHaveTextContent(/Nothing is sent/);
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};

export const Sending: Story = {
  name: "Sending the request",
  render: () => <RegisterWorking poll={POLL} kind="sending" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Sending your registration",
    );
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};

const onToken = fn();

export const TheChallenge: Story = {
  name: "The check, in its frame",
  render: () => (
    <RegisterChallenge
      poll={POLL}
      Challenge={({ onToken: hand }) => (
        <button type="button" onClick={() => hand("token.1")}>
          Pass the check
        </button>
      )}
      onToken={onToken}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Show you're a person",
    );
    await expect(canvas.getByText("What the check page sees")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Pass the check" }));
    await expect(onToken).toHaveBeenCalledWith("token.1");
  },
};

const onBack = fn();

export const Sent: Story = {
  name: "Sent: come back later",
  render: () => <RegisterSent poll={POLL} onBack={onBack} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveFocus();
    await expect(canvas.getByRole("heading", { name: "Come back in an hour or so" })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Back to the poll" }));
    await expect(onBack).toHaveBeenCalledOnce();
  },
};

export const Waiting: Story = {
  name: "Waiting on a request sent earlier",
  render: () => <RegisterWaiting poll={POLL} sentAt="16 Oct 2026, 09:12" onCheck={fn()} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/sent your registration on 16 Oct 2026, 09:12/)).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Check again" })).toBeVisible();
  },
};

export const ChallengeRefused: Story = {
  name: "A refused check, with a retry",
  render: () => <RegisterStopped poll={POLL} problem="challenge-refused" onRetry={fn()} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "The check didn't pass",
    );
    await expect(canvas.getByRole("button", { name: "Try again" })).toBeVisible();
  },
};

export const Faulty: Story = {
  name: "A request the route refused as this build's fault, with no retry",
  render: () => <RegisterStopped poll={POLL} problem="faulty" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "The registration service refused this request",
    );
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};

export const Reading: Story = {
  name: "Reading the registry: nothing to press",
  render: () => <RegisterWorking poll={POLL} kind="reading" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("status")).toHaveTextContent(/all of it/);
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};

const onSend = fn();

export const Due: Story = {
  name: "Due again: the request may be sent once more",
  render: () => <RegisterDue poll={POLL} sentAt="16 Oct 2026, 09:12" onSend={onSend} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveFocus();
    await expect(canvas.getByText(/sent your registration on 16 Oct 2026, 09:12/)).toBeVisible();
    await expect(canvas.getByRole("heading", { name: "Sending it again is safe" })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Send it again" }));
    await expect(onSend).toHaveBeenCalledOnce();
  },
};

const onJoined = fn();

export const Joined: Story = {
  name: "Registered: back to the poll",
  render: () => <RegisterJoined poll={POLL} onBack={onJoined} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("You're registered");
    // A build that offers no backup shows none.
    await expect(canvas.queryByRole("button", { name: "Back up with a passkey" })).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Back to the poll" }));
    await expect(onJoined).toHaveBeenCalledOnce();
  },
};

export const JoinedWithBackup: Story = {
  name: "Registered, with the backup offered",
  render: () => (
    <RegisterJoined
      poll={POLL}
      backer={{
        credential: () => Promise.resolve({ kind: "none" }),
        backUp: () => Promise.resolve({ kind: "stored", syncable: true, backedUp: true }),
        now: () => 1_760_000_000_000,
      }}
      onBack={onJoined}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveFocus();
    await userEvent.click(await canvas.findByRole("button", { name: "Back up with a passkey" }));
    await expect(await canvas.findByText("Backed up with your passkey")).toBeVisible();
  },
};

const onCheck = fn();

export const Moved: Story = {
  name: "Moved to another region's list, shown by one endpoint: the alarm, with a check again",
  render: () => <RegisterMoved poll={POLL} onCheck={onCheck} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveFocus();
    await expect(canvas.getByText("Why this matters")).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "Make a new voting identity" })).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Check again" }));
    await expect(onCheck).toHaveBeenCalled();
  },
};

export const MovedDark: Story = {
  ...Moved,
  name: "Moved, dark",
  parameters: { layout: "fullscreen", theme: "dark" },
};

const onStartAgain = fn();

export const MovedConfirmed: Story = {
  name: "Moved, shown by both endpoints: a new identity offered",
  render: () => <RegisterMoved poll={POLL} onStartAgain={onStartAgain} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveFocus();
    await expect(canvas.getByText(/Two separate sources of the public list agree/)).toBeVisible();
    await expect(canvas.getByText(/A backup you made of it still holds the old one/)).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "Check again" })).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Make a new voting identity" }));
    await expect(onStartAgain).toHaveBeenCalled();
  },
};

export const MovedConfirmedDark: Story = {
  ...MovedConfirmed,
  name: "Moved and confirmed, dark",
  parameters: { layout: "fullscreen", theme: "dark" },
};

export const Replacing: Story = {
  name: "Making the new identity: nothing to press",
  render: () => <RegisterWorking poll={POLL} kind="replacing" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("status")).toHaveTextContent(/Nothing is sent/);
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};

export const OutcomeDisputed: Story = {
  name: "The two endpoints disagree, with a retry",
  render: () => <RegisterStopped poll={POLL} problem="outcome-disputed" onRetry={fn()} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Two sources of the list disagree",
    );
    await expect(canvas.getByRole("button", { name: "Try again" })).toBeVisible();
  },
};

export const RegistryUnavailable: Story = {
  name: "The registry couldn't be read, with a retry",
  render: () => <RegisterStopped poll={POLL} problem="registry-unavailable" onRetry={fn()} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Your registration couldn't be checked",
    );
    await expect(canvas.getByRole("button", { name: "Try again" })).toBeVisible();
  },
};
