import type { Meta, StoryObj } from "@storybook/react-vite";
import { CircleCheck } from "lucide-react";
import { expect, within } from "storybook/test";

import { Alert, AlertDescription, AlertTitle } from "./alert.tsx";

const meta = {
  component: Alert,
  args: { variant: "default" },
  render: (args) => (
    <Alert {...args}>
      <CircleCheck aria-hidden="true" />
      <AlertTitle>Ballot recorded</AlertTitle>
      <AlertDescription>Board entry 18,204. Keep your receipt to check it later.</AlertDescription>
    </Alert>
  ),
} satisfies Meta<typeof Alert>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const alert = within(canvasElement).getByRole("alert");
    await expect(within(alert).getByText("Ballot recorded")).toBeVisible();
  },
};

export const Destructive: Story = {
  args: { variant: "destructive" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("alert")).toHaveTextContent("Board entry 18,204");
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("alert")).toBeVisible();
  },
};

export const DarkDestructive: Story = {
  args: { variant: "destructive" },
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("alert")).toBeVisible();
  },
};
