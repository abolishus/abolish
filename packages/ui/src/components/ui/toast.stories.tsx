import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { Button } from "./button.tsx";
import { Toaster, toast } from "./toast.tsx";

const meta = {
  component: Toaster,
  render: (args) => (
    <Toaster {...args}>
      <Button
        onClick={() =>
          toast.add({
            title: "Ballot recorded",
            description: "Board entry 4,812. Keep your receipt to check it later.",
            type: "success",
          })
        }
      >
        Cast ballot
      </Button>
    </Toaster>
  ),
} satisfies Meta<typeof Toaster>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Cast ballot" }));
    const body = within(canvasElement.ownerDocument.body);
    await expect(await body.findByText("Ballot recorded")).toBeVisible();
    await expect(body.getByText(/Board entry 4,812/)).toBeVisible();
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Cast ballot" }));
    const body = within(canvasElement.ownerDocument.body);
    await expect(await body.findAllByText("Ballot recorded")).not.toHaveLength(0);
  },
};
