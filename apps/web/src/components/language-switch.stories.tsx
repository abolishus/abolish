import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";

import { LanguageSwitch } from "./language-switch.tsx";

const meta = {
  component: LanguageSwitch,
  args: { choose: fn() },
} satisfies Meta<typeof LanguageSwitch>;

export default meta;
type Story = StoryObj<typeof meta>;

export const English: Story = {
  play: async ({ canvasElement, args }) => {
    const nav = within(canvasElement).getByRole("navigation", { name: "Language" });
    // The page's own language is marked, not offered; each name in its own language.
    const current = within(nav).getByText("English");
    await expect(current).toHaveAttribute("aria-current", "true");
    await expect(current).toHaveAttribute("lang", "en-US");
    await expect(within(nav).queryByRole("button", { name: "English" })).toBeNull();
    const other = within(nav).getByRole("button", { name: "Español" });
    await expect(other).toHaveAttribute("lang", "es-US");
    await userEvent.click(other);
    await expect(args.choose).toHaveBeenCalledTimes(1);
    await expect(args.choose).toHaveBeenCalledWith("es-US");
  },
};

export const Spanish: Story = {
  parameters: { locale: "es-US" },
  play: async ({ canvasElement, args }) => {
    const nav = within(canvasElement).getByRole("navigation", { name: "Idioma" });
    await expect(within(nav).getByText("Español")).toHaveAttribute("aria-current", "true");
    await userEvent.keyboard("{Tab}");
    const other = within(nav).getByRole("button", { name: "English" });
    await expect(other).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect(args.choose).toHaveBeenCalledTimes(1);
    await expect(args.choose).toHaveBeenCalledWith("en-US");
  },
};

export const Dark: Story = { parameters: { theme: "dark" } };
