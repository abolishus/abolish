import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { NO_TAGS, type PollView } from "../poll.ts";
import type { PollList } from "../server/load.ts";
import { PollRegister, registerHref } from "./poll-register.tsx";

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

const OPEN = "10".repeat(32);
const SCHEDULED = "20".repeat(32);
const CLOSED = "30".repeat(32);
const UNREADABLE = "40".repeat(32);
const NEXT = "50".repeat(32);
const QUESTIONS = "60".repeat(32);

const LIST: PollList = {
  kind: "list",
  polls: [
    {
      kind: "poll",
      poll: poll(OPEN),
      text: undefined,
      answered: [{ tier: 0, answered: "1204" }],
      tags: NO_TAGS,
      counted: false,
    },
    {
      kind: "poll",
      text: undefined,
      answered: undefined,
      tags: NO_TAGS,
      counted: false,
      poll: poll(SCHEDULED, {
        counting: "approval",
        opensAt: { seconds: "1768435200", iso: "2026-01-15T00:00:00.000Z" },
        closesAt: { seconds: "18446744073709551615", iso: undefined },
      }),
    },
    {
      kind: "poll",
      text: undefined,
      answered: undefined,
      tags: NO_TAGS,
      counted: true,
      poll: poll(CLOSED, {
        closesAt: { seconds: "1767484800", iso: "2026-01-04T00:00:00.000Z" },
      }),
    },
    { kind: "unavailable", electionId: UNREADABLE, problem: "another-election" },
  ],
  next: NEXT,
  asOf: { seconds: "1767571200", iso: "2026-01-05T00:00:00.000Z" },
  counts: { listed: 1234, open: 212, scheduled: 41 },
};

const meta = {
  component: PollRegister,
  args: {
    page: LIST,
    after: undefined,
    typed: "",
    filters: { status: undefined, counting: undefined },
    invalid: undefined,
    phoneVerification: false,
  },
} satisfies Meta<typeof PollRegister>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The polls the register shows, by the IDs their links name. */
function shown(canvasElement: HTMLElement): (string | null)[] {
  const list = within(canvasElement).getByRole("list", { name: "Listed polls" });
  // Each row's heading link, not its results link.
  return within(list)
    .getAllByRole("heading")
    .map((h) => within(h).getByRole("link").getAttribute("href"));
}

const play: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("Every listed poll");
  await expect(canvas.getByText(/the election registry on chain names every poll/)).toBeVisible();
  await expect(canvas.getByRole("textbox", { name: "Poll ID" })).toBeVisible();
  // The whole listing in numbers, from the API's counts, not the page's four.
  const tally = canvasElement.querySelector<HTMLElement>('dl[aria-label="The list in numbers"]')!;
  await expect(tally).toBeVisible();
  const figures = [...tally.querySelectorAll("dt")].map((dt) => [
    dt.textContent,
    dt.nextElementSibling?.textContent,
  ]);
  await expect(figures.slice(0, 3)).toEqual([
    ["Listed polls", "1,234"],
    ["Open now", "212"],
    ["Scheduled", "41"],
  ]);
  await expect(figures[3]![0]).toBe("As of");
  // The clock and "UTC" wrap whole, never "UTC" alone on a line.
  await expect(figures[3]![1]).toMatch(/^January 5, 2026.*12:00\u00a0AM\u00a0UTC$/);
  // Each poll's status, read from its own times at the page's clock.
  const rows = canvas.getAllByRole("article");
  await expect(rows).toHaveLength(4);
  await expect(within(rows[0]!).getByText("Open")).toBeVisible();
  await expect(rows[0]).toHaveTextContent(/Closes January 8, 2026/);
  await expect(rows[0]).toHaveTextContent(/Answered so far1,204 peopleTier 0 \(verified e-mail\)/);
  await expect(rows[1]).not.toHaveTextContent(/Answered so far/);
  await expect(within(rows[1]!).getByText("Scheduled")).toBeVisible();
  await expect(rows[1]).toHaveTextContent(/Opens January 15, 2026/);
  // The status, then when it closed, without saying "Closed" twice.
  await expect(within(rows[2]!).getByText("Closed")).toBeVisible();
  await expect(rows[2]).toHaveTextContent(/On January 4, 2026/);
  await expect(within(rows[3]!).getByText(/another poll's definition/)).toBeVisible();
  await expect(canvas.getByText(/clock \(January 5, 2026/)).toBeVisible();
  // Each group at All, and each option counting the page's polls it matches.
  await expect(canvas.getAllByRole("radio", { name: "All 4", checked: true })).toHaveLength(2);
  await expect(canvas.getByRole("radio", { name: "Open 1" })).not.toBeChecked();
  await expect(canvas.getByRole("radio", { name: "One choice 2" })).not.toBeChecked();
  await expect(canvas.getByRole("radio", { name: "Approve any number 1" })).toBeVisible();
  await expect(canvas.getByText("4 of 4 polls on this page match.")).toBeVisible();
  await expect(canvas.queryByRole("link", { name: "Clear filters" })).toBeNull();
  await expect(shown(canvasElement)).toEqual(
    [OPEN, SCHEDULED, CLOSED, UNREADABLE].map((id) => `/polls/${id}`),
  );
  await expect(canvas.getByRole("link", { name: "More polls" })).toHaveAttribute(
    "href",
    `/polls?after=${NEXT}`,
  );
};

export const Default: Story = { play };

export const Dark: Story = { parameters: { theme: "dark" }, play };

/** Closed plurality polls only: a poll the page can't read never matches a filter. */
export const Filtered: Story = {
  args: { after: OPEN, filters: { status: "closed", counting: "plurality" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const status = canvas.getByRole("radiogroup", { name: "Status" });
    await expect(within(status).getByRole("radio", { name: "Closed 1" })).toBeChecked();
    await expect(within(status).getByRole("radio", { name: "All 4" })).not.toBeChecked();
    await expect(canvas.getByRole("radio", { name: "One choice 2" })).toBeChecked();
    await expect(canvas.getByText("1 of 4 polls on this page match.")).toBeVisible();
    await expect(shown(canvasElement)).toEqual([`/polls/${CLOSED}`]);
    // The form and every link keep this page and these filters.
    const form = canvasElement.querySelector("form:not([role=search]):has(input[name=status])");
    await expect(form?.querySelector("input[type=hidden][name=after]")).toHaveValue(OPEN);
    await expect(canvas.getByRole("link", { name: "Clear filters" })).toHaveAttribute(
      "href",
      `/polls?after=${OPEN}`,
    );
    await expect(canvas.getByRole("link", { name: "More polls" })).toHaveAttribute(
      "href",
      `/polls?after=${NEXT}&status=closed&counting=plurality`,
    );
  },
};

/** What the form sends for a group left at All filters nothing. */
export const AllSent: Story = {
  args: { filters: { status: "all", counting: "approval" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("radio", { name: "All 4", checked: true })).toBeVisible();
    await expect(shown(canvasElement)).toEqual([`/polls/${SCHEDULED}`]);
    await expect(canvas.getByRole("link", { name: "More polls" })).toHaveAttribute(
      "href",
      `/polls?after=${NEXT}&counting=approval`,
    );
  },
};

/** A version-5 poll is counted question by question, and filtered as such. */
export const QuestionByQuestion: Story = {
  args: {
    page: {
      ...LIST,
      polls: [
        ...LIST.polls,
        {
          kind: "poll",
          text: {
            language: "en",
            heading: "Riverside Park improvements",
            question: "Should the park get more lighting?",
            options: ["Yes", "No", "Not sure"],
          },
          answered: undefined,
          tags: NO_TAGS,
          counted: false,
          poll: poll(QUESTIONS, {
            version: 5,
            counting: "questions",
            questions: [
              { optionCount: 3, minSelections: 0, maxSelections: 1 },
              { optionCount: 6, minSelections: 3, maxSelections: 3 },
            ],
          }),
        },
      ],
    },
    filters: { status: undefined, counting: "questions" },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("radio", { name: "Question by question 1" })).toBeChecked();
    await expect(canvas.getByRole("radio", { name: "One choice 2" })).not.toBeChecked();
    await expect(canvas.getByText("1 of 5 polls on this page match.")).toBeVisible();
    await expect(shown(canvasElement)).toEqual([`/polls/${QUESTIONS}`]);
    const row = canvas.getByRole("article", { name: "Riverside Park improvements" });
    await expect(within(row).getByText("Question by question")).toBeVisible();
    await expect(within(row).getByText("Open")).toBeVisible();
  },
};

export const NoMatch: Story = {
  args: { filters: { status: "scheduled", counting: "plurality" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "No polls on this page match" }),
    ).toBeVisible();
    await expect(canvas.getByText(/stays open by its ID/)).toBeVisible();
    await expect(canvas.queryByRole("list", { name: "Listed polls" })).toBeNull();
    await expect(canvas.getAllByRole("link", { name: "Clear filters" })).toHaveLength(2);
  },
};

export const Empty: Story = {
  args: { page: { ...LIST, polls: [], next: undefined, counts: undefined } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("No polls listed.")).toBeVisible();
    // Counts that couldn't be read are left out, not shown as nothing.
    await expect(canvas.queryByText("The list in numbers")).toBeNull();
    await expect(canvas.queryByText("Open now")).toBeNull();
    await expect(canvas.queryByRole("radio")).toBeNull();
    await expect(canvas.queryByRole("link", { name: "More polls" })).toBeNull();
  },
};

/** Text that isn't a poll ID comes back to the form, marked invalid. */
export const InvalidLookup: Story = {
  args: { invalid: "123" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("textbox", { name: "Poll ID" })).toHaveValue("123");
    await expect(canvas.getByRole("alert")).toHaveTextContent("64 hexadecimal characters");
  },
};

/**
 * A search the API ran: the box holds what was typed, the page says it is
 * narrowed without quoting it, and every form and link keeps it but the
 * one that clears it.
 */
export const Searched: Story = {
  args: {
    typed: " Park  library ",
    after: OPEN,
    filters: { q: "Park  library", status: "closed", counting: undefined },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const search = canvas.getByRole("search");
    await expect(within(search).getByRole("searchbox", { name: "Search the polls" })).toHaveValue(
      " Park  library ",
    );
    // A new search starts from the top, keeping the filters.
    await expect(search.querySelector("input[name=after]")).toBeNull();
    await expect(search.querySelector("input[type=hidden][name=status]")).toHaveValue("closed");
    await expect(canvas.getByText(/hold every word you searched for/)).toBeVisible();
    await expect(canvas.queryByText(/Park {2}library/)).toBeNull();
    await expect(canvas.getByRole("link", { name: "Clear the search" })).toHaveAttribute(
      "href",
      "/polls?status=closed",
    );
    const form = canvasElement.querySelector("form:has(input[name=counting])");
    await expect(form?.querySelector("input[type=hidden][name=q]")).toHaveValue("Park  library");
    await expect(canvas.getByRole("link", { name: "Clear filters" })).toHaveAttribute(
      "href",
      `/polls?after=${OPEN}&q=Park%20%20library`,
    );
    await expect(canvas.getByRole("link", { name: "More polls" })).toHaveAttribute(
      "href",
      `/polls?after=${NEXT}&q=Park%20%20library&status=closed`,
    );
  },
};

export const SearchEmpty: Story = {
  args: {
    page: { ...LIST, polls: [], next: undefined },
    typed: "ferries",
    filters: { q: "ferries", status: undefined, counting: undefined },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "No listed poll matches" })).toBeVisible();
    await expect(canvas.queryByText("No polls listed.")).toBeNull();
    await expect(canvas.queryByRole("radio")).toBeNull();
    for (const link of canvas.getAllByRole("link", { name: "Clear the search" }))
      await expect(link).toHaveAttribute("href", "/polls");
  },
};

/** A search the API wouldn't take: said in our words, with the box still holding it. */
export const SearchRefused: Story = {
  args: {
    page: { kind: "search-refused" },
    typed: "w0 w1 w2 w3 w4 w5 w6 w7 w8",
    filters: { q: undefined, status: undefined, counting: undefined },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "That search can't be run" })).toBeVisible();
    await expect(canvas.getByText(/one to 8 words, in at most 200 characters/)).toBeVisible();
    await expect(canvas.getByRole("searchbox", { name: "Search the polls" })).toHaveValue(
      "w0 w1 w2 w3 w4 w5 w6 w7 w8",
    );
    await expect(canvas.queryByRole("radio")).toBeNull();
    await expect(canvas.getByRole("link", { name: "Clear the search" })).toHaveAttribute(
      "href",
      "/polls",
    );
  },
};

/** The register's address puts `after` first, then the search, then each filter in a fixed order. */
export const Addresses: Story = {
  play: async () => {
    await expect(registerHref(undefined, { status: undefined, counting: "all" })).toBe("/polls");
    await expect(registerHref(undefined, { status: "closed", counting: "approval" })).toBe(
      "/polls?status=closed&counting=approval",
    );
    await expect(
      registerHref(NEXT, { q: "café & bar #1", status: undefined, counting: "approval" }),
    ).toBe(`/polls?after=${NEXT}&q=caf%C3%A9%20%26%20bar%20%231&counting=approval`);
  },
};
