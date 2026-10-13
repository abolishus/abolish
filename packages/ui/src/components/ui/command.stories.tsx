import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "./command.tsx";

const meta = {
  component: Command,
  render: (args) => (
    <Command {...args} label="Commands" className="max-w-sm border">
      <CommandInput placeholder="Search…" />
      <CommandList>
        <CommandEmpty>Nothing matches.</CommandEmpty>
        <CommandGroup heading="Polls">
          <CommandItem>Library levy</CommandItem>
          <CommandItem>Park bond</CommandItem>
        </CommandGroup>
        <CommandGroup heading="Receipts">
          <CommandItem>
            Verify a receipt
            <CommandShortcut>⌘V</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  ),
} satisfies Meta<typeof Command>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByRole("combobox", { name: "Commands" });
    await userEvent.type(input, "receipt");
    await expect(input).toHaveValue("receipt");
    await expect(canvas.getByRole("option", { name: /Verify a receipt/ })).toBeVisible();
    await expect(canvas.queryByRole("option", { name: "Park bond" })).toBeNull();
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getAllByRole("option")).toHaveLength(3);
  },
};
