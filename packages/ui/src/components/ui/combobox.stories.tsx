import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "./combobox.tsx";

const polls = ["Library levy", "Park bond", "Transit expansion", "School board recall"];

const meta = {
  component: Combobox,
  render: () => (
    <Combobox items={polls}>
      <ComboboxInput aria-label="Poll" placeholder="Find a poll" />
      <ComboboxContent>
        <ComboboxEmpty>No polls found.</ComboboxEmpty>
        <ComboboxList aria-label="Polls">
          {(item: string) => (
            <ComboboxItem key={item} value={item}>
              {item}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  ),
} satisfies Meta<typeof Combobox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const input = within(canvasElement).getByRole("combobox", { name: "Poll" });
    await userEvent.type(input, "park");
    const option = await body.findByRole("option", { name: "Park bond" });
    await expect(body.queryByRole("option", { name: "Library levy" })).toBeNull();
    await userEvent.click(option);
    await expect(input).toHaveValue("Park bond");
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(within(canvasElement).getByRole("combobox", { name: "Poll" }));
    const option = await body.findByRole("option", { name: "Transit expansion" });
    await waitFor(() => expect(option).toBeVisible());
  },
};
