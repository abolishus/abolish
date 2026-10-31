import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { NO_TAGS, type PollView } from "../poll.ts";
import { PollRows } from "./poll-list.tsx";

const poll = (electionId: string, overrides: Partial<PollView> = {}): PollView => ({
  electionId,
  definitionHash: "a4555c67fbc57b7ed42f873f73f36360baba11fa0de1f0ba0f104780a4071750",
  version: 1,
  illFormed: undefined,
  counting: "plurality",
  questions: [{ optionCount: 3, minSelections: 0, maxSelections: 1 }],
  electorate: [{ tier: 0, groupSize: "5000" }],
  threshold: 4,
  panelSize: 7,
  opensAt: { seconds: "1767225600", iso: "2026-01-01T00:00:00.000Z" },
  closesAt: { seconds: "1767830400", iso: "2026-01-08T00:00:00.000Z" },
  ...overrides,
});

const FIRST = "10".repeat(32);
const SECOND = "20".repeat(32);
const THIRD = "30".repeat(32);

const meta = {
  component: PollRows,
  args: {
    label: "Listed polls",
    polls: [
      {
        kind: "poll",
        poll: poll(FIRST),
        text: {
          language: "en",
          heading: "Should the library open on Sundays?",
          question: undefined,
          options: ["Yes", "No", "Only in winter"],
        },
        answered: [
          { tier: 0, answered: "1" },
          { tier: 2, answered: "1204" },
        ],
        tags: { topic: "community", place: "Riverside" },
      },
      {
        kind: "poll",
        text: undefined,
        answered: undefined,
        tags: NO_TAGS,
        poll: poll(SECOND, {
          counting: "approval",
          illFormed: { rule: "timing", question: undefined },
          closesAt: { seconds: "18446744073709551615", iso: undefined },
        }),
      },
      { kind: "unavailable", electionId: THIRD, problem: "undecodable" },
    ],
    asOf: { seconds: "1767571200", iso: "2026-01-05T00:00:00.000Z" },
    phoneVerification: false,
  },
} satisfies Meta<typeof PollRows>;

export default meta;
type Story = StoryObj<typeof meta>;

const play: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const list = canvas.getByRole("list", { name: "Listed polls" });
  // The rows, not the lines of each row's count.
  const items = within(list)
    .getAllByRole("listitem")
    .filter((item) => item.parentElement === list);
  await expect(items).toHaveLength(3);
  // A poll in its own words, in their language, with its ID under them.
  const first = within(items[0]!).getByRole("link", {
    name: "Should the library open on Sundays?",
  });
  await expect(first).toHaveAttribute("href", `/polls/${FIRST}`);
  await expect(first).toHaveTextContent("Should the library open on Sundays?");
  await expect(first.closest("h3")).toHaveAttribute("lang", "en");
  await expect(within(items[0]!).getByText("1010101010101010…")).toBeVisible();
  // One with no words to show goes by its ID.
  await expect(within(items[1]!).getByRole("link")).toHaveTextContent("2020202020202020…");
  // Where each is listed, each tag a link into the stream narrowed to it,
  // and nothing for a poll listed under neither.
  const listed = within(items[0]!).getByRole("list", { name: "Where it's listed" });
  await expect(
    within(listed)
      .getAllByRole("link")
      .map((link) => [link.textContent, link.getAttribute("href")]),
  ).toEqual([
    ["Community", "/discover?topic=community"],
    ["Riverside", "/discover?place=Riverside"],
  ]);
  await expect(within(items[1]!).queryByRole("list", { name: "Where it's listed" })).toBeNull();
  await expect(within(items[0]!).getByText("One choice")).toBeVisible();
  await expect(within(items[0]!).getByText("Open")).toBeVisible();
  await expect(within(items[0]!).getByText(/January 8, 2026/)).toBeVisible();
  // How many have answered, each tier on its own line, never summed (T-01).
  const answered = within(
    within(items[0]!).getByText("Answered so far").nextElementSibling as HTMLElement,
  ).getAllByRole("listitem");
  await expect(answered.map((item) => item.textContent)).toEqual([
    "1 personTier 0 (verified e-mail)",
    "1,204 peopleTier 2 (document-verified)",
  ]);
  // A count the page couldn't read is left out.
  await expect(within(items[1]!).queryByText("Answered so far")).toBeNull();
  await expect(
    within(items[0]!).getByRole("img", { name: "Fingerprint of poll 10101010" }),
  ).toBeVisible();
  // An ill-formed definition is flagged, and an instant past `Date` shown as seconds.
  await expect(within(items[1]!).getByText(/verifier fails it/)).toBeVisible();
  await expect(within(items[1]!).getByText("18446744073709551615")).toBeVisible();
  // A definition that doesn't decode is still linked, with nothing shown from it.
  await expect(within(items[2]!).getByRole("link")).toHaveAttribute("href", `/polls/${THIRD}`);
  await expect(within(items[2]!).getByText(/doesn't decode/)).toBeVisible();
};

export const Default: Story = { play };

export const Dark: Story = { parameters: { theme: "dark" }, play };

/** Where Tier 0 asks for a phone, its count says so. */
export const PhoneVerification: Story = {
  args: { phoneVerification: true },
  play: async ({ canvasElement }) => {
    const [first] = within(canvasElement).getAllByRole("article");
    await expect(within(first!).getByText("Tier 0 (verified e-mail and phone)")).toBeVisible();
  },
};
