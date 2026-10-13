import type { Meta, StoryObj } from "@storybook/react-vite";
import { FileText, X } from "lucide-react";
import { expect, fn, userEvent, within } from "storybook/test";

import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "./attachment.tsx";

const onRemove = fn();

const meta = {
  component: Attachment,
  args: { state: "done" },
  render: (args) => (
    <Attachment {...args}>
      <AttachmentMedia>
        <FileText aria-hidden="true" />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>receipt-18204.json</AttachmentTitle>
        <AttachmentDescription>2 KB</AttachmentDescription>
      </AttachmentContent>
      <AttachmentActions>
        <AttachmentAction aria-label="Remove receipt-18204.json" onClick={onRemove}>
          <X aria-hidden="true" />
        </AttachmentAction>
      </AttachmentActions>
    </Attachment>
  ),
} satisfies Meta<typeof Attachment>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("receipt-18204.json")).toBeVisible();
    onRemove.mockClear();
    await userEvent.click(canvas.getByRole("button", { name: "Remove receipt-18204.json" }));
    await expect(onRemove).toHaveBeenCalledOnce();
  },
};

export const Failed: Story = {
  args: { state: "error" },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector("[data-slot=attachment]")).toHaveAttribute(
      "data-state",
      "error",
    );
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("2 KB")).toBeVisible();
  },
};

export const DarkFailed: Story = {
  args: { state: "error" },
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("2 KB")).toBeVisible();
  },
};
