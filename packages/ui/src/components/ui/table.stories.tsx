import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { Count } from "../count.tsx";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "./table.tsx";

const rows = [
  { option: "Yes", votes: 23_441 },
  { option: "No", votes: 16_671 },
];

const meta = {
  component: Table,
  render: (args) => (
    <Table {...args}>
      <TableCaption>Document-verified voters: 40,112</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Option</TableHead>
          <TableHead scope="col" className="text-right">
            Votes
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.option}>
            <TableHead scope="row">{row.option}</TableHead>
            <TableCell className="text-right">
              <Count value={row.votes} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableHead scope="row">Total</TableHead>
          <TableCell className="text-right">
            <Count value={40_112} />
          </TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  ),
} satisfies Meta<typeof Table>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const table = within(canvasElement).getByRole("table", {
      name: "Document-verified voters: 40,112",
    });
    const cells = within(table).getAllByRole("cell");
    // Ruled: every cell has its own visible border.
    for (const cell of cells) {
      await expect(getComputedStyle(cell).borderTopStyle).toBe("solid");
    }
    await expect(getComputedStyle(table).fontVariantNumeric).toContain("tabular-nums");
    await expect(within(table).getByRole("rowheader", { name: "Yes" })).toBeVisible();
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("table")).toBeVisible();
  },
};
