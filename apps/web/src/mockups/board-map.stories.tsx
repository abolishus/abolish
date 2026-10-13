import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { BoardMapHero } from "./board-map-hero.tsx";

const meta = {
  title: "Mockups/Web/Board map",
  component: BoardMapHero,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof BoardMapHero>;

export default meta;
type Story = StoryObj<typeof meta>;

const board: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(
    canvas.getByRole("heading", { level: 1, name: "Every entry, at once" }),
  ).toBeVisible();
  const map = canvas.getByRole("figure", { name: /the whole board, 161,874 entries in 16 hourly/ });
  await expect(
    within(map).getByRole("img", { name: /Every entry on the board as one square/ }),
  ).toBeVisible();
  await expect(map).toHaveTextContent("Spoiled-ballot openings 344");
  // The text equivalent: every segment's count and anchor.
  await userEvent.click(canvas.getByText("Every segment as a table"));
  const table = canvas.getByRole("table", { name: "Entries per segment, 3 November 2026 (UTC)" });
  await expect(within(table).getAllByRole("row")).toHaveLength(17);
  await expect(within(table).getByRole("row", { name: /^13:00/ })).toHaveTextContent("15,538");
  await expect(within(table).getByRole("row", { name: /^20:00/ })).toHaveTextContent(
    "21:00 UTC, block 21,384,112",
  );
};

export const Default: Story = {
  play: async (context) => {
    await board(context);
    await expect(within(context.canvasElement).queryByTestId("board-map-position")).toBeNull();
  },
};

const withEntry: Story["play"] = async (context) => {
  await board(context);
  const canvas = within(context.canvasElement);
  await expect(canvas.getByTestId("board-map-position")).toHaveTextContent(
    "Your entry is entry 95,208 of 161,874, in the 14:00 segment, anchored at 15:00 UTC in Ethereum block 21,382,312.",
  );
  await waitFor(() =>
    expect(canvas.getByTestId("board-map-mine")).toHaveTextContent("Your entry, 95,208"),
  );
  const table = canvas.getByRole("table", { name: /Entries per segment/ });
  await expect(table.querySelector('[aria-current="true"]')).toHaveTextContent("14:00");
};

export const WithYourEntry: Story = {
  name: "With your entry",
  args: { withEntry: true },
  play: withEntry,
};

export const Dark: Story = {
  args: { withEntry: true },
  parameters: { layout: "fullscreen", theme: "dark" },
  play: withEntry,
};
