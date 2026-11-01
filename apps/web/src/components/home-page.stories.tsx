import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { NO_TAGS, type PollView } from "../poll.ts";
import type { StreamCard } from "../stream.ts";
import { HomePage } from "./home-page.tsx";
import { SiteLayout } from "./site-layout.tsx";

const poll = (electionId: string, overrides: Partial<PollView> = {}): PollView => ({
  electionId,
  definitionHash: "a4555c67fbc57b7ed42f873f73f36360baba11fa0de1f0ba0f104780a4071750",
  version: 5,
  illFormed: undefined,
  rolling: false,
  pollClass: "everyday",
  counting: "questions",
  questions: [{ optionCount: 3, minSelections: 0, maxSelections: 1 }],
  electorate: [{ tier: 0, groupSize: "5000" }],
  threshold: 1,
  panelSize: 1,
  opensAt: { seconds: "1767225600", iso: "2026-01-01T00:00:00.000Z" },
  closesAt: { seconds: "1767830400", iso: "2026-01-08T00:00:00.000Z" },
  ...overrides,
});

const LIBRARY = "10".repeat(32);
const RIVERSIDE = "20".repeat(32);
const BUS = "30".repeat(32);

const cards: StreamCard[] = [
  {
    kind: "poll",
    poll: poll(LIBRARY),
    text: {
      language: "en",
      heading: "Library hours",
      question: "When should the main library open on Sundays?",
      options: ["At 10", "At noon", "Stay closed"],
    },
    tags: { topic: "culture", place: "Eastside" },
    answered: [{ tier: 0, answered: "86" }],
  },
  {
    kind: "poll",
    poll: poll(RIVERSIDE, {
      questions: [
        { optionCount: 4, minSelections: 0, maxSelections: 1 },
        { optionCount: 5, minSelections: 0, maxSelections: 1 },
      ],
      closesAt: { seconds: "1768435200", iso: "2026-01-15T00:00:00.000Z" },
    }),
    text: {
      language: "en",
      heading: "Riverside park",
      question: "Which one improvement matters most to you?",
      options: ["Better lighting", "Public toilets", "Basketball courts", "Street trees"],
    },
    tags: { topic: undefined, place: "Riverside Park" },
    askedBy: { handle: "k7qa2mzr5xw3bn4d", name: "Riverside Neighbours" },
  },
  {
    kind: "poll",
    poll: poll(BUS, { version: 1, counting: "plurality" }),
    text: {
      language: "en",
      heading: "Should the 23 bus run until midnight?",
      question: undefined,
      options: ["Yes", "No"],
    },
    tags: NO_TAGS,
  },
];

const PARK = "40".repeat(32);

/** The most answered this week of the polls not among the newest. */
const featured: StreamCard = {
  kind: "poll",
  poll: poll(PARK, {
    closesAt: { seconds: "1768435200", iso: "2026-01-15T00:00:00.000Z" },
  }),
  text: {
    language: "en",
    heading: "Should the park stay open late?",
    question: undefined,
    options: ["Yes", "No"],
  },
  tags: { topic: "community", place: "Riverside Park" },
  answered: [{ tier: 0, answered: "1204" }],
};

const meta = {
  component: HomePage,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <SiteLayout current="/">
        <Story />
      </SiteLayout>
    ),
  ],
  args: { newest: { cards, ballot: "https://ballot.example/", phoneVerification: false } },
} satisfies Meta<typeof HomePage>;

export default meta;
type Story = StoryObj<typeof meta>;

const play: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const main = within(canvas.getByRole("main"));
  await expect(main.getByRole("heading", { level: 1 })).toHaveTextContent(
    "Ask anything. Anyone can answer. Anyone can check the count.",
  );
  // Asking signs a visitor in for it, then opens a new poll's form; browsing
  // is the stream, not the register.
  await expect(main.getByRole("link", { name: "Ask a question" })).toHaveAttribute(
    "href",
    "/account?next=new-poll",
  );
  await expect(main.getByRole("link", { name: "Browse questions" })).toHaveAttribute(
    "href",
    "/discover",
  );
  // The newest questions by their words, each answerable from its card.
  const newest = within(main.getByRole("list", { name: "What people are asking" }));
  await expect(newest.getAllByRole("article")).toHaveLength(3);
  await expect(newest.getByRole("heading", { name: "Library hours" })).toBeVisible();
  await expect(newest.getByRole("link", { name: "At noon" })).toHaveAttribute(
    "href",
    `https://ballot.example/#election=${LIBRARY}&pick=1`,
  );
  await expect(main.getByRole("link", { name: "See all questions" })).toHaveAttribute(
    "href",
    "/discover",
  );
  // What choosing an answer does is said once, above the cards; a card of
  // several questions says only which one its answers are for.
  await expect(main.getAllByText(/Nothing is sent until you cast your ballot/)).toHaveLength(1);
  await expect(main.getByText(/The newest open questions\. Choose an answer/)).toBeVisible();
  await expect(newest.getByText("These answers are for question 1 of 2.")).toBeVisible();
  // A card says how many have answered so far, by tier, as in the stream.
  const counts = newest.getAllByRole("list", { name: /^Answered since it opened / });
  await expect(counts).toHaveLength(1);
  await expect(within(counts[0]!).getByRole("listitem")).toHaveTextContent(
    "86 people with a verified e-mail",
  );
  // The lede and the trust scene name the app that seals an answer one way,
  // where two names read as two apps.
  await expect(canvas.getByRole("main")).toHaveTextContent(/open it in the ballot app\./);
  await expect(canvas.getByRole("main")).toHaveTextContent(/the ballot app seals it/);
  await expect(canvas.getByRole("main")).not.toHaveTextContent(/voting app/);
  // The trust scene's picture counts seats, so its words name them as the
  // trustees' seats the first time, not trustees in one sentence and seats,
  // unexplained, in the next.
  const words = canvas.getByRole("main").textContent ?? "";
  await expect(words.match(/\b(\w+) seats?\b/)?.[1]).toBe("trustee");
  await expect(words).not.toMatch(/poll's trustees/);
  // While the poll is open the board shows an answer is there, not that it
  // was counted: step 3 says the count is opened only after the poll closes.
  await expect(words).toMatch(/find yours there and see that it stays there\./);
  await expect(words).not.toMatch(/it was counted/);
  // The lede promises the referendum's steps, not its care: step 3 says
  // launch polls are held by Abolish alone, where a referendum waits for
  // independent trustees.
  await expect(words).toMatch(/sealed, posted and counted the same way as a referendum\./);
  await expect(words).not.toMatch(/same care/);
  // Step 3 says what step 1's detail does: each seat holds a share of every
  // sealed answer. There is no key split among the seats to hold a share of.
  await expect(words).toMatch(/each holding one share of every sealed answer,/);
  await expect(words).not.toMatch(/share of the key/);
  // The civic register's words and the ID lookup stay on the poll register.
  await expect(main.queryByRole("textbox")).toBeNull();
  await expect(canvas.getByRole("main")).not.toHaveTextContent(/server|64-character|Poll ID/);
  await expect(
    main.getByRole("heading", { name: "Why you can trust a casual poll" }),
  ).toBeVisible();
};

export const Default: Story = {
  play: async (context) => {
    await play(context);
    // From 640px each promise starts its own line, where run together the
    // lines broke after "Anyone" twice.
    if (context.canvasElement.ownerDocument.documentElement.clientWidth < 640) return;
    const title = within(context.canvasElement).getByRole("heading", { level: 1 });
    const lines = [...title.children].map((line) => line.getBoundingClientRect());
    await expect(lines).toHaveLength(3);
    await expect(lines[1]?.top).toBeGreaterThanOrEqual(lines[0]?.bottom ?? Infinity);
    await expect(lines[2]?.top).toBeGreaterThanOrEqual(lines[1]?.bottom ?? Infinity);
  },
};

export const Dark: Story = { parameters: { theme: "dark" }, play };

/**
 * On a small phone both ways in are on the first screen, under the frame's
 * header: by 568px, a 320 by 568 screen's height, where iteration 1's
 * "Browse questions" ended at 577px at this width.
 */
export const Phone: Story = {
  globals: { viewport: { value: "phone", isRotated: false } },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.ownerDocument.documentElement.clientWidth).toBe(360);
    const main = within(within(canvasElement).getByRole("main"));
    for (const name of ["Ask a question", "Browse questions"])
      await expect(
        main.getByRole("link", { name }).getBoundingClientRect().bottom,
      ).toBeLessThanOrEqual(568);
    // Where the cards stack, the first follows the lede with nothing between,
    // and "See all questions" comes after the last, where iteration 3 put it
    // between the lede and the first card.
    const lede = main.getByText(/^The newest open questions\./).getBoundingClientRect();
    const cards = main.getAllByRole("article").map((card) => card.getBoundingClientRect());
    await expect(cards[0]?.top).toBeLessThanOrEqual(lede.bottom + 32);
    await expect(
      main.getByRole("link", { name: "See all questions" }).getBoundingClientRect().top,
    ).toBeGreaterThan(cards.at(-1)?.bottom ?? Infinity);
    // In the frame, step 3's seven keys share one row beside the lock, where
    // iteration 5's wrapped one at a time and left the seventh on a line of
    // its own.
    const steps = within(main.getByRole("region", { name: "What happens to an answer" }));
    const step3 = steps.getAllByRole("listitem")[2];
    if (step3 === undefined) throw new Error("no step 3");
    const keys = within(step3).getByTestId("trust-keys");
    const tops = [...keys.querySelectorAll("svg")].map((key) => key.getBoundingClientRect().top);
    await expect(tops).toHaveLength(7);
    await expect(new Set(tops).size).toBe(1);
    const lock = keys.previousElementSibling?.getBoundingClientRect();
    await expect(lock?.right).toBeLessThan(keys.getBoundingClientRect().left);
    await expect(lock?.bottom).toBeGreaterThan(tops[0] ?? Infinity);
  },
};

/**
 * No open questions: the page says so, and the ways to ask and browse stay.
 * Every Discover order lists open polls only, so the section doesn't offer
 * "See all questions" to a page that says there are none either.
 */
export const Empty: Story = {
  args: { newest: { cards: [], ballot: "https://ballot.example/", phoneVerification: false } },
  play: async ({ canvasElement }) => {
    const main = within(within(canvasElement).getByRole("main"));
    await expect(main.getByText(/No questions are open just now/)).toBeVisible();
    // With no card, there is no lede promising the newest questions above
    // the note that says there are none.
    await expect(main.queryByText("The newest open questions.", { exact: false })).toBeNull();
    await expect(main.queryByText(/Choose an answer/)).toBeNull();
    await expect(main.queryByRole("list", { name: "What people are asking" })).toBeNull();
    await expect(main.queryByRole("link", { name: "See all questions" })).toBeNull();
    await expect(main.getByRole("link", { name: "Ask a question" })).toBeVisible();
    await expect(main.getByRole("link", { name: "Browse questions" })).toBeVisible();
  },
};

/**
 * The API didn't answer: only the newest questions are left out, and nothing
 * says why (T-67). A poll's page, its short link and Discover read the same
 * API, so the note promises none of them, and the section doesn't offer
 * "See all questions" under a note saying they couldn't be loaded. The
 * hero's ways in stay, as the frame's links do.
 */
export const Unavailable: Story = {
  args: { newest: undefined },
  play: async ({ canvasElement }) => {
    const main = within(within(canvasElement).getByRole("main"));
    await expect(
      main.getByText(
        "The newest questions couldn't be loaded just now. Try again in a little while.",
      ),
    ).toBeVisible();
    await expect(main.queryByText(/still works/)).toBeNull();
    await expect(main.queryByText("The newest open questions.", { exact: false })).toBeNull();
    await expect(main.queryByRole("article")).toBeNull();
    await expect(main.queryByRole("link", { name: "See all questions" })).toBeNull();
    await expect(main.getByRole("link", { name: "Browse questions" })).toBeVisible();
  },
};

/**
 * The question the mockup features beside the promise: the most answered
 * this week of those not among the newest, answerable from its own card,
 * which says what choosing an answer does since the newest's lede comes
 * after it. On a phone it follows both ways in, which stay on the first
 * screen.
 */
export const Featured: Story = {
  args: {
    newest: { cards, ballot: "https://ballot.example/", phoneVerification: false },
    featured,
  },
  play: async ({ canvasElement }) => {
    const main = within(within(canvasElement).getByRole("main"));
    const region = main.getByRole("region", { name: "Most answered this week" });
    const card = within(region);
    await expect(
      card.getByRole("heading", { name: "Should the park stay open late?" }),
    ).toBeVisible();
    await expect(card.getByRole("link", { name: "No" })).toHaveAttribute(
      "href",
      `https://ballot.example/#election=${PARK}&pick=1`,
    );
    await expect(card.getByRole("link", { name: "More of the most answered" })).toHaveAttribute(
      "href",
      "/discover?sort=answered",
    );
    await expect(card.getByText(/^Choose an answer to open it in the ballot app\./)).toBeVisible();
    // The newest three stay as they were, below it.
    const newest = main.getByRole("list", { name: "What people are asking" });
    await expect(within(newest).getAllByRole("article")).toHaveLength(3);
    await expect(region.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      newest.getBoundingClientRect().top,
    );
    const browse = main.getByRole("link", { name: "Browse questions" }).getBoundingClientRect();
    if (canvasElement.ownerDocument.documentElement.clientWidth < 1024) {
      // Stacked: after the ways in, which stay on a small phone's first screen.
      await expect(region.getBoundingClientRect().top).toBeGreaterThanOrEqual(browse.bottom);
      await expect(browse.bottom).toBeLessThanOrEqual(568);
    } else {
      // Beside the lede and the ways in, in the columns they leave.
      await expect(region.getBoundingClientRect().left).toBeGreaterThan(browse.right);
    }
  },
};

export const FeaturedPhone: Story = {
  ...Featured,
  globals: { viewport: { value: "phone", isRotated: false } },
};
