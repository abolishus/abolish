import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, waitFor, within } from "storybook/test";

import { EverydayHomePage } from "./everyday-home-page.tsx";

const meta = {
  title: "Mockups/Web/Everyday/Home",
  component: EverydayHomePage,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof EverydayHomePage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Ask anything. Anyone can answer. Anyone can check the count.",
    );
    // The live question is answerable from the page: each answer opens the ballot app with it picked.
    const featured = canvas.getByRole("region", {
      name: "Which one improvement matters most to you?",
    });
    const answers = within(featured).getByRole("list", { name: /^Answers to/ });
    await expect(within(answers).getAllByRole("link")).toHaveLength(4);
    await expect(
      within(answers).getByRole("link", { name: "Better lighting on the river path" }),
    ).toHaveAttribute("href", "/polls/riverside/answer#pick=lights");
    await expect(featured).toHaveTextContent("2,418 people with an account have answered.");

    // A calm preview of the stream: three questions, no civic item, no counts of viewers.
    const stream = canvas.getByRole("region", { name: "What people are asking" });
    await expect(within(stream).getAllByRole("article")).toHaveLength(3);
    await expect(canvas.queryByText(/viewing now/i)).toBeNull();

    // The trust band redraws as each step reaches the middle of the viewport.
    const graphic = () => canvas.getByTestId("trust-graphic");
    await expect(graphic()).toHaveAttribute("data-step", "0");
    const scene = canvas.getByRole("region", { name: "What happens to an answer" });
    const steps = [...scene.querySelectorAll<HTMLElement>(":scope > ol > li")];
    await expect(steps).toHaveLength(4);
    steps[2]!.scrollIntoView({ block: "center" });
    await waitFor(() => expect(graphic()).toHaveAttribute("data-step", "2"));
    await expect(graphic()).toHaveTextContent("Riverside Library Friends");
    steps[3]!.scrollIntoView({ block: "center" });
    await waitFor(() => expect(graphic()).toHaveAttribute("data-step", "3"));
    await expect(graphic()).toHaveTextContent("They match.");
  },
};

export const Dark: Story = {
  parameters: { layout: "fullscreen", theme: "dark" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(canvas.getAllByRole("link", { name: "Ask a question" })).toHaveLength(2);
    await expect(
      canvas.getByRole("heading", { level: 3, name: "Opened only at set times" }),
    ).toBeInTheDocument();
  },
};
