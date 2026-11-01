import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import type { CellResults } from "../results.ts";
import { PollResultsPage } from "./poll-results-page.tsx";
import { ViewerNow, ViewerTimeZone } from "./when.tsx";

const electionId = "101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f";
const head = { treeSize: "1234", chainHead: "1f".repeat(32), root: "2e".repeat(32) };

// Tier 0 in three cells (two large regions and the small ones folded), Tier 2 in one.
const cells: readonly CellResults[] = [
  {
    cell: { tier: 0, members: "5000", regions: [0] },
    counted: 900,
    state: "opened",
    signers: [1, 3],
    questions: [
      ["500", "300", "100"],
      ["450", "450"],
    ],
  },
  {
    cell: { tier: 0, members: "1200", regions: [1] },
    counted: 300,
    state: "opened",
    signers: [2],
    questions: [
      ["180", "120", "0"],
      ["130", "130"],
    ],
  },
  {
    cell: { tier: 0, members: "1020", regions: [2, 3] },
    counted: 34,
    state: "opened",
    signers: [1],
    questions: [
      ["20", "14", "0"],
      ["20", "20"],
    ],
  },
  {
    cell: { tier: 2, members: "120", regions: [0] },
    counted: 40,
    state: "missing",
    signers: [],
    questions: undefined,
  },
];

const definitionHash = "a4555c67fbc57b7ed42f873f73f36360baba11fa0de1f0ba0f104780a4071750";
const opensAt = { seconds: "1767225600", iso: "2026-01-01T00:00:00.000Z" };
const closesAt = { seconds: "1767830400", iso: "2026-01-08T00:00:00.000Z" };

const meta = {
  component: PollResultsPage,
  parameters: { layout: "padded" },
  args: {
    poll: {
      electionId,
      version: 5,
      rolling: false,
      definitionHash,
      counting: "questions",
      questions: [
        { optionCount: 3, minSelections: 0, maxSelections: 1 },
        { optionCount: 2, minSelections: 0, maxSelections: 2 },
      ],
      electorate: [
        { tier: 0, groupSize: "7220" },
        { tier: 2, groupSize: "120" },
      ],
      threshold: 2,
      panelSize: 3,
      opensAt,
      closesAt,
    },
    heading: "Riverside Park",
    results: {
      kind: "read",
      tiers: [
        {
          tier: 0,
          counted: 1234,
          questions: [
            ["700", "434", "100"],
            ["600", "600"],
          ],
        },
        { tier: 2, counted: 40, questions: undefined },
      ],
    },
    cells,
    status: "closed",
    words: {
      language: "en",
      title: "Riverside Park",
      questions: [
        { question: "Should the park stay open late?", options: ["Yes", "No", "Abstain"] },
        { question: "Which days should the café open?", options: ["Saturdays", "Sundays"] },
      ],
    },
    phoneVerification: false,
    head,
  },
  // A visitor on New York's clock the day after the close, so the facts'
  // times, drawn on the visitor's clock, don't depend on the machine
  // drawing the story or when.
  decorators: [
    (Story) => (
      <ViewerTimeZone.Provider value="America/New_York">
        <ViewerNow.Provider value={() => new Date("2026-01-09T12:00:00.000Z")}>
          <Story />
        </ViewerNow.Provider>
      </ViewerTimeZone.Provider>
    ),
  ],
} satisfies Meta<typeof PollResultsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A tab per tier, its sentences and bars first, then its cells; the tiers
 * side by side with no total column; and the way to check them (T-16, T-34).
 */
const play: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("Riverside Park");
  // Closed with a tier still unpublished: closed, not counted.
  await expect(canvas.getByText("Closed")).toBeVisible();
  await expect(canvas.queryByText("Counted")).toBeNull();
  // The poll's facts, as its own page states them.
  const facts = canvas.getAllByRole("definition");
  await expect(facts[0]).toHaveTextContent("Tier 0 (verified e-mail)Tier 2 (document-verified)");
  await expect(facts[3]).toHaveTextContent("2 questions, 5 options");
  // Before any figure, the page says whose word it is and links down to checking it (T-34).
  await expect(canvas.getByText(/^Everything below is what our server says/)).toBeVisible();
  const upFront = canvas.getByRole("link", { name: "How to check it yourself" });
  await expect(upFront).toHaveAttribute("href", "#results-check-title");
  await expect(canvasElement.querySelector("#results-check-title")).toHaveTextContent(
    "Check it yourself",
  );
  const tabs = canvas.getByRole("tablist", { name: "Results by group" });
  const tier0 = within(tabs).getByRole("tab", { name: /Tier 0 \(verified e-mail\)/ });
  await expect(tier0).toHaveAttribute("aria-selected", "true");
  await expect(tier0).toHaveTextContent("1,234 people answered");
  const panel = within(canvas.getByRole("tabpanel"));
  // How many of the tier's own members answered, never a figure across tiers (T-16).
  await expect(panel.getByText("Turnout")).toBeVisible();
  await expect(panel.getByText("17.1% of 7,220 members")).toBeVisible();
  await expect(panel.getByText("Most picked: ⁨Yes⁩, by 56.7% of those who answered.")).toBeVisible();
  // Each cell on its own, with its regions and members.
  await expect(panel.getByRole("heading", { name: "Part by part" })).toBeVisible();
  await expect(panel.getAllByText("region 3 and region 4 · 1,020 members")).toHaveLength(2);
  await expect(panel.getAllByRole("table")).toHaveLength(2);

  // The tiers side by side, never added together.
  const side = within(canvas.getByRole("region", { name: "The groups side by side" }));
  await expect(side.getAllByRole("table")).toHaveLength(2);
  await expect(side.getAllByText("Not all published yet")).toHaveLength(2);
  // Each column headed by its own tier's turnout, in every question's table.
  await expect(side.getAllByText("Turnout: 17.1% of 7,220 members")).toHaveLength(2);
  await expect(side.getAllByText("Turnout: 33.3% of 120 members")).toHaveLength(2);
  await expect(
    side.getAllByText(
      "One column per group. There is no total column: the groups are never added together.",
      { exact: false },
    ),
  ).toHaveLength(2);

  // Another tier is a tap away; it has no counts yet and one cell, so no parts.
  await userEvent.click(within(tabs).getByRole("tab", { name: /Tier 2/ }));
  await waitFor(() =>
    expect(within(canvas.getByRole("tabpanel")).getByRole("status")).toHaveTextContent(
      /isn't published yet/,
    ),
  );
  await expect(within(canvas.getByRole("tabpanel")).queryByText("Part by part")).toBeNull();
  // Its turnout stands while its counts wait: how many answered is already known.
  await expect(
    within(canvas.getByRole("tabpanel")).getByText("33.3% of 120 members"),
  ).toBeVisible();

  // Who opened each part, by seat, out of the panel's three; one not opened yet.
  const openings = within(canvas.getByRole("region", { name: "Who opened the count" }));
  await expect(
    openings.getByText(/opened by one of this poll's 3 trustee seats, once at least 2/),
  ).toBeVisible();
  const rows = openings.getAllByRole("row").slice(1);
  await expect(rows.map((r) => r.textContent)).toEqual([
    "Tier 0 (verified e-mail) · Part 1Seats 1 and 3",
    "Tier 0 (verified e-mail) · Part 2Seat 2",
    "Tier 0 (verified e-mail) · Part 3Seat 1",
    "Tier 2 (document-verified)Not published yet",
  ]);

  // The board's head as our server claims it, as the poll page states it (T-34).
  const board = within(canvas.getByRole("region", { name: "What the board holds" }));
  await expect(board.getByText(/^Entries/)).toHaveTextContent("Entries: 1,234");
  await expect(
    board.getByRole("img", { name: "Fingerprint of the chain head 1f1f1f1f" }),
  ).toBeVisible();
  await expect(board.getByRole("figure", { name: "Chain head" })).toHaveTextContent(head.chainHead);
  await expect(board.getByRole("figure", { name: "Tree root" })).toHaveTextContent(head.root);
  await expect(board.getByText(/only this server's word/)).toBeVisible();

  // What a recount starts from, with the ways to check it.
  const check = within(canvas.getByRole("region", { name: "Check it yourself" }));
  await expect(check.getByRole("figure", { name: "Poll ID" })).toHaveTextContent(electionId);
  await expect(check.getByRole("figure", { name: /^Definition hash/ })).toHaveTextContent(
    definitionHash,
  );
  // Where the voter's receipt is, and that this page never looks one up (T-11).
  await expect(check.getByRole("heading", { name: "Your receipt" })).toBeVisible();
  await expect(
    check.getByText(/kept by the ballot app on the device you answered from/),
  ).toBeVisible();
  await expect(check.getByText(/doesn't look a receipt up/)).toBeVisible();
  // The verifier's command for this poll alone, its ID filled in.
  await expect(check.getByRole("heading", { name: "Count this poll again" })).toBeVisible();
  await expect(check.getByLabelText("Count this poll again")).toHaveTextContent(
    `vp node packages/verifier/src/bin.ts --gateway $GATEWAY reports/${electionId}`,
  );
  await expect(check.getByText(/don't anchor boards to Ethereum yet/)).toBeVisible();
  await expect(canvas.getByRole("link", { name: "Check the count on the board" })).toHaveAttribute(
    "href",
    `/polls/${electionId}/board`,
  );
  await expect(canvas.getByRole("link", { name: "How to count it yourself" })).toHaveAttribute(
    "href",
    "/verify",
  );
  await expect(canvas.getByRole("link", { name: "Back to the poll" })).toHaveAttribute(
    "href",
    `/polls/${electionId}`,
  );
};

export const Default: Story = { play };

export const Dark: Story = { parameters: { theme: "dark" }, play };

/** A hidden poll's results, by number: its words are withheld, its count never is. */
export const ByNumber: Story = {
  args: {
    poll: {
      electionId,
      version: 1,
      rolling: false,
      definitionHash,
      counting: "plurality",
      questions: [{ optionCount: 3, minSelections: 0, maxSelections: 1 }],
      electorate: [{ tier: 0, groupSize: "50" }],
      threshold: 1,
      panelSize: 1,
      opensAt,
      closesAt,
    },
    heading: undefined,
    results: { kind: "read", tiers: [{ tier: 0, counted: 3, questions: [["0", "3", "0"]] }] },
    cells: [
      {
        cell: { tier: 0, members: "50", regions: undefined },
        counted: 3,
        state: "opened",
        questions: [["0", "3", "0"]],
        signers: [1],
      },
    ],
    words: undefined,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Poll 1011121314151617…",
    );
    await expect(
      canvas.getByText("Most picked: ⁨Answer 2⁩, by 100% of those who answered."),
    ).toBeVisible();
    await expect(canvas.getByText("6% of 50 members")).toBeVisible();
    // Closed with its one tier read: counted.
    await expect(canvas.getByText("Counted")).toBeVisible();
    await expect(canvas.getAllByRole("definition")[3]).toHaveTextContent("One choice3 options");
    // One tier: nothing to set side by side; one cell: no parts.
    await expect(canvas.queryByRole("region", { name: "The groups side by side" })).toBeNull();
    await expect(canvas.queryByText("Part by part")).toBeNull();
  },
};

/** More ballots claimed than the tier has members: no share past 100% is printed (T-34). */
export const TurnoutUnstated: Story = {
  args: {
    poll: {
      ...meta.args.poll,
      electorate: [
        { tier: 0, groupSize: "1000" },
        { tier: 2, groupSize: "120" },
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const panel = within(within(canvasElement).getByRole("tabpanel"));
    await expect(panel.queryByText("Turnout")).toBeNull();
    // Nor in its column side by side, while the other tier's still stands.
    const side = within(
      within(canvasElement).getByRole("region", { name: "The groups side by side" }),
    );
    await expect(side.queryByText(/^Turnout: .* of 1,000 members$/)).toBeNull();
    await expect(side.getAllByText("Turnout: 33.3% of 120 members")).toHaveLength(2);
    await expect(
      panel.getByText("Most picked: ⁨Yes⁩, by 56.7% of those who answered."),
    ).toBeVisible();
  },
};

/**
 * A rolling poll's results before our server has read the close: no
 * turnout, since its definition names each tier's members at the opening
 * only and whoever joined by the close could answer too
 * ([[0028-rolling-electorates]]).
 */
export const Rolling: Story = {
  args: { poll: { ...meta.args.poll, version: 7, rolling: true } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByText("Open to new identities until it closes")[0]).toBeVisible();
    const panel = within(canvas.getByRole("tabpanel"));
    await expect(panel.queryByText("Turnout")).toBeNull();
    await expect(canvas.queryByText(/^Turnout: /)).toBeNull();
  },
};

/**
 * A rolling poll's results with each tier's count at the close: its turnout
 * is a share of who could answer by then, never of its members at the
 * opening ([[0028-rolling-electorates]]).
 */
export const RollingAtClose: Story = {
  args: {
    poll: { ...meta.args.poll, version: 7, rolling: true },
    results: {
      kind: "read",
      tiers: [
        {
          tier: 0,
          counted: 1234,
          questions: [
            ["700", "434", "100"],
            ["600", "600"],
          ],
          couldAnswer: 8000,
        },
        { tier: 2, counted: 40, questions: undefined, couldAnswer: 150 },
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = within(canvas.getByRole("tabpanel"));
    await expect(panel.getByText("Turnout")).toBeVisible();
    await expect(
      panel.getByText("15.4% of 8,000 people who could answer by the close"),
    ).toBeVisible();
    // Never a share of the 7,220 members at the opening.
    await expect(canvas.queryByText(/of 7,220/)).toBeNull();
    const side = within(canvas.getByRole("region", { name: "The groups side by side" }));
    await expect(
      side.getAllByText("Turnout: 26.7% of 150 people who could answer by the close"),
    ).toHaveLength(2);
  },
};

/**
 * A rolling poll whose Tier 2 so few could answer that the verifier flags
 * the count: the results stand, in the tier's panel and the side-by-side
 * header, saying what so few can reveal (verifier 8.2; T-16).
 */
export const RollingFewCouldAnswer: Story = {
  args: {
    poll: { ...meta.args.poll, version: 7, rolling: true },
    results: {
      kind: "read",
      tiers: [
        {
          tier: 0,
          counted: 1234,
          questions: [
            ["700", "434", "100"],
            ["600", "600"],
          ],
          couldAnswer: 8000,
        },
        {
          tier: 2,
          counted: 12,
          questions: [
            ["6", "4", "2"],
            ["7", "5"],
          ],
          couldAnswer: 15,
          fewCouldAnswer: true,
        },
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Tier 0's panel is open first, and isn't flagged.
    await expect(canvas.queryByText(/So few could answer/)).toBeNull();
    const side = within(canvas.getByRole("region", { name: "The groups side by side" }));
    await expect(side.getAllByText("Few could answer")).toHaveLength(2);
    await userEvent.click(canvas.getByRole("tab", { name: /Tier 2/ }));
    await waitFor(() =>
      expect(
        within(canvas.getByRole("tabpanel")).getByText(
          "So few could answer that these results can show how some of them answered.",
        ),
      ).toBeVisible(),
    );
  },
};

/** A cell whose openings failed the board's check, beside one not yet opened and one no seat signed. */
export const CellFailed: Story = {
  args: {
    results: {
      kind: "read",
      tiers: [{ tier: 0, counted: 1234, questions: undefined }],
    },
    cells: [
      { ...cells[0]!, signers: [] },
      { ...cells[1]!, state: "failed", questions: undefined },
      { ...cells[2]!, state: "missing", questions: undefined, signers: [] },
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = within(canvas.getByRole("tabpanel"));
    await expect(panel.getAllByText("Didn't pass the board's check")).toHaveLength(2);
    await expect(panel.getAllByText("Not published yet")).toHaveLength(2);
    // A failed part names no seat, even one whose opening passed; an opening
    // no checked signature names says so.
    const openings = within(canvas.getByRole("region", { name: "Who opened the count" }));
    await expect(openings.getByText("Didn't pass the board's check")).toBeVisible();
    await expect(openings.getByText("Not published yet")).toBeVisible();
    await expect(openings.getByText("No seat's signature on it checks")).toBeVisible();
  },
};

/** Cells that don't add up to their tier: the tier's results stand, the cells aren't shown. */
export const CellsUnavailable: Story = {
  args: { cells: undefined },
  play: async ({ canvasElement }) => {
    const panel = within(within(canvasElement).getByRole("tabpanel"));
    await expect(panel.getByText("This group's parts couldn't be shown just now.")).toBeVisible();
    await expect(
      panel.getByText("Most picked: ⁨Yes⁩, by 56.7% of those who answered."),
    ).toBeVisible();
  },
};

/** Open, nothing counted yet. */
export const Sealed: Story = {
  args: { results: { kind: "unopened" }, status: "open" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "Answers stay sealed while the poll is open.",
    );
    await expect(canvas.getByText("Open for answers")).toBeVisible();
    await expect(canvas.queryByRole("tablist")).toBeNull();
    await expect(canvas.queryByRole("region", { name: "Who opened the count" })).toBeNull();
  },
};

/** Closed, its count not published yet. */
export const Counting: Story = {
  args: { results: { kind: "unopened" } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("status")).toHaveTextContent(
      "The results appear here once its answers are counted.",
    );
  },
};

/** This server counts no results of the poll; the board can still be counted. */
export const NotCounted: Story = {
  args: { results: { kind: "not-counted" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("status")).toHaveTextContent(
      /doesn't publish this poll's results/,
    );
    await expect(canvas.getByRole("link", { name: "Check the count on the board" })).toBeVisible();
  },
};

/** An empty board says so, and never shows its all-zero head as if it were one. */
export const BoardEmpty: Story = {
  args: { head: { treeSize: "0", chainHead: "00".repeat(32), root: "00".repeat(32) } },
  play: async ({ canvasElement }) => {
    const board = within(
      within(canvasElement).getByRole("region", { name: "What the board holds" }),
    );
    await expect(board.getByText("No entries yet.")).toBeVisible();
    await expect(board.queryByRole("figure")).toBeNull();
  },
};

/** A failed read of the board's head leaves the results up and says so. */
export const BoardUnavailable: Story = {
  args: { head: undefined },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const board = within(canvas.getByRole("region", { name: "What the board holds" }));
    await expect(board.getByRole("status")).toHaveTextContent(
      "The board couldn't be read just now.",
    );
    await expect(board.queryByRole("figure")).toBeNull();
    await expect(canvas.getByRole("tablist", { name: "Results by group" })).toBeVisible();
  },
};
