import type { PollDraft } from "@abolishus/core/poll-draft-rules";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fireEvent, fn, userEvent, waitFor, within } from "storybook/test";

import { type Challenge, ChallengeError } from "../account/challenge.ts";
import {
  type DraftsClient,
  DraftsError,
  type PollSummary,
  type PollWithDraft,
} from "../account/drafts.ts";
import { ProfilesError } from "../account/profiles.ts";
import { PollFormPage } from "./poll-form.tsx";
import { fakeProfiles, HANDLE } from "./profiles-fake.ts";

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
  electionId: undefined,
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
  refuseSubmit,
  hold,
}: {
  read?: PollWithDraft;
  refuse?: DraftsError;
  refuseSubmit?: DraftsError;
  /** Updates answer only once this settles. */
  hold?: Promise<void>;
} = {}): DraftsClient & {
  writes: [string, string | undefined, PollDraft][];
  submits: [string, string][];
} {
  const writes: [string, string | undefined, PollDraft][] = [];
  const submits: [string, string][] = [];
  return {
    writes,
    submits,
    submit: async (id, token) => {
      submits.push([id, token]);
      if (refuseSubmit !== undefined) throw refuseSubmit;
    },
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
      await hold;
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

const savedDraft = () => fakeDrafts({ read: { summary: SUMMARY, draft: SAVED } });

const writes = (client: unknown) => (client as ReturnType<typeof fakeDrafts>).writes;
const submits = (client: unknown) => (client as ReturnType<typeof fakeDrafts>).submits;

/**
 * Turnstile's stand-in: a button in the check's place that solves it, or a
 * check that can't load. Each solve's action and signal are kept.
 */
function fakeChallenge({ unavailable = false } = {}): Challenge & {
  solves: [string, AbortSignal][];
} {
  const solves: [string, AbortSignal][] = [];
  return {
    solves,
    solve: (container, action, signal) => {
      solves.push([action, signal]);
      if (unavailable) return Promise.reject(new ChallengeError());
      return new Promise((resolve, reject) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "I'm a person";
        button.onclick = () => {
          button.remove();
          resolve(`token-${solves.length}`);
        };
        signal.addEventListener("abort", () => {
          button.remove();
          reject(signal.reason);
        });
        container.append(button);
      });
    },
  };
}

const solves = (challenge: unknown) => (challenge as ReturnType<typeof fakeChallenge>).solves;

const meta = {
  component: PollFormPage,
  args: { now: () => NOW, timeZone: "America/New_York", phoneVerification: false },
} satisfies Meta<typeof PollFormPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NewPoll: Story = {
  args: { client: fakeDrafts(), onCreated: fn() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    // Named as home's way in names it, with no list to go back to before a
    // first save: a first-time asker has none (P2-29, creating a poll's
    // iteration 1).
    await expect(canvas.getByRole("heading", { level: 1, name: "Ask a question" })).toBeVisible();
    await expect(canvas.getByText("New poll")).toBeVisible();
    await expect(canvas.queryByRole("link", { name: "Back to your polls" })).toBeNull();
    // The everyday register leaves its sections unnumbered (P2-29, creating
    // a poll's iteration 3).
    await expect(canvasElement.querySelector("[data-slot='section-mark']")).toBeNull();
    // Nothing to check through or submit before a first save, only the way to
    // it (P2-29, creating a poll's iteration 2).
    await expect(canvas.queryByRole("region", { name: "Check it through" })).toBeNull();
    await expect(canvas.queryByRole("button", { name: "Submit poll" })).toBeNull();
    await expect(
      canvas.getByText("Save your draft first. Then you can check it through here and submit it."),
    ).toBeVisible();
    // The lede leaves the poll's title field on a small phone's first screen.
    await expect(
      canvas.getByRole("textbox", { name: "Title" }).getBoundingClientRect().bottom,
    ).toBeLessThanOrEqual(640);
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
    fireEvent.change(canvas.getByLabelText("Closing date"), {
      target: { value: "2026-11-04" },
    });
    fireEvent.change(canvas.getByLabelText("Closing time"), { target: { value: "10:00" } });
    // Typed on the author's own clock, with the time people answering see.
    await expect(canvas.getByText(/on your own clock \(Eastern Time\)/)).toBeVisible();
    await expect(
      canvas.getByText(
        "People answering see it as November 4, 2026 at 3:00 PM UTC, the clock every poll keeps.",
      ),
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
    // Saved, it is a draft in the author's list, and the page says so.
    await expect(canvas.getByRole("heading", { level: 1, name: "Edit your poll" })).toBeVisible();
    await expect(canvas.getAllByRole("link", { name: "Back to your polls" })).toHaveLength(2);
    // And it can be checked through and submitted.
    await expect(canvas.getByRole("region", { name: "Check it through" })).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Submit poll" })).toBeEnabled();
    await expect(
      canvas.queryByText(
        "Save your draft first. Then you can check it through here and submit it.",
      ),
    ).toBeNull();
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

export const TopicAndPlace: Story = {
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
    fireEvent.change(canvas.getByLabelText("Closing date"), {
      target: { value: "2026-11-04" },
    });
    fireEvent.change(canvas.getByLabelText("Closing time"), { target: { value: "10:00" } });
    const preview = within(canvas.getByRole("complementary", { name: "What people will see" }));
    await expect(preview.getByText("Not under any topic or place.")).toBeVisible();
    // Spacing as pasted is tidied to one line, as the draft will hold it.
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Place (optional)" }),
      "  Harbor   Ward ",
    );
    await userEvent.selectOptions(
      canvas.getByRole("combobox", { name: "Topic (optional)" }),
      "Transport",
    );
    await expect(preview.getByText("Harbor Ward")).toBeVisible();
    await expect(preview.getByText("Transport")).toBeVisible();

    await userEvent.click(canvas.getByRole("button", { name: "Save draft" }));
    await expect(await canvas.findByText("Your draft is saved.")).toBeVisible();
    // The review keeps where it is listed apart from what is recorded for good.
    const review = within(canvas.getByRole("region", { name: "Check it through" }));
    const terms = review.getAllByRole("term").map((d) => d.textContent);
    await expect(terms).toEqual([
      "Title",
      "Questions",
      "Who can answer",
      "Closes",
      "Place",
      "Topic",
    ]);
    await expect(
      review.getByText("November 4, 2026 at 10:00 AM your time (3:00 PM UTC)"),
    ).toBeVisible();
    await expect(review.getByText("Harbor Ward")).toBeVisible();
    // With phone verification off, Tier 0 is named by the e-mail alone, in words.
    await expect(review.getByText("People with a verified e-mail address")).toBeVisible();
    await userEvent.click(review.getByRole("link", { name: "Change Topic" }));
    await expect(canvas.getByRole("combobox", { name: "Topic (optional)" })).toHaveFocus();
    await expect(writes(args.client)[0]![2]).toMatchObject({
      title: "Ferry name",
      topic: "transport",
      place: "Harbor Ward",
    });
    // Choosing no topic again sends none.
    await userEvent.selectOptions(
      canvas.getByRole("combobox", { name: "Topic (optional)" }),
      "No topic",
    );
    await userEvent.clear(canvas.getByRole("textbox", { name: "Place (optional)" }));
    await userEvent.click(canvas.getByRole("button", { name: "Save draft" }));
    await expect(await canvas.findByText("Your draft is saved.")).toBeVisible();
    const second = writes(args.client)[1]![2];
    await expect(second).not.toHaveProperty("topic");
    await expect(second).not.toHaveProperty("place");
  },
};

/**
 * With phone verification on, Tier 0 is named by both checks, in the form and
 * its review, in words rather than its code (P2-29, creating a poll's
 * iteration 2), and what counts once is the number.
 */
export const PhoneVerification: Story = {
  args: { client: savedDraft(), id: ID, phoneVerification: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const who = within(await canvas.findByRole("region", { name: "Who can answer?" }));
    const name = "People with a verified e-mail address and phone number";
    await expect(who.getByText(name)).toBeVisible();
    await expect(who.getByText(/Each verified phone number counts once/)).toBeVisible();
    const review = within(canvas.getByRole("region", { name: "Check it through" }));
    await expect(review.getByText(name)).toBeVisible();
    await expect(canvas.queryByText(/Tier 0/)).toBeNull();
  },
};

/** Without it, what counts once is the address, and no tier's code is shown. */
export const EmailVerification: Story = {
  args: { client: savedDraft(), id: ID },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const who = within(await canvas.findByRole("region", { name: "Who can answer?" }));
    await expect(who.getByText("People with a verified e-mail address")).toBeVisible();
    await expect(who.getByText(/Each verified e-mail address counts once/)).toBeVisible();
    await expect(canvas.queryByText(/Tier 0|voting identity/)).toBeNull();
  },
};

/**
 * Where the preview stacks on a phone, it comes after saving and before the
 * review, where it came last, under the submit button (P2-29, creating a
 * poll's iteration 2).
 */
export const PreviewBeforeSubmitPhone: Story = {
  args: { client: savedDraft(), id: ID, challenge: fakeChallenge() },
  globals: { viewport: { value: "phone", isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvasElement.ownerDocument.documentElement.clientWidth).toBe(360);
    const preview = (
      await canvas.findByRole("complementary", { name: "What people will see" })
    ).getBoundingClientRect();
    const save = canvas.getByRole("button", { name: "Save draft" }).getBoundingClientRect();
    const review = canvas.getByRole("region", { name: "Check it through" }).getBoundingClientRect();
    await expect(preview.top).toBeGreaterThan(save.bottom);
    await expect(preview.bottom).toBeLessThan(review.top);
  },
};

export const OptionControlsPhone: Story = {
  args: { client: fakeDrafts() },
  globals: { viewport: { value: "phone", isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvasElement.ownerDocument.documentElement.clientWidth).toBe(360);
    // An option's move and remove buttons share its label's row, so they
    // never wrap between its field and its details (P2-29, creating a
    // poll's iteration 3).
    const label = canvas.getByText("Option 1", { selector: "label" }).getBoundingClientRect();
    const field = (
      await canvas.findByRole("textbox", { name: "Option 1" })
    ).getBoundingClientRect();
    const buttons = canvas.getAllByRole("button", { name: /option 1 of question 1/ });
    await expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      const box = button.getBoundingClientRect();
      await expect(box.top).toBeLessThan(label.bottom);
      await expect(box.bottom).toBeLessThanOrEqual(field.top);
    }
    const details = canvas
      .getByRole("textbox", { name: "Details for option 1 (optional)" })
      .getBoundingClientRect();
    await expect(field.width).toBe(details.width);
  },
};

export const ReviewPhone: Story = {
  args: { client: savedDraft(), id: ID, challenge: fakeChallenge() },
  globals: { viewport: { value: "phone", isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvasElement.ownerDocument.documentElement.clientWidth).toBe(360);
    const review = await canvas.findByRole("region", { name: "Check it through" });
    // Each "Change" shares its label's row, where it took a row of its own
    // under every value (P2-29, creating a poll's iteration 4).
    for (const term of within(review).getAllByRole("term")) {
      const change = within(review).queryByRole("link", { name: `Change ${term.textContent}` });
      if (change === null) continue;
      const label = term.getBoundingClientRect();
      const link = change.getBoundingClientRect();
      await expect(link.top).toBeLessThan(label.bottom);
      await expect(link.bottom).toBeGreaterThan(label.top);
    }
    // The closing time says its date once where both clocks share the day.
    await expect(
      within(review).getByText("November 4, 2026 at 10:00 AM your time (3:00 PM UTC)"),
    ).toBeVisible();
    // The When section's lede is its rule alone, three lines at most.
    const lede = canvas.getByText(/^Choose a time on your own clock/);
    const lines =
      lede.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(lede).lineHeight);
    await expect(lines).toBeLessThanOrEqual(3);
  },
};

export const ClosesOnAnotherUtcDay: Story = {
  args: {
    client: fakeDrafts({
      // 2026-11-05T03:30:00Z, the evening before in New York.
      read: { summary: SUMMARY, draft: { ...SAVED, closesAt: 1793849400n } },
    }),
    id: ID,
    challenge: fakeChallenge(),
  },
  play: async ({ canvasElement }) => {
    const review = within(
      await within(canvasElement).findByRole("region", { name: "Check it through" }),
    );
    await expect(
      review.getByText("November 4, 2026 at 10:30 PM your time (November 5, 2026 at 3:30 AM UTC)"),
    ).toBeVisible();
  },
};

export const ClosesSkipped: Story = {
  args: { client: fakeDrafts({ read: { summary: SUMMARY, draft: SAVED } }), id: ID },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const time = await canvas.findByLabelText("Closing time");
    // New York's clocks go from 2:00 to 3:00 that night: 2:30 never comes.
    fireEvent.change(canvas.getByLabelText("Closing date"), { target: { value: "2027-03-14" } });
    fireEvent.change(time, { target: { value: "02:30" } });
    await expect(canvas.queryByText(/People answering see it as/)).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Save draft" }));
    await expect(
      await canvas.findByRole("region", { name: "Your draft wasn't saved" }),
    ).toHaveTextContent(
      "Your clock skips that time when it moves forward an hour. Choose another time.",
    );
    await expect(writes(args.client)).toEqual([]);
  },
};

export const PlaceRefused: Story = {
  args: { client: fakeDrafts({ read: { summary: SUMMARY, draft: SAVED } }), id: ID },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const place = await canvas.findByRole("textbox", { name: "Place (optional)" });
    // T-67: a text-direction override could make the place read as other words.
    fireEvent.change(place, { target: { value: "\u202eedisreviR" } });
    await userEvent.click(canvas.getByRole("button", { name: "Save draft" }));
    const summary = await canvas.findByRole("region", { name: "Your draft wasn't saved" });
    await expect(
      within(summary)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual([
      "This holds a hidden character or a text-direction mark a place can't have. Retype it.",
    ]);
    await expect(place).toHaveAttribute("aria-invalid", "true");
    await expect(writes(args.client)).toEqual([]);
    fireEvent.change(place, { target: { value: "x".repeat(81) } });
    await userEvent.click(canvas.getByRole("button", { name: "Save draft" }));
    await expect(
      within(await canvas.findByRole("region", { name: "Your draft wasn't saved" })).getByRole(
        "link",
      ),
    ).toHaveTextContent("A place can be up to 80 letters long.");
    await expect(writes(args.client)).toEqual([]);
  },
};

export const TaggedDraftReadsBack: Story = {
  args: {
    client: fakeDrafts({
      read: { summary: SUMMARY, draft: { ...SAVED, topic: "education", place: "Harbor Ward" } },
    }),
    id: ID,
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("textbox", { name: "Place (optional)" })).toHaveValue(
      "Harbor Ward",
    );
    await expect(canvas.getByRole("combobox", { name: "Topic (optional)" })).toHaveValue(
      "education",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Save draft" }));
    await expect(await canvas.findByText("Your draft is saved.")).toBeVisible();
    await expect(writes(args.client)).toEqual([
      ["update", ID, { ...SAVED, topic: "education", place: "Harbor Ward" }],
    ]);
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
  await expect(canvas.getByLabelText("Closing date")).toHaveValue("2026-11-04");
  await expect(canvas.getByLabelText("Closing time")).toHaveValue("10:00");
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
    const time = await canvas.findByLabelText("Closing time");
    const date = canvas.getByLabelText("Closing date");
    // Date and time fields take a whole value, as a picker gives one.
    fireEvent.change(date, { target: { value: "2026-10-18" } });
    fireEvent.change(time, { target: { value: "09:00" } });
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
    for (const status of canvas.getAllByRole("status")) await expect(status).toBeEmptyDOMElement();
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
    fireEvent.change(canvas.getByLabelText("Closing date"), {
      target: { value: "2026-11-04" },
    });
    fireEvent.change(canvas.getByLabelText("Closing time"), { target: { value: "10:00" } });
    await userEvent.click(canvas.getByRole("button", { name: "Save draft" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "You have as many drafts as an account can hold.",
    );
  },
};

export const SubmitADraft: Story = {
  args: { client: savedDraft(), id: ID, challenge: fakeChallenge(), onSubmitted: fn() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(
        "Before it's sent, a check by Cloudflare confirms you're a person. Cloudflare sees your browser's address while it runs.",
      ),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Submit poll" }));
    // The check appears only now, for this action, and nothing is sent until it is solved.
    const check = canvas.getByRole("group", { name: "Check that you're a person" });
    await expect(check).toBeVisible();
    await expect(canvas.getByText("Complete the check to submit your poll.")).toBeVisible();
    await expect(solves(args.challenge).map(([action]) => action)).toEqual(["poll-create"]);
    await expect(submits(args.client)).toEqual([]);
    await expect(canvas.getByRole("button", { name: "Submit poll" })).toBeDisabled();
    await userEvent.click(within(check).getByRole("button", { name: "I'm a person" }));
    await expect(
      await canvas.findByText("Your poll is submitted. Taking you to its setup…"),
    ).toBeVisible();
    await expect(submits(args.client)).toEqual([[ID, "token-1"]]);
    await expect(args.onSubmitted).toHaveBeenCalledOnce();
    await expect(args.onSubmitted).toHaveBeenCalledWith(ID);
    // Nothing more is saved or sent from the page.
    await expect(canvas.getByRole("button", { name: "Save draft" })).toBeDisabled();
    await expect(canvas.getByRole("button", { name: "Submit poll" })).toBeDisabled();
    await expect(writes(args.client)).toEqual([]);
  },
};

export const SubmitADraftDark: Story = {
  ...SubmitADraft,
  args: { client: savedDraft(), id: ID, challenge: fakeChallenge(), onSubmitted: fn() },
  parameters: { theme: "dark" },
};

export const SubmitSavesFirst: Story = {
  args: { client: fakeDrafts(), challenge: fakeChallenge(), onCreated: fn(), onSubmitted: fn() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    // Nothing saved yet: nothing to submit, and no button that could only refuse.
    await userEvent.type(await canvas.findByRole("textbox", { name: "Title" }), "Ferry name");
    await expect(canvas.queryByRole("button", { name: "Submit poll" })).toBeNull();
    await userEvent.type(
      canvas.getByRole("textbox", { name: "What do you want to ask?" }),
      "What should the new ferry be called?",
    );
    await userEvent.type(canvas.getByRole("textbox", { name: "Option 1" }), "Heron");
    await userEvent.type(canvas.getByRole("textbox", { name: "Option 2" }), "Tern");
    fireEvent.change(canvas.getByLabelText("Closing date"), {
      target: { value: "2026-11-04" },
    });
    fireEvent.change(canvas.getByLabelText("Closing time"), { target: { value: "10:00" } });
    await userEvent.click(canvas.getByRole("button", { name: "Save draft" }));
    await expect(await canvas.findByText("Your draft is saved.")).toBeVisible();
    // A change since the save: the stored draft isn't what the page shows.
    await userEvent.type(canvas.getByRole("textbox", { name: "Option 2" }), "s");
    await userEvent.click(canvas.getByRole("button", { name: "Submit poll" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("Save your draft first");
    await expect(solves(args.challenge)).toEqual([]);
    await userEvent.click(canvas.getByRole("button", { name: "Save draft" }));
    await expect(await canvas.findByText("Your draft is saved.")).toBeVisible();
    await expect(canvas.queryByRole("alert")).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Submit poll" }));
    await userEvent.click(await canvas.findByRole("button", { name: "I'm a person" }));
    await waitFor(() => expect(args.onSubmitted).toHaveBeenCalledOnce());
    await expect(args.onSubmitted).toHaveBeenCalledWith(NEW_ID);
    await expect(submits(args.client)).toEqual([[NEW_ID, "token-1"]]);
  },
};

export const EditingTakesTheCheckDown: Story = {
  args: { client: savedDraft(), id: ID, challenge: fakeChallenge(), onSubmitted: fn() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Submit poll" }));
    await expect(canvas.getByRole("button", { name: "I'm a person" })).toBeVisible();
    await userEvent.type(canvas.getByRole("textbox", { name: "Title" }), "!");
    await expect(canvas.queryByRole("button", { name: "I'm a person" })).toBeNull();
    await expect(solves(args.challenge)[0]![1].aborted).toBe(true);
    await expect(canvas.getByRole("button", { name: "Submit poll" })).toBeEnabled();
    await expect(submits(args.client)).toEqual([]);
  },
};

export const SubmitClosesTooSoon: Story = {
  args: {
    client: fakeDrafts({
      // 2026-10-18T13:00:00Z: an hour after the stories' clock, too soon for setup.
      read: { summary: SUMMARY, draft: { ...SAVED, closesAt: 1792328400n } },
    }),
    id: ID,
    challenge: fakeChallenge(),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Submit poll" }));
    const summary = await canvas.findByRole("region", { name: "Your poll wasn't submitted" });
    await expect(summary).toHaveFocus();
    await expect(summary).toHaveTextContent("Choose a time at least 90 minutes from now.");
    await expect(solves(args.challenge)).toEqual([]);
  },
};

export const CheckRefused: Story = {
  args: {
    client: fakeDrafts({
      read: { summary: SUMMARY, draft: SAVED },
      refuseSubmit: new DraftsError("challengeRefused"),
    }),
    id: ID,
    challenge: fakeChallenge(),
    onSubmitted: fn(),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Submit poll" }));
    await userEvent.click(canvas.getByRole("button", { name: "I'm a person" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "The check that you're a person didn't pass, so nothing was submitted.",
    );
    await expect(args.onSubmitted).not.toHaveBeenCalled();
    // A token is spent once: submitting again takes a new check.
    await userEvent.click(canvas.getByRole("button", { name: "Submit poll" }));
    await userEvent.click(canvas.getByRole("button", { name: "I'm a person" }));
    await waitFor(() =>
      expect(submits(args.client)).toEqual([
        [ID, "token-1"],
        [ID, "token-2"],
      ]),
    );
  },
};

export const CheckUnavailable: Story = {
  args: { client: savedDraft(), id: ID, challenge: fakeChallenge({ unavailable: true }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Submit poll" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "The check that you're a person couldn't run just now, so nothing was submitted.",
    );
    await expect(submits(args.client)).toEqual([]);
    await expect(canvas.getByRole("button", { name: "Submit poll" })).toBeEnabled();
  },
};

export const TooManyInSetup: Story = {
  args: {
    client: fakeDrafts({
      read: { summary: SUMMARY, draft: SAVED },
      refuseSubmit: new DraftsError("tooManyInSetup"),
    }),
    id: ID,
    challenge: fakeChallenge(),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Submit poll" }));
    await userEvent.click(canvas.getByRole("button", { name: "I'm a person" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "You have as many polls setting up as an account can at once.",
    );
  },
};

export const SubmittedMeanwhile: Story = {
  args: {
    client: fakeDrafts({
      read: { summary: SUMMARY, draft: SAVED },
      refuseSubmit: new DraftsError("changed"),
    }),
    id: ID,
    challenge: fakeChallenge(),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Submit poll" }));
    await userEvent.click(canvas.getByRole("button", { name: "I'm a person" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "This poll was submitted for setup, so it can't be changed any more.",
    );
    await expect(canvas.queryByRole("button", { name: "Submit poll" })).toBeNull();
  },
};

export const NoSiteKey: Story = {
  args: { client: savedDraft(), id: ID },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Submit poll" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "Polls can't be submitted on this site just now.",
    );
  },
};

let release = () => {};
const held = new Promise<void>((resolve) => (release = resolve));

export const EditDuringSave: Story = {
  args: {
    client: fakeDrafts({ read: { summary: SUMMARY, draft: SAVED }, hold: held }),
    id: ID,
    challenge: fakeChallenge(),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const title = await canvas.findByRole("textbox", { name: "Title" });
    await userEvent.click(canvas.getByRole("button", { name: "Save draft" }));
    // Written while the save is on its way: the stored draft won't have it.
    await userEvent.type(title, "!");
    release();
    await waitFor(() => expect(canvas.getByRole("button", { name: "Save draft" })).toBeEnabled());
    await expect(canvas.queryByText("Your draft is saved.")).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Submit poll" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("Save your draft first");
    await expect(solves(args.challenge)).toEqual([]);
  },
};

export const SaveTakesTheCheckDown: Story = {
  args: { client: savedDraft(), id: ID, challenge: fakeChallenge(), onSubmitted: fn() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Submit poll" }));
    await expect(canvas.getByRole("button", { name: "I'm a person" })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Save draft" }));
    await expect(await canvas.findByText("Your draft is saved.")).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "I'm a person" })).toBeNull();
    await expect(solves(args.challenge)[0]![1].aborted).toBe(true);
    await expect(submits(args.client)).toEqual([]);
    await expect(args.onSubmitted).not.toHaveBeenCalled();
  },
};

export const NoEditsWhileSending: Story = {
  args: {
    client: {
      ...savedDraft(),
      // A submission that never answers: the page stays sending.
      submit: () => new Promise<void>(() => {}),
    },
    id: ID,
    challenge: fakeChallenge(),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const title = await canvas.findByRole("textbox", { name: "Title" });
    await userEvent.click(canvas.getByRole("button", { name: "Submit poll" }));
    await userEvent.click(canvas.getByRole("button", { name: "I'm a person" }));
    await expect(await canvas.findByText("Submitting your poll…")).toBeVisible();
    await userEvent.type(title, "!");
    await expect(title).toHaveValue("Harbor library hours");
  },
};

const PROFILE = {
  handle: HANDLE,
  name: "Harbor Street Neighbors",
  renamableOn: undefined,
  pollIds: [],
};

const profileBox = (canvas: ReturnType<typeof within>) =>
  canvas.findByRole("checkbox", { name: "Show on your profile, Harbor Street Neighbors" });

const profileCalls = (client: unknown) => (client as ReturnType<typeof fakeProfiles>).calls;

/** A new poll's choice waits for its first save, which gives it the ID the choice names. */
export const ShowANewPollOnTheProfile: Story = {
  args: { client: fakeDrafts(), profiles: fakeProfiles({ profile: PROFILE }), onCreated: fn() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await profileBox(canvas));
    await expect(await profileBox(canvas)).toBeChecked();
    await expect(profileCalls(args.profiles)).toEqual([]);
    await userEvent.type(canvas.getByRole("textbox", { name: "Title" }), "Ferry name");
    await userEvent.type(
      canvas.getByRole("textbox", { name: "What do you want to ask?" }),
      "What should the new ferry be called?",
    );
    await userEvent.type(canvas.getByRole("textbox", { name: "Option 1" }), "Heron");
    await userEvent.type(canvas.getByRole("textbox", { name: "Option 2" }), "Tern");
    fireEvent.change(canvas.getByLabelText("Closing date"), {
      target: { value: "2026-11-04" },
    });
    fireEvent.change(canvas.getByLabelText("Closing time"), { target: { value: "10:00" } });
    await userEvent.click(canvas.getByRole("button", { name: "Save draft" }));
    await expect(await canvas.findByText("Your draft is saved.")).toBeVisible();
    await expect(profileCalls(args.profiles)).toEqual([`show ${NEW_ID} true`]);
    await expect(await profileBox(canvas)).toBeChecked();
    await expect(canvas.getByText(/^Your profile lists this poll/)).toBeVisible();
  },
};

/** A saved draft's choice is sent at once, apart from saving the draft. */
export const ChooseOnASavedDraft: Story = {
  args: {
    client: fakeDrafts({ read: { summary: SUMMARY, draft: SAVED } }),
    id: ID,
    profiles: fakeProfiles({ profile: { ...PROFILE, pollIds: [ID] } }),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const box = await profileBox(canvas);
    await waitFor(() => expect(box).toBeChecked());
    await userEvent.click(box);
    await expect(await canvas.findByText("Your profile doesn't show this poll.")).toBeVisible();
    await expect(profileCalls(args.profiles)).toEqual([`show ${ID} false`]);
    await expect(writes(args.client)).toEqual([]);
  },
};

/** The draft saves even when its choice can't go through, and the page says so. */
export const ShownChoiceRefused: Story = {
  args: {
    client: fakeDrafts(),
    profiles: {
      ...fakeProfiles({ profile: PROFILE }),
      show: async () => {
        throw new ProfilesError("failed");
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await profileBox(canvas));
    await userEvent.type(canvas.getByRole("textbox", { name: "Title" }), "Ferry name");
    await userEvent.type(
      canvas.getByRole("textbox", { name: "What do you want to ask?" }),
      "What should the new ferry be called?",
    );
    await userEvent.type(canvas.getByRole("textbox", { name: "Option 1" }), "Heron");
    await userEvent.type(canvas.getByRole("textbox", { name: "Option 2" }), "Tern");
    fireEvent.change(canvas.getByLabelText("Closing date"), {
      target: { value: "2026-11-04" },
    });
    fireEvent.change(canvas.getByLabelText("Closing time"), { target: { value: "10:00" } });
    await userEvent.click(canvas.getByRole("button", { name: "Save draft" }));
    await expect(await canvas.findByText("Your draft is saved.")).toBeVisible();
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "The draft is saved, but your profile doesn't show it. Tick the box again to show it.",
    );
    await expect(await profileBox(canvas)).not.toBeChecked();
  },
};

/** No profile: the form says how to make one, and offers no choice. */
export const NoProfile: Story = {
  args: { client: fakeDrafts(), profiles: fakeProfiles() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("link", { name: "Make one on your account page" }),
    ).toHaveAttribute("href", "/account#profile-title");
    await expect(canvas.queryByRole("checkbox", { name: /^Show on your profile/ })).toBeNull();
  },
};
