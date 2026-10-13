import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { UnreachablePage } from "./system-pages.tsx";

const meta = {
  title: "Mockups/Web/System pages",
  component: UnreachablePage,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof UnreachablePage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ServersUnreachable: Story = {
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
  parameters: { layout: "fullscreen", theme: "dark" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getAllByRole("img", { name: /^Fingerprint of ballot client/ }).length,
    ).toBeGreaterThanOrEqual(1);
  },
};
