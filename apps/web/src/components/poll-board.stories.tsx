import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import type { AnchorRow, BoardRow, EntryKind } from "../board.ts";
import type { CeremonyView } from "../ceremony.ts";
import type { PollView } from "../poll.ts";
import { PollBoard } from "./poll-board.tsx";

const poll: PollView = {
  electionId: "101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f",
  definitionHash: "a4555c67fbc57b7ed42f873f73f36360baba11fa0de1f0ba0f104780a4071750",
  version: 1,
  illFormed: undefined,
  rolling: false,
  pollClass: "everyday",
  counting: "plurality",
  questions: [{ optionCount: 3, minSelections: 0, maxSelections: 1 }],
  electorate: [{ tier: 0, groupSize: "5000" }],
  threshold: 4,
  panelSize: 7,
  opensAt: { seconds: "1767225600", iso: "2026-01-01T00:00:00.000Z" },
  closesAt: { seconds: "1767830400", iso: "2026-01-08T00:00:00.000Z" },
};

const head = { treeSize: "100", chainHead: "1f".repeat(32), root: "2e".repeat(32) };

const KINDS: readonly EntryKind[] = [
  "ballot",
  "ballot",
  "spoiled-opening",
  "ballot",
  "share-receipt",
];

/** Entries 25 to 49: the second page of a board of 100. */
const rows: BoardRow[] = Array.from({ length: 25 }, (_, i) => ({
  index: String(25 + i),
  segment: 3 + Math.floor(i / 10),
  kind: KINDS[i % KINDS.length]!,
  hash: (25 + i).toString(16).padStart(2, "0").repeat(32),
}));

/** Every checkpoint of the board, from period 8 back to its first, fewer than the page asks for. */
const anchors: AnchorRow[] = Array.from({ length: 9 }, (_, i) => ({
  segment: 8 - i,
  size: String(100 - 10 * i),
  head: (0x40 + i).toString(16).repeat(32),
  root: (0x50 + i).toString(16).repeat(32),
  hash: (0x60 + i).toString(16).repeat(32),
}));

const base = `/polls/${poll.electionId}/board`;

const meta = {
  component: PollBoard,
  args: {
    poll,
    head,
    from: "25",
    rows,
    kind: undefined,
    inclusion: { checked: 25, outside: undefined },
    ceremony: undefined,
    pageSize: 25,
    anchors,
    histories: { head: true, anchors: [true, true, true, true, true] },
    activityPage: 24,
    anchorPage: 6,
  },
} satisfies Meta<typeof PollBoard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("The poll's board");
    await expect(canvas.getByText("Poll 1011121314151617… · Public board")).toBeVisible();
    await expect(canvas.getByRole("figure", { name: "Chain head" })).toBeVisible();
    await expect(canvas.getByText(/with the same head hold the same 100 entries\.$/)).toBeVisible();
    await expect(canvas.getByText(/they are only this server's word/)).toBeVisible();
    const table = canvas.getByRole("table", { name: "Entries 25 to 49 of 100" });
    await expect(within(table).getAllByRole("row")).toHaveLength(26);
    await expect(canvas.getByRole("img", { name: "Fingerprint of entry 25" })).toBeVisible();
    await expect(within(table).getAllByText("Trustee receipt")).toHaveLength(5);
    await expect(
      canvas.getByText(/^The 25 entries on this page that the tree root above covers are each/),
    ).toBeVisible();
    // The kind filter offers only the kinds on this page, each with its count, All chosen.
    const kinds = canvas.getByRole("radiogroup", { name: "Kind" });
    const options = within(kinds).getAllByRole("radio");
    await expect(options.map((o) => (o as HTMLInputElement).value)).toEqual([
      "all",
      "ballot",
      "spoiled-opening",
      "share-receipt",
    ]);
    await expect(options[0]).toBeChecked();
    await expect(within(kinds).getByText("Sealed ballot").closest("label")).toHaveTextContent(
      /Sealed ballot\s*15$/,
    );
    await expect(options[0]!.closest("form")).toHaveAttribute("action", base);
    await expect(canvasElement.querySelector('input[type="hidden"][name="from"]')).toHaveValue(
      "25",
    );
    await expect(canvas.queryByText(/entries on this page are of this kind/)).toBeNull();
    await expect(canvas.queryByRole("link", { name: "Clear filters" })).toBeNull();
    await expect(canvas.getByRole("link", { name: "Earlier entries" })).toHaveAttribute(
      "href",
      `${base}?from=0`,
    );
    await expect(canvas.getByRole("link", { name: "Later entries" })).toHaveAttribute(
      "href",
      `${base}?from=50`,
    );
    await expect(canvas.getByRole("link", { name: "Latest entries" })).toHaveAttribute(
      "href",
      `${base}?from=75`,
    );
    // Never a lookup by entry number (T-10).
    await expect(canvas.queryByRole("textbox")).toBeNull();
    await expect(canvas.getByText(/doesn't look up a receipt's entry/)).toBeVisible();
    const list = canvas.getByRole("list", { name: "Checkpoints, latest first" });
    const items = within(list).getAllByRole("listitem");
    await expect(items).toHaveLength(6);
    await expect(within(items[0]!).getByRole("heading", { level: 3 })).toHaveTextContent(
      "After period 8",
    );
    await expect(within(items[0]!).getByText("Latest")).toBeVisible();
    await expect(within(items[1]!).queryByText("Latest")).toBeNull();
    // Each checkpoint's size as a bar against the latest's, drawn as SVG geometry, not an inline width.
    await expect(
      items.map((item) => item.querySelector("svg rect:last-child")?.getAttribute("width")),
    ).toEqual(["100", "90", "80", "70", "60", "50"]);
    await expect(
      canvas.getByRole("img", { name: "Fingerprint of the checkpoint after period 8" }),
    ).toBeVisible();
    await expect(
      within(items[5]!).getByRole("figure", { name: "Checkpoint hash, the value to anchor" }),
    ).toHaveTextContent("65".repeat(32));
    await expect(canvas.getByText(/doesn't check that any of them is anchored/)).toBeVisible();
    // Each consistency proof's verdict beside what it checked (T-24).
    await expect(
      canvas.getByText(/^The tree root above and the latest checkpoint's are one history/),
    ).toBeVisible();
    await expect(
      within(items[0]!).getByText(/^Extends the checkpoint after period 7:/),
    ).toBeVisible();
    await expect(
      within(items[4]!).getByText(/^Extends the checkpoint after period 3:/),
    ).toBeVisible();
    // The last one shown has no earlier one shown to extend.
    await expect(within(items[5]!).queryByText(/^Extends/)).toBeNull();
    await expect(canvasElement.querySelectorAll('[data-history="broken"]')).toHaveLength(0);
    // More than the anchors show.
    await expect(canvas.getByText(/Only the latest 6 checkpoints/)).toBeVisible();
    // Activity: one bar per checkpointed period, the first one's count its whole size.
    await expect(
      canvas.getByRole("img", {
        name: "Entries per period, periods 0 to 8: 100 entries in all. Every period is in the table below.",
      }),
    ).toBeVisible();
    await expect(canvasElement.querySelectorAll("rect.fill-primary")).toHaveLength(9);
    const counts = canvas.getByRole("table", {
      name: "Entries added in each period, earliest first",
    });
    await expect(counts.closest("details")).not.toHaveAttribute("open");
    await userEvent.click(canvas.getByText("The count for each period"));
    await expect(counts).toBeVisible();
    const lines = within(counts).getAllByRole("row");
    await expect(lines).toHaveLength(10);
    await expect(lines[1]).toHaveTextContent(/^0\s*20$/);
    await expect(lines[9]).toHaveTextContent(/^8\s*10$/);
    // Heights are attributes, never inline styles (style-src 'self').
    await expect(canvasElement.querySelector("svg [style]")).toBeNull();
    // The ceremony is read only on the page holding the board's first entry, so this one links there.
    await expect(
      canvas.getByText(/^The ceremony's record is the board's first entry\./),
    ).toBeVisible();
    await expect(canvas.getByRole("link", { name: "See it on the first page" })).toHaveAttribute(
      "href",
      `${base}?from=0#ceremony-title`,
    );
    await expect(canvas.queryByRole("list", { name: "Trustee seats, in order" })).toBeNull();
  },
};

/** Entries 0 to 24, the first page, the ceremony's record first. */
const firstRows: BoardRow[] = rows.map((row, i) => ({
  ...row,
  index: String(i),
  segment: Math.floor(i / 10),
  kind: i === 0 ? "ceremony" : row.kind,
}));

const transcript: CeremonyView = {
  kind: "transcript",
  hash: "c3".repeat(32),
  committed: true,
  // Seat 7 sent its keys, challenges and answers, but no reveals.
  seats: Array.from({ length: 7 }, (_, i) => ({ index: i + 1, rounds: i === 6 ? 3 : 4 })),
};

/**
 * The first page: the ceremony's record, read from its first entry, is the
 * one the definition commits to, with each seat's rounds. Which seats
 * qualified is left to the verifier, and the launch panel is said beside them.
 */
export const Ceremony: Story = {
  args: { from: "0", rows: firstRows, ceremony: transcript },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "How the poll's key was made" }),
    ).toBeVisible();
    await expect(
      canvas.getByText(/^This is the record the poll's definition commits to/),
    ).toBeVisible();
    await expect(
      canvas.getByRole("figure", { name: "Ceremony record hash, computed here" }),
    ).toHaveTextContent("c3".repeat(32));
    await expect(
      canvas.getByRole("img", { name: "Fingerprint of the key ceremony's record" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("heading", { name: "Seats that sent all four rounds: 6 of 7" }),
    ).toBeVisible();
    const seats = within(
      canvas.getByRole("list", { name: "Trustee seats, in order" }),
    ).getAllByRole("listitem");
    await expect(seats).toHaveLength(7);
    await expect(seats[0]).toHaveTextContent(/^Seat 1\s*All four rounds$/);
    await expect(seats[6]).toHaveTextContent(/^Seat 7\s*3 of the four rounds$/);
    await expect(canvas.getByText(/It doesn't check the proofs in it/)).toBeVisible();
    await expect(canvas.getByRole("link", { name: "Who holds the keys" })).toHaveAttribute(
      "href",
      "/trustees",
    );
    await expect(canvas.queryByRole("link", { name: "See it on the first page" })).toBeNull();
    await expect(canvasElement.querySelectorAll('[data-history="broken"]')).toHaveLength(0);
  },
};

/** A record on the board that isn't the one the definition commits to: evidence, and said so (T-34). */
export const CeremonyNotCommitted: Story = {
  args: { from: "0", rows: firstRows, ceremony: { ...transcript, committed: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const verdict = canvas.getByText(/^This isn't the record the poll's definition commits to/);
    await expect(verdict.closest("[data-history]")).toHaveAttribute("data-history", "broken");
    await expect(canvas.getByRole("list", { name: "Trustee seats, in order" })).toBeVisible();
  },
};

/** A board whose first entry is another kind of record. */
export const CeremonyMissing: Story = {
  args: { from: "0", rows: firstRows, ceremony: { kind: "missing" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText(/^The board's first entry isn't a ceremony record/),
    ).toBeVisible();
    await expect(canvas.queryByRole("list", { name: "Trustee seats, in order" })).toBeNull();
  },
};

/** A first entry that is a ceremony record this page can't decode. */
export const CeremonyUndecodable: Story = {
  args: { from: "0", rows: firstRows, ceremony: { kind: "undecodable" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText(/^The board's first entry doesn't decode as a ceremony record/),
    ).toBeVisible();
    await expect(canvas.queryByRole("figure", { name: /Ceremony record hash/ })).toBeNull();
  },
};

/**
 * One kind chosen: only this page's entries of that kind show, and every
 * page link keeps the filter. The page is the same 25 entries, so the
 * caption still names them all.
 */
export const KindChosen: Story = {
  args: { kind: "spoiled-opening" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const table = canvas.getByRole("table", { name: "Entries 25 to 49 of 100" });
    await expect(within(table).getAllByRole("row")).toHaveLength(6);
    await expect(within(table).getAllByText("Spoiled ballot, opened")).toHaveLength(5);
    await expect(within(table).queryByText("Sealed ballot")).toBeNull();
    await expect(
      canvas.getByText("5 of the 25 entries on this page are of this kind."),
    ).toBeVisible();
    await expect(
      within(canvas.getByRole("radiogroup", { name: "Kind" })).getByRole("radio", {
        name: /^Spoiled ballot, opened/,
      }),
    ).toBeChecked();
    await expect(canvas.getByRole("link", { name: "Earlier entries" })).toHaveAttribute(
      "href",
      `${base}?from=0&kind=spoiled-opening`,
    );
    await expect(canvas.getByRole("link", { name: "Later entries" })).toHaveAttribute(
      "href",
      `${base}?from=50&kind=spoiled-opening`,
    );
    await expect(canvas.getByRole("link", { name: "Clear filters" })).toHaveAttribute(
      "href",
      `${base}?from=25`,
    );
  },
};

/** A kind with no entry on this page: it stays offered, at 0, and the page says so. */
export const KindNone: Story = {
  args: { kind: "destruction" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("table", { name: /^Entries \d/ })).toBeNull();
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "No entries on this page are of this kind. Earlier or later pages may have some.",
    );
    const chosen = within(canvas.getByRole("radiogroup", { name: "Kind" })).getByRole("radio", {
      name: /^Key destroyed/,
    });
    await expect(chosen).toBeChecked();
    await expect(chosen.closest("label")).toHaveTextContent(/Key destroyed\s*0$/);
    await expect(canvas.getByRole("link", { name: "Later entries" })).toHaveAttribute(
      "href",
      `${base}?from=50&kind=destruction`,
    );
  },
};

/**
 * As many checkpoints as the page asked for: the one before the earliest is
 * unknown, so that period has no count.
 */
export const ActivityCut: Story = {
  args: { activityPage: 9 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("img", { name: /^Entries per period, periods 1 to 8: 80 entries in all/ }),
    ).toBeVisible();
    await expect(canvasElement.querySelectorAll("rect.fill-primary")).toHaveLength(8);
  },
};

/**
 * Consistency proofs that fail: the head and the latest checkpoint, and the
 * second checkpoint and the third, are two histories. Both say so, as
 * evidence, and the page shows everything else as before (T-24).
 */
export const HistoriesBroken: Story = {
  args: { histories: { head: false, anchors: [true, false, true, true, true] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText(/^The tree root above and the latest checkpoint's are not one history/),
    ).toBeVisible();
    const items = within(
      canvas.getByRole("list", { name: "Checkpoints, latest first" }),
    ).getAllByRole("listitem");
    await expect(
      within(items[0]!).getByText(/^Extends the checkpoint after period 7:/),
    ).toBeVisible();
    await expect(
      within(items[1]!).getByText(
        /^Doesn't extend the checkpoint after period 6:.*evidence of tampering\.$/,
      ),
    ).toBeVisible();
    await expect(canvasElement.querySelectorAll('[data-history="broken"]')).toHaveLength(2);
    await expect(canvas.getByRole("table", { name: "Entries 25 to 49 of 100" })).toBeVisible();
  },
};

/** Fewer checkpoints than the page asks for: the first is among them. */
export const FewAnchors: Story = {
  args: { anchors: anchors.slice(7), histories: { head: true, anchors: [true] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = canvas.getByRole("list", { name: "Checkpoints, latest first" });
    await expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    await expect(canvas.queryByText(/Only the latest/)).toBeNull();
  },
};

/** No period has ended since the first entry: nothing to anchor yet. */
export const NoAnchors: Story = {
  args: { anchors: [], histories: { head: undefined, anchors: [] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const [activity, checkpoints] = canvas.getAllByRole("status");
    await expect(activity).toHaveTextContent(/^No period's entries can be counted yet/);
    await expect(checkpoints).toHaveTextContent("No checkpoint has been taken of this board yet.");
    await expect(canvas.queryByRole("list", { name: "Checkpoints, latest first" })).toBeNull();
    await expect(canvas.queryByRole("img", { name: /^Entries per period/ })).toBeNull();
    await expect(canvas.queryByText(/one history/)).toBeNull();
  },
};

/** Checkpoints the page refused: none shown, and the entries still are. */
export const AnchorsRefused: Story = {
  args: { anchors: undefined, histories: undefined },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const [activity, checkpoints] = canvas.getAllByRole("status");
    await expect(activity).toHaveTextContent(/^Without checkpoints that check/);
    await expect(checkpoints).toHaveTextContent(/checkpoints for this board that/);
    await expect(canvas.queryByRole("img", { name: /^Entries per period/ })).toBeNull();
    await expect(canvas.queryByRole("list", { name: "Checkpoints, latest first" })).toBeNull();
    await expect(canvas.queryByText(/Only the latest/)).toBeNull();
    await expect(canvas.queryByText(/one history/)).toBeNull();
    await expect(canvas.getByRole("table", { name: "Entries 25 to 49 of 100" })).toBeVisible();
  },
};

/**
 * An entry whose inclusion proof fails: the page shows it outside the tree
 * the head's root commits to, and says so as evidence, beside the ledger it
 * still shows (T-23, T-24).
 */
export const OutsideTree: Story = {
  args: { inclusion: { checked: 25, outside: "31" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText(
        /^Entry 31 isn't in the tree whose root is above:.*evidence of tampering\.$/,
      ),
    ).toBeVisible();
    await expect(canvas.queryByText(/that the tree root above covers/)).toBeNull();
    await expect(canvas.getByRole("table", { name: "Entries 25 to 49 of 100" })).toBeVisible();
    await expect(canvasElement.querySelectorAll('[data-history="broken"]')).toHaveLength(1);
  },
};

/** Past the end of the board: no rows, and the way back. */
export const Beyond: Story = {
  args: { from: "125", rows: undefined, inclusion: undefined },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "The board has 100 entries, numbered from 0, so there is no entry 125 yet.",
    );
    await expect(canvas.queryByRole("table", { name: /^Entries \d/ })).toBeNull();
    await expect(canvas.queryByRole("link", { name: "Later entries" })).toBeNull();
    await expect(canvas.getByRole("link", { name: "Earlier entries" })).toHaveAttribute(
      "href",
      `${base}?from=75`,
    );
    await expect(canvas.queryByRole("link", { name: "Latest entries" })).toBeNull();
  },
};

/** A board with nothing on it yet. */
export const Empty: Story = {
  args: {
    head: { treeSize: "0", chainHead: "00".repeat(32), root: "00".repeat(32) },
    from: "0",
    rows: [],
    inclusion: { checked: 0, outside: undefined },
    anchors: [],
    histories: { head: undefined, anchors: [] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByText("No entries yet.")).toHaveLength(2);
    await expect(canvas.getByText(/^No period's entries can be counted yet/)).toBeVisible();
    await expect(canvas.queryByRole("figure", { name: "Chain head" })).toBeNull();
    await expect(canvas.queryByText(/with the same head hold the same/)).toBeNull();
    await expect(
      canvas.getByText(/^The board holds no entries yet, so the ceremony's/),
    ).toBeVisible();
    // Nowhere to go: no empty list of pages either.
    await expect(canvas.queryByRole("navigation", { name: "Pages of the board" })).toBeNull();
  },
};
