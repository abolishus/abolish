import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { ListedUnder } from "./listed-under.tsx";

const meta = {
  component: ListedUnder,
  args: { tags: { topic: "transport", place: "Old Town" }, linked: true },
} satisfies Meta<typeof ListedUnder>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Each tag a link into the stream narrowed to it. */
const play: Story["play"] = async ({ canvasElement }) => {
  const listed = within(within(canvasElement).getByRole("list", { name: "Where it's listed" }));
  await expect(listed.getByRole("link", { name: "Transport" })).toHaveAttribute(
    "href",
    "/discover?topic=transport",
  );
  await expect(listed.getByRole("link", { name: "Old Town" })).toHaveAttribute(
    "href",
    "/discover?place=Old%20Town",
  );
};

export const Default: Story = { play };

export const Dark: Story = { parameters: { theme: "dark" }, play };

/** A place in another script keeps its own direction beside the topic. */
export const RightToLeft: Story = {
  args: { tags: { topic: "housing", place: "حي الزيتون" } },
  play: async ({ canvasElement }) => {
    const place = within(canvasElement).getByRole("link", { name: "حي الزيتون" });
    await expect(place.querySelector("bdi")).toHaveTextContent("حي الزيتون");
  },
};

/** Unlinked, as for a delisted poll: the words only. */
export const Unlinked: Story = {
  args: { linked: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Transport")).toBeVisible();
    await expect(canvas.getByText("Old Town")).toBeVisible();
    await expect(canvas.queryByRole("link")).toBeNull();
  },
};

/** Listed under neither: nothing at all. */
export const Untagged: Story = {
  args: { tags: { topic: undefined, place: undefined } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole("list")).toBeNull();
  },
};
