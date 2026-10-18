import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import {
  type DraftsClient,
  DraftsError,
  type PollModerationView,
  type PollSummary,
} from "../account/drafts.ts";
import { AccountPolls } from "./account-polls.tsx";

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
  ...over,
});

const DRAFT = poll("draft", {});
const UNTITLED = poll("untitled", { title: "", updatedAt: "2026-10-12T08:00:00.000Z" });
const SETTING_UP = poll("setup", {
  state: "ceremony",
  title: "Which crossing should get a signal first?",
  submittedAt: "2026-10-16T18:05:00.000Z",
});
const OPEN = poll("open", { state: "open", title: "Name the new ferry" });
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

const EVERY = [DRAFT, UNTITLED, SETTING_UP, OPEN, TIMED_OUT, REGISTERED];

const meta = {
  component: AccountPolls,
  args: { index: "01" },
} satisfies Meta<typeof AccountPolls>;

export default meta;
type Story = StoryObj<typeof meta>;

const calls = (client: unknown) => (client as ReturnType<typeof fakeDrafts>).calls;

const showsEveryState: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const items = await canvas.findAllByRole("listitem");
  await expect(items).toHaveLength(EVERY.length);
  const [draft, untitled, setup, open, timedOut, registered] = items.map((i) => within(i));
  await expect(draft!.getByText("Draft")).toBeVisible();
  await expect(draft!.getByText("Last edited October 11, 2026 at 2:20 PM UTC")).toBeVisible();
  // A draft opens in the form; nothing past a draft does.
  await expect(
    draft!.getByRole("link", {
      name: "Edit draft",
      description: "Should the harbor library open on Sundays?",
    }),
  ).toHaveAttribute("href", `/account/polls/${DRAFT.id}`);
  await expect(setup!.queryByRole("link")).toBeNull();
  await expect(timedOut!.queryByRole("link")).toBeNull();
  await expect(untitled!.getByRole("heading", { name: "Untitled draft" })).toBeVisible();
  // Setup's steps are one state, never a step's name or a hash.
  await expect(setup!.getByText("Setting up")).toBeVisible();
  await expect(setup!.queryByText(/ceremony/i)).toBeNull();
  await expect(setup!.getByText("Submitted October 16, 2026 at 6:05 PM UTC")).toBeVisible();
  await expect(setup!.queryByRole("button")).toBeNull();
  await expect(open!.getByText("Closes November 4, 2026 at 12:00 AM UTC")).toBeVisible();
  await expect(open!.queryByRole("button")).toBeNull();
  // A failure in its own words, with what the author can do.
  await expect(timedOut!.getByText("Didn't open")).toBeVisible();
  await expect(
    timedOut!.getByText(/couldn't finish preparing its keys after four tries/),
  ).toBeVisible();
  await expect(
    timedOut!.getByRole("button", { name: "Try again", description: "Repaint the bandstand?" }),
  ).toBeVisible();
  // A registered poll stays: nothing to retry or discard.
  await expect(registered!.getByText(/It will never take answers/)).toBeVisible();
  await expect(registered!.queryByRole("button")).toBeNull();
};

export const EveryState: Story = {
  args: { client: fakeDrafts(EVERY) },
  play: showsEveryState,
};

export const EveryStateDark: Story = {
  args: { client: fakeDrafts(EVERY) },
  parameters: { theme: "dark" },
  play: showsEveryState,
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
