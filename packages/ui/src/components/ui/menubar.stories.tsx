import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import {
  Menubar,
  MenubarCheckboxItem,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarSeparator,
  MenubarShortcut,
  MenubarTrigger,
} from "./menubar.tsx";

const meta = {
  component: Menubar,
  render: (args) => (
    <Menubar {...args} aria-label="Board">
      <MenubarMenu>
        <MenubarTrigger>Receipt</MenubarTrigger>
        <MenubarContent>
          <MenubarItem>
            Copy hash <MenubarShortcut>Ctrl C</MenubarShortcut>
          </MenubarItem>
          <MenubarSeparator />
          <MenubarCheckboxItem defaultChecked>Show fingerprint</MenubarCheckboxItem>
        </MenubarContent>
      </MenubarMenu>
      <MenubarMenu>
        <MenubarTrigger>Tier</MenubarTrigger>
        <MenubarContent>
          <MenubarRadioGroup defaultValue="identity">
            <MenubarRadioItem value="identity">Identity checked</MenubarRadioItem>
            <MenubarRadioItem value="email">Email only</MenubarRadioItem>
          </MenubarRadioGroup>
        </MenubarContent>
      </MenubarMenu>
    </Menubar>
  ),
} satisfies Meta<typeof Menubar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(within(canvasElement).getByRole("menuitem", { name: "Tier" }));
    const menu = await body.findByRole("menu");
    await userEvent.click(within(menu).getByRole("menuitemradio", { name: "Email only" }));
    await expect(within(menu).getByRole("menuitemradio", { name: "Email only" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(within(canvasElement).getByRole("menuitem", { name: "Receipt" }));
    await expect(
      await body.findByRole("menuitemcheckbox", { name: "Show fingerprint" }),
    ).toHaveAttribute("aria-checked", "true");
  },
};
