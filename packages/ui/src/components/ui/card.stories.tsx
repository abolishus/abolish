import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./card.tsx";

const meta = {
  component: Card,
  render: (args) => (
    <Card {...args} role="group" aria-label="Election">
      <CardHeader>
        <CardTitle>Library levy</CardTitle>
        <CardDescription>Closes 3 November at 20:00 UTC</CardDescription>
      </CardHeader>
      <CardContent>Should the county renew the library levy?</CardContent>
      <CardFooter>Yes or no</CardFooter>
    </Card>
  ),
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const card = within(canvasElement).getByRole("group", { name: "Election" });
    await expect(within(card).getByText("Library levy")).toBeVisible();
  },
};

export const Small: Story = {
  args: { size: "sm" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("group")).toHaveAttribute("data-size", "sm");
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("group")).toBeVisible();
  },
};
