import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { VerifyPage } from "./verify-page.tsx";

const meta = {
  component: VerifyPage,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <main className="mx-auto max-w-6xl px-4 py-10">
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof VerifyPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Count a poll again without us",
    );
    // What isn't running yet is said first, before any command.
    await expect(canvas.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "Not yet for the polls on this site",
      "Four commands, one verdict per poll",
      "8 groups of checks, from the code to the count",
      "What it takes on trust, and what it doesn't",
    ]);
    await expect(
      within(canvas.getByRole("navigation", { name: "On this page" })).getAllByRole("link"),
    ).toHaveLength(3);
    // Each command sits under its step, as text to copy.
    const commands = canvasElement.querySelectorAll("pre");
    await expect(commands).toHaveLength(4);
    await expect(commands[1]).toHaveTextContent("--anchor $ANCHOR");
    const codes = within(canvas.getByRole("table", { name: "What the exit code means" }))
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.firstElementChild?.textContent);
    await expect(codes).toEqual(["0", "20", "21", "22", "64"]);
    // Our servers are trusted for nothing.
    await expect(canvas.getByText("Our servers").nextElementSibling).toHaveTextContent(
      /^Nothing\./,
    );
    // No link off this site, and no inline styles: the CSP's style-src 'self' would block them.
    await expect(canvasElement.querySelector("a[href^='http']")).toBeNull();
    await expect(canvasElement.querySelector("[style]")).toBeNull();
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(canvasElement.querySelector("[style]")).toBeNull();
  },
};
