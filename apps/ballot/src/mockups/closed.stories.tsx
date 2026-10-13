import { Count } from "@abolishus/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { BOARD_HEAD, LEVY, type BallotElection } from "./fixtures.ts";
import { BallotFrame, Evidence, linkAction, ScreenTitle, Section } from "./frame.tsx";

function Closed({ election }: { election: BallotElection }) {
  return (
    <BallotFrame
      election={election}
      primary={
        <a className={linkAction()} href={`${election.url}/results`}>
          See the results
        </a>
      }
      secondary={
        <a className={linkAction("outline")} href="https://abolish.us/verify">
          Check your receipt
        </a>
      }
    >
      <ScreenTitle eyebrow={election.title} title="Voting has ended">
        <p className="m-0">
          Voting closed on <span className="font-mono text-base">{election.closes}</span>. This
          ballot client can't accept ballots for it any more.
        </p>
      </ScreenTitle>
      <Section index="01" title="The board, as it closed">
        <p className="m-0">
          The board holds{" "}
          <span className="font-semibold">
            <Count value={BOARD_HEAD.entries} />
          </span>{" "}
          entries for this poll. This is its final state; the results are counted from exactly these
          entries.
        </p>
        <Evidence label="Final board hash" hash={BOARD_HEAD.hash} of="the final board" />
      </Section>
      <Section index="02" title="What you can do now">
        <ul className="m-0 grid list-none gap-0 border-y border-foreground p-0">
          <li className="grid gap-1 border-b border-border py-3">
            <a
              className="font-medium underline underline-offset-4"
              href={`${election.url}/results`}
            >
              See the results
            </a>
            <span className="text-sm text-muted-foreground">
              Shown separately for each verification tier, with how many voters each covers.
            </span>
          </li>
          <li className="grid gap-1 border-b border-border py-3">
            <a
              className="font-medium underline underline-offset-4"
              href="https://abolish.us/verify"
            >
              Check your receipt
            </a>
            <span className="text-sm text-muted-foreground">
              Find your entry and compare its fingerprint with the one you saved.
            </span>
          </li>
          <li className="grid gap-1 py-3">
            <a
              className="font-medium underline underline-offset-4"
              href="https://abolish.us/verify#recount"
            >
              Recount it yourself
            </a>
            <span className="text-sm text-muted-foreground">
              The verifier recounts every ballot from Ethereum and IPFS, without Abolish's servers.
            </span>
          </li>
        </ul>
      </Section>
    </BallotFrame>
  );
}

const meta = {
  title: "Mockups/Ballot/Closed",
  component: Closed,
  args: { election: LEVY },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Closed>;

export default meta;
type Story = StoryObj<typeof meta>;

const closed: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("Voting has ended");
  await expect(canvas.getByText(LEVY.closes)).toBeVisible();
  const results = canvas.getAllByRole("link", { name: "See the results" });
  for (const link of results) await expect(link).toHaveAttribute("href", `${LEVY.url}/results`);
  await expect(canvas.getByText("161,874")).toBeVisible();
  // No way to vote from here.
  await expect(canvas.queryByRole("button")).toBeNull();
};

export const VotingEnded: Story = { name: "Voting ended", play: closed };

export const Dark: Story = {
  parameters: { layout: "fullscreen", theme: "dark" },
  play: closed,
};
