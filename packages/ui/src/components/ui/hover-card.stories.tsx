import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { HoverCard, HoverCardContent, HoverCardTrigger } from "./hover-card.tsx";

const meta = {
  component: HoverCard,
  render: (args) => (
    <HoverCard {...args}>
      <HoverCardTrigger href="#tier-2" className="text-sm underline underline-offset-4">
        Tier 2 verification
      </HoverCardTrigger>
      <HoverCardContent>
        Voters who confirmed their address with a mailed code. 40,112 voters.
      </HoverCardContent>
    </HoverCard>
  ),
} satisfies Meta<typeof HoverCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.hover(within(canvasElement).getByRole("link", { name: "Tier 2 verification" }));
    const content = await body.findByText(/confirmed their address/);
    await waitFor(() => expect(content).toBeVisible());
  },
};

export const Dark: Story = {
  args: { defaultOpen: true },
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const content = await body.findByText(/40,112 voters/);
    await waitFor(() => expect(content).toBeVisible());
  },
};
