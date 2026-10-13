import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { PollsIndexPage } from "./polls-index-page.tsx";

const meta = {
  title: "Mockups/Web/Polls",
  component: PollsIndexPage,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof PollsIndexPage>;

export default meta;
type Story = StoryObj<typeof meta>;

const register = (canvasElement: HTMLElement) =>
  within(within(canvasElement).getByRole("list", { name: "Polls" }));

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Every poll on the record",
    );
    await expect(register(canvasElement).getAllByRole("article")).toHaveLength(14);

    const status = canvas.getByRole("group", { name: "Status" });
    const scheduled = within(status).getByRole("button", { name: /^Scheduled/ });
    await userEvent.click(scheduled);
    await expect(scheduled).toHaveAttribute("aria-pressed", "true");
    const rows = register(canvasElement).getAllByRole("article");
    await expect(rows).toHaveLength(3);
    for (const row of rows) await expect(row).toHaveTextContent("Scheduled");

    await userEvent.type(
      canvas.getByRole("searchbox", { name: "Search titles and scopes" }),
      "transit",
    );
    await waitFor(() => expect(register(canvasElement).getAllByRole("article")).toHaveLength(1));
    await expect(
      register(canvasElement).getByRole("link", { name: "Statewide transit bond" }),
    ).toBeVisible();
    await expect(canvas.getByText(/1 of 14/)).toBeVisible();
  },
};

export const Dark: Story = {
  parameters: { layout: "fullscreen", theme: "dark" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const kind = canvas.getByRole("group", { name: "Kind" });
    await userEvent.click(within(kind).getByRole("button", { name: /^Referendum/ }));
    const rows = register(canvasElement).getAllByRole("article");
    await expect(rows).toHaveLength(6);
    for (const row of rows) await expect(row).toHaveTextContent("Referendum");
    await expect(
      register(canvasElement).getByRole("heading", { name: "Alder County library levy" }),
    ).toBeVisible();
  },
};

export const Empty: Story = {
  args: { initialQuery: "lighthouse museum" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "No polls match" })).toBeVisible();
    await expect(canvas.queryByRole("list", { name: "Polls" })).toBeNull();
    await expect(canvas.getByText(/0 of 14/)).toBeVisible();
    const clear = canvas.getAllByRole("button", { name: "Clear filters" }).at(-1);
    if (clear === undefined) throw new Error("no clear button");
    await userEvent.click(clear);
    await expect(register(canvasElement).getAllByRole("article")).toHaveLength(14);
    await expect(canvas.getByRole("searchbox", { name: "Search titles and scopes" })).toHaveValue(
      "",
    );
  },
};
