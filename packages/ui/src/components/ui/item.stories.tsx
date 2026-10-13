import type { Meta, StoryObj } from "@storybook/react-vite";
import { VoteIcon } from "lucide-react";
import { expect, within } from "storybook/test";

import { Button } from "./button.tsx";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "./item.tsx";

const meta = {
  component: Item,
  args: { variant: "outline" },
  render: (args) => (
    <ItemGroup aria-label="Open polls">
      <Item {...args} role="listitem">
        <ItemMedia variant="icon">
          <VoteIcon aria-hidden="true" />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>Library levy</ItemTitle>
          <ItemDescription>Closes 3 November at 20:00 UTC</ItemDescription>
        </ItemContent>
        <ItemActions>
          <Button variant="outline">Vote</Button>
        </ItemActions>
      </Item>
    </ItemGroup>
  ),
} satisfies Meta<typeof Item>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const item = within(canvas.getByRole("list", { name: "Open polls" })).getByRole("listitem");
    await expect(item).toHaveTextContent("Library levy");
    await expect(within(item).getByRole("button", { name: "Vote" })).toBeEnabled();
  },
};

export const Muted: Story = {
  args: { variant: "muted" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("listitem")).toHaveAttribute(
      "data-variant",
      "muted",
    );
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Library levy")).toBeVisible();
  },
};
