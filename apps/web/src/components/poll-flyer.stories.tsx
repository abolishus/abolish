import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { instant } from "../poll.ts";
import { PollFlyer } from "./poll-flyer.tsx";

const CODE = "mhanrsz";
const URL = `https://abolish.us/p/${CODE}`;
const HASH = "3a51c6f0b2e94d7781aa0c3f5e6d2b9817c4e0f9a3b5d1c7e8f2a4b6c9d0e1f2";
const QUESTION = { optionCount: 3, minSelections: 0, maxSelections: 1 };

const meta = {
  component: PollFlyer,
  args: {
    poll: {
      definitionHash: HASH,
      questions: [QUESTION],
      opensAt: instant(1_793_000_000n),
      closesAt: instant(1_794_758_400n),
    },
    asOf: instant(1_793_500_000n),
    code: CODE,
    url: URL,
    title: `Poll ${CODE}`,
    paper: "letter",
    ink: "color",
  },
} satisfies Meta<typeof PollFlyer>;

export default meta;
type Story = StoryObj<typeof meta>;

const play: Story["play"] = async ({ canvasElement, args }) => {
  const page = within(canvasElement);
  const sheet = within(page.getByTestId("flyer"));
  await expect(sheet.getByRole("heading", { level: 2 })).toHaveTextContent(args.title);
  // Level Q of the upper-case link: version 2's 25 modules and the quiet zone.
  const qr = sheet.getByRole("img", { name: `QR code for abolish.us/p/${CODE}` });
  await expect(qr).toHaveAttribute("viewBox", "0 0 33 33");
  await expect(sheet.getByText(`abolish.us/p/${CODE}`, { selector: "p" })).toBeVisible();
  await expect(sheet.getByText(/^Closes /)).toHaveTextContent("Closes November 15, 2026");
  await expect(sheet.getByText(/Abolish alone holds the key for this poll/)).toBeVisible();
  // Seven tabs, each carrying the link and nothing else.
  const tabs = within(sheet.getByRole("list", { name: "Tear-off tabs with the link" }));
  const items = tabs.getAllByRole("listitem");
  await expect(items).toHaveLength(7);
  for (const tab of items) await expect(tab).toHaveTextContent(`abolish.us/p/${CODE}`);
  // Nothing about answers: no count, no percentage.
  await expect(sheet.queryByText(/%|answers? so far/)).toBeNull();
  // The choices are links, so they work without the page's script.
  await expect(page.getByRole("link", { name: "A4" })).toHaveAttribute(
    "href",
    `/p/${CODE}/flyer?paper=a4&ink=${args.ink}`,
  );
  await expect(page.getByRole("button", { name: "Print this flyer" })).toBeVisible();
};

export const Letter: Story = {
  name: "US Letter",
  play: async (context) => {
    await play(context);
    const page = within(context.canvasElement);
    await expect(page.getByRole("link", { name: "US Letter" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByTestId("flyer")).toHaveClass("aspect-[17/22]");
    // Named by its code, in our own words and the page's language.
    const heading = within(page.getByTestId("flyer")).getByRole("heading", { level: 2 });
    await expect(heading).not.toHaveAttribute("lang");
    await expect(heading).not.toHaveAttribute("dir");
  },
};

export const A4: Story = {
  args: { paper: "a4" },
  play: async (context) => {
    await play(context);
    const page = within(context.canvasElement);
    await expect(page.getByRole("link", { name: "A4" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("flyer")).toHaveClass("aspect-[210/297]");
  },
};

export const BlackAndWhite: Story = {
  name: "Black and white",
  args: { ink: "mono" },
  play: async (context) => {
    await play(context);
    const page = within(context.canvasElement);
    await expect(page.getByRole("link", { name: "Black and white" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    // No emerald anywhere on the sheet.
    await expect(
      page.getByTestId("flyer").querySelector(".bg-primary, .border-primary"),
    ).toBeNull();
  },
};

export const Dark: Story = {
  name: "Dark page, light sheet",
  parameters: { theme: "dark" },
  play: async (context) => {
    await play(context);
    // Paper is white whatever the page's theme.
    await expect(within(context.canvasElement).getByTestId("flyer")).toHaveAttribute(
      "data-theme",
      "light",
    );
  },
};

export const Scheduled: Story = {
  name: "Not open yet",
  args: { asOf: instant(1_792_000_000n) },
  play: async ({ canvasElement }) => {
    const sheet = within(within(canvasElement).getByTestId("flyer"));
    await expect(sheet.getByText(/^Opens /)).toHaveTextContent(
      /Opens .+, closes November 15, 2026/,
    );
    await expect(sheet.getByText("Scan to answer")).toBeVisible();
  },
};

export const Closed: Story = {
  args: { asOf: instant(1_795_000_000n) },
  play: async ({ canvasElement }) => {
    const sheet = within(within(canvasElement).getByTestId("flyer"));
    await expect(sheet.getByText("Scan to see the poll")).toBeVisible();
    await expect(sheet.getByText(/^Closed /)).toBeVisible();
    await expect(sheet.getByRole("heading", { name: "This poll has closed" })).toBeVisible();
    await expect(sheet.queryByText("How to answer")).toBeNull();
  },
};

export const Questions: Story = {
  name: "Several questions",
  args: {
    poll: { ...meta.args.poll, questions: [QUESTION, QUESTION, QUESTION] },
  },
  play: async ({ canvasElement }) => {
    const sheet = within(within(canvasElement).getByTestId("flyer"));
    await expect(sheet.getByText("3 short questions, answered together.")).toBeVisible();
  },
};

export const Worded: Story = {
  name: "The poll's own words",
  args: { title: "Should the park stay open late?", titleLanguage: "en" },
  play: async (context) => {
    await play(context);
    const heading = within(within(context.canvasElement).getByTestId("flyer")).getByRole(
      "heading",
      { level: 2 },
    );
    await expect(heading).toHaveAttribute("lang", "en");
    await expect(heading).toHaveAttribute("dir", "auto");
  },
};

export const RightToLeft: Story = {
  name: "Words written right to left",
  args: { title: "هل يبقى المنتزه مفتوحاً حتى وقت متأخر؟", titleLanguage: "ar" },
  play: async (context) => {
    await play(context);
    const heading = within(within(context.canvasElement).getByTestId("flyer")).getByRole(
      "heading",
      { level: 2 },
    );
    await expect(heading).toHaveAttribute("lang", "ar");
    // Its own direction, while the rest of the sheet stays left to right.
    await expect(getComputedStyle(heading).direction).toBe("rtl");
    const sheet = within(context.canvasElement).getByTestId("flyer");
    await expect(getComputedStyle(sheet).direction).toBe("ltr");
  },
};
