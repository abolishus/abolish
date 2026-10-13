import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { BoardMap } from "./board-map.tsx";
import {
  buildBoard,
  LEVY_BOARD,
  LEVY_MAP_LABELS as labels,
  LEVY_MINE,
  LEVY_MINE_SEGMENT,
} from "./board-sample.ts";

const meta = {
  component: BoardMap,
  args: { kinds: LEVY_BOARD.kinds, segments: LEVY_BOARD.segments, labels, mine: LEVY_MINE },
} satisfies Meta<typeof BoardMap>;

export default meta;
type Story = StoryObj<typeof meta>;

const whole: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const map = canvas.getByRole("figure", { name: /the whole board, 161,874 entries/ });
  await expect(within(map).getByRole("img", { name: /Every entry on the board/ })).toBeVisible();
  await expect(canvas.getByTestId("board-map-position")).toHaveTextContent(
    "Your entry is entry 95,208 of 161,874, in the 14:00 segment, anchored at 15:00 UTC in Ethereum block 21,382,312.",
  );
  await waitFor(() =>
    expect(canvas.getByTestId("board-map-mine")).toHaveTextContent("Your entry, 95,208"),
  );
  // The legend's counts add up to the board.
  await expect(map).toHaveTextContent("Ballots 161,432");
  await expect(map).toHaveTextContent("Spoiled-ballot openings 344");
  await userEvent.click(canvas.getByText("Every segment as a table"));
  const table = canvas.getByRole("table", { name: "Entries per segment, 3 November 2026 (UTC)" });
  await expect(within(table).getAllByRole("row")).toHaveLength(17);
  const current = table.querySelector('[aria-current="true"]');
  await expect(current).toHaveTextContent("14:00");
  await expect(current).toHaveTextContent("13,482");
  await expect(current).toHaveTextContent("15:00 UTC, block 21,382,312");
};

export const WholeBoard: Story = { play: whole };

export const YourSegment: Story = {
  args: {
    range: { from: LEVY_MINE_SEGMENT.first, to: LEVY_MINE_SEGMENT.first + LEVY_MINE_SEGMENT.size },
    labels: {
      ...labels,
      caption: "The 14:00 segment: entries 88,478 to 101,959, anchored at 15:00 UTC",
      table: undefined,
    },
  },
  play: async ({ canvasElement }) => {
    const map = within(canvasElement).getByRole("figure", { name: /The 14:00 segment/ });
    await expect(map).toHaveAttribute("data-from", "88478");
    await expect(map).toHaveTextContent("Ballots 13,480");
    await expect(map).toHaveTextContent("Contract events 2");
    await expect(within(map).queryByRole("table")).toBeNull();
  },
};

// A small board over several days, still taking entries: cells big enough for
// their shapes, a new line each day, and the current hour not anchored yet.
const SMALL = buildBoard(
  [
    {
      label: "12:00",
      group: "1 Nov",
      size: 14,
      anchor: { at: "13:00 UTC", block: 21_356_212 },
      lead: [3, 2, 2],
    },
    { label: "13:00", group: "1 Nov", size: 31, anchor: { at: "14:00 UTC", block: 21_356_512 } },
    { label: "18:00", group: "1 Nov", size: 22, anchor: { at: "19:00 UTC", block: 21_358_012 } },
    {
      label: "09:00",
      group: "2 Nov",
      size: 40,
      anchor: { at: "10:00 UTC", block: 21_362_512 },
      tail: [1],
    },
    { label: "12:00", group: "2 Nov", size: 26, anchor: { at: "13:00 UTC", block: 21_363_412 } },
    { label: "08:00", group: "3 Nov", size: 18, anchor: null },
  ],
  495_070,
);

export const StillOpen: Story = {
  args: {
    kinds: SMALL.kinds,
    segments: SMALL.segments,
    mine: 120,
    labels: {
      ...labels,
      caption: "A neighbourhood poll's board: 151 entries so far",
      description: "Every entry as one square, each hour a block, one line per day.",
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId("board-map-position")).toHaveTextContent(
      "Your entry is entry 120 of 151, in the 12:00 segment, anchored at 13:00 UTC in Ethereum block 21,363,412.",
    );
    await expect(canvas.getByText("Not anchored yet")).toBeVisible();
    await userEvent.click(canvas.getByText("Every segment as a table"));
    await expect(canvas.getByRole("row", { name: /3 Nov 08:00/ })).toHaveTextContent("Not yet");
    await expect(canvas.getByRole("row", { name: /2 Nov 09:00/ })).toHaveTextContent(
      "Spoiled-ballot openings: 1",
    );
  },
};

export const Dark: Story = { parameters: { theme: "dark" }, play: whole };
