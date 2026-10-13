import type { Meta, StoryObj } from "@storybook/react-vite";
import { SearchIcon, XIcon } from "lucide-react";
import { expect, userEvent, within } from "storybook/test";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from "./input-group.tsx";

const meta = {
  component: InputGroup,
  render: (args) => (
    <InputGroup {...args} aria-label="Board search" className="max-w-sm">
      <InputGroupInput aria-label="Board entry number" placeholder="4812" inputMode="numeric" />
      <InputGroupAddon>
        <SearchIcon aria-hidden="true" />
        <InputGroupText>#</InputGroupText>
      </InputGroupAddon>
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          size="icon-sm"
          aria-label="Clear"
          onClick={(event) => {
            const input = event.currentTarget
              .closest("[data-slot=input-group]")
              ?.querySelector("input");
            if (input) input.value = "";
          }}
        >
          <XIcon aria-hidden="true" />
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  ),
} satisfies Meta<typeof InputGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByRole("textbox", { name: "Board entry number" });
    await userEvent.type(input, "4812");
    await expect(input).toHaveValue("4812");
    await userEvent.click(canvas.getByRole("button", { name: "Clear" }));
    await expect(input).toHaveValue("");
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("group", { name: "Board search" })).toBeVisible();
  },
};
