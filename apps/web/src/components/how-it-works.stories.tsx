import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, waitFor, within } from "storybook/test";

import { HowItWorks } from "./how-it-works.tsx";

const meta = {
  component: HowItWorks,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <main className="mx-auto max-w-6xl px-4 py-10">
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof HowItWorks>;

export default meta;
type Story = StoryObj<typeof meta>;

function sceneSteps(canvasElement: HTMLElement, name: string) {
  const scene = within(canvasElement).getByRole("region", { name });
  return [...scene.querySelectorAll<HTMLElement>(":scope > ol > li")];
}

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "How a ballot stays secret, gets recorded and is counted in public",
    );
    await expect(canvas.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "Who is counted, and how sure we are",
      "Your choice is sealed on your own device",
      "Checking that the app sealed what you chose",
      "Finding your ballot on the public board",
      "Counting without opening a single ballot",
      "What survives without us",
      "Where it is weak, stated plainly",
    ]);
    await expect(
      within(canvas.getByRole("navigation", { name: "On this page" })).getAllByRole("link"),
    ).toHaveLength(7);
    // What isn't built yet says so.
    await expect(
      canvas.getByRole("heading", { name: "Tier 1: vouched for (planned)" }),
    ).toBeInTheDocument();
    // The launch panel is ours, stated as the first limit ([[0027-trustee-panels-and-live-results]]).
    const limits = canvas.getAllByRole("listitem").filter((li) => li.closest("#weak-points"));
    await expect(limits[0]).toHaveTextContent("During launch, we hold every trustee seat");
    await expect(limits[0]).toHaveTextContent("T-14");
    // Tier 2 counts documents, not people: one person can hold two (T-03).
    const documents = limits.find((li) =>
      li.textContent?.includes("One person can hold two documents"),
    );
    await expect(documents).toHaveTextContent("T-03");
    await expect(documents).toHaveTextContent("Tier 2 isn't open yet.");
    // It ends on how to verify a result, the verify page.
    await expect(
      canvas.getByRole("link", { name: "How to verify a result yourself" }),
    ).toHaveAttribute("href", "/verify");

    // The count's diagram redraws as each step reaches the middle of the viewport.
    const counted = () => canvas.getByTestId("diagram-counted");
    await expect(counted()).toHaveAttribute("data-step", "0");
    await expect(counted()).toHaveAttribute("aria-hidden", "true");
    const steps = sceneSteps(canvasElement, "Counted as recorded, step by step");
    steps[2]!.scrollIntoView({ block: "center" });
    await waitFor(() => expect(counted()).toHaveAttribute("data-step", "2"));
    await expect(within(counted()).getByTestId("seat-count")).toHaveTextContent("4 of 7 seats");
    // The same numbers are in the step's text beside it.
    await expect(steps[2]).toHaveTextContent("4 of the 7 seats");
    // No inline styles anywhere: the CSP's style-src 'self' would block them.
    await expect(canvasElement.querySelector("[style]")).toBeNull();
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toBeVisible();
    // When abolish.us and our servers go, they are marked offline; the rest is planned.
    const takedown = sceneSteps(canvasElement, "If abolish.us is taken down, step by step");
    takedown[3]!.scrollIntoView({ block: "center" });
    const survives = () => canvas.getByTestId("diagram-survives");
    await waitFor(() => expect(survives()).toHaveAttribute("data-step", "3"));
    await expect(survives().querySelectorAll("[data-down]")).toHaveLength(2);
    await expect(canvasElement.querySelector("[style]")).toBeNull();
  },
};
