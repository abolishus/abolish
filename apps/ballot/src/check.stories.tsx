import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { ArrivalCheck, ArrivalChecklist, ElectionRefused } from "./check.tsx";
import { CivicFrame, EverydayFrame, type FramePoll, ScreenTitle } from "./frame.tsx";

const REGISTERED = "3f8a0c51d2e4b69788a1c0d3e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718";
const SERVED = "9c1e77a04b2d3f60e8a5c1d27b9043fe6a18c5d2e7f04b3a96c8d1e2f3a4b5c6";
const ORIGIN =
  "https://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi.ipfs.example.net";

const POLL: FramePoll = {
  definitionHash: REGISTERED,
  name: "Riverside Residents' Association",
  closes: "Fri 17 Oct",
};

const meta = {
  title: "Ballot/Check",
  component: ElectionRefused,
  parameters: { layout: "fullscreen" },
  args: {
    refusal: { problem: "unregistered-definition", servedHash: SERVED },
    registeredHash: REGISTERED,
    origin: ORIGIN,
  },
} satisfies Meta<typeof ElectionRefused>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The refusal's shared shape: the heading, the passed origin check, the failed check by name, no way to vote. */
async function refusedFor(canvasElement: HTMLElement, failed: string) {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
    "Don't vote from this link",
  );
  const checks = within(canvas.getByRole("list", { name: "Checks before voting" }));
  const [origin, election] = checks.getAllByRole("listitem");
  await expect(origin).toHaveTextContent("It is running from an address of its own");
  await expect(origin).toHaveTextContent("Passed");
  await expect(election).toHaveTextContent(failed);
  await expect(election).toHaveTextContent("Failed");
  await expect(
    canvas.getByRole("img", { name: "Fingerprint of the registered definition, 3f8a 0c51" }),
  ).toBeVisible();
  // No ballot and no button: the only way forward is another address.
  await expect(canvas.queryByRole("button")).toBeNull();
  await expect(canvas.getByText(/abolishus\.eth/)).toBeVisible();
  return canvas;
}

const unregistered: Story["play"] = async ({ canvasElement }) => {
  const canvas = await refusedFor(canvasElement, "The election doesn't match the registry");
  // Both fingerprints, so a voter sees the difference without reading hex.
  await expect(
    canvas.getByRole("img", { name: "Fingerprint of the definition this link served, 9c1e 77a0" }),
  ).toBeVisible();
  await expect(
    canvas.getByRole("figure", { name: "Hash of the definition this link served" }),
  ).toHaveTextContent(SERVED.slice(0, 4));
};

export const NotRegistered: Story = { name: "Not the registered election", play: unregistered };

export const NotRegisteredDark: Story = {
  name: "Not the registered election, dark",
  parameters: { layout: "fullscreen", theme: "dark" },
  play: unregistered,
};

export const Undecodable: Story = {
  name: "Definition unreadable",
  args: { refusal: { problem: "definition-undecodable" } },
  play: async ({ canvasElement }) => {
    const canvas = await refusedFor(canvasElement, "The election's definition can't be read");
    // Only the registered fingerprint: there is no served hash to compare.
    await expect(canvas.getAllByRole("img", { name: /^Fingerprint of/ })).toHaveLength(1);
  },
};

export const AnotherElection: Story = {
  name: "Another election's definition",
  args: { refusal: { problem: "another-election" } },
  play: async ({ canvasElement }) => {
    await refusedFor(canvasElement, "The definition is for a different election");
  },
};

export const DefinitionIllFormed: Story = {
  name: "Definition breaks a rule",
  args: { refusal: { problem: "definition-ill-formed", rule: "timing" } },
  play: async ({ canvasElement }) => {
    const canvas = await refusedFor(canvasElement, "The election's definition breaks the rules");
    await expect(canvas.getByText("timing", { selector: "code" })).toBeVisible();
  },
};

export const TextUndecodable: Story = {
  name: "Wording unreadable",
  args: { refusal: { problem: "display-text-undecodable" } },
  play: async ({ canvasElement }) => {
    await refusedFor(canvasElement, "The wording of the questions can't be read");
  },
};

export const TextChanged: Story = {
  name: "Wording changed",
  args: { refusal: { problem: "display-text-ill-formed", rule: "commitment" } },
  play: async ({ canvasElement }) => {
    await refusedFor(canvasElement, "The wording isn't the wording that was registered");
  },
};

export const TextIllFormed: Story = {
  name: "Wording breaks a rule",
  args: { refusal: { problem: "display-text-ill-formed", rule: "labels" } },
  play: async ({ canvasElement }) => {
    const canvas = await refusedFor(canvasElement, "The wording of the questions breaks the rules");
    await expect(canvas.getByText("labels", { selector: "code" })).toBeVisible();
  },
};

export const PanelUnpinned: Story = {
  name: "Trustees this ballot doesn't list",
  args: { refusal: { problem: "ceremony-failed", code: "panel-unpinned" } },
  play: async ({ canvasElement }) => {
    const canvas = await refusedFor(
      canvasElement,
      "The poll's trustees aren't ones this ballot knows",
    );
    await expect(canvas.getByText("panel-unpinned", { selector: "code" })).toBeVisible();
  },
};

export const CeremonyMissing: Story = {
  name: "Key ceremony not served",
  args: { refusal: { problem: "ceremony-failed", code: "ceremony-transcript-missing" } },
  play: async ({ canvasElement }) => {
    await refusedFor(canvasElement, "The record of the trustees' keys isn't available");
  },
};

export const CeremonyFailed: Story = {
  name: "Key ceremony fails",
  args: { refusal: { problem: "ceremony-failed", code: "ceremony-signature" } },
  play: async ({ canvasElement }) => {
    const canvas = await refusedFor(canvasElement, "The trustees' key ceremony doesn't check");
    await expect(canvas.getByText("ceremony-signature", { selector: "code" })).toBeVisible();
  },
};

// The arrival check, in each register, over a poll that passed.

const arrival: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  // One plain line on the surface, the evidence a tap away.
  const summary = canvas.getByText("This is the real poll, checked");
  await expect(summary).toBeVisible();
  await expect(
    canvas.getByRole("figure", { name: "The poll's registered fingerprint" }),
  ).not.toBeVisible();
  await userEvent.click(summary);
  await expect(
    canvas.getByRole("figure", { name: "The poll's registered fingerprint" }),
  ).toBeVisible();
  await expect(canvas.getAllByRole("img", { name: "Seal of this poll, 3f8a 0c51" })).toHaveLength(
    2,
  );
};

const everydayArrival = () => (
  <EverydayFrame poll={POLL} progress={{ current: 1, total: 3 }}>
    <ScreenTitle title="Which one improvement matters most to you?" />
    <div className="mt-8">
      <ArrivalCheck definitionHash={REGISTERED} />
    </div>
  </EverydayFrame>
);

export const Arrival: Story = { name: "Arrival, everyday", render: everydayArrival, play: arrival };

export const ArrivalDark: Story = {
  name: "Arrival, everyday, dark",
  render: everydayArrival,
  parameters: { layout: "fullscreen", theme: "dark" },
  play: arrival,
};

const civicArrival = () => (
  <CivicFrame poll={POLL} progress={{ current: 1, total: 5 }} stepName="Check">
    <ScreenTitle title="Riverside Residents' Association" />
    <ArrivalChecklist definitionHash={REGISTERED} origin={ORIGIN} />
  </CivicFrame>
);

const civic: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const checks = within(canvas.getByRole("list", { name: "Checks before voting" }));
  const items = checks.getAllByRole("listitem");
  await expect(items).toHaveLength(2);
  for (const item of items) await expect(item).toHaveTextContent("Passed");
  await expect(
    canvas.getByText(`Served from ${ORIGIN}, which no other site shares.`),
  ).toBeVisible();
  await expect(
    canvas.getByRole("figure", { name: "Registered definition hash" }),
  ).toHaveTextContent(REGISTERED.slice(0, 4));
};

export const ArrivalCivic: Story = { name: "Arrival, civic", render: civicArrival, play: civic };

export const ArrivalCivicDark: Story = {
  name: "Arrival, civic, dark",
  render: civicArrival,
  parameters: { layout: "fullscreen", theme: "dark" },
  play: civic,
};
