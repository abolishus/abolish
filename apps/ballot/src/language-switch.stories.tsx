import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";

import { Home } from "./app.tsx";
import { LocaleChoice } from "./language-switch.tsx";
import type { Locale } from "./locales.ts";

// The frame's switch (P2-28 part 4b), shown on the screen before any poll
// opens; every frame carries it the same way (frame.tsx).
function Switching({ choose }: { choose: (locale: Locale) => void }) {
  return (
    <LocaleChoice value={choose}>
      <Home />
    </LocaleChoice>
  );
}

const meta = {
  title: "Ballot/Language switch",
  component: Switching,
  parameters: { layout: "fullscreen" },
  args: { choose: fn() },
} satisfies Meta<typeof Switching>;

export default meta;
type Story = StoryObj<typeof meta>;

export const English: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const nav = canvas.getByRole("navigation", { name: "Language" });
    // The current language is marked, not offered; the other is a button in its own words and language.
    await expect(within(nav).getByText("English")).toHaveAttribute("aria-current", "true");
    await expect(within(nav).getByText("English")).toHaveAttribute("lang", "en-US");
    const spanish = within(nav).getByRole("button", { name: "Español" });
    await expect(spanish).toHaveAttribute("lang", "es-US");
    await userEvent.click(spanish);
    await expect(args.choose).toHaveBeenCalledWith("es-US");
  },
};

export const Spanish: Story = {
  parameters: { layout: "fullscreen", locale: "es-US" },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const nav = canvas.getByRole("navigation", { name: "Idioma" });
    await expect(within(nav).getByText("Español")).toHaveAttribute("aria-current", "true");
    await userEvent.click(within(nav).getByRole("button", { name: "English" }));
    await expect(args.choose).toHaveBeenCalledWith("en-US");
  },
};

export const Dark: Story = {
  parameters: { layout: "fullscreen", theme: "dark" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Español" })).toBeVisible();
  },
};
