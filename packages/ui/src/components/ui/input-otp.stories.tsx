import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "./input-otp.tsx";

const meta = {
  // InputOTP's props are a union (children or render) that Storybook's arg
  // inference can't satisfy, so the story renders it directly.
  render: () => (
    <InputOTP maxLength={6} aria-label="Mailed verification code">
      <InputOTPGroup>
        <InputOTPSlot index={0} />
        <InputOTPSlot index={1} />
        <InputOTPSlot index={2} />
      </InputOTPGroup>
      <InputOTPSeparator />
      <InputOTPGroup>
        <InputOTPSlot index={3} />
        <InputOTPSlot index={4} />
        <InputOTPSlot index={5} />
      </InputOTPGroup>
    </InputOTP>
  ),
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByRole("textbox", { name: "Mailed verification code" });
    await userEvent.click(input);
    await userEvent.keyboard("482913");
    await expect(input).toHaveValue("482913");
    await expect(canvas.getByText("9")).toBeVisible();
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    const input = within(canvasElement).getByRole("textbox", { name: "Mailed verification code" });
    await userEvent.click(input);
    await userEvent.keyboard("12");
    await expect(input).toHaveValue("12");
  },
};
