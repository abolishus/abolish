import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { BoardPage } from "./board-page.tsx";

const meta = {
  title: "Mockups/Web/Board",
  component: BoardPage,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof BoardPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Body rows of the ledger table, without its header row. */
const ledgerRows = (canvasElement: HTMLElement) =>
  within(within(canvasElement).getByRole("table", { name: /entries .* of/ }))
    .getAllByRole("row")
    .slice(1);

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1, name: "The board" })).toBeVisible();

    // The chart redraws for the step in the middle of the viewport.
    const scene = canvas.getByRole("region", { name: /Entries per hour through/ });
    await expect(canvas.getByTestId("hourly-chart")).toHaveAttribute("data-step", "0");
    within(scene).getAllByRole("listitem").at(-1)?.scrollIntoView({ block: "center" });
    await waitFor(() =>
      expect(canvas.getByTestId("hourly-chart")).toHaveAttribute("data-step", "4"),
    );
    await expect(
      canvas.getByRole("img", { name: /through the end of the day: 168,889 entries/ }),
    ).toBeInTheDocument();

    // Filter the ledger by kind, then switch boards.
    await expect(ledgerRows(canvasElement)).toHaveLength(12);
    const kinds = canvas.getByRole("group", { name: "Kind of entry" });
    await userEvent.click(within(kinds).getByRole("button", { name: "Spoiled ballot" }));
    const spoiled = ledgerRows(canvasElement);
    await expect(spoiled).toHaveLength(2);
    for (const row of spoiled) await expect(row).toHaveTextContent("Spoiled ballot");

    await userEvent.selectOptions(
      canvas.getByRole("combobox", { name: "Board" }),
      "Tenants' union board seat",
    );
    await expect(within(kinds).getByRole("button", { name: "All kinds" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(within(kinds).getByRole("button", { name: "Tally share" }));
    await expect(ledgerRows(canvasElement)).toHaveLength(7);
  },
};

export const Dark: Story = {
  parameters: { layout: "fullscreen", theme: "dark" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText("Every hour as a table"));
    const table = canvas.getByRole("table", { name: /Entries per hour on all boards/ });
    await expect(within(table).getByRole("rowheader", { name: "13:00–14:00" })).toBeVisible();
    await expect(within(table).getByText("15,480")).toBeVisible();
    const anchors = canvas.getByRole("list", { name: "Anchors, newest first" });
    await expect(within(anchors).getAllByRole("listitem")).toHaveLength(7);
    await expect(within(anchors).getAllByRole("heading", { level: 3 })[0]).toHaveTextContent(
      "21:00 UTC",
    );
  },
};
