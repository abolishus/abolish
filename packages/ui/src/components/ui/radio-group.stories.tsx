import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { Label } from "./label.tsx";
import { RadioGroup, RadioGroupItem } from "./radio-group.tsx";

const meta = {
  component: RadioGroup,
  args: { defaultValue: "yes", "aria-label": "Renew the library levy?" },
  render: (args) => (
    <RadioGroup {...args}>
      {(["yes", "no", "abstain"] as const).map((value) => (
        <Label key={value} className="min-h-12 text-sm capitalize">
          <RadioGroupItem value={value} />
          {value}
        </Label>
      ))}
    </RadioGroup>
  ),
} satisfies Meta<typeof RadioGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("radio", { name: "yes" })).toBeChecked();
    await userEvent.click(canvas.getByRole("radio", { name: "no" }));
    await expect(canvas.getByRole("radio", { name: "no" })).toBeChecked();
    await expect(canvas.getByRole("radio", { name: "yes" })).not.toBeChecked();
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("radiogroup")).toBeVisible();
  },
};
