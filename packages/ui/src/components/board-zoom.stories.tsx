import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, waitFor, within } from "storybook/test";

import {
  entryHashOf,
  LEVY_ANCHOR,
  LEVY_BOARD,
  LEVY_MAP_LABELS,
  LEVY_MINE,
  LEVY_PATH_LABELS,
  LEVY_PROOF,
  levyLedger,
} from "./board-sample.ts";
import { BoardZoom } from "./board-zoom.tsx";

const step = (title: string, body: string) => (
  <div className="grid gap-2">
    <h3 className="m-0 font-heading text-xl font-semibold">{title}</h3>
    <p className="m-0 text-base text-pretty">{body}</p>
  </div>
);

const meta = {
  component: BoardZoom,
  parameters: { layout: "fullscreen" },
  args: {
    label: "From 161,874 entries to yours",
    steps: [
      step(
        "The whole board",
        "161,874 entries, appended one at a time on 3 November 2026 and grouped into 16 hourly segments, each anchored to Ethereum when its hour ended.",
      ),
      step(
        "Your hour",
        "Your entry is in the 14:00 segment: 13,482 entries, from 88,478 to 101,959. Its checkpoint was anchored at 15:00 UTC in Ethereum block 21,382,312.",
      ),
      step(
        "Your neighbours",
        "The entries either side of yours are other people's ballots. The board shows when each arrived, never who sent it or how they voted.",
      ),
      step(
        "Your entry",
        "Entry 95,208: a ballot, recorded at 14:29:57 UTC. Its hash is the one on your receipt.",
      ),
      step(
        "How anyone can check it",
        "17 hashes from the proof take your entry's hash to the root of the 101,960 entries the 15:00 checkpoint covers. That root is the one anchored in block 21,382,312.",
      ),
    ],
    board: { kinds: LEVY_BOARD.kinds, segments: LEVY_BOARD.segments, mine: LEVY_MINE },
    views: {
      board: LEVY_MAP_LABELS,
      segment: {
        ...LEVY_MAP_LABELS,
        caption: "The 14:00 segment, 13,482 entries",
        description: "Every entry of the 14:00 segment as one square, your entry marked.",
      },
      neighbourhood: {
        ...LEVY_MAP_LABELS,
        caption: "Entries 95,172 to 95,244",
        description: "The 73 entries around yours, each one square, yours marked.",
      },
    },
    neighbourhood: {
      ledger: {
        caption: "Entries 95,206 to 95,210",
        columns: { index: "Entry", time: "Time (UTC)", kind: "Kind", hash: "Entry hash" },
        fingerprintLabel: (e) => `Fingerprint of entry ${e.index.toLocaleString("en-US")}`,
        entries: levyLedger(2),
      },
    },
    entry: {
      title: "Entry 95,208",
      hash: entryHashOf("levy", LEVY_MINE),
      hashLabel: "Entry hash",
      fingerprintLabel: `Fingerprint of entry 95,208, ${entryHashOf("levy", LEVY_MINE).slice(0, 8)}`,
      facts: [
        { label: "Segment", value: "14:00 UTC" },
        { label: "Kind", value: "Ballot" },
      ],
    },
    proof: {
      ...LEVY_PROOF,
      anchor: LEVY_ANCHOR,
      verdict: "verified",
      labels: LEVY_PATH_LABELS,
    },
  },
} satisfies Meta<typeof BoardZoom>;

export default meta;
type Story = StoryObj<typeof meta>;

const journey: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const scene = canvas.getByRole("region", { name: "From 161,874 entries to yours" });
  await expect(canvas.getByTestId("board-zoom-view")).toHaveAttribute("data-view", "board");
  await expect(canvas.getByRole("img", { name: /Every entry on the board/ })).toBeVisible();
  // The narrative's steps, not the lists inside the graphic.
  const steps = [...scene.querySelectorAll<HTMLElement>(":scope > ol > li")];
  steps[1]!.scrollIntoView({ block: "center" });
  await waitFor(() =>
    expect(canvas.getByTestId("board-zoom-view")).toHaveAttribute("data-view", "segment"),
  );
  await expect(canvas.getByRole("figure", { name: /The 14:00 segment/ })).toBeVisible();
  steps[2]!.scrollIntoView({ block: "center" });
  await waitFor(() =>
    expect(canvas.getByTestId("board-zoom-view")).toHaveAttribute("data-view", "neighbourhood"),
  );
  await expect(
    canvas
      .getByRole("table", { name: "Entries 95,206 to 95,210" })
      .querySelector('[aria-current="true"]'),
  ).toHaveTextContent("95,208");
  steps.at(-1)!.scrollIntoView({ block: "center" });
  await waitFor(() =>
    expect(canvas.getByTestId("board-zoom-view")).toHaveAttribute("data-view", "proof"),
  );
  const check = canvas.getByRole("group", { name: "Checkpoint anchored 3 Nov 2026, 15:00 UTC" });
  await expect(check).toBeVisible();
  await expect(check).toHaveTextContent("The computed root is the anchored root");
  await expect(check).toHaveTextContent("21,382,312");
};

export const Default: Story = { play: journey };

export const Dark: Story = { parameters: { layout: "fullscreen", theme: "dark" }, play: journey };
