import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, waitFor, within } from "storybook/test";

import { type DraftsClient, DraftsError, type PollSummary } from "../account/drafts.ts";
import { PollSetupPage } from "./poll-setup.tsx";

const ID = "setup".padEnd(32, "0");
const ELECTION = "0e".repeat(32);

const poll = (over: Partial<PollSummary>): PollSummary => ({
  id: ID,
  state: "submitted",
  title: "Which crossing should get a signal first?",
  closesAt: 1793750400n, // 2026-11-04T00:00:00Z
  updatedAt: "2026-10-16T18:05:00.000Z",
  submittedAt: "2026-10-16T18:05:00.000Z",
  failure: undefined,
  retryable: false,
  electionId: undefined,
  ...over,
});

/**
 * The drafts handler as setup moves on: every read answers the current one
 * of `answers` (an error is thrown) until the story moves it to the next
 * (`advance`), so a story never races the page's timer.
 */
function setupDrafts(
  ...answers: (PollSummary | DraftsError)[]
): DraftsClient & { reads: number; at: number } {
  const refused = async (): Promise<never> => {
    throw new DraftsError("failed");
  };
  const client = {
    reads: 0,
    at: 0,
    list: refused,
    remove: refused,
    retry: refused,
    discard: refused,
    create: refused,
    update: refused,
    moderation: refused,
    appeal: refused,
    answered: refused,
    submit: refused,
    read: async (id: string) => {
      const answer = answers[Math.min(client.at, answers.length - 1)];
      client.reads += 1;
      if (answer === undefined || answer instanceof DraftsError) throw answer;
      if (id !== answer.id) throw new DraftsError("gone");
      return {
        summary: answer,
        draft: {
          language: "en",
          title: answer.title,
          description: "",
          questions: [],
          tiers: [0],
          closesAt: answer.closesAt,
        },
      };
    },
  };
  return client;
}

const meta = {
  component: PollSetupPage,
  args: { id: ID, every: 30 },
} satisfies Meta<typeof PollSetupPage>;

export default meta;
type Story = StoryObj<typeof meta>;

const reads = (client: unknown) => (client as ReturnType<typeof setupDrafts>).reads;
/** Moves setup on: the page's next read gets the next answer. */
const advance = (client: unknown) => {
  (client as ReturnType<typeof setupDrafts>).at += 1;
};
const saysNow = (canvasElement: HTMLElement, step: string) =>
  waitFor(() =>
    expect(within(canvasElement).getByRole("status")).toHaveTextContent(`Now: ${step}.`),
  );

/** Each step's line with what the screen reader hears after it. */
const steps = (canvasElement: HTMLElement) =>
  within(canvasElement)
    .getAllByRole("listitem")
    .map((li) => li.textContent);

const followsSetupToOpen: Story["play"] = async ({ canvasElement, args }) => {
  const canvas = within(canvasElement);
  await expect(
    canvas.getByRole("heading", { level: 1, name: "Setting up your poll" }),
  ).toBeVisible();
  await expect(
    await canvas.findByRole("heading", { name: "Which crossing should get a signal first?" }),
  ).toBeVisible();
  await expect(steps(canvasElement)).toEqual([
    "Submitted (done)",
    "Put on the public record (under way)",
    "The people who can answer counted (still to come)",
    "The trustees make the key that seals answers (still to come)",
    "Checked and opened for answers (still to come)",
  ]);
  await expect(canvas.getByRole("status")).toHaveTextContent("Now: Put on the public record.");
  advance(args.client);
  await saysNow(canvasElement, "The people who can answer counted");
  // The key's step is under way through the worker's two states, never named.
  for (let i = 0; i < 2; i++) {
    advance(args.client);
    await saysNow(canvasElement, "The trustees make the key that seals answers");
    await expect(canvas.queryByText(/ceremony|rooted|registered/i)).toBeNull();
    await expect(canvas.getByRole("listitem", { current: "step" })).toHaveTextContent(
      "The trustees make the key that seals answers",
    );
  }
  advance(args.client);
  await saysNow(canvasElement, "Checked and opened for answers");
  // Open: every step done, the link to its public page, and no more reads.
  advance(args.client);
  await expect(await canvas.findByRole("link", { name: "Go to your poll's page" })).toHaveAttribute(
    "href",
    `/polls/${ELECTION}`,
  );
  await expect(canvas.getByRole("status")).toHaveTextContent(
    "Your poll is open.People can answer until November 4, 2026 at 12:00 AM UTC.",
  );
  await expect(steps(canvasElement).every((s) => s?.endsWith("(done)"))).toBe(true);
  await expect(canvas.queryByRole("listitem", { current: "step" })).toBeNull();
  const done = reads(args.client);
  await new Promise((r) => setTimeout(r, 120));
  await expect(reads(args.client)).toBe(done);
};

const throughSetup = () =>
  setupDrafts(
    poll({}),
    poll({ state: "created" }),
    poll({ state: "rooted" }),
    poll({ state: "ceremony" }),
    poll({ state: "registered" }),
    poll({ state: "open", electionId: ELECTION }),
  );

export const FollowsSetupToOpen: Story = {
  args: { client: throughSetup() },
  play: followsSetupToOpen,
};

export const FollowsSetupToOpenDark: Story = {
  args: { client: throughSetup() },
  parameters: { theme: "dark" },
  play: followsSetupToOpen,
};

export const Failed: Story = {
  args: {
    client: setupDrafts(
      poll({ state: "rooted" }),
      poll({ state: "failed", failure: "ceremony-timeout", retryable: true }),
    ),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await saysNow(canvasElement, "The trustees make the key that seals answers");
    advance(args.client);
    const alert = await canvas.findByRole("alert");
    await expect(alert).toHaveTextContent("Your poll didn't open.");
    await expect(alert).toHaveTextContent(
      /Making the key that seals your poll's answers didn't finish after four tries/,
    );
    await expect(
      within(alert).getByRole("link", {
        name: "Back to your polls, to submit it again or discard it",
      }),
    ).toHaveAttribute("href", "/account");
    await expect(canvas.queryByRole("list")).toBeNull();
    const done = reads(args.client);
    await new Promise((r) => setTimeout(r, 120));
    await expect(reads(args.client)).toBe(done);
  },
};

export const FailedRegistered: Story = {
  args: {
    client: setupDrafts(poll({ state: "failed", failure: "open-mismatch", retryable: false })),
  },
  play: async ({ canvasElement }) => {
    const alert = await within(canvasElement).findByRole("alert");
    await expect(alert).toHaveTextContent(/It will never take answers/);
    // Nothing to retry or discard: the link says only where the list is.
    await expect(within(alert).getByRole("link", { name: "Back to your polls" })).toBeVisible();
  },
};

export const ACheckThatFails: Story = {
  args: { client: setupDrafts(poll({}), new DraftsError("failed"), poll({ state: "created" })) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await saysNow(canvasElement, "Put on the public record");
    // A read that fails keeps what was shown, says so, and the next one carries on.
    advance(args.client);
    await expect(await canvas.findByText(/couldn't check just now/)).toBeVisible();
    await expect(canvas.getByRole("status")).toHaveTextContent("Now: Put on the public record.");
    advance(args.client);
    await saysNow(canvasElement, "The people who can answer counted");
    await expect(canvas.getByText(/You can leave it/)).toBeVisible();
  },
};

export const NotSubmitted: Story = {
  args: { client: setupDrafts(poll({ state: "drafted", submittedAt: undefined })) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/hasn't been submitted/)).toBeVisible();
    await expect(canvas.getByRole("link", { name: "Edit draft" })).toHaveAttribute(
      "href",
      `/account/polls/${ID}`,
    );
    await expect(canvas.queryByRole("list")).toBeNull();
  },
};

export const SignedOut: Story = {
  args: { client: setupDrafts(new DraftsError("signedOut")) },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByRole("alert")).toHaveTextContent(
      "You've been signed out.",
    );
  },
};

export const Gone: Story = {
  args: { client: setupDrafts(poll({}), new DraftsError("gone")) },
  play: async ({ canvasElement, args }) => {
    await saysNow(canvasElement, "Put on the public record");
    advance(args.client);
    await expect(await within(canvasElement).findByRole("alert")).toHaveTextContent(
      "That poll is no longer here.",
    );
  },
};

export const NotAPollId: Story = {
  args: { client: setupDrafts(poll({})), id: "new" },
  play: async ({ canvasElement, args }) => {
    await expect(await within(canvasElement).findByRole("alert")).toHaveTextContent(
      "That poll is no longer here.",
    );
    await expect(reads(args.client)).toBe(0);
  },
};

export const Unloaded: Story = {
  args: { client: setupDrafts(new DraftsError("failed")) },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByRole("alert")).toHaveTextContent(
      "Your poll couldn't be loaded.",
    );
  },
};

export const UnloadedThenLoaded: Story = {
  args: { client: setupDrafts(new DraftsError("failed"), poll({})) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    // A first read that fails isn't the last: the next one shows the steps.
    await expect(await canvas.findByRole("alert")).toHaveTextContent(/tries again/);
    advance(args.client);
    await saysNow(canvasElement, "Put on the public record");
    await expect(canvas.queryByRole("alert")).toBeNull();
  },
};
