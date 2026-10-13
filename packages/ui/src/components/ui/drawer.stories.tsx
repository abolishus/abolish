import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { Button } from "./button.tsx";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "./drawer.tsx";

const meta = {
  component: Drawer,
  render: (args) => (
    <Drawer {...args}>
      <DrawerTrigger render={<Button variant="outline" />}>Show receipt</DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Your receipt</DrawerTitle>
          <DrawerDescription>
            Board entry #4,812, recorded 3 November at 18:42 UTC.
          </DrawerDescription>
        </DrawerHeader>
        <DrawerFooter>
          <DrawerClose render={<Button variant="outline" />}>Done</DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  ),
} satisfies Meta<typeof Drawer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Show receipt" }));
    const drawer = await body.findByRole("dialog", { name: "Your receipt" });
    await expect(within(drawer).getByText(/Board entry #4,812/)).toBeVisible();
    await userEvent.click(within(drawer).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(body.queryByRole("dialog")).toBeNull());
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Show receipt" }));
    await expect(await body.findByRole("dialog", { name: "Your receipt" })).toBeVisible();
  },
};
