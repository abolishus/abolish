import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./context-menu.tsx";

const meta = {
  component: ContextMenu,
  render: (args) => (
    <ContextMenu {...args}>
      <ContextMenuTrigger className="flex h-24 w-64 items-center justify-center border border-dashed text-sm">
        Board entry #4,812
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem>Copy hash</ContextMenuItem>
        <ContextMenuItem>Compare with receipt</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive">Report entry</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  ),
} satisfies Meta<typeof ContextMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.pointer({
      keys: "[MouseRight]",
      target: within(canvasElement).getByText("Board entry #4,812"),
    });
    const menu = await body.findByRole("menu");
    await waitFor(() =>
      expect(within(menu).getByRole("menuitem", { name: "Copy hash" })).toBeVisible(),
    );
    await expect(within(menu).getAllByRole("menuitem")).toHaveLength(3);
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.pointer({
      keys: "[MouseRight]",
      target: within(canvasElement).getByText("Board entry #4,812"),
    });
    const item = await body.findByRole("menuitem", { name: "Report entry" });
    await waitFor(() => expect(item).toBeVisible());
  },
};
