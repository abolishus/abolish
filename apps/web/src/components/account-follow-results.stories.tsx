import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import {
  type FollowedPoll,
  type FollowResultsClient,
  FollowResultsError,
} from "../account/follow-results.ts";
import { AccountFollowResults } from "./account-follow-results.tsx";

const id = (n: number) => n.toString(16).padStart(2, "0").repeat(32);

const HEADINGS: Readonly<Record<string, string | undefined>> = {
  [id(1)]: "Should the library stay open until nine on weeknights?",
  [id(2)]: "Which day suits the street clean-up best?",
  // Its words are withheld, or failed their checks.
  [id(3)]: undefined,
};

/**
 * The list in memory: `polls` with results, each heading from `headings`
 * (one of `id(n)` past those is "Poll n"), failing as told, counting calls.
 */
function fakeClient({
  polls = Object.keys(HEADINGS),
  failList,
  failHeadings,
  failDrop,
}: {
  polls?: string[];
  failList?: FollowResultsError;
  /** Fails every headings read after the first `failHeadings.after`. */
  failHeadings?: { after: number; error: FollowResultsError };
  failDrop?: FollowResultsError;
} = {}): FollowResultsClient & { calls: string[] } {
  let list = [...polls];
  let reads = 0;
  const calls: string[] = [];
  return {
    calls,
    list: async () => {
      calls.push("list");
      if (failList !== undefined) throw failList;
      return list;
    },
    drop: async (electionId) => {
      calls.push(`drop ${electionId.slice(0, 2)}`);
      if (failDrop !== undefined) throw failDrop;
      list = list.filter((p) => p !== electionId);
    },
    headings: async (electionIds) => {
      calls.push(`headings ${electionIds.length}`);
      if (failHeadings !== undefined && reads++ >= failHeadings.after) throw failHeadings.error;
      return electionIds.map((electionId): FollowedPoll => ({
        electionId,
        heading: Object.hasOwn(HEADINGS, electionId)
          ? HEADINGS[electionId]
          : `Poll ${parseInt(electionId.slice(0, 2), 16)}`,
      }));
    },
  };
}

const meta = {
  component: AccountFollowResults,
  args: { index: "05", client: fakeClient(), onSignedOut: fn() },
} satisfies Meta<typeof AccountFollowResults>;

export default meta;
type Story = StoryObj<typeof meta>;

const rows = (canvas: ReturnType<typeof within>) => canvas.getAllByRole("listitem");

/** Three polls with results, one whose words can't be shown, each linking to its results. */
export const Listed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "Results for polls you followed" }),
    ).toBeVisible();
    // T-73: the e-mail names no poll, so the page says which, and who sees it.
    await expect(canvas.getByText(/Only you can see this list/)).toBeVisible();
    await expect(await canvas.findByRole("heading", { name: HEADINGS[id(1)]! })).toBeVisible();
    await expect(rows(canvas)).toHaveLength(3);
    await expect(
      canvas.getByRole("heading", { name: "A poll whose words can't be shown" }),
    ).toBeVisible();
    const see = canvas.getAllByRole("link", { name: "See the results" });
    await expect(see.map((a) => a.getAttribute("href"))).toEqual([
      `/polls/${id(1)}/results`,
      `/polls/${id(2)}/results`,
      `/polls/${id(3)}/results`,
    ]);
    // Every row's actions are told apart by its heading.
    await expect(see[1]).toHaveAccessibleDescription(HEADINGS[id(2)]!);
    await expect(canvas.queryByRole("button", { name: /^Show/ })).toBeNull();
  },
};

export const ListedDark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("heading", { name: HEADINGS[id(2)]! }),
    ).toBeVisible();
  },
};

/** Taking one off: it leaves the list, focus returns to the heading, and it says so. */
export const TakeOff: Story = {
  args: { client: fakeClient() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("heading", { name: HEADINGS[id(1)]! });
    const remove = canvas.getAllByRole("button", { name: "Take it off this list" });
    await expect(remove[0]).toHaveAccessibleDescription(HEADINGS[id(1)]!);
    await userEvent.click(remove[0]!);
    await waitFor(() => expect(rows(canvas)).toHaveLength(2));
    await expect(canvas.queryByRole("heading", { name: HEADINGS[id(1)]! })).toBeNull();
    await expect(canvas.getByRole("status")).toHaveTextContent("Taken off the list.");
    await expect(
      canvas.getByRole("heading", { name: "Results for polls you followed" }),
    ).toHaveFocus();
    await expect((args.client as ReturnType<typeof fakeClient>).calls).toEqual([
      "list",
      "headings 3",
      "drop 01",
    ]);
  },
};

/** Nothing has landed yet. */
export const Empty: Story = {
  args: { client: fakeClient({ polls: [] }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/^Nothing here yet\./)).toBeVisible();
    await expect(canvas.queryByRole("list")).toBeNull();
    // An empty list costs no read of words.
    await expect((args.client as ReturnType<typeof fakeClient>).calls).toEqual(["list"]);
  },
};

const many = Array.from({ length: 23 }, (_, i) => id(i + 16));

/** A long list reads its polls' words ten at a time. */
export const ShowMore: Story = {
  args: { client: fakeClient({ polls: many }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("heading", { name: "Poll 16" });
    await expect(rows(canvas)).toHaveLength(10);
    await userEvent.click(canvas.getByRole("button", { name: "Show 10 more" }));
    await waitFor(() => expect(rows(canvas)).toHaveLength(20));
    await userEvent.click(canvas.getByRole("button", { name: "Show 3 more" }));
    await waitFor(() => expect(rows(canvas)).toHaveLength(23));
    await expect(canvas.queryByRole("button", { name: /^Show/ })).toBeNull();
    await expect((args.client as ReturnType<typeof fakeClient>).calls).toEqual([
      "list",
      "headings 10",
      "headings 10",
      "headings 3",
    ]);
  },
};

/** The next polls' words fail: the ones shown stay, and it can try again. */
export const MoreFailed: Story = {
  args: {
    client: fakeClient({
      polls: many,
      failHeadings: { after: 1, error: new FollowResultsError("failed") },
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("heading", { name: "Poll 16" });
    await userEvent.click(canvas.getByRole("button", { name: "Show 10 more" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "The rest of the list couldn't be loaded just now. Try again.",
    );
    await expect(rows(canvas)).toHaveLength(10);
    await expect(canvas.getByRole("button", { name: "Show 10 more" })).toBeEnabled();
  },
};

/** The list can't be read: it says so where the list would be, and loads it again. */
export const Unlisted: Story = {
  args: { client: fakeClient({ failList: new FollowResultsError("failed") }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "This list couldn't be loaded just now.",
    );
    await expect(canvas.queryByText(/^Nothing here yet/)).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Load the list again" }));
    await waitFor(() =>
      expect((args.client as ReturnType<typeof fakeClient>).calls).toEqual(["list", "list"]),
    );
  },
};

/** A failed change keeps the poll on the list and says so. */
export const TakeOffFailed: Story = {
  args: { client: fakeClient({ failDrop: new FollowResultsError("failed") }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("heading", { name: HEADINGS[id(1)]! });
    await userEvent.click(canvas.getAllByRole("button", { name: "Take it off this list" })[0]!);
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "That poll wasn't taken off the list. Try again.",
    );
    await expect(rows(canvas)).toHaveLength(3);
    await expect(canvas.getByRole("status")).toBeEmptyDOMElement();
  },
};

/** The session ended: it says so, and the page is told. */
export const SignedOut: Story = {
  args: { client: fakeClient({ failList: new FollowResultsError("signedOut") }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "You've been signed out. Sign in again to see this list.",
    );
    await waitFor(() => expect(args.onSignedOut).toHaveBeenCalledOnce());
    await expect(canvas.queryByRole("button", { name: "Load the list again" })).toBeNull();
  },
};
