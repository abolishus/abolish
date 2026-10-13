import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "./native-select.tsx";

const meta = {
  component: NativeSelect,
  args: { "aria-label": "Verification tier", defaultValue: "residency" },
  render: (args) => (
    <NativeSelect {...args}>
      <NativeSelectOptGroup label="Verified">
        <NativeSelectOption value="identity">Identity checked</NativeSelectOption>
        <NativeSelectOption value="residency">Residency checked</NativeSelectOption>
      </NativeSelectOptGroup>
      <NativeSelectOption value="email">Email only</NativeSelectOption>
    </NativeSelect>
  ),
} satisfies Meta<typeof NativeSelect>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const select = within(canvasElement).getByRole("combobox", { name: "Verification tier" });
    await expect(select).toHaveValue("residency");
    await userEvent.selectOptions(select, "email");
    await expect(select).toHaveValue("email");
  },
};

export const Disabled: Story = {
  args: { disabled: true },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("combobox")).toBeDisabled();
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("combobox")).toBeVisible();
  },
};
