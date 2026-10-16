import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "./select.tsx";

const tiers = [
  { value: "all", label: "All voters" },
  { value: "verified", label: "Verified" },
  { value: "resident", label: "Residents" },
];

const meta = {
  component: Select,
  args: { items: tiers, defaultValue: "all" },
  render: (args) => (
    <div className="flex flex-col gap-2 text-sm">
      <span id="tier-label">Verification tier</span>
      <Select {...args}>
        <SelectTrigger aria-labelledby="tier-label" className="w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Tiers</SelectLabel>
            {tiers.map((tier) => (
              <SelectItem key={tier.value} value={tier.value}>
                {tier.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  ),
} satisfies Meta<typeof Select>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole("combobox", { name: /Verification tier/ });
    await expect(trigger).toHaveTextContent("All voters");
    await userEvent.click(trigger);
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(await body.findByRole("option", { name: "Residents" }));
    await expect(trigger).toHaveTextContent("Residents");
    // Base UI keeps the popup mounted and marks it `hidden` only once its exit
    // transition ends; until then its focus guards and unnamed listbox are
    // still in the accessibility tree, where the axe check that runs after the
    // story finds them. On a loaded CI runner the transition can outlast
    // waitFor's default second.
    await waitFor(() => expect(body.queryByRole("listbox")).toBeNull(), { timeout: 5_000 });
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("combobox")).toHaveTextContent("All voters");
  },
};
