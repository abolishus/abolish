import { Button } from "@abolishus/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { LEVY, PARK, SEALED, TENANTS, type BallotElection } from "./fixtures.ts";
import { ACTION, BallotFrame, Evidence, Notice, ScreenTitle, Section } from "./frame.tsx";

const ORDINALS = ["1st", "2nd", "3rd", "4th", "5th", "6th"];

function Review({
  election,
  choices,
}: {
  election: BallotElection;
  /** Option keys the voter chose; for ranked choice, in rank order. */
  choices: readonly string[];
}) {
  const labelOf = (key: string) => election.options.find((o) => o.key === key)?.label ?? key;
  const unranked = election.options.filter((o) => !choices.includes(o.key));
  const heading =
    election.method === "ranked"
      ? "Your ranking"
      : election.method === "approval"
        ? "Your choices"
        : "Your choice";
  return (
    <BallotFrame
      election={election}
      step="Review"
      primary={
        <Button size="lg" className={ACTION}>
          Cast this ballot
        </Button>
      }
      secondary={
        <Button size="lg" variant="outline" className={ACTION}>
          Check the encryption first
        </Button>
      }
    >
      <ScreenTitle title="Review your ballot">
        <p className="m-0">Check that these are your choices. Nothing has been sent yet.</p>
      </ScreenTitle>
      <section
        aria-labelledby="question-1"
        className="mt-8 grid gap-4 border-2 border-foreground px-4 py-5"
      >
        <p className="m-0 font-mono text-xs tracking-widest text-muted-foreground uppercase">
          Question 1 of 1
        </p>
        <h2 id="question-1" className="m-0 text-base font-normal text-pretty">
          {election.question}
        </h2>
        <div className="grid gap-2 border-t border-border pt-4">
          <h3 className="m-0 text-sm font-normal text-muted-foreground">{heading}</h3>
          {choices.length === 0 ? (
            <p className="m-0 text-xl font-semibold">No choice. This question is left blank.</p>
          ) : election.method === "ranked" ? (
            <ol aria-label={heading} className="m-0 grid list-none gap-2 p-0">
              {choices.map((key, i) => (
                <li key={key} className="flex items-baseline gap-3 text-xl font-semibold">
                  <span className="w-12 shrink-0 font-mono text-sm font-normal tracking-wide">
                    {ORDINALS[i]}
                  </span>
                  {labelOf(key)}
                </li>
              ))}
            </ol>
          ) : (
            <ul aria-label={heading} className="m-0 grid list-none gap-2 p-0">
              {choices.map((key) => (
                <li key={key} className="text-xl font-semibold">
                  {labelOf(key)}
                </li>
              ))}
            </ul>
          )}
          {election.method === "ranked" && choices.length > 0 && unranked.length > 0 ? (
            <p className="m-0 text-sm text-muted-foreground">
              You ranked {choices.length} of {election.options.length}. Not ranked:{" "}
              {unranked.map((o) => o.label).join(", ")}.
            </p>
          ) : null}
          {election.method === "approval" && choices.length > 0 ? (
            <p className="m-0 text-sm text-muted-foreground">
              {choices.length} of {election.options.length} chosen.
            </p>
          ) : null}
        </div>
        <div>
          <Button variant="outline" aria-label={`Change ${heading.toLowerCase()}`}>
            Change
          </Button>
        </div>
      </section>
      {choices.length === 0 ? (
        <div className="mt-6">
          <Notice title="You are about to cast a blank ballot">
            <p className="m-0">
              It is recorded on the board like any other ballot but counts for no option. If you
              meant to choose, use Change.
            </p>
          </Notice>
        </div>
      ) : null}
      <Section index="01" title="Your sealed ballot">
        <p className="m-0">
          This device has already encrypted your choices into a sealed ballot. No one can read it,
          including Abolish. This is its fingerprint:
        </p>
        <Evidence label="Sealed ballot hash" hash={SEALED.hash} of="your sealed ballot" />
      </Section>
      <Section index="02" title="Two ways to go on">
        <dl className="m-0 grid gap-4">
          <div className="grid gap-1 border-s-4 border-s-primary ps-4">
            <dt className="font-semibold">Cast this ballot</dt>
            <dd className="m-0">
              Sends the sealed ballot to the public board, where it counts. You'll get a receipt.
            </dd>
          </div>
          <div className="grid gap-1 border-s-4 border-s-border ps-4">
            <dt className="font-semibold">Check the encryption first</dt>
            <dd className="m-0 grid gap-2">
              <p className="m-0">
                Opens this sealed ballot so you can see it holds exactly your choices. An opened
                ballot can never be counted, so it is set aside and you choose again.
              </p>
              <p className="m-0 text-muted-foreground">
                Optional. Checking now and then, by anyone, is what catches a device that changes
                votes.
              </p>
            </dd>
          </div>
        </dl>
      </Section>
    </BallotFrame>
  );
}

const meta = {
  title: "Mockups/Ballot/Review",
  component: Review,
  args: { election: LEVY, choices: ["yes"] },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Review>;

export default meta;
type Story = StoryObj<typeof meta>;

const reviewPlurality: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("Review your ballot");
  await expect(canvas.getByRole("heading", { level: 2, name: LEVY.question })).toBeVisible();
  await expect(canvas.getByRole("list", { name: "Your choice" })).toHaveTextContent(
    "Yes, renew the levy",
  );
  await expect(canvas.getByRole("button", { name: "Change your choice" })).toBeVisible();
  await expect(canvas.getByRole("button", { name: "Cast this ballot" })).toBeVisible();
  await expect(canvas.getByRole("button", { name: "Check the encryption first" })).toBeVisible();
  await expect(canvas.getByRole("figure", { name: "Sealed ballot hash" })).toHaveTextContent(
    SEALED.hash,
  );
};

export const Plurality: Story = { play: reviewPlurality };

export const Approval: Story = {
  args: { election: PARK, choices: ["lights", "trees"] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = within(canvas.getByRole("list", { name: "Your choices" }));
    await expect(list.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Better lighting on the river path",
      "Two hundred new street trees",
    ]);
    await expect(canvas.getByText("2 of 4 chosen.")).toBeVisible();
  },
};

export const RankedChoice: Story = {
  args: { election: TENANTS, choices: ["reyes", "okafor"] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = within(canvas.getByRole("list", { name: "Your ranking" }));
    await expect(list.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "1stTomás Reyes",
      "2ndAdaeze Okafor",
    ]);
    await expect(canvas.getByText(/Not ranked: Mara Lindqvist\./)).toBeVisible();
  },
};

export const Blank: Story = {
  name: "Blank (undervote)",
  args: { choices: [] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("No choice. This question is left blank.")).toBeVisible();
    await expect(canvas.getByText("You are about to cast a blank ballot")).toBeVisible();
  },
};

export const Dark: Story = {
  parameters: { layout: "fullscreen", theme: "dark" },
  play: reviewPlurality,
};
