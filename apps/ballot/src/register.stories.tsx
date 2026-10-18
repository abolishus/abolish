import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";

import {
  RegisterChallenge,
  RegisterIntro,
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
