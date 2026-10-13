import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { Button } from "./button.tsx";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog.tsx";

const meta = {
  component: Dialog,
  render: (args) => (
    <Dialog {...args}>
      <DialogTrigger render={<Button />}>Cast ballot</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cast your ballot?</DialogTitle>
          <DialogDescription>
            Your choice on the library levy is final once recorded on the board.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Review</DialogClose>
          <Button>Cast</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
} satisfies Meta<typeof Dialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Cast ballot" }));
    const dialog = await body.findByRole("dialog", { name: "Cast your ballot?" });
    await expect(dialog).toHaveAccessibleDescription(/final once recorded/);
    await userEvent.click(within(dialog).getByRole("button", { name: "Review" }));
    await waitFor(() => expect(body.queryByRole("dialog")).toBeNull());
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Cast ballot" }));
    const dialog = await body.findByRole("dialog");
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Close" })).toBeVisible(),
    );
  },
};
