import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "./accordion.tsx";

const meta = {
  component: Accordion,
  render: (args) => (
    <Accordion {...args}>
      <AccordionItem value="binding">
        <AccordionTrigger>Is my vote binding?</AccordionTrigger>
        <AccordionContent>No. Results are a public signal, not law.</AccordionContent>
      </AccordionItem>
      <AccordionItem value="receipt">
        <AccordionTrigger>What does my receipt prove?</AccordionTrigger>
        <AccordionContent>That your ballot is on the board, unchanged.</AccordionContent>
      </AccordionItem>
    </Accordion>
  ),
} satisfies Meta<typeof Accordion>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("button", { name: "What does my receipt prove?" });
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(trigger);
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(canvas.getByText("That your ballot is on the board, unchanged.")).toBeVisible();
  },
};

export const Dark: Story = {
  args: { defaultValue: ["binding"] },
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("No. Results are a public signal, not law."),
    ).toBeVisible();
  },
};
