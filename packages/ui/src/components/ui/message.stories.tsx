import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageGroup,
  MessageHeader,
} from "./message.tsx";

const meta = {
  component: Message,
  render: (args) => (
    <MessageGroup role="log" aria-label="Trustee notes">
      <Message {...args}>
        <MessageAvatar aria-hidden="true">T1</MessageAvatar>
        <MessageContent>
          <MessageHeader>Trustee 1</MessageHeader>
          <div className="bg-muted px-2.5 py-2">Key share published for the library levy.</div>
          <MessageFooter>20:04 UTC</MessageFooter>
        </MessageContent>
      </Message>
      <Message align="end">
        <MessageContent>
          <div className="bg-muted px-2.5 py-2">Board entry 4,812 confirmed.</div>
        </MessageContent>
      </Message>
    </MessageGroup>
  ),
} satisfies Meta<typeof Message>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const log = within(canvasElement).getByRole("log", { name: "Trustee notes" });
    await expect(within(log).getByText("Trustee 1")).toBeVisible();
    await expect(
      within(log).getByText("Board entry 4,812 confirmed.").closest("[data-slot=message]"),
    ).toHaveAttribute("data-align", "end");
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("20:04 UTC")).toBeVisible();
  },
};
