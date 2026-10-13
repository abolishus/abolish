import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { DiscoverPage } from "./everyday-discover-page.tsx";

const meta = {
  title: "Mockups/Web/Everyday/Discover",
  component: DiscoverPage,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof DiscoverPage>;

export default meta;
type Story = StoryObj<typeof meta>;

const stream = (root: HTMLElement) =>
  within(within(root).getByRole("region", { name: "Questions" }));

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "What people are asking",
    );
    const list = stream(canvasElement);
    await expect(list.getAllByRole("article")).toHaveLength(5);

    // A one-question poll is answerable from its card; each answer hands off to the ballot app.
    const library = list.getByRole("list", {
      name: "Answers to “When should the main library open on Sundays?”",
    });
    await expect(within(library).getByRole("link", { name: "10:00 to 16:00" })).toHaveAttribute(
      "href",
      "/polls/library-hours/answer#pick=ten",
    );
    // A multi-question poll hands off to the whole set.
    await expect(list.getByRole("link", { name: /Answer 3 questions/ })).toHaveAttribute(
      "href",
      "/polls/riverside/answer",
    );

    // Live results say their audience in words; sealed ones say when.
    await expect(
      list.getByText("Results so far, among 2,418 people with an account · updated 7 Nov"),
    ).toBeVisible();
    await expect(list.getByText("Results when it closes")).toBeVisible();

    // The civic item reads as part of the record, with its tier, and isn't answerable.
    const civic = canvasElement.querySelector<HTMLElement>("[data-civic]");
    await expect(civic).not.toBeNull();
    await expect(civic!).toHaveTextContent("From the civic record");
    await expect(civic!).toHaveTextContent("58.4% yes among 40,112 document-verified voters.");
    await expect(within(civic!).queryByRole("list")).toBeNull();

    // No engagement counts.
    await expect(canvas.queryByText(/viewing now/i)).toBeNull();
  },
};

export const Filtered: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const topics = canvas.getByRole("group", { name: "Topic" });
    await userEvent.click(within(topics).getByRole("button", { name: "Transport" }));
    await waitFor(() => expect(stream(canvasElement).getAllByRole("article")).toHaveLength(1));
    await expect(
      stream(canvasElement).getByRole("heading", { name: "Should the 23 bus run until midnight?" }),
    ).toBeVisible();
    await expect(canvas.getByText("1 question match")).toBeVisible();

    // Two filters that share nothing leave a friendly empty state, and one tap clears them.
    const places = canvas.getByRole("group", { name: "Place" });
    await userEvent.click(within(places).getByRole("button", { name: "Riverside" }));
    await waitFor(() => expect(canvas.getByText("Nothing here yet")).toBeVisible());
    await userEvent.click(canvas.getByRole("button", { name: "Show everything" }));
    await waitFor(() => expect(stream(canvasElement).getAllByRole("article")).toHaveLength(5));
  },
};

export const Dark: Story = {
  parameters: { layout: "fullscreen", theme: "dark" },
  args: { topic: "Libraries" },
  play: async ({ canvasElement }) => {
    const list = stream(canvasElement);
    await expect(list.getAllByRole("article")).toHaveLength(1);
    await expect(list.getByRole("link", { name: "Keep it closed on Sundays" })).toBeVisible();
  },
};
