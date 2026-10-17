import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { Home, SharedOrigin } from "./app.tsx";

const meta = { component: Home, parameters: { layout: "fullscreen" } } satisfies Meta<typeof Home>;

export default meta;
type Story = StoryObj<typeof meta>;

const play: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("Abolish ballot");
  await expect(canvas.getByText(/open the ballot link/)).toBeVisible();
  await expect(canvas.getByText(/leave this device only encrypted/)).toBeVisible();
  // No poll is open, so there is no seal, no progress and nothing to press.
  await expect(canvas.queryByRole("img")).toBeNull();
  await expect(canvas.queryByRole("button")).toBeNull();
};

export const Default: Story = { play };

export const Dark: Story = { parameters: { layout: "fullscreen", theme: "dark" }, play };

const ADDRESS =
  "https://ipfs.example.net/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/";

export const OnASharedOrigin: Story = {
  render: () => <SharedOrigin address={ADDRESS} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "This address isn't safe for voting",
    );
    await expect(canvas.getByText(ADDRESS)).toBeVisible();
    await expect(canvas.getByRole("heading", { level: 2, name: "Nothing was sent" })).toBeVisible();
    await expect(canvas.getByText(/abolishus\.eth/)).toBeVisible();
    // No way forward from here but another address: no ballot, no button.
    await expect(canvas.queryByRole("button")).toBeNull();
    await expect(canvas.queryByText(/open the ballot link/)).toBeNull();
  },
};
