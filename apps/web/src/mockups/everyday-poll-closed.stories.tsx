import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { EverydayPollClosedPage } from "./everyday-poll-closed-page.tsx";

const meta = {
  title: "Mockups/Web/Everyday/Poll closed",
  component: EverydayPollClosedPage,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof EverydayPollClosedPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "What should Riverside ask the city for next year?",
    );
    // A sentence per question up top, then the bars, each with its audience in words.
    const summary = canvas.getByRole("list", { name: "In short" });
    await expect(within(summary).getAllByRole("listitem")).toHaveLength(3);
    await expect(summary).toHaveTextContent("Better lighting on the river path leads, with 42%.");
    await expect(
      canvas.getAllByRole("figure", {
        name: "Among 3,152 people with an account · final count, closed 15 Nov",
      }),
    ).toHaveLength(3);
    await expect(canvas.getByText("15 November 2026, 12:00 UTC")).toBeVisible();

    // The scene ends on the final count.
    const scene = canvas.getByRole("region", { name: "Releases of the first question’s results" });
    const steps = [...scene.querySelectorAll<HTMLElement>(":scope > ol > li")];
    await expect(steps).toHaveLength(4);
    steps[3]!.scrollIntoView({ block: "center" });
    // The sticky graphic follows the reader's step (drawn from `lg`; below it
    // each step's card draws its own).
    const sticky = within(scene.querySelector<HTMLElement>(":scope > div")!);
    await waitFor(() =>
      expect(sticky.getByTestId("release-graphic")).toHaveAttribute("data-release", "3"),
    );
    await expect(steps[3]!).toHaveTextContent("Final count, closed 15 Nov, 12:00 UTC");
    await expect(steps[3]!).toHaveTextContent("734 more answers after 7 Nov, 3,152 in all.");

    // The evidence is one step down, opened in place.
    const trigger = canvas.getByRole("button", { name: "Show the evidence" });
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(trigger);
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Hide the evidence" })).toHaveAttribute(
        "aria-expanded",
        "true",
      ),
    );
    await expect(canvas.getByTestId("trustee-statement")).toHaveTextContent(
      "During launch, Abolish alone holds the key for this poll.",
    );
  },
};

export const Dark: Story = {
  args: { evidenceOpen: true },
  parameters: { layout: "fullscreen", theme: "dark" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("link", { name: "Open the civic record" })).toHaveAttribute(
      "href",
      "/polls/riverside/record",
    );
    await expect(
      canvas.getAllByRole("img", { name: /^Fingerprint of poll b1a7 1203$/ }),
    ).toHaveLength(2);
  },
};
