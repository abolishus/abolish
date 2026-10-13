import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { Textarea } from "./textarea.tsx";

const meta = {
  component: Textarea,
  args: { id: "poll-comment", placeholder: "Why did you vote this way?" },
  render: (args) => (
    <div className="flex w-72 flex-col gap-2 text-sm">
      <label htmlFor="poll-comment">Comment on the library levy</label>
      <Textarea {...args} />
    </div>
  ),
} satisfies Meta<typeof Textarea>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const textarea = within(canvasElement).getByRole("textbox", {
      name: "Comment on the library levy",
    });
    await userEvent.type(textarea, "Branches need longer hours.");
    await expect(textarea).toHaveValue("Branches need longer hours.");
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("textbox")).toBeVisible();
  },
};
