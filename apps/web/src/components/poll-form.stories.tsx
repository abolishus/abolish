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
    answered: async () => {
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

/** Where an element's own text is drawn, by its lines rather than its box. */
function textLines(element: Element) {
  const range = element.ownerDocument.createRange();
  range.selectNodeContents(element);
  const rects = [...range.getClientRects()];
  return {
    count: new Set(rects.map((r) => Math.round(r.top))).size,
    top: Math.min(...rects.map((r) => r.top)),
    bottom: Math.max(...rects.map((r) => r.bottom)),
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
      "Question 1, option 1: Give this option its words, or remove it.",
      "Question 1, option 2: Give this option its words, or remove it.",
      "Choose a closing date and time.",
    ]);
    // Two options' problems never read the same (P2-29, creating a poll's
    // iteration 11).
    await expect(new Set(links.map((l) => l.textContent)).size).toBe(links.length);
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

export const OnlyItemsStayPut: Story = {
  args: { client: fakeDrafts(), onCreated: fn() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The only question has no move buttons, which could never be used, so
    // its heading's row is the heading alone (P2-29, creating a poll's
    // iteration 12).
    const only = within(canvas.getByRole("region", { name: "Question 1" }));
    await expect(only.queryByRole("button", { name: /^Move question/ })).toBeNull();
    await expect(
      only.getByRole("button", { name: "Move option 1 of question 1 down" }),
    ).toBeVisible();
    // A second question gives both their moves; removing it takes them away again.
    await userEvent.click(canvas.getByRole("button", { name: "Add a question" }));
    await expect(canvas.getByRole("button", { name: "Move question 1 down" })).toBeEnabled();
    await expect(canvas.getByRole("button", { name: "Move question 2 up" })).toBeEnabled();
    await userEvent.click(canvas.getByRole("button", { name: "Remove question 2" }));
    await expect(canvas.queryByRole("button", { name: /^Move question/ })).toBeNull();
    // The same for an option left on its own, which can't be removed either.
    await userEvent.click(only.getByRole("button", { name: "Remove option 2 of question 1" }));
    await expect(only.queryByRole("button", { name: /option 1 of question 1/ })).toBeNull();
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
    // And how long that leaves it open, setup's half hour taken out.
    await expect(
      canvas.getByText(
        "Submitted now, it opens after about half an hour of setup and stays open for about 17 days and 3 hours.",
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

// A poll that didn't open and can't be tried again, whose author asks it
// again from their list (P2-29, the author's list's iteration 27).
const NEVER_OPENED: PollWithDraft = {
  summary: {
    ...SUMMARY,
    id: "ab".repeat(16),
    state: "failed",
    submittedAt: "2026-10-14T10:00:00.000Z",
    failure: "open-timeout",
  },
  draft: { ...SAVED, closesAt: 1792195200n }, // 2026-10-17T00:00:00Z, before the stories' clock
};

export const AskAgain: Story = {
  args: { client: fakeDrafts({ read: NEVER_OPENED }), from: "ab".repeat(16), onCreated: fn() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    // The author's words are back, so asking again isn't typing it all again.
    await expect(await canvas.findByRole("textbox", { name: "Title" })).toHaveValue(
      "Harbor library hours",
    );
    await expect(canvas.getAllByRole("region", { name: /^Question \d$/ })).toHaveLength(2);
    await expect(
      canvas.getByDisplayValue("Which evenings should it stay open late?"),
    ).toBeVisible();
    // A new poll, not the old one: nothing saved yet, so no list to go back to.
    await expect(canvas.getByRole("heading", { level: 1, name: "Ask a question" })).toBeVisible();
    await expect(canvas.queryByRole("link", { name: "Back to your polls" })).toBeNull();
    await expect(
      canvas.getByText(
        "Your words from the poll that didn't open are filled in. Choose when this one closes; only you can see it until you submit it.",
      ),
    ).toBeVisible();
    // The old close was for a poll that never opened, and has passed: it is chosen anew.
    await expect(canvas.getByLabelText("Closing date")).toHaveValue("");
    await expect(canvas.getByLabelText("Closing time")).toHaveValue("");
    fireEvent.change(canvas.getByLabelText("Closing date"), { target: { value: "2026-11-04" } });
    fireEvent.change(canvas.getByLabelText("Closing time"), { target: { value: "10:00" } });
    await userEvent.click(canvas.getByRole("button", { name: "Save draft" }));
    await expect(await canvas.findByText("Your draft is saved.")).toBeVisible();
    // Saved as a new draft with the old words, never as a change to the poll that failed.
    await expect(writes(args.client)).toEqual([["create", undefined, SAVED]]);
    await expect(args.onCreated).toHaveBeenCalledWith(NEW_ID);
    await expect(canvas.getByText(/^Only you can see a draft/)).toBeVisible();
  },
};

export const AskAgainFromAPollGone: Story = {
  args: { client: fakeDrafts(), from: "ab".repeat(16) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The link promised a new poll: one that can't be read still starts one, empty.
    await expect(await canvas.findByRole("textbox", { name: "Title" })).toHaveValue("");
    await expect(canvas.queryByRole("alert")).toBeNull();
    await expect(canvas.getByText(/^Only you can see a draft/)).toBeVisible();
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
      "Description",
      "Questions",
      "Who can answer",
      "Results",
      "Opens",
      "Closes",
      "Who holds the key",
      "Place",
      "Topic",
    ]);
    await expect(
      review.getByText("November 4, 2026 at 10:00 AM your time (3:00 PM UTC)"),
    ).toBeVisible();
    await expect(review.getByText("Harbor Ward")).toBeVisible();
    await expect(review.getByText("No description")).toBeVisible();
    // Each question's limits are recorded with its words, so the review
    // says them under it, in the ballot client's words.
    await expect(
      review.getByText("2 options. Choose one. This question can't be skipped."),
    ).toBeVisible();
    // With phone verification off, Tier 0 is named by the e-mail alone, in words.
    await expect(
      review.getByText(wholeText("People with a verified e-mail address")),
    ).toBeVisible();
    // How the results come out is recorded for good too: sealed until the
    // close, with no choice to change.
    await expect(
      review.getByText(/^Sealed until it closes\. No running count is published/),
    ).toBeVisible();
    await expect(review.queryByRole("link", { name: "Change Results" })).toBeNull();
    // When it opens is the worker's, set after setup, so the review says
    // when in words, with no choice to change.
    await expect(
      review.getByText(/^About half an hour after you submit it, once it's set up\./),
    ).toBeVisible();
    await expect(review.queryByRole("link", { name: "Change Opens" })).toBeNull();
    // Who holds the key is recorded for good with the rest, said as every
    // page of the poll says it, with the trustees page one step away (T-14).
    await expect(
      review.getByText(/During launch, Abolish alone holds the key for this poll/),
    ).toBeVisible();
    await expect(review.getByRole("link", { name: "How the key works" })).toHaveAttribute(
      "href",
      "/trustees",
    );
    await expect(review.queryByRole("link", { name: "Change Who holds the key" })).toBeNull();
    // What moderation can do is said before submitting, with the log it
    // writes to, and that it never reaches the answers or the count.
    await expect(review.getByRole("heading", { name: "What moderation can do" })).toBeVisible();
    await expect(
      review.getByText(/Moderation never touches the answers or the count/),
    ).toBeVisible();
    // A hide of an open poll for illegal content or personal data stops
    // answers through our app (docs/moderation-policy.md, Open polls).
    await expect(review.getByText(/stops people answering it through our app/)).toBeVisible();
    await expect(review.getByRole("link", { name: "See the moderation log" })).toHaveAttribute(
      "href",
      "/moderation",
    );
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
    await expect(who.getByText(wholeText(name))).toBeVisible();
    await expect(who.getByText(/Each verified phone number counts once/)).toBeVisible();
    const review = within(canvas.getByRole("region", { name: "Check it through" }));
    await expect(review.getByText(wholeText(name))).toBeVisible();
    await expect(canvas.queryByText(/Tier 0/)).toBeNull();
  },
};

/** Without it, what counts once is the address, and no tier's code is shown. */
export const EmailVerification: Story = {
  args: { client: savedDraft(), id: ID },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const who = within(await canvas.findByRole("region", { name: "Who can answer?" }));
    await expect(who.getByText(wholeText("People with a verified e-mail address"))).toBeVisible();
    await expect(who.getByText(/Each verified e-mail address counts once/)).toBeVisible();
    await expect(canvas.queryByText(/Tier 0|voting identity/)).toBeNull();
    // The one tier is a statement, not a row between two rules: with the next
    // section's own rule, those drew an empty band (P2-29, creating a poll's
    // iteration 7).
    const item = who.getByRole("listitem");
    for (const box of [item, item.parentElement]) {
      if (box === null) throw new Error("a tier outside its list");
      await expect(getComputedStyle(box).borderTopWidth).toBe("0px");
      await expect(getComputedStyle(box).borderBottomWidth).toBe("0px");
    }
    // The answer to the heading comes first, then what counts once, which as
    // the heading's lede came before it (P2-29, creating a poll's iteration 8).
    const counts = who.getByText(/Each verified e-mail address counts once/);
    await expect(item.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      counts.getBoundingClientRect().top,
    );
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

export const RuleChoicesPhone: Story = {
  args: { client: savedDraft(), id: ID, challenge: fakeChallenge() },
  globals: { viewport: { value: "phone", isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvasElement.ownerDocument.documentElement.clientWidth).toBe(360);
    const first = within(await canvas.findByRole("region", { name: "Question 1" }));
    // The five rules are one column of full-width choices, where they
    // wrapped two, one, one and one at their words' widths (P2-29, creating
    // a poll's iteration 6).
    const choices = first.getAllByRole("radio").map((radio) => {
      const label = radio.closest("label");
      if (label === null) throw new Error("a rule without its label");
      return label.getBoundingClientRect();
    });
    await expect(choices).toHaveLength(5);
    const field = first
      .getByRole("textbox", { name: "What do you want to ask?" })
      .getBoundingClientRect();
    for (const [i, box] of choices.entries()) {
      await expect(box.left).toBe(field.left);
      await expect(box.width).toBe(field.width);
      if (i > 0) await expect(box.top).toBeGreaterThan(choices[i - 1]?.bottom ?? 0);
    }
    // Their words are the size of the blank choice's under them, where they
    // were smaller (P2-29, creating a poll's iteration 7).
    const blank = first.getByText("People can leave this question blank");
    const size = getComputedStyle(blank).fontSize;
    await expect(size).toBe("16px");
    for (const radio of first.getAllByRole("radio")) {
      const label = radio.closest("label");
      if (label === null) throw new Error("a rule without its label");
      await expect(getComputedStyle(label).fontSize).toBe(size);
    }
    // The preview is framed by the everyday register's soft rule, not the
    // civic record's heavy one.
    const preview = await canvas.findByRole("complementary", { name: "What people will see" });
    const frame = within(preview).getByText("Harbor library hours").parentElement?.parentElement;
    if (frame === null || frame === undefined) throw new Error("no preview frame");
    await expect(getComputedStyle(frame).borderTopWidth).toBe("1px");
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
    await valuesLineUp(review);
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

/**
 * The preview states the close in the poll's own face, as the poll page
 * does, where it drew it in 12px monospace, the civic record's mark for
 * evidence, split at 360 between "3:00" and "PM UTC" (P2-29, creating a
 * poll's iteration 18).
 */
export const PreviewClosesInWordsPhone: Story = {
  args: { client: savedDraft(), id: ID },
  globals: { viewport: { value: "phone", isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const preview = within(
      await canvas.findByRole("complementary", { name: "What people will see" }),
    );
    const closes = getComputedStyle(preview.getByText(/^Closes November 4, 2026/));
    const rule = getComputedStyle(preview.getByText("Choose one."));
    await expect(closes.fontFamily).toBe(rule.fontFamily);
    await expect(closes.fontSize).toBe(rule.fontSize);
  },
};

/**
 * A question emptied since the save reads "No question yet" in the review,
 * as an emptied title reads "No title yet", where it left "1." with nothing
 * after it (P2-29, creating a poll's iteration 18).
 */
export const EmptiedQuestionInReview: Story = {
  args: { client: savedDraft(), id: ID, challenge: fakeChallenge() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const review = within(await canvas.findByRole("region", { name: "Check it through" }));
    const first = within(canvas.getByRole("region", { name: "Question 1" }));
    await userEvent.clear(first.getByRole("textbox", { name: "What do you want to ask?" }));
    const [one, two] = within(review.getByRole("list")).getAllByRole("listitem");
    await expect(one).toHaveTextContent("No question yet");
    await expect(two).toHaveTextContent("Which evenings should it stay open late?");
  },
};

/**
 * The preview drew a question's explanation at 14px, the smallest words on
 * the question and smaller than its options, where the ballot client sets it
 * at its options' size (P2-29, creating a poll's iteration 19).
 */
export const PreviewExplanationAtOptionsSizePhone: Story = {
  args: { client: savedDraft(), id: ID },
  globals: { viewport: { value: "phone", isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const preview = within(
      await canvas.findByRole("complementary", { name: "What people will see" }),
    );
    const explanation = getComputedStyle(preview.getByText("Until 9 PM."));
    const option = getComputedStyle(preview.getByText("Monday"));
    await expect(explanation.fontSize).toBe(option.fontSize);
  },
};

/**
 * The preview's options were plain boxes, so it never showed whether an
 * answer picks one or several; it now draws the ballot client's empty mark,
 * round for one and square for more, and follows the rule as it changes
 * (P2-29, creating a poll's iteration 19).
 */
export const PreviewMarksTheChoice: Story = {
  args: { client: savedDraft(), id: ID },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const preview = await canvas.findByRole("complementary", { name: "What people will see" });
    const marks = (n: number) =>
      [...preview.querySelectorAll("ol > li")][n]?.querySelectorAll("[data-mark]") ?? [];
    const kinds = (n: number) => [...marks(n)].map((m) => m.getAttribute("data-mark"));
    await expect(kinds(0)).toEqual(["one", "one"]);
    await expect(kinds(1)).toEqual(["many", "many", "many"]);
    for (const mark of [...marks(0), ...marks(1)])
      await expect(mark).toHaveAttribute("aria-hidden", "true");
    await expect(getComputedStyle(marks(0)[0]!).borderRadius).not.toBe("0px");
    await expect(getComputedStyle(marks(1)[0]!).borderRadius).toBe("0px");
    const first = within(canvas.getByRole("region", { name: "Question 1" }));
    await userEvent.click(first.getByRole("radio", { name: "Any number" }));
    await waitFor(() => expect(kinds(0)).toEqual(["many", "many"]));
  },
};

/**
 * The preview named each question's range in the form's own words ("Choose
 * any number." whether or not it could be left blank, "Choose 2 to 3.") and
 * said "You can leave this question blank." where the ballot client says
 * nothing, while saying nothing where the ballot client says the question
 * can't be skipped. It now gives the ballot client's instruction and skip
 * note, word for word (P2-29, creating a poll's iteration 20).
 */
export const PreviewSaysWhatTheBallotSays: Story = {
  args: { client: savedDraft(), id: ID },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const preview = await canvas.findByRole("complementary", { name: "What people will see" });
    const line = (n: number) =>
      [...preview.querySelectorAll("ol > li")][n]?.querySelector("p.text-sm")?.textContent;
    await expect(line(0)).toBe("Choose one. This question can't be skipped.");
    await expect(line(1)).toBe("Choose up to 2.");
    const first = within(canvas.getByRole("region", { name: "Question 1" }));
    await userEvent.click(first.getByRole("radio", { name: "Any number" }));
    await waitFor(() =>
      expect(line(0)).toBe("Choose at least one. This question can't be skipped."),
    );
    await userEvent.click(
      first.getByRole("checkbox", { name: "People can leave this question blank" }),
    );
    await waitFor(() => expect(line(0)).toBe("Choose as many as you like."));
    const second = within(canvas.getByRole("region", { name: "Question 2" }));
    await userEvent.click(second.getByRole("radio", { name: "Between two numbers" }));
    await waitFor(() =>
      expect(line(1)).toMatch(/^Choose from \d to \d\. This question can't be skipped\.$/),
    );
  },
};

/**
 * The review's `text-pretty` ended the who row's first line at "e-", with
 * "mail address" under it, wherever the row was 212px to 270px wide: on the
 * site, any screen under 303px, a folded phone's 280 or a 360px phone zoomed
 * to 125% (P2-29, creating a poll's iteration 14). Both places the who-name
 * is drawn keep "e-mail" on one line.
 */
export const WhoKeepsItsWordsFolded: Story = {
  args: { client: savedDraft(), id: ID },
  globals: { viewport: { value: "folded", isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvasElement.ownerDocument.documentElement.clientWidth).toBe(280);
    const name = "People with a verified e-mail address";
    const who = within(await canvas.findByRole("region", { name: "Who can answer?" }));
    const review = within(canvas.getByRole("region", { name: "Check it through" }));
    for (const element of [who.getByText(wholeText(name)), review.getByText(wholeText(name))])
      await expect(wordLines(element, "e-mail")).toBe(1);
  },
};

/** The element whose whole text is `text`, read across the spans inside it. */
function wholeText(text: string) {
  return (_: string, element: Element | null) =>
    element?.textContent === text &&
    [...element.children].every((child) => child.textContent !== text);
}

/** How many lines `word`, the first time it appears in `element`'s text, is drawn on. */
function wordLines(element: Element, word: string): number {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const at = node.textContent?.indexOf(word) ?? -1;
    if (at < 0) continue;
    const range = element.ownerDocument.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + word.length);
    return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
  }
  throw new Error(`no "${word}"`);
}

/**
 * Each review row's value lies as far below its row's top as every other
 * row's, the rows with no "Change" included (who can answer, the results,
 * when it opens and who holds the key), which drew its value 20px higher at 360 and its row 24px shorter
 * from 640px (P2-29, creating a poll's iteration 8).
 */
async function valuesLineUp(review: HTMLElement) {
  const offsets = within(review)
    .getAllByRole("term")
    .map((term) => {
      const value = term.nextElementSibling;
      if (term.parentElement === null || value === null) throw new Error("a term with no value");
      return value.getBoundingClientRect().top - term.parentElement.getBoundingClientRect().top;
    });
  await expect(offsets).toHaveLength(10);
  const [first = 0] = offsets;
  for (const offset of offsets) await expect(Math.abs(offset - first)).toBeLessThanOrEqual(1);
}

/** The middle of the first line of `element`'s text, on the screen. */
function textMiddle(element: Element): number {
  const range = element.ownerDocument.createRange();
  range.selectNodeContents(element);
  const line = range.getClientRects()[0];
  if (line === undefined) throw new Error("no text");
  return line.top + line.height / 2;
}

export const ReviewDesktop: Story = {
  args: { client: savedDraft(), id: ID, challenge: fakeChallenge() },
  globals: { viewport: { value: "desktop", isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvasElement.ownerDocument.documentElement.clientWidth).toBe(1280);
    const review = await canvas.findByRole("region", { name: "Check it through" });
    // In three columns, each "Change" reads on its label's line, where it
    // sat 12px under it, centred in its 48px target (P2-29, creating a
    // poll's iteration 5).
    let changes = 0;
    for (const term of within(review).getAllByRole("term")) {
      const change = within(review).queryByRole("link", { name: `Change ${term.textContent}` });
      if (change === null) continue;
      changes += 1;
      await expect(Math.abs(textMiddle(change) - textMiddle(term))).toBeLessThanOrEqual(1);
    }
    await expect(changes).toBe(6);
    await valuesLineUp(review);
    // The description is recorded for good as the title is, where the review
    // left it out (iteration 17).
    await expect(
      within(review).getByText("The council is weighing longer hours next year."),
    ).toBeVisible();
    await userEvent.click(within(review).getByRole("link", { name: "Change Description" }));
    await expect(canvas.getByRole("textbox", { name: "Description (optional)" })).toHaveFocus();
    // The questions are numbered as the form numbers them, where the reset's
    // bare list drew them as an unmarked indent (iteration 15).
    const questions = within(review).getByRole("list");
    await expect(getComputedStyle(questions).listStyleType).toBe("decimal");
    // Each question's limits are recorded for good with its words, so each
    // says them under it, as the preview does (P2-19 part 68).
    const [one, two] = within(questions).getAllByRole("listitem");
    await expect(one).toHaveTextContent(
      "Should the harbor library open on Sundays?2 options. Choose one. This question can't be skipped.",
    );
    await expect(two).toHaveTextContent(
      "Which evenings should it stay open late?3 options. Choose up to 2.",
    );
  },
};

/**
 * From 768px "Ready to ask?" is its own row, with what submitting does under
 * it, where that and the Cloudflare note sat beside it and made the row 224px
 * tall over an empty band; the note sits by the button that starts the check,
 * where it was read a whole review earlier (P2-29, creating a poll's
 * iteration 9).
 */
export const SubmitSectionDesktop: Story = {
  args: { client: savedDraft(), id: ID, challenge: fakeChallenge() },
  globals: { viewport: { value: "desktop", isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvasElement.ownerDocument.documentElement.clientWidth).toBe(1280);
    const heading = await canvas.findByRole("heading", { name: "Ready to ask?", level: 2 });
    // What submitting does lies under the heading, close enough to read as
    // its next line, where it sat beside it.
    const below =
      canvas.getByText(/^Submitting sets your poll up/).getBoundingClientRect().top -
      heading.getBoundingClientRect().bottom;
    await expect(below).toBeGreaterThan(0);
    await expect(below).toBeLessThanOrEqual(40);
    const review = canvas.getByRole("region", { name: "Check it through" }).getBoundingClientRect();
    const note = canvas
      .getByText(/^Before it's sent, a check by Cloudflare/)
      .getBoundingClientRect();
    const submit = canvas.getByRole("button", { name: "Submit poll" }).getBoundingClientRect();
    await expect(note.top).toBeGreaterThan(review.bottom);
    await expect(note.bottom).toBeLessThanOrEqual(submit.top);
    await expect(submit.top - note.bottom).toBeLessThanOrEqual(24);
  },
};

/**
 * Every section's lede follows its heading in the section's own column: beside
 * the heading from 768px, What are you asking? and When does it close? drew
 * rows of 104px and 80px for a 45px heading, the band iterations 8 and 9 took
 * out of the others (P2-29, creating a poll's iteration 10).
 */
export const SectionLedesDesktop: Story = {
  args: { client: savedDraft(), id: ID },
  globals: { viewport: { value: "desktop", isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvasElement.ownerDocument.documentElement.clientWidth).toBe(1280);
    for (const [name, lede] of [
      ["What are you asking?", /^Each question has its options/],
      ["When does it close?", /^Choose a time on your own clock/],
    ] as const) {
      const heading = (
        await canvas.findByRole("heading", { name, level: 2 })
      ).getBoundingClientRect();
      const text = canvas.getByText(lede).getBoundingClientRect();
      await expect(text.left).toBe(heading.left);
      await expect(text.top - heading.bottom).toBeGreaterThan(0);
      await expect(text.top - heading.bottom).toBeLessThanOrEqual(40);
    }
  },
};

/**
 * Side by side, the place's three-line hint pushed its field 40px below the
 * topic's one-line hint's select; the labels and the fields now line up
 * (P2-29, creating a poll's iteration 13).
 */
export const PlaceAndTopicLineUpDesktop: Story = {
  args: { client: savedDraft(), id: ID },
  globals: { viewport: { value: "desktop", isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvasElement.ownerDocument.documentElement.clientWidth).toBe(1280);
    const place = (await canvas.findByRole("textbox", { name: /^Place/ })).getBoundingClientRect();
    const topic = canvas.getByRole("combobox", { name: /^Topic/ }).getBoundingClientRect();
    await expect(topic.left).toBeGreaterThan(place.right);
    await expect(topic.top).toBe(place.top);
    await expect(topic.height).toBe(place.height);
    const placeLabel = canvas.getByText(/^Place/, { selector: "label" }).getBoundingClientRect();
    const topicLabel = canvas.getByText(/^Topic/, { selector: "label" }).getBoundingClientRect();
    await expect(topicLabel.top).toBe(placeLabel.top);
  },
};

/**
 * The problems after a refused save lie the same distance apart whether they
 * wrap or not: at 360 two that wrapped sat 16px apart and one-line ones 28px
 * (P2-29, creating a poll's iteration 10).
 */
export const ProblemsApartPhone: Story = {
  args: { client: fakeDrafts(), onCreated: fn() },
  globals: { viewport: { value: "phone", isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvasElement.ownerDocument.documentElement.clientWidth).toBe(360);
    await userEvent.click(await canvas.findByRole("button", { name: "Save draft" }));
    const summary = await canvas.findByRole("region", { name: "Your draft wasn't saved" });
    const links = within(summary).getAllByRole("link");
    const lines = links.map(textLines);
    await expect(lines.some((l) => l.count > 1)).toBe(true);
    await expect(lines.some((l) => l.count === 1)).toBe(true);
    // Each target stays at least 48px tall.
    for (const link of links)
      await expect(link.getBoundingClientRect().height).toBeGreaterThanOrEqual(48);
    const gaps = lines.slice(1).map((l, i) => l.top - lines[i]!.bottom);
    for (const gap of gaps) await expect(Math.abs(gap - gaps[0]!)).toBeLessThanOrEqual(1);
  },
};

export const SubmitIsTheNextStep: Story = {
  args: { client: savedDraft(), id: ID, challenge: fakeChallenge() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const submit = await canvas.findByRole("button", { name: "Submit poll" });
    const save = canvas.getByRole("button", { name: "Save draft" });
    const ground = (button: HTMLElement) => getComputedStyle(button).backgroundColor;
    // A saved draft with nothing unsaved has one next step, and its button is
    // the primary one; an edit gives the primary back to saving (P2-29,
    // creating a poll's iteration 5).
    const primary = ground(submit);
    const outline = ground(save);
    await expect(primary).not.toBe(outline);
    // Waited for: the buttons ease between their colours.
    const swapped = (to: HTMLElement, from: HTMLElement) =>
      waitFor(async () => {
        await expect(ground(to)).toBe(primary);
        await expect(ground(from)).toBe(outline);
      });
    await userEvent.type(canvas.getByRole("textbox", { name: "Title" }), " and days");
    await swapped(save, submit);
    await userEvent.click(save);
    await expect(await canvas.findByText("Your draft is saved.")).toBeVisible();
    // Off the button, whose hover would tint it.
    await userEvent.unhover(save);
    await swapped(submit, save);
    // The preview and where it's listed carry headings, not mono marks: the
    // everyday register keeps those for evidence.
    await expect(canvas.queryByText("Preview")).toBeNull();
    await expect(
      canvas.getByRole("heading", { name: "Where it's listed", level: 3 }),
    ).toBeVisible();
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
  await expect(preview.getByText("Choose up to 2.")).toBeVisible();
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
      "Question 2, option 2: Another option of this question says the same. People couldn't tell them apart.",
    ]);
    // Apart, so problems that wrap don't read as one paragraph (P2-29,
    // creating a poll's iteration 6): further apart than a problem's own lines.
    const [one, two] = within(summary).getAllByRole("link").map(textLines);
    await expect((two?.top ?? 0) - (one?.bottom ?? 0)).toBeGreaterThanOrEqual(24);
    await expect(writes(args.client)).toEqual([]);
  },
};

export const TooLongNamesItsField: Story = {
  args: { client: fakeDrafts({ read: { summary: SUMMARY, draft: SAVED } }), id: ID },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    // Words, not one long one: a field too long, not too wide.
    const long = "word ".repeat(1700);
    fireEvent.change(await canvas.findByRole("textbox", { name: "Title" }), {
      target: { value: long },
    });
    fireEvent.change(canvas.getByRole("textbox", { name: "Description (optional)" }), {
      target: { value: long },
    });
    const second = within(canvas.getByRole("region", { name: "Question 2" }));
    for (const name of [
      "What do you want to ask?",
      "Explanation (optional)",
      "Option 3",
      "Details for option 3 (optional)",
    ])
      fireEvent.change(second.getByRole("textbox", { name }), { target: { value: long } });
    await userEvent.click(canvas.getByRole("button", { name: "Save draft" }));
    const summary = await canvas.findByRole("region", { name: "Your draft wasn't saved" });
    // Each problem names its field: "This is too long." alone read the same
    // for a question and its explanation, or an option and its details
    // (P2-29, creating a poll's iteration 16).
    await expect(
      within(summary)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual([
      "Title: This is too long.",
      "Description: This is too long.",
      "Question 2: This is too long.",
      "Question 2, explanation: This is too long.",
      "Question 2, option 3: This is too long.",
      "Question 2, details for option 3: This is too long.",
    ]);
    await expect(writes(args.client)).toEqual([]);
  },
};

export const LinkInTheTextPhone: Story = {
  args: { client: fakeDrafts({ read: { summary: SUMMARY, draft: SAVED } }), id: ID },
  globals: { viewport: { value: "phone", isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const link =
      "https://harbor-library.example.org/council/minutes/2026-10-14/longer-opening-hours.pdf";
    fireEvent.change(await canvas.findByRole("textbox", { name: "Description (optional)" }), {
      target: { value: `The proposal: ${link}` },
    });
    const second = within(canvas.getByRole("region", { name: "Question 2" }));
    fireEvent.change(second.getByRole("textbox", { name: "Details for option 3 (optional)" }), {
      target: { value: link },
    });
    // A link is one word as wide as the screen several times over: the
    // preview broke it only where its column allowed, so its column took
    // the link's width and the page scrolled sideways (P2-29, creating a
    // poll's iteration 16). The story's own check fails on any sideways
    // scroll; the preview's text also keeps inside its frame.
    const preview = await canvas.findByRole("complementary", { name: "What people will see" });
    const frame = preview.getBoundingClientRect();
    for (const text of within(preview).getAllByText(link, { exact: false }))
      await expect(text.getBoundingClientRect().right).toBeLessThanOrEqual(frame.right);
    await expect(frame.right).toBeLessThanOrEqual(
      canvasElement.ownerDocument.documentElement.clientWidth,
    );
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
    // A time submission wouldn't take has no length, only its error.
    await expect(canvas.queryByText(/^Submitted now/)).toBeNull();
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
    // Nothing more is saved or sent from the page, and the review offers no
    // "Change" that would lead to a field taking no edits (iteration 15).
    await expect(canvas.getByRole("button", { name: "Save draft" })).toBeDisabled();
    await expect(canvas.getByRole("button", { name: "Submit poll" })).toBeDisabled();
    await expect(canvas.queryAllByRole("link", { name: /^Change/ })).toEqual([]);
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
    await expect(canvas.queryAllByRole("link", { name: /^Change/ })).toEqual([]);
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
    // Saved, it's still a draft: the profile lists it once it opens.
    await expect(
      canvas.getByText(/^Your profile lists this poll.*once the poll is open and listed\./),
    ).toBeVisible();
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
    await userEvent.click(box);
    await expect(
      await canvas.findByText("Your profile will show this poll once it opens."),
    ).toBeVisible();
    await expect(profileCalls(args.profiles)).toEqual([`show ${ID} false`, `show ${ID} true`]);
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
