import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "./message-scroller.tsx";

const entries = Array.from({ length: 30 }, (_, i) => i + 4801);

const meta = {
  component: MessageScroller,
  render: (args) => (
    <MessageScrollerProvider defaultScrollPosition="start">
      <MessageScroller {...args} className="h-64 border border-border">
        <MessageScrollerViewport aria-label="Board entries">
          <MessageScrollerContent className="gap-2 p-3">
            {entries.map((n) => (
              <MessageScrollerItem key={n} messageId={String(n)}>
                Board entry {n} recorded
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  ),
} satisfies Meta<typeof MessageScroller>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByRole("button", { name: "Scroll to end" });
    await waitFor(() => expect(button).toHaveAttribute("data-active", "true"));
    await userEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute("data-active", "false"));
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Board entry 4801 recorded")).toBeVisible();
  },
};
