import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import {
  LEVY_ANCHOR,
  LEVY_PATH_LABELS as INCLUSION_LABELS,
  LEVY_PROOF,
  sampleHash,
  sampleProof,
} from "./board-sample.ts";
import { InclusionPath } from "./inclusion-path.tsx";

const anchor = LEVY_ANCHOR;

const meta = {
  component: InclusionPath,
  args: { ...LEVY_PROOF, anchor, verdict: "verified", labels: INCLUSION_LABELS },
} satisfies Meta<typeof InclusionPath>;

export default meta;
type Story = StoryObj<typeof meta>;

const verified: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const path = canvas.getByRole("figure", { name: "Entry 95,208 in the tree of 101,960 entries" });
  // Seventeen steps, each with the proof's hash and the computed one.
  await expect(within(path).getAllByText(/^Step \d+ of 17$/)).toHaveLength(17);
  await expect(within(path).getAllByText("Root of all 101,960 entries")[0]).toBeVisible();
  const check = canvas.getByRole("group", { name: "Checkpoint anchored 3 Nov 2026, 15:00 UTC" });
  await expect(check).toHaveTextContent("The computed root is the anchored root");
  await expect(check).toHaveTextContent("21,382,312");
  // The last step's sibling is the first 65,536 entries, on the left.
  const steps = path.querySelectorAll("li[data-side]");
  await expect(steps[16]).toHaveAttribute("data-side", "left");
  await expect(steps[16]).toHaveTextContent("entries 0–65,535");
  await userEvent.click(canvas.getByText("Every hash of the proof, in full"));
  await expect(canvas.getByText(LEVY_PROOF.siblings[0]!.hash)).toBeVisible();
};

export const Verified: Story = { play: verified };

export const Mismatch: Story = {
  args: {
    anchor: { ...anchor, root: sampleHash("a different board") },
    verdict: "mismatch",
  },
  play: async ({ canvasElement }) => {
    const check = within(canvasElement).getByRole("group", { name: /Checkpoint anchored/ });
    await expect(check).toHaveAttribute("data-verdict", "mismatch");
    await expect(check).toHaveTextContent(
      "The computed root does not match the anchored root. This path does not prove the entry is on the anchored board.",
    );
  },
};

// Right after casting: the path in the tree the receipt signs, of the entries
// up to the reader's, whose checkpoint isn't anchored yet.
const AT_CAST = sampleProof("parks", 2_431, 2_432);

export const Pending: Story = {
  args: {
    ...AT_CAST,
    anchor: {
      root: AT_CAST.root,
      size: AT_CAST.size,
      title: "Your receipt's root, to be anchored 7 Nov 2026, 15:00 UTC",
      facts: [{ label: "Signed", value: "7 Nov 2026, 14:02:12 UTC" }],
    },
    verdict: "pending",
    labels: { ...INCLUSION_LABELS, caption: "Entry 2,431 in the tree of 2,432 entries" },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByText(/^Step \d+ of 9$/)).toHaveLength(9);
    await expect(canvas.getByRole("group", { name: /to be anchored/ })).toHaveTextContent(
      "Its checkpoint is anchored at 15:00 UTC.",
    );
  },
};

export const Compact: Story = {
  args: { variant: "compact" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("img", { name: "17 steps, from your entry to all 101,960 entries" }),
    ).toBeVisible();
    await expect(canvas.getByRole("group", { name: /Checkpoint anchored/ })).toHaveTextContent(
      "Ethereum block21,382,312",
    );
  },
};

export const Dark: Story = { parameters: { theme: "dark" }, play: verified };

export const DarkMismatch: Story = {
  ...Mismatch,
  parameters: { theme: "dark" },
};
