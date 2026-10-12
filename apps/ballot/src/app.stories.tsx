import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { App } from "./app.tsx";

const meta = { component: App } satisfies Meta<typeof App>;

export default meta;
type Story = StoryObj<typeof meta>;

const play: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("Abolish ballot");
  await expect(canvas.getByText(/open the ballot link/)).toBeVisible();
};

export const Default: Story = { play };

export const Dark: Story = { parameters: { theme: "dark" }, play };
