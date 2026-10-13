import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "./sidebar.tsx";

const meta = {
  component: SidebarProvider,
  render: (args) => (
    <SidebarProvider {...args} className="min-h-0">
      <Sidebar>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Election</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton isActive>Polls</SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton>Board</SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton>Receipts</SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
      <SidebarInset className="p-4 text-sm">
        <SidebarTrigger />
        <p>Library levy closes 3 November at 20:00 UTC.</p>
      </SidebarInset>
    </SidebarProvider>
  ),
} satisfies Meta<typeof SidebarProvider>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = canvas.getByRole("button", { name: "Toggle Sidebar" });
    // Below 768px the sidebar is a sheet the trigger opens.
    if (window.innerWidth < 768) {
      await userEvent.click(toggle);
      const body = within(canvasElement.ownerDocument.body);
      await waitFor(() => expect(body.getByRole("button", { name: "Polls" })).toBeVisible());
      await expect(body.getByRole("button", { name: "Polls" })).toHaveAttribute("data-active");
      return;
    }
    await expect(canvas.getByRole("button", { name: "Polls" })).toHaveAttribute("data-active");
    const sidebar = canvasElement.querySelector("[data-slot=sidebar]");
    await expect(sidebar).toHaveAttribute("data-state", "expanded");
    await userEvent.click(toggle);
    await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("main")).toHaveTextContent("Library levy");
  },
};
