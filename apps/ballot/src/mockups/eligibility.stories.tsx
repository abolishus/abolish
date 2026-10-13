import { Button } from "@abolishus/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { KeyRound, Smartphone } from "lucide-react";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";

import { LEVY, lowerFirst, PARK, PROOF_REQUEST, TENANTS, type BallotElection } from "./fixtures.ts";
import {
  ACTION,
  BallotFrame,
  Checklist,
  CheckItem,
  linkAction,
  Notice,
  NumberedSteps,
  ScreenTitle,
  Section,
} from "./frame.tsx";

/**
 * A drawn stand-in for the proof request's QR code: three finder squares and
 * cells from a hash. Dark on light in both themes, as scanners expect.
 */
function QrPlaceholder({ seed, label }: { seed: string; label: string }) {
  const n = 25;
  const bits = Array.from({ length: seed.length * 4 }, (_, i) =>
    Boolean((Number.parseInt(seed.charAt(i >> 2), 16) >> (3 - (i & 3))) & 1),
  );
  const finder = (x: number, y: number) =>
    (x < 8 && y < 8) || (x >= n - 8 && y < 8) || (x < 8 && y >= n - 8);
  const cells: { x: number; y: number }[] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (finder(x, y)) continue;
      if (bits[(y * n + x * 7) % bits.length]) cells.push({ x, y });
    }
  }
  const finders = [
    [0, 0],
    [n - 7, 0],
    [0, n - 7],
  ] as const;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`-2 -2 ${n + 4} ${n + 4}`}
      className="size-56 shrink-0 border border-foreground"
    >
      <rect x={-2} y={-2} width={n + 4} height={n + 4} fill="white" />
      {cells.map(({ x, y }) => (
        <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill="black" />
      ))}
      {finders.map(([x, y]) => (
        <g key={`${x}-${y}`}>
          <rect x={x} y={y} width={7} height={7} fill="black" />
          <rect x={x + 1} y={y + 1} width={5} height={5} fill="white" />
          <rect x={x + 2} y={y + 2} width={3} height={3} fill="black" />
        </g>
      ))}
    </svg>
  );
}

function PasskeyCheck({ election }: { election: BallotElection }) {
  const [confirmed, setConfirmed] = useState(false);
  return (
    <BallotFrame
      election={election}
      step="Check"
      primary={
        confirmed ? (
          <Button size="lg" className={ACTION}>
            Continue to the ballot
          </Button>
        ) : (
          <Button size="lg" className={ACTION} onClick={() => setConfirmed(true)}>
            <KeyRound aria-hidden="true" />
            Use my passkey
          </Button>
        )
      }
      secondary={
        <Button size="lg" variant="outline" className={ACTION}>
          Back
        </Button>
      }
    >
      <ScreenTitle
        eyebrow={`${election.tier.short} · ${election.tier.name}`}
        title="Confirm you can vote"
      >
        <p className="m-0">
          This poll is open to {lowerFirst(election.scope)}. Your device will ask you to use your
          passkey, the same way you sign in.
        </p>
      </ScreenTitle>
      <Section index="01" title="What this proves, and what it doesn't">
        <NumberedSteps
          label="What the passkey proves"
          items={[
            "That you are one of the people allowed to vote in this poll.",
            "That you haven't already used this right in this poll, so the board can keep only your last ballot.",
            "Not who you are. The proof is made on this device, and the board never learns which member you are.",
          ]}
        />
      </Section>
      <div className="mt-8">
        {confirmed ? (
          <Notice tone="done" title="Confirmed. You can vote in this poll." live>
            <p className="m-0">
              Your proof of eligibility was made on this device and stays here until you cast.
            </p>
          </Notice>
        ) : (
          <p role="status" className="m-0 text-muted-foreground">
            Not confirmed yet.
          </p>
        )}
      </div>
    </BallotFrame>
  );
}

function PassportHandoff({ election }: { election: BallotElection }) {
  return (
    <BallotFrame
      election={election}
      step="Check"
      secondary={
        <Button size="lg" variant="outline" className={ACTION}>
          Back
        </Button>
      }
      primary={
        <a className={linkAction("outline")} href="https://abolish.us/how-it-works#tier-2">
          <Smartphone aria-hidden="true" />
          I'm already on my phone
        </a>
      }
    >
      <ScreenTitle
        eyebrow={`${election.tier.short} · ${election.tier.name}`}
        title="Prove you can vote, using your phone"
      >
        <p className="m-0">
          This vote is for {lowerFirst(election.scope)}. A proof app on your phone reads the chip in
          your passport or your digital driving licence and sends this page a proof. The proof says
          you meet this poll's rules, and nothing else.
        </p>
      </ScreenTitle>
      <div className="mt-8 flex flex-col items-center gap-3 border-y border-foreground py-6">
        <QrPlaceholder
          seed={PROOF_REQUEST.hash}
          label={`QR code for this poll's proof request. Scan it with ${PROOF_REQUEST.apps.join(" or ")}.`}
        />
        <p className="m-0 font-mono text-xs tracking-wide text-muted-foreground">
          Request {PROOF_REQUEST.hash.slice(0, 4)} {PROOF_REQUEST.hash.slice(4, 8)}
        </p>
      </div>
      <Section index="01" title="Steps">
        <NumberedSteps
          label="How to prove you can vote"
          items={[
            `Open ${PROOF_REQUEST.apps.join(" or ")} on your phone. Both are free.`,
            "Scan the code above with the app.",
            "When the app asks, hold your passport against the back of your phone, or share your digital driving licence.",
            "Come back to this screen. It moves on by itself when the proof arrives.",
          ]}
        />
      </Section>
      <Section index="02" title="Your passport data stays on your phone">
        <p className="m-0">
          The app reads your passport on your phone and makes the proof there. This page receives
          only the proof: that you are 18 or over and live in Alder County, and a number for this
          poll that stops one document voting twice. Not your name, your address, your photo or your
          document number.
        </p>
      </Section>
      <div className="mt-8">
        <Checklist label="Proof status">
          <CheckItem state="waiting" title="Waiting for the proof from your phone" />
        </Checklist>
      </div>
    </BallotFrame>
  );
}

function NotEligible({ election }: { election: BallotElection }) {
  return (
    <BallotFrame
      election={election}
      step="Check"
      primary={
        <Button size="lg" className={ACTION}>
          <KeyRound aria-hidden="true" />
          Try a different passkey
        </Button>
      }
      secondary={
        <a className={linkAction("outline")} href={election.url}>
          See the poll's record
        </a>
      }
    >
      <ScreenTitle title="You can't vote in this poll">
        <p className="m-0">
          This vote is only for {lowerFirst(election.scope)}. The passkey you used isn't in the
          group of members who can vote in it.
        </p>
      </ScreenTitle>
      <Section index="01" title="Nothing was recorded">
        <p className="m-0">
          No ballot was started, and nothing about this attempt is on the board.
        </p>
      </Section>
      <Section index="02" title="Why this might be">
        <NumberedSteps
          label="Possible reasons"
          items={[
            "You used a different passkey from the one you joined with. Try another one.",
            "You joined after the member list for this vote was fixed, on 19 October 2026.",
            `Your membership hasn't been added yet. Ask ${election.organiser}; they can check without seeing how anyone voted.`,
          ]}
        />
      </Section>
    </BallotFrame>
  );
}

const meta = {
  title: "Mockups/Ballot/Eligibility",
  component: PasskeyCheck,
  args: { election: PARK },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof PasskeyCheck>;

export default meta;
type Story = StoryObj<typeof meta>;

const confirmPasskey: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("Confirm you can vote");
  await expect(canvas.getByRole("status")).toHaveTextContent("Not confirmed yet.");
  await userEvent.click(canvas.getByRole("button", { name: "Use my passkey" }));
  await expect(canvas.getByRole("status")).toHaveTextContent(
    "Confirmed. You can vote in this poll.",
  );
  await expect(canvas.getByRole("button", { name: "Continue to the ballot" })).toBeVisible();
};

export const PasskeyTier0: Story = { name: "Passkey (Tier 0)", play: confirmPasskey };

export const PassportTier2: Story = {
  name: "Passport handoff (Tier 2)",
  args: { election: LEVY },
  render: (args) => <PassportHandoff {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("img", { name: /^QR code for this poll's proof request/ }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("heading", { name: "Your passport data stays on your phone" }),
    ).toBeVisible();
    const steps = within(canvas.getByRole("list", { name: "How to prove you can vote" }));
    await expect(steps.getAllByRole("listitem")).toHaveLength(4);
    await expect(canvas.getByRole("list", { name: "Proof status" })).toHaveTextContent("Waiting");
  },
};

export const NotEligibleScreen: Story = {
  name: "Not eligible",
  args: { election: TENANTS },
  render: (args) => <NotEligible {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "You can't vote in this poll",
    );
    await expect(canvas.getByText(/nothing about this attempt is on the board/)).toBeVisible();
    await expect(canvas.queryByRole("button", { name: /ballot/i })).toBeNull();
    await expect(canvas.getByRole("link", { name: "See the poll's record" })).toHaveAttribute(
      "href",
      TENANTS.url,
    );
  },
};

export const Dark: Story = {
  parameters: { layout: "fullscreen", theme: "dark" },
  play: confirmPasskey,
};

export const PassportTier2Dark: Story = {
  name: "Passport handoff (Tier 2), dark",
  args: { election: LEVY },
  parameters: { layout: "fullscreen", theme: "dark" },
  render: (args) => <PassportHandoff {...args} />,
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("img", { name: /^QR code for this poll's proof request/ }),
    ).toBeVisible();
  },
};
