import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "./field.tsx";
import { Input } from "./input.tsx";

const meta = {
  component: Field,
  render: (args) => (
    <FieldSet className="max-w-sm">
      <FieldLegend>Verify a receipt</FieldLegend>
      <FieldGroup>
        <Field {...args}>
          <FieldLabel htmlFor="receipt-hash">Receipt hash</FieldLabel>
          <Input id="receipt-hash" aria-describedby="receipt-hash-help" />
          <FieldDescription id="receipt-hash-help">
            The 64 characters printed on your receipt.
          </FieldDescription>
        </Field>
      </FieldGroup>
    </FieldSet>
  ),
} satisfies Meta<typeof Field>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("group", { name: "Verify a receipt" })).toBeVisible();
    const input = canvas.getByRole("textbox", { name: "Receipt hash" });
    await expect(input).toHaveAccessibleDescription("The 64 characters printed on your receipt.");
    await userEvent.type(input, "9f2c");
    await expect(input).toHaveValue("9f2c");
  },
};

export const Invalid: Story = {
  render: () => (
    <Field data-invalid="true" className="max-w-sm">
      <FieldLabel htmlFor="poll-code">Poll code</FieldLabel>
      <Input id="poll-code" aria-invalid="true" aria-describedby="poll-code-error" />
      <FieldError id="poll-code-error" errors={[{ message: "No poll has that code." }]} />
    </Field>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("alert")).toHaveTextContent("No poll has that code.");
    await expect(canvas.getByRole("textbox", { name: "Poll code" })).toBeInvalid();
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("textbox", { name: "Receipt hash" }),
    ).toBeVisible();
  },
};
