import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";

import { Button } from "./button.tsx";
import { ButtonGroup, ButtonGroupText } from "./button-group.tsx";

const onPrevious = fn();
const onNext = fn();

const meta = {
  component: ButtonGroup,
  render: (args) => (
    <ButtonGroup {...args} aria-label="Board pages">
      <Button variant="outline" onClick={onPrevious}>
        Previous
      </Button>
      <ButtonGroupText>Page 4 of 12</ButtonGroupText>
      <Button variant="outline" onClick={onNext}>
        Next
      </Button>
    </ButtonGroup>
  ),
} satisfies Meta<typeof ButtonGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    onNext.mockClear();
    const group = within(canvasElement).getByRole("group", { name: "Board pages" });
    await userEvent.click(within(group).getByRole("button", { name: "Next" }));
    await expect(onNext).toHaveBeenCalledOnce();
    await expect(onPrevious).not.toHaveBeenCalled();
  },
};

export const Vertical: Story = {
  args: { orientation: "vertical" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("group")).toHaveAttribute(
      "data-orientation",
      "vertical",
    );
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Page 4 of 12")).toBeVisible();
  },
};
