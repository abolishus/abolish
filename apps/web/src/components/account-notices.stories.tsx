import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { AccountNotices } from "./account-notices.tsx";

const meta = {
  component: AccountNotices,
  args: { index: "04" },
} satisfies Meta<typeof AccountNotices>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The one kind there is, which can't be turned off, and what its e-mail says. */
const tells = async ({ canvasElement }: { canvasElement: HTMLElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { name: "What we tell you about" })).toBeVisible();
  const kinds = canvas.getAllByRole("listitem");
  await expect(kinds).toHaveLength(1);
  await expect(kinds[0]).toHaveTextContent("Always sent, so that you can appeal");
  // Nothing to switch: the optional kinds wait on published results.
  await expect(canvas.queryByRole("switch")).toBeNull();
  await expect(canvas.queryByRole("checkbox")).toBeNull();
  await expect(canvas.getByText(/says only that there was one/)).toBeVisible();
};

export const Moderation: Story = { play: tells };

export const ModerationDark: Story = { parameters: { theme: "dark" }, play: tells };
