import { BoardLedger, Button, ReceiptStub, StatusTrail, type StatusStep } from "@abolishus/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Download, Printer } from "lucide-react";
import { expect, within } from "storybook/test";

import {
  BOARD_EXCERPT,
  ENTRY_POINTS,
  LEVY,
  RECEIPT,
  shortHex,
  type BallotElection,
} from "./fixtures.ts";
import { ACTION, BallotFrame, NumberedSteps, ScreenTitle, Section } from "./frame.tsx";

const STATE_LABELS = { complete: "done", pending: "in progress", upcoming: "not yet" };

function trail(election: BallotElection, anchored: boolean): StatusStep[] {
  return [
    { label: "Encrypted on this device", state: "complete", detail: "Sealed at 14:02:08 UTC" },
    {
      label: "Recorded on the board",
      state: "complete",
      detail: `Entry ${RECEIPT.entry.toLocaleString("en-US")} at 14:02:12 UTC`,
    },
    anchored
      ? { label: "Anchored to Ethereum", state: "complete", detail: "At 15:00 UTC" }
      : { label: "Anchored to Ethereum", state: "pending", detail: RECEIPT.nextAnchor },
    { label: "Counted", state: "upcoming", detail: `After voting closes, ${election.closes}` },
  ];
}

/**
 * The receipt: the one screen after casting, and the one place on the ballot
 * where the explanations may settle in as they scroll (`reveal`). The stub
 * and the trail themselves never move.
 */
function Receipt({ election, anchored }: { election: BallotElection; anchored: boolean }) {
  return (
    <BallotFrame
      election={election}
      step="Receipt"
      primary={
        <Button size="lg" className={ACTION}>
          <Download aria-hidden="true" />
          Save receipt
        </Button>
      }
      secondary={
        <Button size="lg" variant="outline" className={ACTION}>
          <Printer aria-hidden="true" />
          Print receipt
        </Button>
      }
    >
      <ScreenTitle eyebrow={election.title} title="Your ballot is recorded">
        <p className="m-0">
          It is on the public board as entry {RECEIPT.entry.toLocaleString("en-US")}. Keep this
          receipt. It shows that your ballot is on the board, not how you voted.
        </p>
      </ScreenTitle>
      <div className="mt-8 [&>[role=group]]:max-w-none">
        <ReceiptStub
          title="Your receipt"
          hash={RECEIPT.hash}
          entry={RECEIPT.entry}
          recordedAt={RECEIPT.recordedAt}
          labels={{
            hash: "Receipt hash",
            fingerprint: `Fingerprint of receipt ${shortHex(RECEIPT.hash)}`,
            entry: "Board entry",
            recordedAt: "Recorded",
          }}
        />
      </div>
      <Section index="01" title="Where your ballot is" className="reveal">
        <StatusTrail
          label="Your ballot"
          steps={trail(election, anchored)}
          stateLabels={STATE_LABELS}
          stepTemplate="{step}, {state}"
        />
      </Section>
      <Section index="02" title="Your entry on the board" className="reveal">
        <div className="overflow-x-auto">
          <BoardLedger
            caption={`Entries ${BOARD_EXCERPT[0].index.toLocaleString("en-US")} to ${BOARD_EXCERPT[3].index.toLocaleString("en-US")}, ${election.title}`}
            columns={{ index: "Entry", time: "Time (UTC)", kind: "Kind", hash: "Hash" }}
            fingerprintLabel={(e) =>
              `Fingerprint of entry ${e.index.toLocaleString("en-US")}, ${shortHex(e.hash)}`
            }
            entries={BOARD_EXCERPT}
            highlight={RECEIPT.entry}
          />
        </div>
        <p className="m-0 text-sm text-muted-foreground">
          Your entry is marked. The others are other voters' sealed ballots; none of them shows a
          vote.
        </p>
      </Section>
      <Section index="03" title="Check it later" className="reveal">
        <NumberedSteps
          label="How to check your receipt"
          items={[
            <>
              Open <span className="font-mono">abolish.us/verify</span>, or the same page on{" "}
              {ENTRY_POINTS.slice(1)
                .map((e) => e.name)
                .join(" or ")}
              . Any of them will do.
            </>,
            "Enter your receipt hash, or open the receipt file you saved.",
            "Compare the fingerprint it shows with the one on your receipt. They should be identical.",
            "After voting closes, the verifier recounts every ballot, yours included, without Abolish's servers.",
          ]}
        />
      </Section>
      <Section index="04" title="You can vote again" className="reveal">
        <p className="m-0">
          Until voting closes at {election.closes}, you can vote again from any device. Only your
          last ballot counts. If someone watched or pressured you as you voted, you can vote again
          later, somewhere private.
        </p>
      </Section>
    </BallotFrame>
  );
}

const meta = {
  title: "Mockups/Ballot/Receipt",
  component: Receipt,
  args: { election: LEVY, anchored: false },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Receipt>;

export default meta;
type Story = StoryObj<typeof meta>;

const recorded: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
    "Your ballot is recorded",
  );
  const stub = within(canvas.getByRole("group", { name: "Your receipt" }));
  await expect(stub.getByRole("figure", { name: "Receipt hash" })).toHaveTextContent(RECEIPT.hash);
  await expect(stub.getByText("1,203")).toBeVisible();
  await expect(canvasElement.querySelector("time")).toHaveTextContent(
    "Nov 3, 2026, 2:02:12 PM UTC",
  );
  const heard = within(canvas.getByRole("list", { name: "Your ballot" }))
    .getAllByRole("listitem")
    .map((li) => li.querySelector(".sr-only")?.textContent);
  await expect(heard).toEqual([
    "Encrypted on this device, done",
    "Recorded on the board, done",
    "Anchored to Ethereum, in progress",
    "Counted, not yet",
  ]);
  await expect(canvasElement.querySelector("tr[aria-current]")).toHaveTextContent("1,203");
  await expect(canvas.getByText(/Only your last ballot counts/)).toBeVisible();
  await expect(canvas.getByRole("button", { name: "Save receipt" })).toBeVisible();
  await expect(canvas.getByRole("button", { name: "Print receipt" })).toBeVisible();
};

export const Recorded: Story = { play: recorded };

export const Anchored: Story = {
  args: { anchored: true },
  play: async ({ canvasElement }) => {
    const steps = within(
      within(canvasElement).getByRole("list", { name: "Your ballot" }),
    ).getAllByRole("listitem");
    await expect(steps[2]?.querySelector(".sr-only")).toHaveTextContent(
      "Anchored to Ethereum, done",
    );
    await expect(steps[3]?.querySelector(".sr-only")).toHaveTextContent("Counted, not yet");
  },
};

export const Dark: Story = {
  parameters: { layout: "fullscreen", theme: "dark" },
  play: recorded,
};
