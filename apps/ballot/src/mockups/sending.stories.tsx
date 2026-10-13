import { Button, StatusTrail, type StatusStep } from "@abolishus/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { LEVY, SEALED, type BallotElection } from "./fixtures.ts";
import { ACTION, BallotFrame, Evidence, Notice, ScreenTitle, Section } from "./frame.tsx";

const STATE_LABELS = { complete: "done", pending: "in progress", upcoming: "not yet" };

const ENCRYPTING: readonly StatusStep[] = [
  {
    label: "Encrypted on this device",
    state: "pending",
    detail:
      "Sealed. Now adding the proof that it is a valid ballot from an eligible voter, without saying which one.",
  },
  { label: "Recorded on the board", state: "upcoming" },
  { label: "Anchored to Ethereum", state: "upcoming" },
  { label: "Counted", state: "upcoming" },
];

const STALLED: readonly StatusStep[] = [
  { label: "Encrypted on this device", state: "complete" },
  {
    label: "Recorded on the board",
    state: "pending",
    detail: "Sent at 14:02:09 UTC. No answer from the board yet.",
  },
  { label: "Anchored to Ethereum", state: "upcoming" },
  { label: "Counted", state: "upcoming" },
];

function Sending({ election, slow }: { election: BallotElection; slow: boolean }) {
  return (
    <BallotFrame
      election={election}
      step="Cast"
      {...(slow
        ? {
            primary: (
              <Button size="lg" className={ACTION}>
                Keep waiting
              </Button>
            ),
            secondary: (
              <Button size="lg" variant="outline" className={ACTION}>
                Send it directly instead
              </Button>
            ),
          }
        : {})}
    >
      <ScreenTitle title={slow ? "This is taking longer than usual" : "Casting your ballot"}>
        <p className="m-0">
          {slow
            ? "Your sealed ballot is safe on this device. Nothing is lost by waiting."
            : "Keep this page open. This usually takes less than a minute."}
        </p>
      </ScreenTitle>
      <div className="mt-8 border-y border-foreground py-6">
        <StatusTrail
          label="Your ballot"
          steps={slow ? STALLED : ENCRYPTING}
          stateLabels={STATE_LABELS}
          stepTemplate="{step}, {state}"
        />
      </div>
      {slow ? (
        <Section index="01" title="If you'd rather not wait">
          <Notice tone="pending" title="Send it directly to the election's contract">
            <p className="m-0">
              This path skips Abolish's servers and posts the same sealed ballot to the election's
              contract on Ethereum, where the board must pick it up. It is slower to show on the
              board, and your receipt then comes from the chain.
            </p>
            <p className="m-0">
              If the first copy arrives as well, the board keeps one. Your vote counts once.
            </p>
          </Notice>
        </Section>
      ) : (
        <Section index="01" title="What is happening">
          <p className="m-0">
            Your choices were sealed on this device before anything left it. The proof being made
            now lets the board accept your ballot without learning who you are. Then the sealed
            ballot is sent, and the board answers with your receipt.
          </p>
        </Section>
      )}
      <Section index="02" title="The ballot being sent">
        <Evidence label="Sealed ballot hash" hash={SEALED.hash} of="your sealed ballot" />
      </Section>
    </BallotFrame>
  );
}

const meta = {
  title: "Mockups/Ballot/Sending",
  component: Sending,
  args: { election: LEVY, slow: false },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Sending>;

export default meta;
type Story = StoryObj<typeof meta>;

const encrypting: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const steps = within(canvas.getByRole("list", { name: "Your ballot" })).getAllByRole("listitem");
  await expect(steps[0]?.querySelector(".sr-only")).toHaveTextContent(
    "Encrypted on this device, in progress",
  );
  await expect(steps[0]).toHaveAttribute("aria-current", "step");
  await expect(steps[1]?.querySelector(".sr-only")).toHaveTextContent(
    "Recorded on the board, not yet",
  );
  // A still screen: nothing to press, and no spinner.
  await expect(canvas.queryByRole("button")).toBeNull();
  await expect(canvasElement.querySelector(".animate-spin")).toBeNull();
};

export const Encrypting: Story = { play: encrypting };

export const TakingLonger: Story = {
  name: "Taking longer than usual",
  args: { slow: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const steps = within(canvas.getByRole("list", { name: "Your ballot" })).getAllByRole(
      "listitem",
    );
    await expect(steps[0]?.querySelector(".sr-only")).toHaveTextContent(
      "Encrypted on this device, done",
    );
    await expect(steps[1]).toHaveAttribute("aria-current", "step");
    await expect(canvas.getByText("Send it directly to the election's contract")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Keep waiting" })).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Send it directly instead" })).toBeVisible();
  },
};

export const Dark: Story = {
  parameters: { layout: "fullscreen", theme: "dark" },
  play: encrypting,
};
