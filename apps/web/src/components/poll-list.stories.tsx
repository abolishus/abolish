import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import type { PollView } from "../poll.ts";
import { PollList } from "./poll-list.tsx";

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

const FIRST = "10".repeat(32);
const SECOND = "20".repeat(32);
const THIRD = "30".repeat(32);
const FOURTH = "40".repeat(32);

const meta = {
  component: PollList,
  args: {
    list: {
      polls: [
        { kind: "poll", poll: poll(FIRST) },
        {
          kind: "poll",
          poll: poll(SECOND, {
            electionType: "approval",
            illFormed: "timing",
            closesAt: { seconds: "18446744073709551615", iso: undefined },
          }),
        },
        { kind: "unavailable", electionId: THIRD, problem: "undecodable" },
      ],
      next: FOURTH,
    },
  },
} satisfies Meta<typeof PollList>;

export default meta;
type Story = StoryObj<typeof meta>;

const play: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { name: "Listed polls" })).toBeVisible();
  const items = canvas.getAllByRole("listitem");
  await expect(items).toHaveLength(3);
  await expect(within(items[0]!).getByRole("link")).toHaveAttribute("href", `/polls/${FIRST}`);
  await expect(within(items[0]!).getByText("One choice")).toBeVisible();
  await expect(within(items[0]!).getByText(/January 8, 2026/)).toBeVisible();
  // An ill-formed definition is flagged, and an instant past `Date` shown as seconds.
  await expect(within(items[1]!).getByText(/verifier fails it/)).toBeVisible();
  await expect(within(items[1]!).getByText("18446744073709551615")).toBeVisible();
  // A definition that doesn't decode is still linked, with nothing shown from it.
  await expect(within(items[2]!).getByRole("link")).toHaveAttribute("href", `/polls/${THIRD}`);
  await expect(within(items[2]!).getByText(/doesn't decode/)).toBeVisible();
  await expect(canvas.getByRole("link", { name: "More polls" })).toHaveAttribute(
    "href",
    `/polls?after=${FOURTH}`,
  );
};

export const Default: Story = { play };

export const Dark: Story = { parameters: { theme: "dark" }, play };

export const Empty: Story = {
  args: { list: { polls: [], next: undefined } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("No polls listed.")).toBeVisible();
    await expect(canvas.queryByRole("list")).toBeNull();
    await expect(canvas.queryByRole("link", { name: "More polls" })).toBeNull();
  },
};
