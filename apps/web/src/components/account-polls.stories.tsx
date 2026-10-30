import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import {
  type DraftsClient,
  DraftsError,
  type PollModerationView,
  type PollSummary,
} from "../account/drafts.ts";
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
  }: { refuse?: DraftsError; moderated?: Record<string, PollModerationView> } = {},
): DraftsClient & { calls: string[] } {
  let list = [...polls];
  const moderation = new Map(Object.entries(moderated));
  const calls: string[] = [];
  const act = (name: string, id: string, change: () => void) => {
    calls.push(`${name} ${id}`);
    if (refuse !== undefined) throw refuse;
    change();
  };
  return {
    calls,
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
  args: { index: "01", now: () => new Date("2026-10-18T12:00:00.000Z") },
} satisfies Meta<typeof AccountPolls>;

export default meta;
type Story = StoryObj<typeof meta>;

const calls = (client: unknown) => (client as ReturnType<typeof fakeDrafts>).calls;

const showsEveryState: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const items = await canvas.findAllByRole("listitem");
  await expect(items).toHaveLength(EVERY.length);
  const [draft, untitled, setup, open, closed, timedOut, registered] = items.map((i) => within(i));
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
  await expect(open!.getByText("Closes November 4, 2026 at 12:00 AM UTC")).toBeVisible();
  await expect(open!.queryByRole("button")).toBeNull();
  // The list still says `open` once the close has passed: the clock decides.
  await expect(closed!.getByText("Closed", { exact: true })).toBeVisible();
  await expect(closed!.queryByText("Open", { exact: true })).toBeNull();
  await expect(closed!.getByText("Closed October 17, 2026 at 12:00 AM UTC")).toBeVisible();
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
    timedOut!.getByText(/couldn't finish preparing its keys after four tries/),
  ).toBeVisible();
  await expect(
    timedOut!.getByRole("button", { name: "Try again", description: "Repaint the bandstand?" }),
  ).toBeVisible();
  // Why a poll waits or failed comes before what the author can do about it.
  const before = (reason: Element, action: Element) =>
    expect(reason.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await before(
    setup!.getByText(/^Setting up takes a while/),
    setup!.getByRole("link", { name: "Follow its setup" }),
  );
  await before(
    timedOut!.getByText(/couldn't finish preparing its keys/),
    timedOut!.getByRole("button", { name: "Try again" }),
  );
  // A registered poll stays: nothing to retry or discard. Its reason ends
  // "start a new poll", and the row has the way to, after the reason.
  await expect(registered!.getByText(/It will never take answers/)).toBeVisible();
  await expect(registered!.queryByRole("button")).toBeNull();
  await expect(
    registered!.getByRole("link", {
      name: "Start a new poll",
      description: "Move the market to Saturdays?",
    }),
  ).toHaveAttribute("href", "/account/polls/new");
  await before(
    registered!.getByText(/start a new poll\.$/),
    registered!.getByRole("link", { name: "Start a new poll" }),
  );
  // A time is in the state's face and size, never the evidence's monospace.
  for (const item of items) {
    const style = (e: Element) => getComputedStyle(e);
    const state = style(within(item).getByText(/^(Draft|Setting up|Open|Closed|Didn't open)$/));
    const time = style(within(item).getByText(/^(Last edited|Submitted|Closes|Closed) .* UTC$/));
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
      timedOut.getByText(/couldn't finish preparing its keys/).getBoundingClientRect().bottom,
    ).toBeLessThanOrEqual(
      timedOut.getByRole("button", { name: "Try again" }).getBoundingClientRect().top,
    );
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
      lefts((i) => within(i).getByText(/^(Last edited|Submitted|Closes|Closed) .* UTC$/)).size,
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

export const RetryAFailedPoll: Story = {
  args: { client: fakeDrafts([TIMED_OUT]) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Try again" }));
    await expect(await canvas.findByText("Draft")).toBeVisible();
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "Your poll is a draft again, as you wrote it.",
    );
    await expect(canvas.queryByText(/four tries/)).toBeNull();
    await expect(
      canvas.getByRole("heading", { level: 2, name: "Polls you created" }),
    ).toHaveFocus();
    await expect(calls(args.client)).toEqual([`retry ${TIMED_OUT.id}`]);
  },
};

export const DiscardAFailedPoll: Story = {
  args: { client: fakeDrafts([TIMED_OUT, DRAFT]) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Discard…" }));
    // Asks once more, and can step back.
    await userEvent.click(canvas.getByRole("button", { name: "Keep it" }));
    await expect(canvas.queryByRole("group")).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Discard…" }));
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
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Try again" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "That poll is registered on the public record, so it stays.",
    );
    await expect(canvas.getByRole("status")).toBeEmptyDOMElement();
  },
};

export const ListUnavailable: Story = {
  args: {
    client: {
      ...fakeDrafts([]),
      list: async () => {
        throw new DraftsError("failed");
      },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByRole("alert")).toHaveTextContent(
      "Your polls couldn't be loaded. Try again shortly.",
    );
  },
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
      name: "Delisted: Spam, October 17, 2026 at 4:45 PM UTC",
    });
    const moderation = within(block);
    await expect(moderation.getByText(/stays open at its address/)).toBeVisible();
    await expect(moderation.getByRole("link", { name: "See the moderation log" })).toHaveAttribute(
      "href",
      "/moderation",
    );
    // Asks once more, and can step back.
    await userEvent.click(
      moderation.getByRole("button", {
        name: "Appeal this decision…",
        description: "Name the new ferry",
      }),
    );
    await userEvent.click(moderation.getByRole("button", { name: "Not now" }));
    await expect(calls(args.client)).toEqual([]);
    await userEvent.click(moderation.getByRole("button", { name: "Appeal this decision…" }));
    await expect(moderation.getByRole("group", { name: /^Appeal this decision\?/ })).toBeVisible();
    await userEvent.click(moderation.getByRole("button", { name: "Send appeal" }));
    await expect(await moderation.findByRole("status")).toHaveTextContent(
      "Your appeal is filed. A different moderator will review it.",
    );
    await expect(
      moderation.getByText(
        "You appealed decision No. 41 on October 18, 2026 at 9:30 AM UTC: waiting for a moderator other than the one who decided.",
      ),
    ).toBeVisible();
    // Once filed, the decision can't be appealed again.
    await expect(moderation.queryByRole("button", { name: /Appeal/ })).toBeNull();
    await expect(
      moderation.getByText("Delisted: Spam, October 17, 2026 at 4:45 PM UTC"),
    ).toHaveFocus();
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

const HIDDEN_POLL = poll("hidden", { state: "open", title: "Rename the east pier?" });

const showsModeration: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const hidden = within(
    await canvas.findByRole("group", {
      name: "Text hidden: Personal data, October 16, 2026 at 8:00 AM UTC",
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
  await expect(hidden.queryByRole("button")).toBeNull();
  const restored = within(
    canvas.getByRole("group", { name: "Restored: Appeal upheld, October 17, 2026 at 3:00 PM UTC" }),
  );
  await expect(restored.getByText("Our pages list and show this poll again.")).toBeVisible();
  await expect(
    restored.getByText(/upheld on October 17, 2026 at 3:00 PM UTC, and the poll restored\./),
  ).toBeVisible();
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
  },
};

export const ModerationUnavailable: Story = {
  args: {
    client: {
      ...fakeDrafts([OPEN]),
      moderation: async () => {
        throw new DraftsError("failed");
      },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByRole("alert")).toHaveTextContent(
      "This poll's moderation couldn't be loaded. Try again shortly.",
    );
  },
};

const PROFILE = {
  handle: HANDLE,
  name: "Harbor Street Neighbors",
  renamableOn: undefined,
  pollIds: [OPEN.id],
};

const choice = (row: ReturnType<typeof within>) =>
  row.getByRole("checkbox", { name: "Show on your profile, Harbor Street Neighbors" });

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
    await expect(await draft!.findByText("Your profile shows this poll.")).toBeVisible();
    await waitFor(() => expect(choice(draft!)).toBeChecked());
    await userEvent.click(choice(open!));
    await waitFor(() => expect(choice(open!)).not.toBeChecked());
    const profiles = args.profiles as ReturnType<typeof fakeProfiles>;
    await expect(profiles.calls).toEqual([`show ${DRAFT.id} true`, `show ${OPEN.id} false`]);
    await expect(args.onProfileChanged).toHaveBeenCalledTimes(2);
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
