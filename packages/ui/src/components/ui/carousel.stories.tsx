import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "./carousel.tsx";

const polls = ["Library levy", "Bike lanes on Main", "Park curfew"];

const meta = {
  component: Carousel,
  render: (args) => (
    <div className="px-14">
      <Carousel {...args} aria-label="Open polls" className="w-64">
        <CarouselContent>
          {polls.map((poll, index) => (
            <CarouselItem key={poll} aria-label={`${index + 1} of ${polls.length}`}>
              <div className="flex h-32 items-center justify-center border bg-card text-sm">
                {poll}
              </div>
            </CarouselItem>
          ))}
        </CarouselContent>
        <CarouselPrevious />
        <CarouselNext />
      </Carousel>
    </div>
  ),
} satisfies Meta<typeof Carousel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const previous = canvas.getByRole("button", { name: "Previous slide" });
    const next = canvas.getByRole("button", { name: "Next slide" });
    await waitFor(() => expect(next).toBeEnabled());
    await expect(previous).toBeDisabled();
    await userEvent.click(next);
    await waitFor(() => expect(previous).toBeEnabled());
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("region", { name: "Open polls" })).toBeVisible();
  },
};
