import { Button } from "@abolishus/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { KeyRound } from "lucide-react";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";

import {
  ACTION,
  BallotFrame,
  Facts,
  linkAction,
  Notice,
  NumberedSteps,
  ScreenTitle,
  Section,
} from "./frame.tsx";

const IDENTITY_FACTS = [
  ["Your account", "Who you are to Abolish: signing in, and polls you create or follow."],
  [
    "Your voting identity",
    "What lets you vote without saying who you are. It never leaves this device unlocked.",
  ],
] as const;

function Backup() {
  const [done, setDone] = useState(false);
  return (
    <BallotFrame
      primary={
        done ? (
          <Button size="lg" className={ACTION}>
            Continue
          </Button>
        ) : (
          <Button size="lg" className={ACTION} onClick={() => setDone(true)}>
            <KeyRound aria-hidden="true" />
            Back up with my passkey
          </Button>
        )
      }
      secondary={
        done ? undefined : (
          <Button size="lg" variant="outline" className={ACTION}>
            Not now
          </Button>
        )
      }
    >
      <ScreenTitle title="Back up your voting identity">
        <p className="m-0">
          Your voting identity is a secret kept only on this device. Back it up so you can still
          vote if you lose this device or move to a new one.
        </p>
      </ScreenTitle>
      <Section index="01" title="How the backup works">
        <NumberedSteps
          label="How the backup works"
          items={[
            "Your passkey makes a key that only that passkey can make again.",
            "This device locks your voting identity with that key.",
            "Only the locked copy is stored. Abolish can't open it, and it isn't linked to your account or to any ballot.",
          ]}
        />
      </Section>
      <Section index="02" title="Two separate things">
        <Facts items={IDENTITY_FACTS} />
      </Section>
      <div className="mt-8">
        {done ? (
          <Notice tone="done" title="Backed up with your passkey" live>
            <p className="m-0">
              To vote from a new device, open the ballot there and choose Restore. You'll need the
              same passkey.
            </p>
          </Notice>
        ) : (
          <p role="status" className="m-0 text-muted-foreground">
            Not backed up yet.
          </p>
        )}
      </div>
    </BallotFrame>
  );
}

function Restore() {
  const [done, setDone] = useState(false);
  return (
    <BallotFrame
      primary={
        done ? (
          <Button size="lg" className={ACTION}>
            Continue
          </Button>
        ) : (
          <Button size="lg" className={ACTION} onClick={() => setDone(true)}>
            <KeyRound aria-hidden="true" />
            Unlock with my passkey
          </Button>
        )
      }
      secondary={
        done ? undefined : (
          <Button size="lg" variant="outline" className={ACTION}>
            Back
          </Button>
        )
      }
    >
      <ScreenTitle title="Restore your voting identity">
        <p className="m-0">
          There is a locked backup of your voting identity. Use the passkey you made it with to
          unlock it on this device.
        </p>
      </ScreenTitle>
      <Section index="01" title="What happens">
        <NumberedSteps
          label="What happens when you restore"
          items={[
            "Your device asks for your passkey.",
            "The passkey makes the same key as before, and this device unlocks the backup with it.",
            "Your voting identity is now on this device too. Ballots you cast from either device count the same way: only your last one.",
          ]}
        />
      </Section>
      <Section index="02" title="If you no longer have that passkey">
        <p className="m-0">
          The backup can't be opened without it, by you or by Abolish. You can confirm that you can
          vote again instead, the way you did the first time.
        </p>
      </Section>
      <div className="mt-8">
        {done ? (
          <Notice tone="done" title="Restored. You can vote from this device." live />
        ) : (
          <p role="status" className="m-0 text-muted-foreground">
            Not restored yet.
          </p>
        )}
      </div>
    </BallotFrame>
  );
}

function Unsupported() {
  return (
    <BallotFrame
      primary={
        <Button size="lg" className={ACTION}>
          Continue without a backup
        </Button>
      }
      secondary={
        <a className={linkAction("outline")} href="https://abolish.us/how-it-works#backups">
          Which browsers work
        </a>
      }
    >
      <ScreenTitle title="This browser can't make a backup">
        <p className="m-0">
          Backups need a passkey feature that this browser, or the place your passkey is stored,
          doesn't offer.
        </p>
      </ScreenTitle>
      <Section index="01" title="You can still vote here">
        <p className="m-0">
          Your voting identity works on this device as before. Without a backup, if you lose this
          device you'll need to confirm that you can vote again on a new one.
        </p>
      </Section>
      <Section index="02" title="To make a backup">
        <NumberedSteps
          label="How to make a backup"
          items={[
            "Use an up-to-date version of Chrome, Edge, Safari or Firefox.",
            "Use a passkey saved on your phone or computer's built-in passkey store, or a recent security key.",
            "Open this screen again and choose Back up.",
          ]}
        />
      </Section>
    </BallotFrame>
  );
}

const meta = {
  title: "Mockups/Ballot/Recovery",
  component: Backup,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Backup>;

export default meta;
type Story = StoryObj<typeof meta>;

const backUp: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
    "Back up your voting identity",
  );
  await expect(canvas.getByRole("status")).toHaveTextContent("Not backed up yet.");
  await userEvent.click(canvas.getByRole("button", { name: "Back up with my passkey" }));
  await expect(canvas.getByRole("status")).toHaveTextContent("Backed up with your passkey");
  await expect(canvas.queryByRole("button", { name: "Not now" })).toBeNull();
};

export const BackUp: Story = { name: "Back up", play: backUp };

export const RestoreScreen: Story = {
  name: "Restore",
  render: () => <Restore />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("status")).toHaveTextContent("Not restored yet.");
    await userEvent.click(canvas.getByRole("button", { name: "Unlock with my passkey" }));
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "Restored. You can vote from this device.",
    );
  },
};

export const CantBackUp: Story = {
  name: "Browser can't back up",
  render: () => <Unsupported />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "This browser can't make a backup",
    );
    await expect(canvas.getByRole("heading", { name: "You can still vote here" })).toBeVisible();
    await expect(canvas.queryByRole("button", { name: /Back up with/ })).toBeNull();
  },
};

export const Dark: Story = {
  parameters: { layout: "fullscreen", theme: "dark" },
  play: backUp,
};
