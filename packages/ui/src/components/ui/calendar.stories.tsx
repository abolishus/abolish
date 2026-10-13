import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";

import { Calendar } from "./calendar.tsx";

function PollCloseDate(props: Partial<React.ComponentProps<typeof Calendar>>) {
  const [selected, setSelected] = useState<Date | undefined>(new Date(Date.UTC(2026, 10, 3)));
  return (
    <Calendar
      {...props}
      mode="single"
      timeZone="UTC"
      defaultMonth={new Date(Date.UTC(2026, 10, 1))}
      selected={selected}
      onSelect={setSelected}
    />
  );
}

const meta = {
  component: Calendar,
  render: () => <PollCloseDate />,
} satisfies Meta<typeof Calendar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("grid", { name: "November 2026" })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: /November 10th, 2026/ }));
    await expect(canvas.getByRole("button", { name: /November 10th, 2026/ })).toHaveAttribute(
      "data-selected-single",
      "true",
    );
    await expect(canvas.getByRole("button", { name: /November 3rd, 2026/ })).not.toHaveAttribute(
      "data-selected-single",
      "true",
    );
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: /November 3rd, 2026/ }),
    ).toHaveAttribute("data-selected-single", "true");
  },
};
