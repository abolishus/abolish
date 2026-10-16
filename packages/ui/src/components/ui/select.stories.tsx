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
    // The popup unmounts after its exit transition, with its focus guards and
    // unnamed listbox still in the page until then; the axe check that runs
    // after the story must see it gone. On a loaded CI runner the transition
    // can outlast waitFor's default second. `hidden` counts the listbox even
    // once it is hidden for its exit.
    await waitFor(() => expect(body.queryByRole("listbox", { hidden: true })).toBeNull(), {
      timeout: 5_000,
    });
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("combobox")).toHaveTextContent("All voters");
  },
};
