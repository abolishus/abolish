import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { expectTextFocus } from "./focus-text.ts";

import type { FollowsClient } from "../account/follows.ts";
import type { ReactionsClient } from "../account/reactions.ts";
import type { PollView } from "../poll.ts";
import type { ReportOutcome } from "../profile-report.ts";
import { PollSummary } from "./poll-summary.tsx";
import { ViewerNow, ViewerTimeZone } from "./when.tsx";

const poll: PollView = {
  electionId: "101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f",
  definitionHash: "a4555c67fbc57b7ed42f873f73f36360baba11fa0de1f0ba0f104780a4071750",
  version: 1,
  illFormed: undefined,
  rolling: false,
  pollClass: "everyday",
  counting: "plurality",
  questions: [{ optionCount: 3, minSelections: 0, maxSelections: 1 }],
  electorate: [
    { tier: 0, groupSize: "5000" },
    { tier: 2, groupSize: "1" },
  ],
  threshold: 4,
  panelSize: 7,
  opensAt: { seconds: "1767225600", iso: "2026-01-01T00:00:00.000Z" },
  closesAt: { seconds: "18446744073709551615", iso: undefined },
};

/** Between the poll's opening and its close. */
const OPEN_AT = { seconds: "1767571200", iso: "2026-01-05T00:00:00.000Z" };

const board = { treeSize: "1234", chainHead: "1f".repeat(32), root: "2e".repeat(32) };

/** A signed-out visitor's reactions: the counts only. */
const reactions: ReactionsClient = {
  counts: async () => ({ heart: 4, laugh: 0, wow: 1, thinking: 2, sad: 0, clap: 0 }),
  own: async () => {
    throw new Error("signed out");
  },
  set: async () => {
    throw new Error("signed out");
  },
};

const reporting = (outcome: ReportOutcome) =>
  fn(async (_electionId: string, _reason: string) => outcome);

/** A signed-out visitor's follow: refused, and never asked until pressed. */
const follows: FollowsClient = {
  set: async () => {
    throw new Error("signed out");
  },
};

const meta = {
  component: PollSummary,
  args: {
    poll,
    board,
    moderation: { state: "visible" },
    asOf: OPEN_AT,
    code: "mhanrsz",
    share: { url: "https://abolish.us/p/mhanrsz", title: "Poll mhanrsz" },
    reactions,
    report: reporting("reported"),
    follows,
    phoneVerification: false,
  },
  // A visitor on New York's clock at `asOf`, so the facts' times, drawn on the
  // visitor's clock, don't depend on the machine drawing the story or when.
  decorators: [
    (Story, { args }) => (
      <ViewerTimeZone.Provider value="America/New_York">
        <ViewerNow.Provider value={() => new Date(args.asOf.iso ?? OPEN_AT.iso)}>
          <Story />
        </ViewerNow.Provider>
      </ViewerTimeZone.Provider>
    ),
  ],
} satisfies Meta<typeof PollSummary>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The line beside the poll's status at the top of its page (P2-19 part 64,
 * from the open poll mockup's byline): which time it is, and that it is the
 * definition's own, the same instant the facts show.
 */
async function expectWhen(canvasElement: HTMLElement, word: string, iso: string | undefined) {
  const header = canvasElement.querySelector("article > header");
  const line = [...(header?.querySelectorAll("span") ?? [])].find((s) =>
    s.textContent?.startsWith(`${word} `),
  );
  await expect(line).toBeVisible();
  const time = line?.querySelector("time") ?? null;
  if (iso === undefined) await expect(time).toBeNull();
  else await expect(time).toHaveAttribute("datetime", iso);
}

/**
 * The page says once that each answer is sealed on the voter's device, and
 * once that anyone can count the board again: in the Answering panel and the
 * evidence while the poll takes answers, in the evidence alone once it has
 * closed (P2-29, the poll page's iteration 13).
 */
async function expectSaidOnce(canvasElement: HTMLElement, closed: boolean) {
  const article = canvasElement.querySelector("article");
  const text = article?.textContent ?? "";
  await expect(text.match(/sealed on/g)).toHaveLength(1);
  await expect(text.match(/count (it )?again/g)).toHaveLength(1);
  const panel = within(canvasElement).getByRole("region", { name: "Answering" });
  await expect(within(panel).queryByText(/sealed on/) === null).toBe(closed);
}

/** Opens "How do we know this is real?", where the definition and board facts are. */
async function openEvidence(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  // The question and its answer in plain words are on the surface; the evidence is one step down.
  const section = canvas.getByRole("region", { name: "How do we know this is real?" });
  await expect(
    within(section).getByText(/^Every answer (is|was) .*listed on the public board/),
  ).toBeVisible();
  // Who can open the answers, in the brief's words for the launch panel.
  await expect(
    within(section).getByText(
      "Whoever asked it can't see anyone's answers. During launch, Abolish alone holds the key for this poll.",
    ),
  ).toBeVisible();
  // Closed, the evidence is in the page but not shown.
  const details = canvasElement.querySelector("details");
  await expect(details).not.toHaveAttribute("open");
  await expect(canvas.getByText(/^Definition hash/, { selector: "figcaption" })).not.toBeVisible();
  await userEvent.click(within(section).getByText("Show the evidence"));
  await expect(details).toHaveAttribute("open");
  await expect(canvas.getByRole("figure", { name: /^Definition hash/ })).toBeVisible();
  // Its words follow it: opened, it offers to hide the evidence.
  await expect(within(section).getByText("Hide the evidence")).toBeVisible();
  await expect(within(section).getByText("Show the evidence")).not.toBeVisible();
}

const play: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
    "Poll 1011121314151617…",
  );
  // The surface: where the poll stands, who can vote, when, and how answering works.
  await expect(canvas.getByText("Open for answers")).toBeVisible();
  await expect(canvas.getByText("3 options")).toBeVisible();
  // With phone verification off, Tier 0 is named by the e-mail alone.
  await expect(canvas.getByText("Tier 0 (verified e-mail)")).toBeVisible();
  await expect(canvas.getByRole("heading", { name: "Answering" })).toBeVisible();
  await expect(canvas.getByText(/only in the ballot app, never on this website/)).toBeVisible();
  await expect(canvas.getByRole("button", { name: "Share this poll" })).toBeVisible();
  // Reactions, offered alike whether or not this visitor answered (T-10, T-11).
  await expect(await canvas.findByText("Heart: 4 people")).toBeInTheDocument();
  // And following, alike too.
  await expect(canvas.getByRole("button", { name: "Follow this poll" })).toBeVisible();
  // Side by side from a tablet's width, stacked on a phone, each saying in
  // a sentence that it isn't an answer (P2-29, the poll page's iteration 5).
  const reacting = canvas.getByRole("region", { name: "Reactions" });
  const following = canvas.getByRole("region", { name: "Follow" });
  await expect(
    within(reacting).getByText(
      "React to the poll itself. A reaction isn't an answer and says nothing about whether you answered.",
    ),
  ).toBeVisible();
  await expect(
    within(following).getByText(
      "Get an e-mail when its results are in. Following isn't answering and says nothing about whether you answered.",
    ),
  ).toBeVisible();
  const [reactingBox, followingBox] = [reacting, following].map((r) => r.getBoundingClientRect());
  if (window.matchMedia("(min-width: 48rem)").matches) {
    await expect(followingBox?.top).toBe(reactingBox?.top);
    await expect(followingBox?.left).toBeGreaterThan(reactingBox?.right ?? Infinity);
  } else {
    await expect(followingBox?.top).toBeGreaterThan(reactingBox?.bottom ?? Infinity);
  }
  await openEvidence(canvasElement);
  await expect(canvas.getByText(/what our server says about this poll/)).toBeVisible();
  await expect(canvas.getByRole("figure", { name: "Poll ID" })).toBeVisible();
  await expect(
    canvas.getByRole("img", { name: "Fingerprint of definition a4555c67" }),
  ).toBeVisible();
  await expect(canvas.getByText("4 of 7")).toBeVisible();
  await expect(canvas.getByText("5,000 members")).toBeVisible();
  // A singular plural, and an instant past what Date holds shown as seconds.
  await expect(canvas.getByText("1 member")).toBeVisible();
  // Beside its status, on the surface and in the evidence.
  await expect(canvas.getAllByText("18446744073709551615")).toHaveLength(3);
  await expectWhen(canvasElement, "Closes", undefined);
  await expect(canvas.getByRole("figure", { name: "Chain head" })).toBeVisible();
  await expect(canvas.getByText(/with the same head hold the same 1,234 entries\.$/)).toBeVisible();
  await expect(canvas.queryByRole("note")).toBeNull();
  await expect(canvas.getByRole("link", { name: "/p/mhanrsz" })).toHaveAttribute(
    "href",
    "/p/mhanrsz",
  );
  // The page's text links focus as the answers' boxes do (P2-29, the poll
  // page's iteration 4).
  await expectTextFocus(canvas.getByRole("link", { name: "/p/mhanrsz" }));
  await expectTextFocus(canvas.getByRole("link", { name: "Read the board, entry by entry" }));
};

export const Default: Story = { play };

export const Dark: Story = { parameters: { theme: "dark" }, play };

/** With phone verification on, Tier 0 is named by both checks, on the surface and in the evidence. */
export const PhoneVerification: Story = {
  args: { phoneVerification: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Tier 0 (verified e-mail and phone)")).toBeVisible();
    await openEvidence(canvasElement);
    await expect(canvas.getByText(/^Tier 0 \(verified e-mail and phone\):/)).toBeVisible();
    await expect(canvas.queryByText(/^Tier 0 \(verified e-mail\)/)).toBeNull();
  },
};

/**
 * A rolling poll (version 7): each tier is open to whoever joins it before the
 * close, Tier 0 to new identities, and its count is its members when the poll
 * opened, never the electorate at the close ([[0028-rolling-electorates]]).
 */
export const Rolling: Story = {
  args: {
    poll: {
      ...poll,
      version: 7,
      rolling: true,
      counting: "questions",
      electorate: [
        { tier: 0, groupSize: "5000" },
        { tier: 2, groupSize: "1" },
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // On the surface, each tier says so, Tier 0's newcomers as new identities.
    await expect(canvas.getAllByText("Open to new identities until it closes")[0]).toBeVisible();
    await expect(canvas.getAllByText("Open to new members until it closes")[0]).toBeVisible();
    await openEvidence(canvasElement);
    await expect(canvas.getByText("5,000 members when it opened")).toBeVisible();
    await expect(canvas.getByText("1 member when it opened")).toBeVisible();
    await expect(canvas.queryByText("5,000 members")).toBeNull();
  },
};

/**
 * A version-7 poll whose definition files it on the civic record: the class
 * is named as its definition states it, with why no poll under the launch
 * panel can be registered there (P2-19 part 56; T-14).
 */
export const CivicRecord: Story = {
  args: { poll: { ...poll, version: 7, pollClass: "civic", counting: "questions" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/· Civic referendum · Question by question$/)).toBeVisible();
    await expect(
      canvas.getByText(/^Its definition puts it on the civic record, .* independent trustees\./),
    ).toBeVisible();
    await openEvidence(canvasElement);
    const kind = canvas.getByText("Kind", { selector: "dt" });
    await expect(kind.nextElementSibling).toHaveTextContent("Civic referendum");
  },
};

/** Before `opens_at`: not open yet, saying so under the heading, with its opening time on the surface. */
export const Scheduled: Story = {
  args: { asOf: { seconds: "1767225599", iso: "2025-12-31T23:59:59.000Z" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Not open yet")).toBeVisible();
    await expect(canvas.queryByText("Open for answers")).toBeNull();
    await expect(canvas.getByText(/^Nothing can be answered until it opens\./)).toBeVisible();
    // When it opens, beside its status, rather than when it closes.
    await expectWhen(canvasElement, "Opens", poll.opensAt.iso);
    // Before it opens, where its key came from is one link away, on the
    // surface beside who holds it, as the scheduled poll's mockup shows its
    // ceremony: the board's record, on the board's first page.
    const evidence = canvas.getByRole("region", { name: "How do we know this is real?" });
    await expect(
      within(evidence).getByRole("link", { name: "How the poll's key was made" }),
    ).toHaveAttribute("href", `/polls/${poll.electionId}/board#ceremony-title`);
  },
};

/** Past `closes_at`: closed, and answering says it takes no more answers. */
export const Closed: Story = {
  args: {
    poll: { ...poll, closesAt: { seconds: "1767830400", iso: "2026-01-08T00:00:00.000Z" } },
    asOf: { seconds: "1767830401", iso: "2026-01-08T00:00:01.000Z" },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Closed")).toBeVisible();
    await expect(canvas.getByText("This poll has closed and takes no more answers.")).toBeVisible();
    await expect(canvas.queryByText(/only in the ballot app/)).toBeNull();
    await expectSaidOnce(canvasElement, true);
    await expectWhen(canvasElement, "On", "2026-01-08T00:00:00.000Z");
  },
};

/** How many have answered so far, tier by tier as the definition names them, never summed (T-01). */
export const Answered: Story = {
  args: {
    answered: [
      { tier: 0, answered: "1204" },
      { tier: 2, answered: "1" },
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const counts = canvas.getByRole("list", { name: "Answered so far" });
    await expect(
      within(counts)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["1,204 people · Tier 0 (verified e-mail)", "1 person · Tier 2 (document-verified)"]);
    await expect(canvas.queryByText("1,205 people")).toBeNull();
  },
};

/** Past `closes_at`, the same count says it was before it closed. */
export const AnsweredClosed: Story = {
  args: {
    ...Closed.args,
    answered: [
      { tier: 0, answered: "12" },
      { tier: 2, answered: "0" },
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const counts = canvas.getByRole("list", { name: "Answered before it closed" });
    await expect(within(counts).getByText("12 people")).toBeVisible();
    await expect(within(counts).getByText("0 people")).toBeVisible();
    await expect(canvas.queryByText("Answered so far")).toBeNull();
  },
};

/** Before `opens_at`, no count is shown: nobody can have answered yet. */
export const AnsweredScheduled: Story = {
  args: { ...Scheduled.args, answered: [{ tier: 0, answered: "0" }] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Not open yet")).toBeVisible();
    await expect(canvas.queryByText("Answered so far")).toBeNull();
    await expect(canvas.queryByText("0 people")).toBeNull();
  },
};

/** No registration recorded yet: no code resolves, so none is printed. */
export const NoShortCode: Story = {
  // The route offers no share sheet without a short link.
  args: { code: undefined, share: undefined },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await openEvidence(canvasElement);
    await expect(canvas.queryByText("Short link")).toBeNull();
    // The board's links are the only ones left, beside the report's link to the policy.
    await expect(canvas.getAllByRole("link").map((l) => l.textContent)).toEqual([
      "How the poll's key was made",
      "Read the board, entry by entry",
      "What moderation can and can't do",
    ]);
  },
};

export const EmptyBoard: Story = {
  args: { board: { treeSize: "0", chainHead: "00".repeat(32), root: "00".repeat(32) } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await openEvidence(canvasElement);
    await expect(canvas.getByText("No entries yet.")).toBeVisible();
    // No ceremony record to point at before the board's first entry.
    await expect(canvas.queryByRole("link", { name: "How the poll's key was made" })).toBeNull();
    // An empty board's all-zero head is never shown as if it were one.
    await expect(canvas.queryByRole("figure", { name: "Chain head" })).toBeNull();
  },
};

export const Hidden: Story = {
  args: {
    // The route offers no share sheet for a hidden poll.
    share: undefined,
    moderation: {
      state: "hidden",
      latest: {
        seq: "7",
        action: "hide",
        reason: "personal-data",
        decidedAt: "2026-10-01T12:00:00.000Z",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const note = within(canvasElement).getByRole("note");
    await expect(within(canvasElement).getByText("Text hidden")).toBeVisible();
    await expect(note).toHaveTextContent("withheld (Personal data)");
    // No reactions on a hidden poll, and no counts (T-68).
    await expect(within(canvasElement).queryByRole("heading", { name: "Reactions" })).toBeNull();
    // Nor a report: moderators have already removed its text.
    await expect(
      within(canvasElement).queryByRole("button", { name: "Report this poll" }),
    ).toBeNull();
    // Nor following: it takes no new followers.
    await expect(within(canvasElement).queryByRole("heading", { name: "Follow" })).toBeNull();
    await expect(
      within(note).getByRole("link", { name: "See the moderation log" }),
    ).toHaveAttribute("href", "/moderation");
  },
};

export const Delisted: Story = {
  parameters: { theme: "dark" },
  args: {
    moderation: {
      state: "delisted",
      latest: { seq: "3", action: "delist", reason: "spam", decidedAt: "2026-10-01T12:00:00.000Z" },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("note")).toHaveTextContent(
      "left out of discovery and search (Spam)",
    );
    await expect(within(canvasElement).getByText("Delisted")).toBeVisible();
    await expectTextFocus(
      within(canvasElement).getByRole("link", { name: "See the moderation log" }),
    );
  },
};

const ASKED_BY = { handle: "k7qa2mzr5xw3bn4d", name: "Riverside Neighbours" };

/**
 * Its author chose to show it on their profile: "Asked by" the name, a link
 * to the profile, and a note that it's the website's word, not the poll's (T-75).
 */
export const AskedBy: Story = {
  args: { askedBy: ASKED_BY },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("link", { name: ASKED_BY.name })).toHaveAttribute(
      "href",
      `/by/${ASKED_BY.handle}`,
    );
    await expect(canvas.getByText(/It isn't part of the poll/)).toBeVisible();
  },
};

/** A hidden poll names no one, whatever it was given: nothing beside withheld text (T-68). */
export const HiddenAskedBy: Story = {
  args: {
    askedBy: ASKED_BY,
    share: undefined,
    moderation: {
      state: "hidden",
      latest: {
        seq: "7",
        action: "hide",
        reason: "personal-data",
        decidedAt: "2026-10-01T12:00:00.000Z",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText(/Asked by/)).toBeNull();
    await expect(canvas.queryByText(ASKED_BY.name)).toBeNull();
  },
};

const TAGS = { topic: "housing", place: "حي الزيتون" } as const;

/**
 * Filed under a topic and a place: each a way into the stream narrowed to
 * it, the place in its own direction, and a note that both are the asker's
 * and moderation can change them (T-68).
 */
export const Tagged: Story = {
  args: { tags: TAGS },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const listed = within(canvas.getByRole("list", { name: "Where it's listed" }));
    await expect(listed.getByRole("link", { name: "Housing" })).toHaveAttribute(
      "href",
      "/discover?topic=housing",
    );
    const place = listed.getByRole("link", { name: TAGS.place });
    await expect(place).toHaveAttribute(
      "href",
      `/discover?place=${encodeURIComponent(TAGS.place)}`,
    );
    await expect(place.querySelector("bdi")).toHaveTextContent(TAGS.place);
    await expect(canvas.getByText(/moderation can change them/)).toBeVisible();
  },
};

/** Filed under a place only: the topic isn't named. */
export const PlaceOnly: Story = {
  args: { tags: { topic: undefined, place: "Eastside" } },
  play: async ({ canvasElement }) => {
    const listed = within(within(canvasElement).getByRole("list", { name: "Where it's listed" }));
    await expect(listed.getAllByRole("listitem")).toHaveLength(1);
    await expect(listed.getByRole("link")).toHaveAccessibleName("Eastside");
  },
};

/** A delisted poll keeps its tags, but as words: the stream they'd link to leaves it out. */
export const DelistedTagged: Story = {
  args: {
    tags: TAGS,
    moderation: {
      state: "delisted",
      latest: { seq: "3", action: "delist", reason: "spam", decidedAt: "2026-10-01T12:00:00.000Z" },
    },
  },
  play: async ({ canvasElement }) => {
    const listed = within(within(canvasElement).getByRole("list", { name: "Where it's listed" }));
    await expect(listed.getByText("Housing")).toBeVisible();
    await expect(listed.getByText(TAGS.place)).toBeVisible();
    await expect(listed.queryByRole("link")).toBeNull();
  },
};

/** A hidden poll shows no tags, whatever it was given: they are withheld with its text (T-68). */
export const HiddenTagged: Story = {
  args: {
    tags: TAGS,
    share: undefined,
    moderation: {
      state: "hidden",
      latest: {
        seq: "7",
        action: "hide",
        reason: "personal-data",
        decidedAt: "2026-10-01T12:00:00.000Z",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("list", { name: "Where it's listed" })).toBeNull();
    await expect(canvas.queryByText(TAGS.place)).toBeNull();
    await expect(canvas.queryByText(/moderation can change them/)).toBeNull();
  },
};

export const IllFormed: Story = {
  args: {
    poll: { ...poll, counting: "approval", illFormed: { rule: "panel", question: undefined } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("alert")).toHaveTextContent("(trustee panel)");
    await expect(canvas.getAllByText("Approve any number")[0]).toBeVisible();
  },
};

/** Version 5: each question's limits, worded as the ballot client words them. */
const questions: PollView = {
  ...poll,
  version: 5,
  counting: "questions",
  questions: [
    { optionCount: 3, minSelections: 0, maxSelections: 1 },
    { optionCount: 5, minSelections: 0, maxSelections: 5 },
    { optionCount: 4, minSelections: 0, maxSelections: 2 },
    { optionCount: 6, minSelections: 3, maxSelections: 3 },
    { optionCount: 4, minSelections: 1, maxSelections: 4 },
    { optionCount: 5, minSelections: 2, maxSelections: 3 },
  ],
};

const questionsPlay: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getAllByText("Question by question")[0]).toBeVisible();
  await expect(canvas.getByText("6 questions, 27 options")).toBeVisible();
  await openEvidence(canvasElement);
  // The term's row holds the list; `getByText` would have thrown without it.
  const row = canvas.getByText("Questions", { selector: "dt" }).parentElement!;
  const items = within(row).getAllByRole("listitem");
  await expect(items.map((li) => li.textContent)).toEqual([
    "Question 1: Pick one, from 3 options; 0 to 1 selections",
    "Question 2: Pick any, from 5 options; 0 to 5 selections",
    "Question 3: Pick up to 2, from 4 options; 0 to 2 selections",
    "Question 4: Pick exactly 3, from 6 options; 3 to 3 selections",
    "Question 5: Pick at least 1, from 4 options; 1 to 4 selections",
    "Question 6: Pick 2 to 3, from 5 options; 2 to 3 selections",
  ]);
  await expect(canvas.getByText("Options", { selector: "dt" }).nextSibling).toHaveTextContent("27");
  await expect(canvas.queryByText("Selections per ballot")).toBeNull();
};

export const Questions: Story = { args: { poll: questions }, play: questionsPlay };

export const QuestionsDark: Story = {
  args: { poll: questions },
  parameters: { theme: "dark" },
  play: questionsPlay,
};

/** A rule broken in one question names the question, counted from 1. */
export const IllFormedQuestion: Story = {
  args: { poll: { ...questions, illFormed: { rule: "selections", question: 3 } } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("alert")).toHaveTextContent(
      "(selection limits) in question 4",
    );
  },
};

/** The poll's report section, where its outcome is said. */
const reportSection = (canvasElement: HTMLElement) =>
  within(within(canvasElement).getByRole("region", { name: "Something wrong with this poll?" }));

const choose = async (section: ReturnType<typeof within>, ground: string) => {
  await userEvent.click(section.getByRole("button", { name: "Report this poll" }));
  await expect(section.getByRole("button", { name: "Send report" })).toBeDisabled();
  await userEvent.click(section.getByRole("radio", { name: ground }));
  await userEvent.click(section.getByRole("button", { name: "Send report" }));
};

/** Nothing is sent until a ground is chosen and the report sent; then the poll and the ground alone. */
export const Report: Story = {
  args: { report: reporting("reported") },
  play: async ({ canvasElement, args }) => {
    const section = reportSection(canvasElement);
    await expect(section.getByText(/Anyone can report a poll, without an account/)).toBeVisible();
    await choose(section, "Personal data");
    await expect(await section.findByRole("status")).toHaveTextContent(
      "Reported. A moderator will look at it.",
    );
    await expect(args.report).toHaveBeenCalledTimes(1);
    await expect(args.report).toHaveBeenCalledWith(poll.electionId, "personal-data");
    // The form closes and focus goes back to the button that opened it.
    await waitFor(() =>
      expect(section.getByRole("button", { name: "Report this poll" })).toHaveFocus(),
    );
  },
};

export const ReportCancelled: Story = {
  args: { report: reporting("reported") },
  play: async ({ canvasElement, args }) => {
    const section = reportSection(canvasElement);
    await userEvent.click(section.getByRole("button", { name: "Report this poll" }));
    await userEvent.click(section.getByRole("radio", { name: "Spam" }));
    await userEvent.click(section.getByRole("button", { name: "Cancel" }));
    await expect(section.getByRole("button", { name: "Report this poll" })).toBeVisible();
    await expect(args.report).not.toHaveBeenCalled();
  },
};

export const ReportedPollGone: Story = {
  parameters: { theme: "dark" },
  args: { report: reporting("gone") },
  play: async ({ canvasElement }) => {
    const section = reportSection(canvasElement);
    await choose(section, "Threat");
    await expect(await section.findByRole("status")).toHaveTextContent(
      "This poll isn't on our server any more, so nothing was reported.",
    );
  },
};

/** A failure keeps the form and the chosen ground, so the report can be sent again. */
export const ReportFailed: Story = {
  args: { report: reporting("failed") },
  play: async ({ canvasElement }) => {
    const section = reportSection(canvasElement);
    await choose(section, "Harassment");
    await expect(await section.findByRole("status")).toHaveTextContent(
      "That didn't work. Nothing was reported; try again shortly.",
    );
    await expect(section.getByRole("radio", { name: "Harassment" })).toBeChecked();
    await expect(section.getByRole("button", { name: "Send report" })).toBeEnabled();
  },
};

/** The ballot client's address, as `BALLOT_URL` gives it. */
const BALLOT = "https://ballot.abolish.us/";

/** A poll with no title: its one question heads the page. */
const WORDED = {
  text: {
    language: "en",
    heading: "Should the park stay open late?",
    question: undefined,
    options: ["Yes", "No", "Abstain"],
  },
  words: {
    language: "en",
    title: "",
    questions: [{ question: "Should the park stay open late?", options: ["Yes", "No", "Abstain"] }],
  },
};

/**
 * Where its answers open the ballot app, the page goes from the lede straight
 * to the questions, as the open poll's mockup does: "What it asks" names the
 * section for screen readers only, and the first card stands 40px under the
 * lede (P2-29, the poll page's iteration 9).
 */
const fromTheLede = async (canvasElement: HTMLElement) => {
  const canvas = within(canvasElement);
  const asks = canvas.getByRole("region", { name: "What it asks" });
  const title = within(asks).getByRole("heading", { level: 2, name: "What it asks" });
  await expect(title.getBoundingClientRect().width).toBeLessThanOrEqual(1);
  // The header ends on the lede on an open poll.
  const header = canvasElement.querySelector("article > header");
  const card = within(asks).getAllByRole("listitem")[0];
  if (header === null || card === undefined) throw new Error("no header or question card");
  await expect(within(header as HTMLElement).getByText(/^(One question\.|\d+ questions,) /)).toBe(
    header.lastElementChild,
  );
  await expect(
    Math.round(card.getBoundingClientRect().top - header.getBoundingClientRect().bottom),
  ).toBe(40);
};

const wordedPlay: Story["play"] = async ({ canvasElement }) => {
  await fromTheLede(canvasElement);
  const canvas = within(canvasElement);
  const heading = canvas.getByRole("heading", { level: 1 });
  await expect(heading).toHaveTextContent("Should the park stay open late?");
  await expect(heading).toHaveAttribute("lang", "en");
  // No monospace label over an everyday poll's own words: the page opens on
  // its question, the ID one step down in the evidence (P2-29, the poll
  // page's iteration 11).
  await expect(heading).toBe(canvasElement.querySelector("article > header")?.firstElementChild);
  await expect(canvas.queryByText(/^Poll 1011121314151617…/)).toBeNull();
  await expectSaidOnce(canvasElement, false);
  const asks = canvas.getByRole("region", { name: "What it asks" });
  // The question heading the page isn't said again: its answers, numbered by question.
  await expect(within(asks).getByRole("heading", { name: "Question 1" })).toBeInTheDocument();
  // One line above the answers that open the ballot app, not "Pick one from
  // 3 options" over it as a second: the boxes count themselves and "Choose an
  // answer" says "Pick one" (P2-29, the poll page's iteration 8).
  await expect(within(asks).queryByText(/Pick one/)).toBeNull();
  await expect(within(asks).queryByText(/from 3 options/)).toBeNull();
  await expect(
    within(asks)
      .getAllByRole("listitem")
      .slice(1)
      .map((li) => li.textContent),
  ).toEqual(["Yes", "No", "Abstain"]);
  // Each answer opens the ballot client with it chosen, as a stream card's
  // does, the pick in the fragment alone (T-10, T-11; P2-29, the poll
  // page's iteration 1). The list is named by the question heading the page.
  const answers = within(asks).getByRole("list", { name: "Should the park stay open late?" });
  await expect(
    within(answers)
      .getAllByRole("link")
      .map((a) => [a.textContent, a.getAttribute("href")]),
  ).toEqual(
    ["Yes", "No", "Abstain"].map((label, pick) => [
      label,
      `${BALLOT}#election=${poll.electionId}&pick=${pick}`,
    ]),
  );
  await expect(within(answers).getByRole("link", { name: "Yes" })).toHaveStyle({
    minHeight: "48px",
  });
  // The question and its answers before the facts, as the open poll's
  // mockup orders them, and no "1" numbering the one question that heads the
  // page (P2-29, the poll page's iteration 2).
  const facts = canvas.getByRole("region", { name: "About this poll" });
  await expect(within(facts).getByText("Who can vote")).toBeInTheDocument();
  await expect(asks.compareDocumentPosition(facts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await expect(within(asks).queryByText("1", { exact: true })).toBeNull();
  await expect(
    within(asks).getByText(/^Choose an answer to open it in the ballot app\./),
  ).toBeVisible();
  // Said only before it opens, as the scheduled poll's mockup says it.
  await expect(within(asks).queryByText(/^The poll's definition fixes these words/)).toBeNull();
  await expect(canvas.queryByText(/^Nothing can be answered until it opens/)).toBeNull();
  // The open poll's lede: answered again until it closes, the last one counting (G-11).
  await expect(
    canvas.getByText(
      "One question. You can change your answer until the poll closes, and only your last one counts.",
    ),
  ).toBeVisible();
  // One way into the ballot client, with the poll in the fragment alone (T-10, T-11).
  await expect(canvas.getByRole("link", { name: "Answer the question" })).toHaveAttribute(
    "href",
    `${BALLOT}#election=${poll.electionId}`,
  );
  // What choosing does is said once, on the answers' card, as the stream
  // says it once above its cards, not again under the button (P2-29, the poll
  // page's iteration 7).
  await expect(canvas.getAllByText(/Nothing is sent until you cast/)).toHaveLength(1);
  await expect(
    within(canvas.getByRole("region", { name: "Answering" })).queryByText(/Nothing is sent/),
  ).toBeNull();
  // The way in and the share in one row, of one height, where both fit; the
  // share stood alone on its own line under the green button (P2-29, the poll
  // page's iteration 12).
  if (window.matchMedia("(min-width: 48rem)").matches) {
    const way = canvas.getByRole("link", { name: "Answer the question" }).getBoundingClientRect();
    const share = canvas.getByRole("button", { name: "Share this poll" }).getBoundingClientRect();
    await expect(share.top).toBe(way.top);
    await expect(share.height).toBe(way.height);
    await expect(share.left).toBeGreaterThan(way.right);
  }
  // The share is as wide as its words, its icon right after them as the way
  // in's arrow is: a fixed minimum width set its icon at the far edge of a
  // box wider than the green button beside it (P2-29, the poll page's
  // iteration 14).
  for (const control of [
    canvas.getByRole("link", { name: "Answer the question" }),
    canvas.getByRole("button", { name: "Share this poll" }),
  ]) {
    const words = control.ownerDocument.createRange();
    words.selectNodeContents(control);
    words.setEndBefore(control.querySelector("svg") ?? control);
    const icon = control.querySelector("svg")?.getBoundingClientRect();
    await expect(
      (icon?.left ?? Infinity) - words.getBoundingClientRect().right,
    ).toBeLessThanOrEqual(16);
  }
};

/** In its own words, answerable in the ballot client. */
export const Worded: Story = { args: { ...WORDED, ballot: BALLOT }, play: wordedPlay };

export const WordedDark: Story = {
  args: { ...WORDED, ballot: BALLOT },
  parameters: { theme: "dark" },
  play: wordedPlay,
};

/**
 * Open, closing in three days, its answers sealed until then: the facts and
 * the results' sentence say the close on the visitor's clock, the evidence
 * in UTC (P2-29, the poll page's iteration 3).
 */
export const WordedClosing: Story = {
  args: {
    ...WORDED,
    ballot: BALLOT,
    poll: { ...poll, closesAt: { seconds: "1767830400", iso: "2026-01-08T00:00:00.000Z" } },
    results: { kind: "unopened" },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const facts = canvas.getByRole("region", { name: "About this poll" });
    // Midnight UTC on January 8 is the evening of January 7 in New York.
    await expect(within(facts).getByText(/^January 7 at 7:00\sPM\sEST$/)).toBeVisible();
    await expect(within(facts).getByText(/^December 31, 2025 at 7:00\sPM\sEST$/)).toBeVisible();
    await expect(within(facts).queryByText(/UTC/)).toBeNull();
    await expect(
      canvas.getByText(/^The answers stay sealed until the poll closes on/),
    ).toHaveTextContent(/closes on January 7, 2026 at 7:00\sPM\sEST\./);
    // The evidence keeps UTC, the board's own time.
    await openEvidence(canvasElement);
    const evidence = canvas.getByRole("region", { name: "How do we know this is real?" });
    await expect(
      within(evidence).getByText(/^January 8, 2026 at 12:00\sAM\sUTC$/),
    ).toBeInTheDocument();
  },
};

/** A titled poll of several questions: each question in its words, with its answers. */
const WORDED_QUESTIONS = {
  poll: { ...questions, questions: questions.questions.slice(0, 2) },
  text: {
    language: "en",
    heading: "Park and library",
    question: "Should the park stay open late?",
    options: ["Yes", "No", "Abstain"],
  },
  words: {
    language: "en",
    title: "Park and library",
    questions: [
      { question: "Should the park stay open late?", options: ["Yes", "No", "Abstain"] },
      {
        question: "Which days should the library open on Sundays and holidays?",
        options: ["Sundays", "Public holidays", "School holidays", "Every evening", "None"],
      },
    ],
  },
  ballot: BALLOT,
} satisfies Story["args"];

export const WordedQuestions: Story = {
  args: WORDED_QUESTIONS,
  play: async ({ canvasElement }) => {
    await fromTheLede(canvasElement);
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("Park and library");
    // Questions of their own are numbered beside their words.
    const asks = canvas.getByRole("region", { name: "What it asks" });
    await expect(within(asks).getByText("1", { exact: true })).toBeVisible();
    await expect(within(asks).getByText("2", { exact: true })).toBeVisible();
    await expect(
      canvas.getByRole("heading", { name: "Question 1: Should the park stay open late?" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("heading", {
        name: "Question 2: Which days should the library open on Sundays and holidays?",
      }),
    ).toBeVisible();
    await expect(canvas.getByText("Pick any from 5 options")).toBeVisible();
    await expect(canvas.getByText("Public holidays")).toBeVisible();
    // A link carries one pick, for question 1: its answers are links, named
    // by their question, and question 2's are words, with no box to tap.
    await expect(
      within(
        canvas.getByRole("list", { name: "Question 1: Should the park stay open late?" }),
      ).getByRole("link", { name: "No" }),
    ).toHaveAttribute("href", `${BALLOT}#election=${poll.electionId}&pick=1`);
    // The card is numbered and the lede counts the questions, so its line
    // doesn't say "to question 1 of 2" a third time (P2-29, the poll page's
    // iteration 10).
    await expect(
      within(asks).getByText(
        "Choose an answer to open it in the ballot app. Nothing is sent until you cast your ballot there.",
      ),
    ).toBeVisible();
    await expect(within(asks).queryByText(/question 1 of/)).toBeNull();
    // Question 1's rule is said by its one line; question 2's, whose answers
    // are words, keeps its own (P2-29, the poll page's iteration 8).
    await expect(canvas.queryByText("Pick one from 3 options")).toBeNull();
    await expect(canvas.queryByRole("link", { name: "Public holidays" })).toBeNull();
    await expect(canvas.getByText("Public holidays")).toHaveStyle({ borderTopWidth: "0px" });
    await expect(canvas.getByRole("link", { name: "Answer 2 questions" })).toBeVisible();
    await expect(canvas.getAllByText(/Nothing is sent until you cast/)).toHaveLength(1);
    await expect(
      canvas.getByText(/^2 questions, answered together\. You can change your answers until/),
    ).toBeVisible();
  },
};

/**
 * On a small phone's first screen, a poll of several questions shows its
 * first answer whole, as the frame's own phone stories hold the system pages'
 * first actions (P2-29, the poll page's iteration 9).
 */
export const WordedQuestionsPhone: Story = {
  args: WORDED_QUESTIONS,
  globals: { viewport: { value: "phone", isRotated: false } },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.ownerDocument.documentElement.clientWidth).toBe(360);
    await fromTheLede(canvasElement);
    const answers = within(
      within(canvasElement).getByRole("list", {
        name: "Question 1: Should the park stay open late?",
      }),
    );
    const first = answers.getByRole("link", { name: "Yes" });
    await expect(first.getBoundingClientRect().bottom).toBeLessThanOrEqual(640);
    // With no monospace label over the title, the second answer is on the
    // first screen too, where the label's two lines held it under (P2-29,
    // the poll page's iteration 11).
    await expect(
      answers.getByRole("link", { name: "No" }).getBoundingClientRect().bottom,
    ).toBeLessThanOrEqual(640);
    // The line above the answers keeps to four lines in the numbered
    // card's 182px at 360, where "to question 1 of 2" made it five (P2-29,
    // the poll page's iteration 10).
    const line = within(canvasElement).getByText(/^Choose an answer to open it/);
    await expect(
      line.getBoundingClientRect().height / parseFloat(getComputedStyle(line).lineHeight),
    ).toBeLessThanOrEqual(4.1);
    // At 360 the two don't fit side by side: the way in first, the share
    // under it (P2-29, the poll page's iteration 12).
    const way = within(canvasElement)
      .getByRole("link", { name: "Answer 2 questions" })
      .getBoundingClientRect();
    await expect(
      within(canvasElement).getByRole("button", { name: "Share this poll" }).getBoundingClientRect()
        .top,
    ).toBeGreaterThan(way.bottom);
  },
};

/**
 * A first question that takes more than one answer: a link carries one pick,
 * so its rule leads the line above the answers, the one line there (P2-29,
 * the poll page's iteration 8).
 */
export const WordedApproval: Story = {
  args: {
    ...WORDED,
    ballot: BALLOT,
    poll: { ...poll, questions: [{ optionCount: 3, minSelections: 0, maxSelections: 2 }] },
  },
  play: async ({ canvasElement }) => {
    const asks = within(within(canvasElement).getByRole("region", { name: "What it asks" }));
    await expect(
      asks.getByText(
        "Pick up to 2. Choose an answer to open it in the ballot app. Nothing is sent until you cast your ballot there.",
      ),
    ).toBeVisible();
    await expect(asks.queryByText(/from 3 options/)).toBeNull();
    await expect(asks.getAllByRole("link")).toHaveLength(3);
  },
};

/** A question in a right-to-left script keeps its own direction beside our words. */
export const WordedRightToLeft: Story = {
  args: {
    text: {
      language: "he",
      heading: "האם הפארק יישאר פתוח?",
      question: undefined,
      options: ["כן", "לא", "נמנע"],
    },
    words: {
      language: "he",
      title: "",
      questions: [
        {
          question: "האם הפארק יישאר פתוח?",
          options: ["כן", "לא", "נמנע"],
        },
      ],
    },
    ballot: BALLOT,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const heading = canvas.getByRole("heading", { level: 1 });
    await expect(heading).toHaveAttribute("lang", "he");
    await expect(heading).toHaveAttribute("dir", "auto");
    await expect(canvas.getByText("נמנע")).toHaveAttribute("dir", "auto");
  },
};

/** Not open yet: its words, and no way in until it opens. */
export const WordedScheduled: Story = {
  args: {
    ...WORDED,
    ballot: BALLOT,
    asOf: { seconds: "1767225599", iso: "2025-12-31T23:59:59.000Z" },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const asks = canvas.getByRole("region", { name: "What it asks" });
    await expect(asks).toBeVisible();
    // Before it opens nothing links answering, so the section keeps its
    // visible heading over the note (P2-29, the poll page's iteration 9).
    await expect(
      within(asks).getByRole("heading", { level: 2 }).getBoundingClientRect().width,
    ).toBeGreaterThan(1);
    await expect(within(asks).getByText(/^The poll's definition fixes these words/)).toBeVisible();
    await expect(canvas.getByText(/^Nothing can be answered until it opens\./)).toBeVisible();
    await expect(canvas.getByText("You can answer here once the poll opens.")).toBeVisible();
    await expect(canvas.queryByRole("link", { name: /^Answer/ })).toBeNull();
    // Its answers are words until it opens, with no box to tap.
    await expect(within(asks).queryByRole("link")).toBeNull();
    await expect(within(asks).getByText("Yes")).toHaveStyle({ borderTopWidth: "0px" });
    await expect(canvas.queryByText(/You can change your answers? until/)).toBeNull();
  },
};

/** A deployment that names no ballot client says so and links nowhere. */
export const WordedNoBallot: Story = {
  args: { ...WORDED, ballot: null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText("Answering from this page isn't set up on this site yet."),
    ).toBeVisible();
    await expect(canvas.queryByRole("link", { name: /^Answer/ })).toBeNull();
    await expect(canvas.queryByRole("link", { name: "Yes" })).toBeNull();
    // Nothing to answer here, so nothing promised about answering again.
    await expect(canvas.queryByText(/You can change your answers? until/)).toBeNull();
  },
};

/** Closed, of two questions, with Tier 0 alone counting it. */
const FINAL = {
  ...WordedQuestions.args,
  ...Closed.args,
  poll: {
    ...questions,
    questions: questions.questions.slice(0, 2),
    electorate: [{ tier: 0 as const, groupSize: "5000" }],
    closesAt: { seconds: "1767830400", iso: "2026-01-08T00:00:00.000Z" },
  },
  results: {
    kind: "read" as const,
    tiers: [
      {
        tier: 0 as const,
        counted: 8,
        questions: [
          ["4", "4", "0"],
          ["5", "1", "0", "0", "2"],
        ],
      },
    ],
  },
};

const inShortPlay: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(
    canvas.getByText("Final results. 8 people answered; here is what they said."),
  ).toBeVisible();
  // Counted, the results name every question and answer, so "What it asks"
  // isn't said again, and they come straight after the summary, before the
  // facts, as the closed poll's mockup orders them (P2-29, the poll page's
  // iteration 6).
  await expect(canvas.queryByRole("region", { name: "What it asks" })).toBeNull();
  const results = canvas.getByRole("heading", { level: 2, name: "Results" });
  const facts = canvas.getByRole("heading", { level: 2, name: "About this poll" });
  await expect(
    results.compareDocumentPosition(facts) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  for (const answer of ["Abstain", "School holidays", "Every evening"])
    await expect(canvas.getByText(answer)).toBeVisible();
  const items = within(canvas.getByRole("list", { name: "In short" })).getAllByRole("listitem");
  await expect(items.map((li) => li.textContent)).toEqual([
    "Should the park stay open late?" +
      "Tied for most picked: ⁨Yes⁩ and ⁨No⁩, each by 50% of those who answered.",
    "Which days should the library open on Sundays and holidays?" +
      "Most picked: ⁨Sundays⁩, by 62.5% of those who answered.",
  ]);
  // The summary's link to what it rests on opens the evidence and takes the reader there.
  const evidence = canvasElement.querySelector("details");
  await expect(evidence).not.toHaveAttribute("open");
  const link = canvas.getByRole("link", { name: "How do we know this is real?" });
  await expect(link).toHaveAttribute("href", "#evidence");
  // The test runner's frame mustn't navigate, even to a fragment; the
  // page's own handler still runs, which is what opens the disclosure.
  const stay = (event: Event) => event.preventDefault();
  canvasElement.addEventListener("click", stay, { capture: true });
  await userEvent.click(link);
  canvasElement.removeEventListener("click", stay, { capture: true });
  await expect(evidence).toHaveAttribute("open");
  await expect(canvas.getByText(/^Everything below is what our server says/)).toBeVisible();
};

/** A closed poll counted in its one tier, each question's lead under its heading. */
export const InShort: Story = { args: FINAL, play: inShortPlay };

export const InShortDark: Story = {
  args: FINAL,
  parameters: { theme: "dark" },
  play: inShortPlay,
};

/** A hidden poll's summary goes by question and answer number, as its results do. */
export const InShortHidden: Story = {
  args: {
    ...FINAL,
    // The loader withholds a hidden poll's words (T-68).
    text: undefined,
    words: undefined,
    share: undefined,
    moderation: {
      state: "hidden",
      latest: {
        seq: "7",
        action: "hide",
        reason: "personal-data",
        decidedAt: "2026-10-01T12:00:00.000Z",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const items = within(
      within(canvasElement).getByRole("list", { name: "In short" }),
    ).getAllByRole("listitem");
    await expect(items.map((li) => li.textContent)).toEqual([
      "Question 1" +
        "Tied for most picked: ⁨Answer 1⁩ and ⁨Answer 2⁩, each by 50% of those who answered.",
      "Question 2Most picked: ⁨Answer 1⁩, by 62.5% of those who answered.",
    ]);
    await expect(within(canvasElement).queryByText(/Should the park/)).toBeNull();
  },
};

/** Several tiers have no lead across them, so no summary (ADR 0026; T-16); nor has an open poll. */
export const InShortNone: Story = {
  args: {
    ...FINAL,
    poll: { ...FINAL.poll, electorate: questions.electorate },
    results: {
      kind: "read",
      tiers: [
        ...FINAL.results.tiers,
        {
          tier: 2,
          counted: 1,
          questions: [
            ["1", "0", "0"],
            ["0", "1", "0", "0", "0"],
          ],
        },
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "Results" })).toBeVisible();
    await expect(canvas.queryByRole("list", { name: "In short" })).toBeNull();
    // With no summary, the questions keep their own section; closed,
    // nothing in it opens the ballot client.
    await expect(
      within(canvas.getByRole("region", { name: "What it asks" })).queryByRole("link"),
    ).toBeNull();
    await expect(canvas.queryByText(/^Final results/)).toBeNull();
    await expect(canvas.queryByRole("link", { name: "How do we know this is real?" })).toBeNull();
  },
};
