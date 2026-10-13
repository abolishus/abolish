import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "./resizable.tsx";

const meta = {
  component: ResizablePanelGroup,
  args: { orientation: "horizontal" },
  render: (args) => (
    <div className="h-40 w-80 border text-sm">
      <ResizablePanelGroup {...args}>
        <ResizablePanel defaultSize={50}>
          <div className="p-3">Ballot</div>
        </ResizablePanel>
        <ResizableHandle withHandle aria-label="Resize ballot and receipt" />
        <ResizablePanel defaultSize={50}>
          <div className="p-3">Receipt</div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  ),
} satisfies Meta<typeof ResizablePanelGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const handle = within(canvasElement).getByRole("separator", {
      name: "Resize ballot and receipt",
    });
    const before = Number(handle.getAttribute("aria-valuenow"));
    handle.focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect(Number(handle.getAttribute("aria-valuenow"))).toBeGreaterThan(before);
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Receipt")).toBeVisible();
  },
};
