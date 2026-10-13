import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { BoardPlacePage } from "./board-place-page.tsx";

const meta = {
  title: "Mockups/Web/Your place on the board",
  component: BoardPlacePage,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof BoardPlacePage>;

export default meta;
type Story = StoryObj<typeof meta>;

const view = (canvasElement: HTMLElement) =>
  within(canvasElement).getByTestId("board-zoom-view").getAttribute("data-view");

const journey: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const scene = canvas.getByRole("region", { name: "From 161,874 entries to yours" });
  const steps = [...scene.querySelectorAll<HTMLElement>(":scope > ol > li")];
  await expect(steps).toHaveLength(5);
  // Every step states its facts in words.
  await expect(steps[0]).toHaveTextContent("161,874 entries");
  await expect(steps[1]).toHaveTextContent(
    "Entry 95,208 is in the 14:00 segment: 13,482 entries, 88,478 to 101,959",
  );
  await expect(steps[4]).toHaveTextContent("anchored in block 21,382,312");
  // The whole board first, with the reader's entry marked and named.
  await expect(view(canvasElement)).toBe("board");
  await waitFor(() =>
    expect(canvas.getByTestId("board-map-mine")).toHaveTextContent("Your entry, 95,208"),
  );
  steps[1]!.scrollIntoView({ block: "center" });
  await waitFor(() => expect(view(canvasElement)).toBe("segment"));
  steps[2]!.scrollIntoView({ block: "center" });
  await waitFor(() => expect(view(canvasElement)).toBe("neighbourhood"));
  await expect(
    canvas
      .getByRole("table", { name: /Entries 95,206 to 95,210/ })
      .querySelector('[aria-current="true"]'),
  ).toHaveTextContent("95,208");
  steps[3]!.scrollIntoView({ block: "center" });
  await waitFor(() => expect(view(canvasElement)).toBe("entry"));
  await expect(canvas.getByRole("figure", { name: "Entry 95,208" })).toBeVisible();
  // The last step: the path ends at the root anchored on Ethereum.
  steps[4]!.scrollIntoView({ block: "center" });
  await waitFor(() => expect(view(canvasElement)).toBe("proof"));
  const graphic = canvas.getByTestId("board-zoom-view");
  await expect(
    within(graphic).getByRole("img", { name: "17 steps, from your entry to all 101,960 entries" }),
  ).toBeVisible();
  const anchor = within(graphic).getByRole("group", {
    name: "Checkpoint anchored 3 Nov 2026, 15:00 UTC",
  });
  await expect(anchor).toBeVisible();
  await expect(anchor).toHaveTextContent("Ethereum block21,382,312");
};

const verified: Story["play"] = async (context) => {
  await journey(context);
  const canvas = within(context.canvasElement);
  const groups = canvas.getAllByRole("group", {
    name: "Checkpoint anchored 3 Nov 2026, 15:00 UTC",
  });
  for (const g of groups)
    await expect(g).toHaveTextContent("The computed root is the anchored root");
  await userEvent.click(canvas.getByText("Every hash of the proof, in full"));
  await expect(canvas.getAllByText(/^Step \d+ of 17 · on the (left|right)/)).toHaveLength(17);
};

export const Found: Story = { play: verified };

export const Mismatch: Story = {
  name: "Root doesn't match",
  args: { mismatch: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const groups = canvas.getAllByRole("group", {
      name: "Checkpoint anchored 3 Nov 2026, 15:00 UTC",
    });
    for (const g of groups) {
      await expect(g).toHaveAttribute("data-verdict", "mismatch");
      await expect(g).toHaveTextContent(
        "The computed root does not match the anchored root. This path does not show that the entry is on the anchored board.",
      );
    }
  },
};

export const Dark: Story = { parameters: { layout: "fullscreen", theme: "dark" }, play: verified };
