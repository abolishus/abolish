import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { BoardLedger, type LedgerEntry } from "./board-ledger.tsx";

const hashes = [
  "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "60303ae22b998861bce3b28f33eec1be758a213c86c93c076dbe9f558c11c752",
  "fd61a03af4f77d870fc21e05e7e80678095c92d808cfb3b5c279ee04c74aca13",
  "a4e624d686e03ed2767c0abd85c14426b0b1157d2ce81d27bb4fe4f6f01d688a",
];
const entries: LedgerEntry[] = hashes.map((hash, i) => ({
  index: 1201 + i,
  time: `14:0${i}:12 UTC`,
  kind: i === 2 ? "Spoiled ballot" : "Ballot",
  hash,
}));

const meta = {
  component: BoardLedger,
  args: {
    caption: "Library levy, entries 1,201 to 1,204",
    columns: { index: "Entry", time: "Recorded", kind: "Kind", hash: "Hash" },
    fingerprintLabel: (entry) => `Fingerprint of entry ${entry.index.toString()}`,
    entries,
  },
} satisfies Meta<typeof BoardLedger>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const table = within(canvasElement).getByRole("table", {
      name: "Library levy, entries 1,201 to 1,204",
    });
    await expect(within(table).getAllByRole("row")).toHaveLength(5);
    await expect(
      within(table).getByRole("img", { name: "Fingerprint of entry 1203" }),
    ).toBeVisible();
  },
};

export const YourReceipt: Story = {
  args: { highlight: 1203 },
  play: async ({ canvasElement }) => {
    const current = canvasElement.querySelector('[aria-current="true"]');
    await expect(current).toHaveTextContent("1,203");
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getAllByRole("row")).toHaveLength(5);
  },
};
