import { Button, Count } from "@abolishus/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { LEVY, PRIOR_RECEIPT, type BallotElection } from "./fixtures.ts";
import {
  ACTION,
  BallotFrame,
  Evidence,
  Facts,
  NumberedSteps,
  ScreenTitle,
  Section,
} from "./frame.tsx";

function Revote({ election }: { election: BallotElection }) {
  return (
    <BallotFrame
      election={election}
      step="Check"
      primary={
        <Button size="lg" className={ACTION}>
          Vote again
        </Button>
      }
      secondary={
        <Button size="lg" variant="outline" className={ACTION}>
          Keep my earlier ballot
        </Button>
      }
    >
      <ScreenTitle title="You have already voted in this poll">
        <p className="m-0">
          You can vote again. If you do, your new ballot replaces the earlier one. Only your last
          ballot counts.
        </p>
      </ScreenTitle>
      <Section index="01" title="Your earlier ballot">
        <p className="m-0">This device kept the receipt from when you voted before.</p>
        <Evidence label="Receipt hash" hash={PRIOR_RECEIPT.hash} of="your earlier receipt" />
        <Facts
          items={[
            [
              "Board entry",
              <span className="font-mono">
                <Count value={PRIOR_RECEIPT.entry} />
              </span>,
            ],
            ["Recorded", <span className="font-mono">{PRIOR_RECEIPT.recordedAt}</span>],
          ]}
        />
      </Section>
      <Section index="02" title="What voting again does">
        <NumberedSteps
          label="What voting again does"
          items={[
            "Your new ballot goes on the board as a new entry, with a new receipt.",
            "Your earlier ballot stays on the board, because nothing on it is ever deleted, but the count uses only your last one.",
            `You can do this as many times as you like until voting closes, ${election.closes}.`,
          ]}
        />
      </Section>
      <Section index="03" title="If someone pressured you">
        <p className="m-0">
          This is why voting again is allowed. If someone watched you vote, told you how to vote or
          asked to see your screen, you can vote again later, somewhere private, and only that
          ballot counts. Your receipts never show how you voted.
        </p>
      </Section>
    </BallotFrame>
  );
}

const meta = {
  title: "Mockups/Ballot/Revote",
  component: Revote,
  args: { election: LEVY },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Revote>;

export default meta;
type Story = StoryObj<typeof meta>;

const alreadyVoted: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
    "You have already voted in this poll",
  );
  await expect(canvas.getByText(/Only your last ballot counts/)).toBeVisible();
  await expect(canvas.getByRole("figure", { name: "Receipt hash" })).toHaveTextContent(
    PRIOR_RECEIPT.hash,
  );
  await expect(canvas.getByText("812")).toBeVisible();
  await expect(canvas.getByRole("button", { name: "Vote again" })).toBeVisible();
  await expect(canvas.getByRole("button", { name: "Keep my earlier ballot" })).toBeVisible();
};

export const AlreadyVoted: Story = { play: alreadyVoted };

export const Dark: Story = {
  parameters: { layout: "fullscreen", theme: "dark" },
  play: alreadyVoted,
};
