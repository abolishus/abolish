import { Button, Count, Hash } from "@abolishus/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { LEVY, SEALED, type BallotElection } from "./fixtures.ts";
import {
  ACTION,
  BallotFrame,
  Checklist,
  CheckItem,
  Evidence,
  Facts,
  linkAction,
  Notice,
  ScreenTitle,
  Section,
} from "./frame.tsx";

function Challenge({
  election,
  chosen,
  inside,
}: {
  election: BallotElection;
  /** What the voter chose on the ballot screen. */
  chosen: string;
  /** What the opened sealed ballot holds. */
  inside: string;
}) {
  const labelOf = (key: string) => election.options.find((o) => o.key === key)?.label ?? key;
  const matches = chosen === inside;
  const boardLink = `https://abolish.us/board/${SEALED.spoiledEntry}`;
  return (
    <BallotFrame
      election={election}
      step="Review"
      primary={
        matches ? (
          <Button size="lg" className={ACTION}>
            Choose again
          </Button>
        ) : (
          <a className={linkAction()} href="https://abolish.us/verify#report">
            How to report this
          </a>
        )
      }
      secondary={
        <a className={linkAction("outline")} href={boardLink}>
          See entry {SEALED.spoiledEntry.toLocaleString("en-US")} on the board
        </a>
      }
    >
      <ScreenTitle title="Your sealed ballot, opened">
        <p className="m-0">
          You asked this device to show that it sealed your choices correctly. This is the sealed
          ballot it made, opened with the key that locked it.
        </p>
      </ScreenTitle>
      <div className="mt-8 grid gap-6 border-2 border-foreground px-4 py-5">
        <Evidence label="Sealed ballot hash" hash={SEALED.hash} of="the sealed ballot" />
        <p className="m-0 text-sm text-muted-foreground">
          The same fingerprint you saw on the review screen.
        </p>
        <div className="grid gap-1 border-t border-border pt-4">
          <p className="m-0 text-sm text-muted-foreground">Inside it</p>
          <p className="m-0 text-xl font-semibold">{labelOf(inside)}</p>
        </div>
        <Checklist label="Comparison">
          {matches ? (
            <CheckItem state="passed" title="This is what you chose" />
          ) : (
            <CheckItem state="failed" title="This is not what you chose">
              <p className="m-0 text-sm">You chose: {labelOf(chosen)}.</p>
            </CheckItem>
          )}
        </Checklist>
      </div>
      {matches ? null : (
        <div className="mt-6">
          <Notice tone="error" title="Don't cast a ballot from this device">
            <p className="m-0">
              The device sealed something other than your choice. Your vote has not been cast. Vote
              from a different device, and report this with the entry number below; the opened
              ballot on the board is the evidence.
            </p>
          </Notice>
        </div>
      )}
      <Section index="01" title="This ballot is now spoiled">
        <p className="m-0">
          Once opened, a sealed ballot can never be counted, so your vote has not been cast. It has
          been posted to the board as a spoiled ballot, with its key, so anyone can check that it
          holds what this screen says.
        </p>
        <Facts
          items={[
            [
              "Board entry",
              <span className="font-mono">
                <Count value={SEALED.spoiledEntry} />
              </span>,
            ],
            ["Kind", "Spoiled ballot"],
            ["Posted", <span className="font-mono">{SEALED.spoiledAt}</span>],
          ]}
        />
        <Hash value={SEALED.opening} label="Opening key, published with it" />
      </Section>
      <Section index="02" title="Check it from somewhere else">
        <p className="m-0">
          This screen was drawn by the same device that sealed the ballot. For a check that doesn't
          rely on it, open entry {SEALED.spoiledEntry.toLocaleString("en-US")} on the board from
          another device, or run the verifier on it.
        </p>
      </Section>
      {matches ? (
        <Section index="03" title="What happens now">
          <p className="m-0">
            You choose again, and this device seals your choices with a new key. You can check as
            many times as you like. Only a ballot you cast counts.
          </p>
        </Section>
      ) : null}
    </BallotFrame>
  );
}

const meta = {
  title: "Mockups/Ballot/Challenge",
  component: Challenge,
  args: { election: LEVY, chosen: "yes", inside: "yes" },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Challenge>;

export default meta;
type Story = StoryObj<typeof meta>;

const opened: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
    "Your sealed ballot, opened",
  );
  await expect(canvas.getByText("Inside it").nextElementSibling).toHaveTextContent(
    "Yes, renew the levy",
  );
  await expect(canvas.getByRole("list", { name: "Comparison" })).toHaveTextContent(
    "This is what you chosePassed",
  );
  await expect(canvas.getByRole("heading", { name: "This ballot is now spoiled" })).toBeVisible();
  await expect(canvas.getByText("Spoiled ballot")).toBeVisible();
  await expect(canvas.getByRole("button", { name: "Choose again" })).toBeVisible();
  // Nothing on this screen casts.
  await expect(canvas.queryByRole("button", { name: /^Cast/ })).toBeNull();
};

export const Matches: Story = { play: opened };

export const DoesNotMatch: Story = {
  name: "Does not match",
  args: { inside: "no" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("list", { name: "Comparison" })).toHaveTextContent(
      "This is not what you choseFailed",
    );
    await expect(canvas.getByText("You chose: Yes, renew the levy.")).toBeVisible();
    await expect(canvas.getByText("Don't cast a ballot from this device")).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "Choose again" })).toBeNull();
  },
};

export const Dark: Story = {
  parameters: { layout: "fullscreen", theme: "dark" },
  play: opened,
};
