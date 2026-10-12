import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs.tsx";

// During a switch Base UI keeps the outgoing panel mounted (inert) until its
// exit transition ends, so read the panel the selected tab controls.
function selectedPanel(root: HTMLElement): HTMLElement | null {
  const tab = within(root).getByRole("tab", { selected: true });
  return root.ownerDocument.getElementById(tab.getAttribute("aria-controls") ?? "");
}

const meta = {
  component: Tabs,
  args: { defaultValue: "board" },
  render: (args) => (
    <Tabs {...args}>
      <TabsList aria-label="Election">
        <TabsTrigger value="board">Board</TabsTrigger>
        <TabsTrigger value="trustees">Trustees</TabsTrigger>
      </TabsList>
      <TabsContent value="board">Every entry, in order.</TabsContent>
      <TabsContent value="trustees">Who holds the keys.</TabsContent>
    </Tabs>
  ),
} satisfies Meta<typeof Tabs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("tab", { name: "Trustees" }));
    await expect(selectedPanel(canvasElement)).toHaveTextContent("Who holds the keys.");
    for (const tab of canvas.getAllByRole("tab")) {
      await expect(tab.getBoundingClientRect().height).toBeGreaterThanOrEqual(48);
    }
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("tablist")).toBeVisible();
  },
};
