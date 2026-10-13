import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { ScrollArea } from "./scroll-area.tsx";

const entries = Array.from({ length: 30 }, (_, i) => `Entry ${i + 1}`);

const meta = {
  component: ScrollArea,
  render: (args) => (
    <ScrollArea {...args} className="h-48 w-56 border">
      <ol aria-label="Board entries" className="p-3 text-sm">
        {entries.map((entry) => (
          <li key={entry} className="py-1">
            {entry}
          </li>
        ))}
      </ol>
    </ScrollArea>
  ),
} satisfies Meta<typeof ScrollArea>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const list = within(canvasElement).getByRole("list", { name: "Board entries" });
    await expect(within(list).getAllByRole("listitem")).toHaveLength(30);
    const viewport = canvasElement.querySelector<HTMLElement>("[data-slot=scroll-area-viewport]");
    await expect(viewport?.scrollHeight).toBeGreaterThan(viewport?.clientHeight ?? 0);
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Entry 1")).toBeVisible();
  },
};
