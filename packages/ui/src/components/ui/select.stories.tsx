import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

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
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("combobox")).toHaveTextContent("All voters");
  },
};
