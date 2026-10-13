import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { ErrorPage, NotFoundPage, UnreachablePage } from "./system-pages.tsx";

const meta = {
  title: "Mockups/Web/System pages",
  component: NotFoundPage,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof NotFoundPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NotFound: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "There is no page at this address",
    );
    const ways = canvas.getByRole("navigation", { name: "Other places to go" });
    await expect(within(ways).getByRole("link", { name: /^Verify/ })).toHaveAttribute(
      "href",
      "/verify",
    );
    await userEvent.tab();
    await expect(canvas.getByRole("link", { name: "Skip to content" })).toHaveFocus();
  },
};

export const SomethingWentWrong: Story = {
  render: () => <ErrorPage />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Something went wrong on our side",
    );
    // Says nothing about the error itself: no codes, traces or request IDs.
    await expect(canvasElement.querySelector("main")?.textContent ?? "").not.toMatch(
      /\b(5\d\d|stack|exception|request id|trace)\b/i,
    );
    await expect(canvas.getByRole("button", { name: "Try again" })).toBeEnabled();
  },
};

export const SomethingWentWrongDark: Story = {
  render: () => <ErrorPage />,
  parameters: { layout: "fullscreen", theme: "dark" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("navigation", { name: "Other places to go" })).toBeVisible();
  },
};

export const ServersUnreachable: Story = {
  render: () => <UnreachablePage />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Our servers are unreachable",
    );
    const entry = canvas.getByRole("region", { name: "Other ways in" });
    await expect(within(entry).getByText("abolishus.eth")).toBeVisible();
    await expect(within(entry).getByText("abolish.ch")).toBeVisible();
    await expect(canvas.getByRole("region", { name: "Recount without us" })).toHaveTextContent(
      "abolish-verify --poll",
    );
    await expect(
      canvas.getByRole("region", { name: "Cast a ballot without us" }),
    ).toHaveTextContent("direct-submit path");
  },
};

export const ServersUnreachableDark: Story = {
  render: () => <UnreachablePage />,
  parameters: { layout: "fullscreen", theme: "dark" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getAllByRole("img", { name: /^Fingerprint of ballot client/ }).length,
    ).toBeGreaterThanOrEqual(1);
  },
};
