import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { RIVERSIDE } from "./everyday-fixtures.ts";
import { EverydayPlace } from "./everyday-place.tsx";

const meta = {
  title: "Mockups/Ballot/Everyday/Your place",
  component: EverydayPlace,
  args: { poll: RIVERSIDE },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof EverydayPlace>;

export default meta;
type Story = StoryObj<typeof meta>;

const place: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
    "Your place on the board",
  );
  const map = canvas.getByRole("figure", { name: "The public board, 2,432 answers, newest last" });
  await expect(within(map).getByRole("img", { name: /yours is the last square/ })).toBeVisible();
  await expect(within(map).getByTestId("board-map-position")).toHaveTextContent(
    "Yours is number 2,431, the newest of 2,432. It arrived in the 14:00 hour, which is written to Ethereum at 15:00.",
  );
  await waitFor(() => expect(within(map).getByTestId("board-map-mine")).toHaveTextContent("Yours"));
  await expect(map).toHaveTextContent("Not written yet");
  await userEvent.click(within(map).getByText("Every hour as a list"));
  await expect(within(map).getByRole("row", { name: /^7 Nov 14:00/ })).toHaveTextContent(
    "At 15:00",
  );
  const rows = canvas.getByRole("table", { name: "Numbers 2,427 to 2,431, times UTC" });
  await expect(rows.querySelector('[aria-current="true"]')).toHaveTextContent("2,431");
  await expect(rows).toHaveTextContent("Your checked answers, set aside");
  const receipt = canvas.getAllByRole("group", { name: "The board in your receipt" })[0]!;
  await expect(receipt).toHaveAttribute("data-verdict", "pending");
  await expect(receipt).toHaveTextContent(
    "They match: the board your phone was shown holds your answers.",
  );
  await expect(
    canvas.getByRole("img", { name: "9 steps from your answers to all 2,432" }),
  ).toBeVisible();
};

export const FromDone: Story = {
  name: "From the Done screen",
  play: async (context) => {
    const canvas = within(context.canvasElement);
    await expect(canvas.getByText(/number 2,431, the newest of 2,432/)).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "See your place on the board" }));
    await place(context);
    await userEvent.click(canvas.getByRole("button", { name: "Done" }));
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Your answers are in",
    );
  },
};

export const Place: Story = { name: "Your place", args: { start: "place" }, play: place };

export const Dark: Story = {
  name: "Your place, dark",
  args: { start: "place" },
  parameters: { layout: "fullscreen", theme: "dark" },
  play: place,
};
