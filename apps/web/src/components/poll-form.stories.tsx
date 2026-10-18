import type { PollDraft } from "@abolishus/core/poll-draft-rules";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fireEvent, fn, userEvent, waitFor, within } from "storybook/test";

import {
  type DraftsClient,
  DraftsError,
  type PollSummary,
  type PollWithDraft,
} from "../account/drafts.ts";
import { PollFormPage } from "./poll-form.tsx";

const ID = "draft".padEnd(32, "0");
const NEW_ID = "made".padEnd(32, "0");

/** The stories' clock: every closing time is judged from here. */
const NOW = new Date("2026-10-18T12:00:00.000Z");

const SUMMARY: PollSummary = {
  id: ID,
  state: "drafted",
  title: "Harbor library hours",
  closesAt: 1793804400n,
  updatedAt: "2026-10-17T14:20:00.000Z",
  submittedAt: undefined,
  failure: undefined,
  retryable: false,
};

const SAVED: PollDraft = {
  language: "en",
  title: "Harbor library hours",
  description: "The council is weighing longer hours next year.",
  questions: [
    {
      question: "Should the harbor library open on Sundays?",
      description: "",
      options: [
        { label: "Yes", description: "" },
        { label: "No", description: "" },
      ],
      minSelections: 1,
      maxSelections: 1,
    },
    {
      question: "Which evenings should it stay open late?",
      description: "Until 9 PM.",
      options: [
        { label: "Monday", description: "" },
        { label: "Wednesday", description: "" },
        { label: "Friday", description: "Busiest at the ferry" },
      ],
      minSelections: 0,
      maxSelections: 2,
    },
  ],
  tiers: [0],
  // 2026-11-04T15:00:00Z
  closesAt: 1793804400n,
};

/** A drafts handler in memory: the form's calls, with no network. */
function fakeDrafts({
  read,
  refuse,
}: { read?: PollWithDraft; refuse?: DraftsError } = {}): DraftsClient & {
  writes: [string, string | undefined, PollDraft][];
} {
  const writes: [string, string | undefined, PollDraft][] = [];
  return {
    writes,
    list: async () => [],
    remove: async () => {},
    retry: async () => {},
    discard: async () => {},
    read: async () => {
      if (read === undefined) throw new DraftsError("gone");
      return read;
    },
    create: async (draft) => {
      writes.push(["create", undefined, draft]);
      if (refuse !== undefined) throw refuse;
      return NEW_ID;
    },
    update: async (id, draft) => {
      writes.push(["update", id, draft]);
      if (refuse !== undefined) throw refuse;
    },
    // The form never reads moderation: the list's stories do (account-polls.stories.tsx).
    moderation: async () => {
      throw new DraftsError("failed");
    },
    appeal: async () => {
      throw new DraftsError("failed");
    },
  };
}

const writes = (client: unknown) => (client as ReturnType<typeof fakeDrafts>).writes;

const meta = {
  component: PollFormPage,
  args: { now: () => NOW, timeZone: "America/New_York" },
} satisfies Meta<typeof PollFormPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NewPoll: Story = {
  args: { client: fakeDrafts(), onCreated: fn() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1, name: "Create a poll" })).toBeVisible();
    // Saving an empty form names every problem, linked to its field, and sends nothing.
    await userEvent.click(await canvas.findByRole("button", { name: "Save draft" }));
    const summary = await canvas.findByRole("region", { name: "Your draft wasn't saved" });
    await expect(summary).toHaveFocus();
    const links = within(summary).getAllByRole("link");
    await expect(links.map((l) => l.textContent)).toEqual([
      "Give your poll a title.",
      "Question 1: Write the question.",
      "Question 1: Give this option its words, or remove it.",
      "Question 1: Give this option its words, or remove it.",
      "Choose a closing date and time.",
    ]);
    await expect(writes(args.client)).toEqual([]);
    await userEvent.click(links[0]!);
    const title = canvas.getByRole("textbox", { name: "Title" });
    await expect(title).toHaveFocus();
    await expect(title).toHaveAttribute("aria-invalid", "true");
    // A fixed field drops its error at once.
    await userEvent.type(title, "Harbor library hours");
    await expect(title).not.toHaveAttribute("aria-invalid");
    await expect(within(summary).getAllByRole("link")).toHaveLength(4);
  },
};

export const WriteAndSave: Story = {
  args: { client: fakeDrafts(), onCreated: fn() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByRole("textbox", { name: "Title" }), "Ferry name");
    await userEvent.type(
      canvas.getByRole("textbox", { name: "What do you want to ask?" }),
      "What should the new ferry be called?",
    );
    await userEvent.type(canvas.getByRole("textbox", { name: "Option 1" }), "Heron");
    await userEvent.type(canvas.getByRole("textbox", { name: "Option 2" }), "Tern");
    await userEvent.click(canvas.getByRole("button", { name: "Add an option to question 1" }));
    await userEvent.type(canvas.getByRole("textbox", { name: "Option 3" }), "Gull");
    fireEvent.change(canvas.getByLabelText("Closing date (UTC)"), {
      target: { value: "2026-11-04" },
    });
    fireEvent.change(canvas.getByLabelText("Closing time (UTC)"), { target: { value: "15:00" } });
    // The author's own time beside the UTC one.
    await expect(
      canvas.getByText("That's November 4, 2026 at 10:00 AM where you are."),
    ).toBeVisible();
    // The preview reads as the poll will.
    const preview = within(canvas.getByRole("complementary", { name: "What people will see" }));
    await expect(preview.getByText("What should the new ferry be called?")).toBeVisible();
    await expect(preview.getByText("Choose one.")).toBeVisible();
    await expect(preview.getByText("Gull")).toBeVisible();

    await userEvent.click(canvas.getByRole("button", { name: "Save draft" }));
    await expect(await canvas.findByText("Your draft is saved.")).toBeVisible();
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveFocus();
    await expect(args.onCreated).toHaveBeenCalledWith(NEW_ID);
    // A second save edits the draft the first one made.
    await userEvent.type(canvas.getByRole("textbox", { name: "Option 3" }), "s");
    await expect(canvas.queryByText("Your draft is saved.")).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Save draft" }));
    await expect(await canvas.findByText("Your draft is saved.")).toBeVisible();
    const sent = writes(args.client);
    await expect(sent.map(([call, id]) => [call, id])).toEqual([
      ["create", undefined],
      ["update", NEW_ID],
    ]);
    await expect(sent[0]![2]).toEqual({
      language: "en",
      title: "Ferry name",
      description: "",
      questions: [
        {
          question: "What should the new ferry be called?",
          description: "",
          options: [
            { label: "Heron", description: "" },
            { label: "Tern", description: "" },
            { label: "Gull", description: "" },
          ],
          minSelections: 1,
          maxSelections: 1,
        },
      ],
      tiers: [0],
      closesAt: 1793804400n,
    });
  },
};

const editsADraft: Story["play"] = async ({ canvasElement, args }) => {
  const canvas = within(canvasElement);
  await expect(
    await canvas.findByRole("heading", { level: 1, name: "Edit your poll" }),
  ).toBeVisible();
  await expect(canvas.getByRole("textbox", { name: "Title" })).toHaveValue("Harbor library hours");
  // The second question's range reads back as the rule it is.
  await expect(canvas.getAllByRole("radio", { name: "Up to a number" })[1]).toBeChecked();
  await expect(canvas.getAllByRole("spinbutton", { name: "Up to" })[0]).toHaveValue(2);
  await expect(
    canvas.getAllByRole("checkbox", { name: "People can leave this question blank" })[1],
  ).toBeChecked();
  await expect(canvas.getByLabelText("Closing date (UTC)")).toHaveValue("2026-11-04");
  await expect(canvas.getByLabelText("Closing time (UTC)")).toHaveValue("15:00");
  const preview = within(canvas.getByRole("complementary", { name: "What people will see" }));
  await expect(
    preview.getByText("Choose up to 2. You can leave this question blank."),
  ).toBeVisible();
  await expect(preview.getByText("Busiest at the ferry")).toBeVisible();
  // Saved unchanged, it is the draft it was.
  await userEvent.click(canvas.getByRole("button", { name: "Save draft" }));
  await expect(await canvas.findByText("Your draft is saved.")).toBeVisible();
  await expect(writes(args.client)).toEqual([["update", ID, SAVED]]);
};

export const EditADraft: Story = {
  args: { client: fakeDrafts({ read: { summary: SUMMARY, draft: SAVED } }), id: ID },
  play: editsADraft,
};

export const EditADraftDark: Story = {
  args: { client: fakeDrafts({ read: { summary: SUMMARY, draft: SAVED } }), id: ID },
  parameters: { theme: "dark" },
  play: editsADraft,
};

export const ReorderAndRemove: Story = {
  args: { client: fakeDrafts({ read: { summary: SUMMARY, draft: SAVED } }), id: ID },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Move question 2 up" }));
    await userEvent.click(canvas.getByRole("button", { name: "Remove option 1 of question 1" }));
    await userEvent.click(canvas.getByRole("button", { name: "Remove question 2" }));
    await userEvent.click(canvas.getByRole("button", { name: "Save draft" }));
    await expect(await canvas.findByText("Your draft is saved.")).toBeVisible();
    const [, , draft] = writes(args.client)[0]!;
    await expect(draft.questions).toEqual([
      {
        ...SAVED.questions[1]!,
        options: SAVED.questions[1]!.options.slice(1),
      },
    ]);
  },
};

export const ProblemsInAQuestion: Story = {
  args: { client: fakeDrafts({ read: { summary: SUMMARY, draft: SAVED } }), id: ID },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const second = within(await canvas.findByRole("region", { name: "Question 2" }));
    // Two options alike, and a range the options can't meet.
    const option = second.getByRole("textbox", { name: "Option 2" });
    await userEvent.clear(option);
    await userEvent.type(option, "Monday");
    await userEvent.click(second.getByRole("radio", { name: "Exactly a number" }));
    const exactly = second.getByRole("spinbutton", { name: "Exactly" });
    await userEvent.clear(exactly);
    await userEvent.type(exactly, "4");
    await userEvent.click(canvas.getByRole("button", { name: "Save draft" }));
    const summary = await canvas.findByRole("region", { name: "Your draft wasn't saved" });
    await expect(
      within(summary)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual([
      "Question 2: These numbers don't fit the options: an answer must be able to pick at least one, and no more than there are.",
      "Question 2: Another option of this question says the same. People couldn't tell them apart.",
    ]);
    await expect(writes(args.client)).toEqual([]);
  },
};

export const ClosesTooSoon: Story = {
  args: { client: fakeDrafts({ read: { summary: SUMMARY, draft: SAVED } }), id: ID },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const time = await canvas.findByLabelText("Closing time (UTC)");
    const date = canvas.getByLabelText("Closing date (UTC)");
    // Date and time fields take a whole value, as a picker gives one.
    fireEvent.change(date, { target: { value: "2026-10-18" } });
    fireEvent.change(time, { target: { value: "13:00" } });
    await userEvent.click(canvas.getByRole("button", { name: "Save draft" }));
    await expect(
      await canvas.findByRole("region", { name: "Your draft wasn't saved" }),
    ).toHaveTextContent("Choose a time at least 90 minutes from now.");
    await expect(date).toHaveAttribute("aria-invalid", "true");
  },
};

export const SubmittedElsewhere: Story = {
  args: {
    client: fakeDrafts({
      read: {
        summary: { ...SUMMARY, state: "ceremony", submittedAt: "2026-10-17T15:00:00.000Z" },
        draft: SAVED,
      },
    }),
    id: ID,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "This poll was submitted for setup, so it can't be changed any more.",
    );
    await expect(canvas.queryByRole("button", { name: "Save draft" })).toBeNull();
  },
};

export const DraftGone: Story = {
  args: { client: fakeDrafts(), id: ID },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByRole("alert")).toHaveTextContent(
      "That draft is no longer here.",
    );
  },
};

export const SignedOutOnSave: Story = {
  args: {
    client: fakeDrafts({
      read: { summary: SUMMARY, draft: SAVED },
      refuse: new DraftsError("signedOut"),
    }),
    id: ID,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(canvas.getByRole("alert")).toHaveTextContent("You've been signed out."),
    );
    // What was written stays on the page.
    await expect(canvas.getByRole("textbox", { name: "Title" })).toHaveValue(
      "Harbor library hours",
    );
    await expect(canvas.getByRole("status")).toBeEmptyDOMElement();
  },
};

export const TooManyDrafts: Story = {
  args: {
    client: fakeDrafts({ refuse: new DraftsError("tooManyDrafts") }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByRole("textbox", { name: "Title" }), "Ferry name");
    await userEvent.type(
      canvas.getByRole("textbox", { name: "What do you want to ask?" }),
      "What should the new ferry be called?",
    );
    await userEvent.type(canvas.getByRole("textbox", { name: "Option 1" }), "Heron");
    await userEvent.type(canvas.getByRole("textbox", { name: "Option 2" }), "Tern");
    fireEvent.change(canvas.getByLabelText("Closing date (UTC)"), {
      target: { value: "2026-11-04" },
    });
    fireEvent.change(canvas.getByLabelText("Closing time (UTC)"), { target: { value: "15:00" } });
    await userEvent.click(canvas.getByRole("button", { name: "Save draft" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "You have as many drafts as an account can hold.",
    );
  },
};
