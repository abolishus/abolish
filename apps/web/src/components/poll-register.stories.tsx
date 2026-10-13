import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import type { PollView } from "../poll.ts";
import { PollRegister, registerHref } from "./poll-register.tsx";

const poll = (electionId: string, overrides: Partial<PollView> = {}): PollView => ({
  electionId,
  definitionHash: "a4555c67fbc57b7ed42f873f73f36360baba11fa0de1f0ba0f104780a4071750",
  illFormed: undefined,
  electionType: "plurality",
  optionCount: 3,
  minSelections: 0,
  maxSelections: 1,
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

const meta = {
  component: PollRegister,
  args: {
    list: {
      polls: [
        { kind: "poll", poll: poll(OPEN) },
        {
          kind: "poll",
          poll: poll(SCHEDULED, {
            electionType: "approval",
            opensAt: { seconds: "1768435200", iso: "2026-01-15T00:00:00.000Z" },
            closesAt: { seconds: "18446744073709551615", iso: undefined },
          }),
        },
        {
          kind: "poll",
          poll: poll(CLOSED, {
            closesAt: { seconds: "1767484800", iso: "2026-01-04T00:00:00.000Z" },
          }),
        },
        { kind: "unavailable", electionId: UNREADABLE, problem: "another-election" },
      ],
      next: NEXT,
      asOf: { seconds: "1767571200", iso: "2026-01-05T00:00:00.000Z" },
    },
    after: undefined,
    filters: { status: undefined, counting: undefined },
    invalid: undefined,
  },
} satisfies Meta<typeof PollRegister>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The polls the register shows, by the IDs their links name. */
function shown(canvasElement: HTMLElement): (string | null)[] {
  const list = within(canvasElement).getByRole("list", { name: "Listed polls" });
  return within(list)
    .getAllByRole("link")
    .map((a) => a.getAttribute("href"));
}

const play: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("Every listed poll");
  await expect(canvas.getByText(/the election registry on chain names every poll/)).toBeVisible();
  await expect(canvas.getByRole("textbox", { name: "Poll ID" })).toBeVisible();
  // Each poll's status, read from its own times at the page's clock.
  const rows = canvas.getAllByRole("article");
  await expect(rows).toHaveLength(4);
  await expect(within(rows[0]!).getByText("Open")).toBeVisible();
  await expect(rows[0]).toHaveTextContent(/Closes January 8, 2026/);
  await expect(within(rows[1]!).getByText("Scheduled")).toBeVisible();
  await expect(rows[1]).toHaveTextContent(/Opens January 15, 2026/);
  // The status, then when it closed.
  await expect(within(rows[2]!).getAllByText("Closed")).toHaveLength(2);
  await expect(rows[2]).toHaveTextContent(/Closed January 4, 2026/);
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
    const form = canvasElement.querySelector("form:has(input[name=status])");
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
  args: { list: { polls: [], next: undefined, asOf: meta.args.list.asOf } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("No polls listed.")).toBeVisible();
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

/** The register's address puts `after` first and each filter in a fixed order. */
export const Addresses: Story = {
  play: async () => {
    await expect(registerHref(undefined, { status: undefined, counting: "all" })).toBe("/polls");
    await expect(registerHref(undefined, { status: "closed", counting: "approval" })).toBe(
      "/polls?status=closed&counting=approval",
    );
  },
};
