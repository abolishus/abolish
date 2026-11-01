import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import {
  type DraftsClient,
  DraftsError,
  type PollModerationView,
  type PollSummary,
} from "../account/drafts.ts";
import type { CardAnswered } from "../stream.ts";
import { AccountPolls } from "./account-polls.tsx";
import { fakeProfiles, HANDLE } from "./profiles-fake.ts";

const VISIBLE: PollModerationView = {
  state: "visible",
  latest: undefined,
  appealable: false,
  appeals: [],
};

/** A drafts handler in memory: the list's calls, with no network. */
function fakeDrafts(
  polls: PollSummary[],
  {
    refuse,
    moderated = {},
    answered = {},
  }: {
    refuse?: DraftsError;
    moderated?: Record<string, PollModerationView>;
    /** Each open poll's counts, or the refusal its read gets; a poll with none fails to read. */
    answered?: Record<string, CardAnswered | DraftsError>;
  } = {},
): DraftsClient & { calls: string[]; asked: string[] } {
  let list = [...polls];
  const moderation = new Map(Object.entries(moderated));
  const calls: string[] = [];
  // The counts each row reads: not an action, so not among `calls`.
  const asked: string[] = [];
  const act = (name: string, id: string, change: () => void) => {
    calls.push(`${name} ${id}`);
    if (refuse !== undefined) throw refuse;
    change();
  };
  return {
    calls,
    asked,
    list: async () => list,
    remove: async (id) => act("remove", id, () => (list = list.filter((p) => p.id !== id))),
    discard: async (id) => act("discard", id, () => (list = list.filter((p) => p.id !== id))),
    // The list never reads or writes a draft: the form's stories do (poll-form.stories.tsx).
    read: async () => {
      throw new DraftsError("gone");
    },
    create: async () => {
      throw new DraftsError("failed");
    },
    update: async () => {},
    moderation: async (id) => moderation.get(id) ?? VISIBLE,
    answered: async (id) => {
      asked.push(id);
      const counts = answered[id] ?? new DraftsError("failed");
      if (counts instanceof DraftsError) throw counts;
      return counts;
    },
    appeal: async (id) =>
      act("appeal", id, () => {
        const m = moderation.get(id);
        if (m?.latest === undefined) throw new DraftsError("changed");
        moderation.set(id, {
          ...m,
          appealable: false,
          appeals: [
            ...m.appeals,
            {
              decisionSeq: m.latest.seq,
              filedAt: "2026-10-18T09:30:00.000Z",
              outcome: undefined,
              reviewedAt: undefined,
            },
          ],
        });
      }),
    submit: async () => {},
    retry: async (id) =>
      act("retry", id, () => {
        list = list.map((p) =>
          p.id === id
            ? {
                ...p,
                state: "drafted",
                failure: undefined,
                retryable: false,
                submittedAt: undefined,
                updatedAt: "2026-10-17T09:00:00.000Z",
              }
            : p,
        );
      }),
  };
}

const poll = (id: string, over: Partial<PollSummary>): PollSummary => ({
  id: id.padEnd(32, "0"),
  state: "drafted",
  title: "Should the harbor library open on Sundays?",
  closesAt: 1793750400n, // 2026-11-04T00:00:00Z
  updatedAt: "2026-10-11T14:20:00.000Z",
  submittedAt: undefined,
  failure: undefined,
  retryable: false,
  electionId: undefined,
  ...over,
});

const DRAFT = poll("draft", {});
const UNTITLED = poll("untitled", { title: "", updatedAt: "2026-10-12T08:00:00.000Z" });
const SETTING_UP = poll("setup", {
  state: "ceremony",
  title: "Which crossing should get a signal first?",
  submittedAt: "2026-10-16T18:05:00.000Z",
});
const OPEN = poll("open", {
  state: "open",
  title: "Name the new ferry",
  electionId: "0f".repeat(32),
});
const CLOSED = poll("closed", {
  state: "open",
  title: "Light the pier at night?",
  closesAt: 1792195200n, // 2026-10-17T00:00:00Z, before the stories' clock
  electionId: "1e".repeat(32),
});
const TIMED_OUT = poll("timeout", {
  state: "failed",
  title: "Repaint the bandstand?",
  submittedAt: "2026-10-15T10:00:00.000Z",
  failure: "ceremony-timeout",
  retryable: true,
});
const REGISTERED = poll("registered", {
  state: "failed",
  title: "Move the market to Saturdays?",
  submittedAt: "2026-10-14T10:00:00.000Z",
  failure: "open-mismatch",
  retryable: false,
});

const EVERY = [DRAFT, UNTITLED, SETTING_UP, OPEN, CLOSED, TIMED_OUT, REGISTERED];

const meta = {
  component: AccountPolls,
  // Every story reads the list on one day: after CLOSED's close, before OPEN's.
  // Retrying opens the draft's page; here it is only recorded.
  args: { index: "01", now: () => new Date("2026-10-18T12:00:00.000Z"), onRetried: fn() },
} satisfies Meta<typeof AccountPolls>;

export default meta;
type Story = StoryObj<typeof meta>;

const calls = (client: unknown) => (client as ReturnType<typeof fakeDrafts>).calls;

const showsEveryState: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const items = await canvas.findAllByRole("listitem");
  await expect(items).toHaveLength(EVERY.length);
  const [draft, untitled, setup, open, closed, timedOut, registered] = items.map((i) => within(i));
  // The lede names every kind of poll the list holds, those that never opened too.
  await expect(
    within(canvasElement).getByText(
      /^Your drafts and every poll you submitted, whether it opened or not\./,
    ),
  ).toBeVisible();
  await expect(draft!.getByText("Draft")).toBeVisible();
  await expect(draft!.getByText("Last edited October 11, 2026 at 2:20 PM UTC")).toBeVisible();
  // A draft opens in the form; nothing past a draft does.
  await expect(
    draft!.getByRole("link", {
      name: "Edit draft",
      description: "Should the harbor library open on Sundays?",
    }),
  ).toHaveAttribute("href", `/account/polls/${DRAFT.id}`);
  // A poll in setup links to its steps, an open one to its public page (part 6d).
  await expect(
    setup!.getByRole("link", {
      name: "Follow its setup",
      description: "Which crossing should get a signal first?",
    }),
  ).toHaveAttribute("href", `/account/polls/${SETTING_UP.id}/setup`);
  await expect(
    open!.getByRole("link", { name: "Go to its page", description: "Name the new ferry" }),
  ).toHaveAttribute("href", `/polls/${"0f".repeat(32)}`);
  await expect(timedOut!.queryByRole("link")).toBeNull();
  await expect(untitled!.getByRole("heading", { name: "Untitled draft" })).toBeVisible();
  // Setup's steps are one state, never a step's name or a hash.
  await expect(setup!.getByText("Setting up")).toBeVisible();
  await expect(setup!.queryByText(/ceremony/i)).toBeNull();
  await expect(setup!.getByText("Submitted October 16, 2026 at 6:05 PM UTC")).toBeVisible();
  await expect(setup!.queryByRole("button")).toBeNull();
  // On the list there is no page to wait on: its reason says nothing more is
  // needed and where the outcome shows, not "You can leave this page", the
  // setup page's words (P2-29, the author's list's iteration 29).
  await expect(
    setup!.getByText(
      /Nothing more is needed from you: it opens on its own, and this list shows when it does, or why it didn't\./,
    ),
  ).toBeVisible();
  await expect(setup!.queryByText(/leave this page/)).toBeNull();
  await expect(open!.getByText("Closes November 4, 2026 at 12:00 AM UTC")).toBeVisible();
  await expect(open!.queryByRole("button")).toBeNull();
  // The list still says `open` once the close has passed: the clock decides.
  await expect(closed!.getByText("Closed", { exact: true })).toBeVisible();
  await expect(closed!.queryByText("Open", { exact: true })).toBeNull();
  // The state, then when it closed, without saying "Closed" twice (as the poll register does).
  await expect(closed!.getByText("On October 17, 2026 at 12:00 AM UTC")).toBeVisible();
  await expect(closed!.getAllByText(/closed/i)).toHaveLength(1);
  // Once closed, its results come first, then its page.
  const closedLinks = closed!.getAllByRole("link", { description: "Light the pier at night?" });
  await expect(closedLinks.map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
    ["See its results", `/polls/${"1e".repeat(32)}/results`],
    ["Go to its page", `/polls/${"1e".repeat(32)}`],
  ]);
  await expect(open!.queryByRole("link", { name: "See its results" })).toBeNull();
  // A failure in its own words, with what the author can do.
  await expect(timedOut!.getByText("Didn't open")).toBeVisible();
  await expect(
    timedOut!.getByText(
      /Making the key that seals your poll's answers didn't finish after four tries/,
    ),
  ).toBeVisible();
  // Trustees are invisible in an everyday poll: a reason never names them (P2-29, iteration 24).
  await expect(timedOut!.queryByText(/trustee/i)).toBeNull();
  await expect(
    timedOut!.getByRole("button", {
      name: "Edit and submit again",
      description: "Repaint the bandstand?",
    }),
  ).toBeVisible();
  // Why a poll waits or failed comes before what the author can do about it.
  const before = (reason: Element, action: Element) =>
    expect(reason.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await before(
    setup!.getByText(/^Setting up takes a while/),
    setup!.getByRole("link", { name: "Follow its setup" }),
  );
  await before(
    timedOut!.getByText(/didn't finish after four tries/),
    timedOut!.getByRole("button", { name: "Edit and submit again" }),
  );
  // A registered poll stays: nothing to retry or discard. Its reason ends
  // with asking again as a new poll, and the row has the way to, after the
  // reason, starting from the poll's own words (P2-29, iteration 27).
  await expect(registered!.getByText(/It will never take answers/)).toBeVisible();
  await expect(registered!.queryByRole("button")).toBeNull();
  await expect(
    registered!.getByRole("link", {
      name: "Ask it again",
      description: "Move the market to Saturdays?",
    }),
  ).toHaveAttribute("href", `/account/polls/new?from=${REGISTERED.id}`);
  await before(
    registered!.getByText(/ask your question again as a new poll, starting from what you wrote\.$/),
    registered!.getByRole("link", { name: "Ask it again" }),
  );
  // A time is in the state's face and size, never the evidence's monospace.
  for (const item of items) {
    const style = (e: Element) => getComputedStyle(e);
    const state = style(within(item).getByText(/^(Draft|Setting up|Open|Closed|Didn't open)$/));
    const time = style(within(item).getByText(/^(Last edited|Submitted|Closes|On) .* UTC$/));
    await expect(time.fontFamily).toBe(state.fontFamily);
    await expect(time.fontSize).toBe(state.fontSize);
  }
};

export const EveryState: Story = {
  args: { client: fakeDrafts(EVERY) },
  play: showsEveryState,
};

export const EveryStatePhone: Story = {
  args: { client: fakeDrafts(EVERY) },
  globals: { viewport: { value: "phone", isRotated: false } },
  play: async (context) => {
    await showsEveryState(context);
    // On a phone the row stacks, so the reason is read above its actions.
    const timedOut = within(within(context.canvasElement).getAllByRole("listitem")[5]!);
    await expect(
      timedOut.getByText(/didn't finish after four tries/).getBoundingClientRect().bottom,
    ).toBeLessThanOrEqual(
      timedOut.getByRole("button", { name: "Edit and submit again" }).getBoundingClientRect().top,
    );
  },
};

/**
 * Where a time wraps, "UTC" stood alone on the next line ("…at 2:20 PM",
 * then "UTC") wherever the time was about 300px wide or less: a folded
 * phone's 280, a 360px phone zoomed to 125%, and the longer Spanish times
 * (P2-29, the author's list's iteration 6). The time now wraps whole.
 */
export const EveryStateFolded: Story = {
  args: { client: fakeDrafts(EVERY) },
  globals: { viewport: { value: "folded", isRotated: false } },
  play: async (context) => {
    await showsEveryState(context);
    await expect(context.canvasElement.ownerDocument.documentElement.clientWidth).toBe(280);
    const times = within(context.canvasElement).getAllByText(
      /^(Last edited|Submitted|Closes|On) .* UTC$/,
    );
    for (const time of times) {
      const text = time.firstChild!; // The time is the paragraph's only child, its text.
      const top = (from: number, to: number) => {
        const range = document.createRange();
        range.setStart(text, from);
        range.setEnd(text, to);
        return Math.round(range.getBoundingClientRect().top);
      };
      const end = text.textContent!.length;
      // "UTC" is on the line of the time's hour, so "AM" and "PM" are too.
      const hour = text.textContent!.lastIndexOf(":") - 1;
      await expect(top(end - 3, end)).toBe(top(hour, hour + 1));
    }
  },
};

export const EveryStateDark: Story = {
  args: { client: fakeDrafts(EVERY) },
  parameters: { theme: "dark" },
  play: showsEveryState,
};

export const EveryStateDesktop: Story = {
  args: { client: fakeDrafts(EVERY) },
  globals: { viewport: { value: "desktop", isRotated: false } },
  play: async (context) => {
    await showsEveryState(context);
    const items = within(context.canvasElement).getAllByRole("listitem");
    const box = (e: Element) => e.getBoundingClientRect();
    const width = box(items[0]!).width;
    // Each title has its row's width, never a column beside the state.
    for (const item of items)
      await expect(box(within(item).getByRole("heading")).width).toBeGreaterThan(width - 1);
    // The states start at one edge and the times at another, row after row.
    const lefts = (find: (i: HTMLElement) => Element) =>
      new Set(items.map((i) => Math.round(box(find(i)).left)));
    await expect(
      lefts((i) => within(i).getByText(/^(Draft|Setting up|Open|Closed|Didn't open)$/)).size,
    ).toBe(1);
    await expect(
      lefts((i) => within(i).getByText(/^(Last edited|Submitted|Closes|On) .* UTC$/)).size,
    ).toBe(1);
    // The state's line is one height in every row, with or without an action.
    const below = new Set(
      items.map((i) =>
        Math.round(
          box(within(i).getByText(/^(Draft|Setting up|Open|Closed|Didn't open)$/)).top -
            box(within(i).getByRole("heading")).bottom,
        ),
      ),
    );
    await expect(below.size).toBe(1);
    // The actions stay on the state's line, above the reason under it.
    for (const item of items) {
      const state = box(within(item).getByText(/^(Draft|Setting up|Open|Closed|Didn't open)$/));
      for (const target of [
        ...within(item).queryAllByRole("link"),
        ...within(item).queryAllByRole("button"),
      ])
        await expect(
          Math.abs(box(target).top + box(target).height / 2 - state.top - state.height / 2),
        ).toBeLessThan(2);
    }
    // A row's links and buttons are one height, so its actions sit on one line.
    for (const item of items) {
      const targets = [
        ...within(item).queryAllByRole("link"),
        ...within(item).queryAllByRole("button"),
      ];
      for (const target of targets) await expect(box(target).height).toBe(48);
    }
    // The empty status line takes no gap: the list's rule is one gap under the button (iteration 14).
    const canvas = within(context.canvasElement);
    const ask = box(canvas.getByRole("link", { name: "Ask a question" }));
    await expect(box(canvas.getAllByRole("list")[0]!).top - ask.bottom).toBe(16);
  },
};

export const Empty: Story = {
  args: { client: fakeDrafts([]) },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByText("You haven't created a poll yet."),
    ).toBeVisible();
  },
};

/**
 * Retrying puts a poll back to its draft and nothing more, so the button
 * says what comes next and takes the author to the draft, where it is
 * submitted again: "Try again" left the author on the list, the poll a
 * draft three taps from being submitted, and read as if setup had started
 * over (P2-29, the author's list's iteration 28).
 */
export const RetryAFailedPoll: Story = {
  args: { client: fakeDrafts([TIMED_OUT]) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(
        /Your question wasn't published\. You can submit it again or discard it\.$/,
      ),
    ).toBeVisible();
    const retry = canvas.getByRole("button", { name: "Edit and submit again" });
    await userEvent.click(retry);
    await waitFor(() => expect(args.onRetried).toHaveBeenCalledWith(TIMED_OUT.id));
    await expect(calls(args.client)).toEqual([`retry ${TIMED_OUT.id}`]);
    // Nothing more to click while the draft's page opens.
    await expect(retry).toBeDisabled();
    await expect(canvas.getByRole("button", { name: "Discard…" })).toBeDisabled();
  },
};

export const DiscardAFailedPoll: Story = {
  args: { client: fakeDrafts([TIMED_OUT, DRAFT]) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Discard…" }));
    // Asks once more, and can step back. Focus goes to the question, and
    // "Keep it", which removes itself, returns it to the button that asked
    // rather than to the page's start (P2-29, the author's list's iteration 19).
    await expect(canvas.getByText(/^Discard this poll and its draft\?/)).toHaveFocus();
    await userEvent.click(canvas.getByRole("button", { name: "Keep it" }));
    await expect(canvas.queryByRole("group")).toBeNull();
    await expect(canvas.getByRole("button", { name: "Discard…" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    const question = canvas.getByRole("group", {
      name: "Discard this poll and its draft? This can't be undone. Repaint the bandstand?",
    });
    await userEvent.click(within(question).getByRole("button", { name: "Discard permanently" }));
    await waitFor(() => expect(canvas.getAllByRole("listitem")).toHaveLength(1));
    await expect(canvas.getByRole("status")).toHaveTextContent("The poll is discarded.");
    await expect(calls(args.client)).toEqual([`discard ${TIMED_OUT.id}`]);
  },
};

export const DeleteADraft: Story = {
  args: { client: fakeDrafts([DRAFT]) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", {
        name: "Delete draft…",
        description: "Should the harbor library open on Sundays?",
      }),
    );
    await userEvent.click(canvas.getByRole("button", { name: "Delete draft permanently" }));
    await expect(await canvas.findByText("You haven't created a poll yet.")).toBeVisible();
    await expect(canvas.getByRole("status")).toHaveTextContent("The draft is deleted.");
    await expect(calls(args.client)).toEqual([`remove ${DRAFT.id}`]);
  },
};

export const RefusedAsRegistered: Story = {
  args: { client: fakeDrafts([TIMED_OUT], { refuse: new DraftsError("registered") }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Edit and submit again" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "That poll is registered on the public record, so it stays.",
    );
    await expect(canvas.getByRole("status")).toBeEmptyDOMElement();
    // Refused, it stays on the list, which says why.
    await expect(args.onRetried).not.toHaveBeenCalled();
  },
};

/**
 * After an action focus goes back to the section's heading, so the words
 * saying how it went are under that heading, above the list: below it, a
 * phone showed the heading and a list with no word of the outcome, which
 * was a screen or more further down (P2-29, the author's list's iteration 9).
 */
const outcomeUnderTheHeading = async (canvasElement: HTMLElement, outcome: HTMLElement) => {
  const canvas = within(canvasElement);
  const heading = canvas.getByRole("heading", { level: 2, name: "Polls you created" });
  await expect(heading).toHaveFocus();
  await expect(outcome.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    canvas.getByRole("list").getBoundingClientRect().top,
  );
  // On the screen the heading is on: a phone's 640px.
  await expect(
    outcome.getBoundingClientRect().bottom - heading.getBoundingClientRect().top,
  ).toBeLessThan(640);
};

export const OutcomeAboveALongList: Story = {
  args: { client: fakeDrafts(EVERY) },
  globals: { viewport: { value: "phone", isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Discard…" }));
    await userEvent.click(canvas.getByRole("button", { name: "Discard permanently" }));
    await expect(await canvas.findByRole("status")).toHaveTextContent("The poll is discarded.");
    await outcomeUnderTheHeading(canvasElement, canvas.getByRole("status"));
  },
};

export const RefusedInALongList: Story = {
  args: { client: fakeDrafts(EVERY, { refuse: new DraftsError("registered") }) },
  globals: { viewport: { value: "phone", isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Edit and submit again" }));
    const alert = await canvas.findByRole("alert");
    await expect(alert).toHaveTextContent(
      "That poll is registered on the public record, so it stays.",
    );
    await outcomeUnderTheHeading(canvasElement, alert);
  },
};

/** A list that fails to load until the story lets it. */
const flaky = (() => {
  const drafts = fakeDrafts([DRAFT]);
  const state = { down: true };
  const client: DraftsClient = {
    ...drafts,
    list: async () => {
      if (state.down) throw new DraftsError("failed");
      return drafts.list();
    },
  };
  return { client, state };
})();

/**
 * A list that couldn't be loaded says so where the list would be, and loads
 * again from there: "Try again shortly" alone left reloading the page.
 */
export const ListUnavailable: Story = {
  args: { client: flaky.client },
  beforeEach: () => {
    flaky.state.down = true;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "Your polls couldn't be loaded just now.",
    );
    await expect(canvas.queryByRole("list")).toBeNull();
    const again = canvas.getByRole("button", { name: "Load your polls again" });
    // The way to load it again sits right under the words saying it failed.
    await expect(
      again.getBoundingClientRect().top - canvas.getByRole("alert").getBoundingClientRect().bottom,
    ).toBeLessThan(8);
    await expect(again.getBoundingClientRect().height).toBeGreaterThanOrEqual(48);
    flaky.state.down = false;
    await userEvent.click(again);
    await expect(
      await canvas.findByRole("heading", {
        level: 3,
        name: "Should the harbor library open on Sundays?",
      }),
    ).toBeVisible();
    await expect(canvas.queryByRole("alert")).toBeNull();
    await expect(canvas.queryByRole("button", { name: "Load your polls again" })).toBeNull();
    await expect(
      canvas.getByRole("heading", { level: 2, name: "Polls you created" }),
    ).toHaveFocus();
  },
};

/**
 * A moderation block's outcome is the first thing under its heading, where
 * focus returns after filing: drawn at the block's end, under the log link,
 * it sat a phone's screen below (P2-29, the author's list's iteration 18).
 */
const outcomeUnderTheDecision = async (block: HTMLElement, outcome: HTMLElement) => {
  const heading = within(block)
    .getByText(/^(Delisted|Text hidden|Restored):/)
    .closest("p");
  if (heading === null) throw new Error("no decision heading");
  const gap = outcome.getBoundingClientRect().top - heading.getBoundingClientRect().bottom;
  await expect(gap).toBeGreaterThanOrEqual(0);
  await expect(gap).toBeLessThanOrEqual(16);
};

const DELISTED: PollModerationView = {
  state: "delisted",
  latest: { seq: 41n, action: "delist", reason: "spam", decidedAt: "2026-10-17T16:45:00.000Z" },
  appealable: true,
  appeals: [],
};

export const AppealADecision: Story = {
  args: { client: fakeDrafts([OPEN], { moderated: { [OPEN.id]: DELISTED } }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const block = await canvas.findByRole("group", {
      name: /^Delisted: Spam\sOn October 17, 2026 at 4:45\sPM\sUTC, decision No.\s41$/,
    });
    const moderation = within(block);
    await expect(moderation.getByText(/stays open at its address/)).toBeVisible();
    // The log opens at the decision the heading names (P2-29, the author's
    // list's iteration 26).
    const log = moderation.getByRole("link", { name: "See it in the moderation log" });
    await expect(log).toHaveAttribute("href", "/moderation?before=42");
    // The history's actions are drawn as the row's, 48px targets (P2-29,
    // the author's list's iteration 13).
    for (const action of [moderation.getByRole("button", { name: "Appeal this decision…" }), log])
      await expect(action.getBoundingClientRect().height).toBeGreaterThanOrEqual(48);
    // Asks once more, and can step back.
    await userEvent.click(
      moderation.getByRole("button", {
        name: "Appeal this decision…",
        description: "Name the new ferry",
      }),
    );
    // The ask replaces the button that had focus, and "Not now" removes
    // itself: focus goes to the question, then back to the button, not to
    // the page's start (P2-29, the author's list's iteration 19).
    await expect(moderation.getByText(/^Appeal this decision\?/)).toHaveFocus();
    await userEvent.click(moderation.getByRole("button", { name: "Not now" }));
    await expect(moderation.getByRole("button", { name: "Appeal this decision…" })).toHaveFocus();
    await expect(calls(args.client)).toEqual([]);
    await userEvent.keyboard("{Enter}");
    // Focus left the button its poll described, so the question names the
    // poll itself, as the list's own do (P2-29, the author's list's iteration 20).
    await expect(
      moderation.getByRole("group", { name: /^Appeal this decision\?.* Name the new ferry$/ }),
    ).toBeVisible();
    await userEvent.click(moderation.getByRole("button", { name: "Send appeal" }));
    await expect((await moderation.findByRole("status")).textContent).toBe("Your appeal is filed.");
    await outcomeUnderTheDecision(block, moderation.getByRole("status"));
    await expect(
      moderation.getByText(
        "You appealed decision No. 41 on October 18, 2026 at 9:30 AM UTC: waiting for a moderator other than the one who decided.",
      ),
    ).toBeVisible();
    // Who reviews it is said once, in the appeal's own line: the notice
    // above it said it again in other words (P2-29, the author's list's
    // iteration 22).
    await expect(
      block.textContent!.match(/other than the one who decided|different moderator/g),
    ).toHaveLength(1);
    // Once filed, the decision can't be appealed again.
    await expect(moderation.queryByRole("button", { name: /Appeal/ })).toBeNull();
    const decision = moderation.getByText("Delisted: Spam").closest("p");
    await expect(decision).toHaveFocus();
    // Focused only by script, it draws no ring, as the list's heading and
    // questions draw none: the browser's crossed the history's rule and the
    // time under it (P2-29, the author's list's iteration 20).
    await expect(decision && getComputedStyle(decision).outlineStyle).toBe("none");
    await expect(calls(args.client)).toEqual([`appeal ${OPEN.id}`]);
  },
};

const HIDDEN: PollModerationView = {
  state: "hidden",
  latest: {
    seq: 52n,
    action: "hide",
    reason: "personal-data",
    decidedAt: "2026-10-16T08:00:00.000Z",
  },
  appealable: false,
  appeals: [
    {
      decisionSeq: 47n,
      filedAt: "2026-10-14T12:00:00.000Z",
      outcome: "superseded",
      reviewedAt: "2026-10-16T08:00:00.000Z",
    },
    {
      decisionSeq: 52n,
      filedAt: "2026-10-16T09:10:00.000Z",
      outcome: "rejected",
      reviewedAt: "2026-10-17T11:00:00.000Z",
    },
  ],
};

const RESTORED: PollModerationView = {
  state: "visible",
  latest: {
    seq: 60n,
    action: "restore",
    reason: "appeal-upheld",
    decidedAt: "2026-10-17T15:00:00.000Z",
  },
  appealable: false,
  appeals: [
    {
      decisionSeq: 55n,
      filedAt: "2026-10-17T10:00:00.000Z",
      outcome: "upheld",
      reviewedAt: "2026-10-17T15:00:00.000Z",
    },
  ],
};

const HIDDEN_POLL = poll("hidden", {
  state: "open",
  title: "Rename the east pier?",
  electionId: "2d".repeat(32),
});

const showsModeration: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const hidden = within(
    await canvas.findByRole("group", {
      name: /^Text hidden: Personal data\sOn October 16, 2026 at 8:00\sAM\sUTC, decision No.\s52$/,
    }),
  );
  await expect(hidden.getByText(/don't show this poll's text/)).toBeVisible();
  await expect(
    hidden.getByText(
      /decision No. 47 .*: closed on October 16, 2026 at 8:00 AM UTC, because a later decision changed the poll first\./,
    ),
  ).toBeVisible();
  await expect(
    hidden.getByText(/decision No. 52 .*: rejected on October 17, 2026 at 11:00 AM UTC\./),
  ).toBeVisible();
  // The appeal of the decision in the heading comes first, right under its
  // meaning; an older decision's after it (P2-29, the author's list's iteration 25).
  await expect(
    hidden.getAllByText(/^You appealed decision No\./).map((a) => a.textContent?.slice(0, 28)),
  ).toEqual(["You appealed decision No. 52", "You appealed decision No. 47"]);
  await expect(hidden.queryByRole("button")).toBeNull();
  // Hidden text leaves the poll at its address, and its row still goes there.
  await expect(
    canvas.getByRole("link", { name: "Go to its page", description: "Rename the east pier?" }),
  ).toHaveAttribute("href", `/polls/${"2d".repeat(32)}`);
  const restored = within(
    canvas.getByRole("group", {
      name: /^Restored: Appeal upheld\sOn October 17, 2026 at 3:00\sPM\sUTC, decision No.\s60$/,
    }),
  );
  await expect(restored.getByText("Our pages list and show this poll again.")).toBeVisible();
  await expect(
    restored.getByText(/upheld on October 17, 2026 at 3:00 PM UTC, and the poll restored\./),
  ).toBeVisible();
  // Each block's log link opens the log at the decision its heading names,
  // not at the log's first page (P2-29, the author's list's iteration 26).
  await expect(hidden.getByRole("link", { name: "See it in the moderation log" })).toHaveAttribute(
    "href",
    "/moderation?before=53",
  );
  await expect(
    restored.getByRole("link", { name: "See it in the moderation log" }),
  ).toHaveAttribute("href", "/moderation?before=61");
  // A poll nothing was decided about, and a draft, show no moderation at all.
  await expect(canvas.getAllByRole("group")).toHaveLength(2);
};

const MODERATED = fakeDrafts([HIDDEN_POLL, OPEN, SETTING_UP, DRAFT], {
  moderated: { [HIDDEN_POLL.id]: HIDDEN, [OPEN.id]: RESTORED },
});

export const ModerationHistory: Story = {
  args: { client: MODERATED },
  play: showsModeration,
};

export const ModerationHistoryDark: Story = {
  args: { client: MODERATED },
  parameters: { theme: "dark" },
  play: showsModeration,
};

/**
 * At desktop width each appeal ran the row's whole width, about 150
 * characters a line, and the moderation log's link was a 14px line of text
 * where the row's own links are 48px (P2-29, the author's list's iteration
 * 13). An appeal now keeps the reason's measure, and the link the row's.
 * Its rule ran 12px past the log's link, the gap before an empty status
 * line (iteration 14); it now ends with the link.
 */
export const ModerationHistoryDesktop: Story = {
  args: { client: MODERATED },
  globals: { viewport: { value: "desktop", isRotated: false } },
  play: async (context) => {
    await showsModeration(context);
    const canvas = within(context.canvasElement);
    const reason = canvas.getByText(/don't show this poll's text/);
    const appeals = canvas.getAllByText(/^You appealed decision No\./);
    await expect(appeals).toHaveLength(3);
    for (const appeal of appeals)
      await expect(appeal.getBoundingClientRect().width).toBeLessThanOrEqual(
        reason.getBoundingClientRect().width,
      );
    const row = canvas.getAllByRole("link", { name: "Go to its page" })[0]!.getBoundingClientRect();
    for (const log of canvas.getAllByRole("link", { name: "See it in the moderation log" })) {
      await expect(log.getBoundingClientRect().height).toBe(row.height);
      const history = log.closest('[role="group"]');
      await expect(history?.getBoundingClientRect().bottom).toBe(
        log.getBoundingClientRect().bottom,
      );
    }
  },
};

/**
 * Each decision's date is on one line. Run on after its reason, the
 * heading broke it at a phone's 360, "October" over "16, 2026" (P2-29, the
 * author's list's iteration 16); the time now starts a line of its own.
 * Its log number, which the appeals name decisions by and the heading
 * left out (iteration 17), is whole on that line too.
 */
const decisionDatesWhole = async (canvasElement: HTMLElement) => {
  let dates = 0;
  for (const group of within(canvasElement).getAllByRole("group")) {
    const heading = group.firstElementChild!;
    const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text !== null; text = walker.nextNode()) {
      for (const m of text.textContent!.matchAll(/[A-Z][a-z]+\s\d{1,2},\s\d{4}|No\.\s\d+/g)) {
        const range = document.createRange();
        range.setStart(text, m.index);
        range.setEnd(text, m.index + m[0].length);
        await expect(range.getClientRects()).toHaveLength(1);
        dates += 1;
      }
    }
  }
  // Each of the two decisions: its date and its number.
  await expect(dates).toBe(4);
};

/**
 * Two appeals of four lines each, 4px apart, read at 360 as one paragraph
 * (P2-29, the author's list's iteration 21); they are now as far apart as
 * the decision's meaning is from the first of them.
 */
export const ModerationHistoryPhone: Story = {
  args: { client: MODERATED },
  globals: { viewport: { value: "phone", isRotated: false } },
  play: async (context) => {
    await showsModeration(context);
    await expect(context.canvasElement.ownerDocument.documentElement.clientWidth).toBe(360);
    await decisionDatesWhole(context.canvasElement);
    const canvas = within(context.canvasElement);
    const means = canvas.getByText(/don't show this poll's text/).getBoundingClientRect();
    const [first, second] = canvas
      .getAllByText(/^You appealed decision No\./)
      .slice(0, 2)
      .map((a) => a.getBoundingClientRect());
    await expect(second!.top - first!.bottom).toBe(first!.top - means.bottom);
  },
};

/**
 * Where the list is narrow, the moderation history's times broke as the
 * rows' did before iteration 6, "…at 8:00 AM" over "UTC" (P2-29, the
 * author's list's iteration 7). Every time in it now wraps whole.
 */
export const ModerationHistoryFolded: Story = {
  args: { client: MODERATED },
  globals: { viewport: { value: "folded", isRotated: false } },
  play: async (context) => {
    await showsModeration(context);
    await expect(context.canvasElement.ownerDocument.documentElement.clientWidth).toBe(280);
    let times = 0;
    for (const group of within(context.canvasElement).getAllByRole("group")) {
      const walker = document.createTreeWalker(group, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text !== null; text = walker.nextNode()) {
        for (const m of text.textContent!.matchAll(/\d{1,2}:\d{2}\s[AP]M\sUTC/g)) {
          const range = document.createRange();
          range.setStart(text, m.index);
          range.setEnd(text, m.index + m[0].length);
          // One box: the hour, its "AM" or "PM" and "UTC" on one line.
          await expect(range.getClientRects()).toHaveLength(1);
          times += 1;
        }
      }
    }
    // The two decisions and the three appeals, each filed and reviewed.
    await expect(times).toBe(8);
    await decisionDatesWhole(context.canvasElement);
    // Each decision wraps here, and its icon sits on the first line, not
    // between the two (P2-29, the author's list's iteration 15).
    for (const group of within(context.canvasElement).getAllByRole("group")) {
      const heading = group.firstElementChild!;
      const icon = heading.querySelector("svg")!.getBoundingClientRect();
      // The text's own lines, not the boxes of the elements holding them.
      const lines: DOMRect[] = [];
      const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text !== null; text = walker.nextNode()) {
        const range = document.createRange();
        range.selectNodeContents(text);
        lines.push(...[...range.getClientRects()].filter((r) => r.width > 0));
      }
      await expect(new Set(lines.map((r) => r.top)).size).toBeGreaterThan(1);
      const first = lines[0]!;
      await expect(
        Math.abs(icon.top + icon.height / 2 - (first.top + first.height / 2)),
      ).toBeLessThan(2);
    }
  },
};

export const AppealRefusedAsChanged: Story = {
  args: {
    client: fakeDrafts([OPEN], {
      moderated: { [OPEN.id]: DELISTED },
      refuse: new DraftsError("changed"),
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Appeal this decision…" }));
    await userEvent.click(canvas.getByRole("button", { name: "Send appeal" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "That decision changed or was already appealed since this page read it. This shows how it stands now.",
    );
    await outcomeUnderTheDecision(
      canvas.getByRole("group", { name: /^Delisted: Spam/ }),
      canvas.getByRole("alert"),
    );
  },
};

/** A moderation read that fails `failures` times, then answers `then`. */
const failingModeration = (failures: number, then: PollModerationView) => {
  let left = failures;
  return async () => {
    if (left-- > 0) throw new DraftsError("failed");
    return then;
  };
};

export const ModerationUnavailable: Story = {
  args: {
    client: { ...fakeDrafts([OPEN]), moderation: failingModeration(2, DELISTED) },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const alert = await canvas.findByRole("alert");
    // It says what failed and offers what tries again, never "try again" with nothing to press.
    await expect(alert).toHaveTextContent(/^This poll's moderation couldn't be loaded just now\.$/);
    const reload = () =>
      canvas.getByRole("button", {
        name: "Load its moderation again",
        description: "Name the new ferry",
      });
    // Failing again keeps the words and the way, and focus on the block.
    await userEvent.click(reload());
    await waitFor(() => expect(reload()).toBeEnabled());
    await expect(canvas.getByRole("alert")).toHaveTextContent(/couldn't be loaded just now/);
    await expect(canvas.getByText("Moderation")).toHaveFocus();
    await userEvent.click(reload());
    const heading = await canvas.findByText("Delisted: Spam", { exact: false });
    await expect(canvas.queryByRole("alert")).toBeNull();
    await expect(canvas.queryByRole("button", { name: "Load its moderation again" })).toBeNull();
    await expect(heading.closest("p")).toHaveFocus();
    await expect(canvas.getByRole("button", { name: "Appeal this decision…" })).toBeEnabled();
  },
};

/** Loaded again, a poll nothing was decided about says so rather than vanishing with focus in it. */
export const ModerationUnavailableThenNone: Story = {
  args: {
    client: { ...fakeDrafts([OPEN]), moderation: failingModeration(1, VISIBLE) },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Load its moderation again" }));
    await expect(
      await canvas.findByText("Moderation hasn't decided anything about this poll."),
    ).toBeVisible();
    await expect(canvas.queryByRole("alert")).toBeNull();
    await expect(canvas.getByText("Moderation", { exact: true })).toHaveFocus();
  },
};

const PROFILE = {
  handle: HANDLE,
  name: "Harbor Street Neighbors",
  renamableOn: undefined,
  pollIds: [OPEN.id],
};

const choice = (row: ReturnType<typeof within>) =>
  row.getByRole("checkbox", { name: "Show on your profile" });

/** Each poll's own choice of whether the profile shows it (P2-27 part 1d-3). */
export const ChooseWhatTheProfileShows: Story = {
  args: {
    client: fakeDrafts([DRAFT, OPEN]),
    profiles: fakeProfiles({ profile: PROFILE }),
    onProfileChanged: fn(),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getAllByRole("checkbox")).toHaveLength(2));
    const [draft, open] = canvas.getAllByRole("listitem").map((i) => within(i));
    // Each box is described by its poll's title, so a screen reader knows which it is.
    await expect(choice(open!)).toBeChecked();
    await expect(choice(open!)).toHaveAccessibleDescription(/^Name the new ferry /);
    await expect(choice(draft!)).not.toBeChecked();
    await userEvent.click(choice(draft!));
    // The public profile lists only polls that opened: a draft's tick is a promise.
    await expect(
      await draft!.findByText("Your profile will show this poll once it opens."),
    ).toBeVisible();
    await waitFor(() => expect(choice(draft!)).toBeChecked());
    await userEvent.click(choice(open!));
    await waitFor(() => expect(choice(open!)).not.toBeChecked());
    const profiles = args.profiles as ReturnType<typeof fakeProfiles>;
    await expect(profiles.calls).toEqual([`show ${DRAFT.id} true`, `show ${OPEN.id} false`]);
    await expect(args.onProfileChanged).toHaveBeenCalledTimes(2);
  },
};

/**
 * What a box does is said once, above the list, not under each of seven
 * polls (P2-29, the author's list's iteration 11), and describes every box;
 * it names the profile once, so no box's label repeats it (iteration 12).
 * A poll that hasn't opened isn't on the public profile yet, so its tick
 * answers when it will be (iteration 10); one that failed for good answers
 * as an open poll does: its election is on the record.
 */
export const ChoiceBeforeAPollOpens: Story = {
  args: {
    client: fakeDrafts(EVERY),
    profiles: fakeProfiles({ profile: PROFILE }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getAllByRole("checkbox")).toHaveLength(EVERY.length));
    // The note's text runs through the name's own element.
    const help = canvas.getByText(
      (_, e) =>
        e?.tagName === "P" &&
        e.textContent.startsWith(
          "Your profile is Harbor Street Neighbors. Ticking “Show on your profile” under a poll",
        ),
    );
    await expect(help).toHaveTextContent(
      /while the poll is listed\. A poll that hasn't opened yet is listed once it opens\./,
    );
    // The profile's name is drawn once, in the note, isolated as any name is (T-75).
    const names = canvas.getAllByText("Harbor Street Neighbors");
    await expect(names).toHaveLength(1);
    await expect(names[0]!.tagName).toBe("BDI");
    await expect(help).toContainElement(names[0]!);
    await expect(canvas.queryAllByText(/^Your profile lists this poll/)).toHaveLength(0);
    // Said above the list, before the first box.
    const list = canvas.getByRole("list");
    await expect(
      help.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const rows = canvas.getAllByRole("listitem").map((i) => within(i));
    for (const [i, p] of EVERY.entries())
      await expect(choice(rows[i]!)).toHaveAccessibleDescription(
        `${p.title === "" ? "Untitled draft" : p.title} ${help.textContent}`,
      );
    // Every poll but the open one, which the profile already shows.
    const answers = [];
    for (const row of rows.filter((_, i) => EVERY[i] !== OPEN)) {
      await userEvent.click(choice(row));
      answers.push((await row.findByText(/^Your profile (will show|shows) this poll/)).textContent);
    }
    const once = "Your profile will show this poll once it opens.";
    const now = "Your profile shows this poll.";
    await expect(answers).toEqual([once, once, once, now, once, now]);
  },
};

/** No profile: no choice under any poll; the profile's own section offers one. */
export const NoProfile: Story = {
  args: { client: fakeDrafts([DRAFT, OPEN]), profiles: fakeProfiles() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findAllByRole("listitem")).toHaveLength(2);
    await expect(canvas.queryByRole("checkbox")).toBeNull();
  },
};

/**
 * How many have answered each open or closed poll, under its row, tier by
 * tier as its page says it (`account-page.tsx`'s entries, P2-19 part 57):
 * every tier at zero said once, Tier 0 named by the deployment's checks, and
 * nothing for a draft, a poll in setup or one whose count couldn't be read.
 */
export const AnsweredSoFar: Story = {
  args: {
    client: fakeDrafts([DRAFT, SETTING_UP, OPEN, CLOSED, TIMED_OUT], {
      answered: {
        [OPEN.id]: [
          { tier: 0, answered: "38" },
          { tier: 2, answered: "1" },
        ],
        [CLOSED.id]: [{ tier: 0, answered: "0" }],
      },
    }),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const items = await canvas.findAllByRole("listitem");
    await expect(items).toHaveLength(5);
    const [draft, setup, open, closed, timedOut] = items.map((i) => within(i));
    const counts = await open!.findByRole("group", { name: "Answered so far" });
    await expect(counts).toHaveTextContent(/^38 people · Tier 0 \(verified e-mail\)/);
    await expect(counts).toHaveTextContent(/1 person · Tier 2 \(document-verified\)$/);
    await expect(await closed!.findByText("Answered before it closed")).toBeVisible();
    await expect(closed!.getByText("No one yet")).toBeVisible();
    for (const row of [draft!, setup!, timedOut!])
      await expect(row.queryByText(/^Answered/)).toBeNull();
    // Only the open and the closed poll are asked about.
    const asked = (args.client as ReturnType<typeof fakeDrafts>).asked;
    await expect(new Set(asked)).toEqual(new Set([OPEN.id, CLOSED.id]));
  },
};

export const AnsweredSoFarPhone: Story = {
  ...AnsweredSoFar,
  globals: { viewport: { value: "phone", isRotated: false } },
};

/** Where the deployment checks a phone, Tier 0 is named by both checks, as on the poll's page. */
export const AnsweredSoFarWithPhones: Story = {
  args: {
    phoneVerification: true,
    client: fakeDrafts([OPEN], { answered: { [OPEN.id]: [{ tier: 0, answered: "1" }] } }),
  },
  play: async ({ canvasElement }) => {
    const counts = await within(canvasElement).findByRole("group", { name: "Answered so far" });
    await expect(counts).toHaveTextContent("1 person · Tier 0 (verified e-mail and phone)");
  },
};

/** A count read after the session ended sends the page back to signing in, as every other read does. */
export const AnsweredSignedOut: Story = {
  args: {
    onSignedOut: fn(),
    client: fakeDrafts([OPEN], { answered: { [OPEN.id]: new DraftsError("signedOut") } }),
  },
  play: async ({ canvasElement, args }) => {
    await within(canvasElement).findByRole("listitem");
    await waitFor(() => expect(args.onSignedOut).toHaveBeenCalled());
    await expect(within(canvasElement).queryByText("Answered so far")).toBeNull();
  },
};
