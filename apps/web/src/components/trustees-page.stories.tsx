import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { TrusteesPage } from "./trustees-page.tsx";

const meta = {
  component: TrusteesPage,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <main className="mx-auto max-w-6xl px-4 py-10">
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof TrusteesPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The launch panel's label is the page's headline, never only in the evidence (T-14).
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "During launch, Abolish alone holds the key",
    );
    await expect(canvas.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "7 seats, and any 4 open a count",
      "For now, every seat is ours",
      "Our commitments, and what no one can check",
      "Independent trustees, before the first civic vote",
    ]);
    await expect(
      within(canvas.getByRole("navigation", { name: "On this page" })).getAllByRole("link"),
    ).toHaveLength(4);
    // The figures carry their scope: every seat is ours, and none is anyone else's.
    await expect(canvas.getByText("every one run by Abolish")).toBeVisible();
    await expect(
      canvas.getByText("Seats held by anyone else").previousElementSibling,
    ).toHaveTextContent("0");
    // A threshold of 4 is said as what fewer than it can't do.
    await expect(canvas.getByText(/One share, or any 3 of them, reveals nothing/)).toBeVisible();
    // Each promise says what of it can be checked, the destruction included.
    await expect(
      canvas.getByText(/The destruction itself can't be checked by anyone\./),
    ).toBeVisible();
    // No invented trustee: the names wait on independent ones.
    await expect(canvas.getByText("Names and the key ceremony")).toBeVisible();
    await expect(
      canvas.getByRole("link", { name: "Where it is weak, stated plainly" }),
    ).toHaveAttribute("href", "/how-it-works#weak-points");
    await expect(canvas.getByRole("link", { name: "Verify it yourself" })).toHaveAttribute(
      "href",
      "/verify",
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
