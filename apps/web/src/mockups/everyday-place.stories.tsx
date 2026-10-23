import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { EverydayPlacePage } from "./everyday-place-page.tsx";

const meta = {
  title: "Mockups/Web/Everyday/Your place",
  component: EverydayPlacePage,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof EverydayPlacePage>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The scene's sticky graphic, the one that follows the reader's step (drawn
 * from `lg`; below it each step's card draws its own).
 */
const sticky = (canvasElement: HTMLElement) =>
  within(
    within(canvasElement)
      .getByRole("region", { name: "Where your answer is" })
      .querySelector<HTMLElement>(":scope > div")!,
  );

const view = (canvasElement: HTMLElement) =>
  sticky(canvasElement).getByTestId("board-zoom-view").getAttribute("data-view");

const place: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(
    canvas.getByRole("heading", { level: 1, name: "Your answer is one of 2,418" }),
  ).toBeVisible();
  const scene = canvas.getByRole("region", { name: "Where your answer is" });
  const steps = [...scene.querySelectorAll<HTMLElement>(":scope > ol > li")];
  await expect(steps).toHaveLength(5);
  await expect(steps[1]).toHaveTextContent(
    "Yours arrived on 3 November between 14:00 and 15:00, with 39 others.",
  );
  await expect(view(canvasElement)).toBe("board");
  // The map drawn at this width: the sticky graphic's, or the first card's own.
  await waitFor(() =>
    expect(
      canvas.queryAllByTestId("board-map-mine").find((mine) => mine.checkVisibility()),
    ).toHaveTextContent("Yours"),
  );
  steps.at(-1)!.scrollIntoView({ block: "center" });
  await waitFor(() => expect(view(canvasElement)).toBe("proof"));
  const written = canvas.getByRole("group", { name: "Written to Ethereum, 3 November, 15:00 UTC" });
  await expect(written).toBeVisible();
  await expect(written).toHaveTextContent(
    "They match. Your answer is part of what was written to Ethereum.",
  );
};

export const FromTheSheet: Story = {
  name: "From “How do we know this is real?”",
  play: async (context) => {
    const canvas = within(context.canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /How do we know this is real\?/ }));
    const sheet = within(await within(document.body).findByRole("dialog"));
    await waitFor(() =>
      expect(
        sheet.getByRole("heading", { name: "Your answer is one of 2,418 on the public board" }),
      ).toBeVisible(),
    );
    await waitFor(() =>
      expect(sheet.getByRole("img", { name: /Each answer as one small square/ })).toBeVisible(),
    );
    await userEvent.click(sheet.getByRole("button", { name: "See where" }));
    await place(context);
    await userEvent.click(canvas.getByRole("button", { name: "Back to the poll" }));
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "What should Riverside ask the city for next year?",
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
