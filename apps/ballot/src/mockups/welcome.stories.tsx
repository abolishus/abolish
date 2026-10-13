import { Button } from "@abolishus/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { CLIENT, ENTRY_POINTS, LEVY, SHARED_GATEWAY_URL, type BallotElection } from "./fixtures.ts";
import {
  ACTION,
  BallotFrame,
  Checklist,
  CheckItem,
  Evidence,
  Facts,
  NumberedSteps,
  ScreenTitle,
  Section,
} from "./frame.tsx";

function Welcome({ election }: { election: BallotElection }) {
  return (
    <BallotFrame
      election={election}
      step="Check"
      primary={
        <Button size="lg" className={ACTION}>
          Start
        </Button>
      }
    >
      <ScreenTitle eyebrow={election.organiser} title={election.title}>
        <p className="m-0">
          Before showing you the ballot, this device checked that the election and the ballot client
          are the ones on public record. Both checks passed.
        </p>
      </ScreenTitle>
      <div className="mt-6">
        <Facts
          items={[
            ["Who can vote", election.scope],
            ["Voting closes", <span className="font-mono text-sm">{election.closes}</span>],
            ["Result", "Non-binding. Counted in public, per verification tier."],
          ]}
        />
      </div>
      <Section index="01" title="What this device checked">
        <Checklist label="Checks before voting">
          <CheckItem state="passed" title="This is the election that was registered">
            <p className="m-0 text-sm text-muted-foreground">
              The election's definition has the same hash as the one in the public election
              registry. Its fingerprint is in the top bar.
            </p>
            <Evidence
              label="Registered definition hash"
              hash={election.definitionHash}
              of="the registered definition"
            />
          </CheckItem>
          <CheckItem state="passed" title={`This is the signed ballot client ${CLIENT.version}`}>
            <p className="m-0 text-sm text-muted-foreground">
              The code running here has the same hash as the release Abolish signed and published.
            </p>
            <Evidence label="Signed release hash" hash={CLIENT.hash} of="the signed release" />
          </CheckItem>
          <CheckItem state="passed" title="It is running from an address of its own">
            <p className="m-0 text-sm text-muted-foreground">
              Served from <span className="font-mono">{CLIENT.origin}</span>, which no other site
              shares.
            </p>
          </CheckItem>
        </Checklist>
      </Section>
      <Section index="02" title="What happens next">
        <NumberedSteps
          label="Voting steps"
          items={[
            "Confirm that you can vote in this poll. No one learns which voter you are.",
            "Choose. Take as long as you need; nothing is sent while you choose.",
            "Review your choices. You can also check that this device sealed them correctly.",
            "Cast. Your ballot is encrypted on this device before it leaves.",
            "Keep your receipt, so you can find your ballot on the public board later.",
          ]}
        />
      </Section>
    </BallotFrame>
  );
}

function OriginRefused() {
  return (
    <BallotFrame>
      <ScreenTitle title="This address isn't safe for voting">
        <p className="m-0">
          This copy of the ballot client was opened from a shared gateway address. Other pages on
          the same address could read or change what this page does, so it won't show a ballot here.
        </p>
      </ScreenTitle>
      <div className="mt-6 grid gap-2">
        <p className="m-0 text-sm text-muted-foreground">The address you opened</p>
        <p translate="no" className="m-0 font-mono text-sm break-all">
          {SHARED_GATEWAY_URL}
        </p>
      </div>
      <Section index="01" title="Nothing was sent">
        <p className="m-0">
          No ballot was shown and nothing left this device. You haven't lost your chance to vote.
        </p>
      </Section>
      <Section index="02" title="Open the ballot from one of these addresses">
        <ul className="m-0 grid list-none gap-0 border-y border-foreground p-0">
          {ENTRY_POINTS.map((entry) => (
            <li key={entry.name} className="border-b border-border py-3 last:border-b-0">
              <p className="m-0 font-mono">{entry.name}</p>
              <p className="m-0 text-sm text-muted-foreground">{entry.note}</p>
            </li>
          ))}
        </ul>
        <p className="m-0 text-sm text-muted-foreground">
          A gateway that puts the content address first, such as{" "}
          <span className="font-mono">bafy….ipfs.example.net</span>, is also safe.
        </p>
      </Section>
    </BallotFrame>
  );
}

const meta = {
  title: "Mockups/Ballot/Welcome",
  component: Welcome,
  args: { election: LEVY },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Welcome>;

export default meta;
type Story = StoryObj<typeof meta>;

const checked: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(LEVY.title);
  const checks = within(canvas.getByRole("list", { name: "Checks before voting" }));
  const items = checks.getAllByRole("listitem");
  await expect(items).toHaveLength(3);
  for (const item of items) await expect(item).toHaveTextContent("Passed");
  await expect(
    canvas.getByRole("figure", { name: "Registered definition hash" }),
  ).toHaveTextContent(LEVY.definitionHash);
  await expect(canvas.getByText("Step 1 of 5")).toBeVisible();
  await expect(canvas.getByRole("button", { name: "Start" })).toBeEnabled();
};

export const Checked: Story = { play: checked };

export const Dark: Story = { parameters: { layout: "fullscreen", theme: "dark" }, play: checked };

export const OriginRefusedScreen: Story = {
  name: "Origin refused",
  render: () => <OriginRefused />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "This address isn't safe for voting",
    );
    await expect(canvas.getByText(SHARED_GATEWAY_URL)).toBeVisible();
    // No way forward from here but another address: no ballot, no start button.
    await expect(canvas.queryByRole("button")).toBeNull();
    await expect(canvas.getByText("abolishus.eth")).toBeVisible();
  },
};
