import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { NO_TAGS, type PollView } from "../poll.ts";
import type { StreamCard } from "../stream.ts";
import { streamHref } from "../stream.ts";
import { StreamPage } from "./stream.tsx";

const poll = (electionId: string, overrides: Partial<PollView> = {}): PollView => ({
  electionId,
  definitionHash: "a4555c67fbc57b7ed42f873f73f36360baba11fa0de1f0ba0f104780a4071750",
  version: 5,
  illFormed: undefined,
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
const UNREADABLE = "40".repeat(32);
const NEXT = "50".repeat(32);
const BALLOT = "https://ballot.example/";

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
    answered: [{ tier: 0, answered: "1204" }],
  },
  {
    kind: "poll",
    poll: poll(RIVERSIDE, {
      questions: [
        { optionCount: 4, minSelections: 0, maxSelections: 1 },
        { optionCount: 4, minSelections: 0, maxSelections: 4 },
        { optionCount: 5, minSelections: 0, maxSelections: 1 },
      ],
      electorate: [
        { tier: 0, groupSize: "5000" },
        { tier: 2, groupSize: "800" },
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
    answered: [
      { tier: 0, answered: "38" },
      { tier: 2, answered: "1" },
    ],
  },
  {
    kind: "poll",
    poll: poll(BUS, { version: 1, counting: "plurality" }),
    text: {
      language: "es-419",
      heading: "¿Debería el autobús 23 circular hasta la medianoche?",
      question: undefined,
      options: ["Sí", "No"],
    },
    tags: NO_TAGS,
  },
  { kind: "unavailable", electionId: UNREADABLE, problem: "text" },
];

const meta = {
  component: StreamPage,
  args: {
    stream: { kind: "stream", cards, next: NEXT },
    sort: "new",
    typed: "",
    typedPlace: "",
    filter: {},
    ballot: BALLOT,
    phoneVerification: false,
  },
} satisfies Meta<typeof StreamPage>;

export default meta;
type Story = StoryObj<typeof meta>;

const searchForm = (root: HTMLElement) =>
  within(root).getByRole("search", { name: "Search the questions" });
const placeForm = (root: HTMLElement) => within(root).getByRole("search", { name: "Place" });

const questions = (root: HTMLElement) =>
  within(within(root).getByRole("list", { name: "Questions" }));

const play: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
    "What people are asking",
  );
  const list = questions(canvasElement);
  await expect(list.getAllByRole("article")).toHaveLength(4);

  // Each card's heading names the poll's page; the asker's words keep their own language.
  const library = list.getByRole("heading", { name: "Library hours" });
  await expect(within(library).getByRole("link")).toHaveAttribute("href", `/polls/${LIBRARY}`);
  await expect(list.getByText("When should the main library open on Sundays?")).toBeVisible();
  await expect(
    list.getByRole("heading", { name: "¿Debería el autobús 23 circular hasta la medianoche?" }),
  ).toHaveAttribute("lang", "es-419");

  // A card names who asked only where its author chose to say, linking to
  // their profile (T-75).
  const asker = list.getByRole("link", { name: "Riverside Neighbours" });
  await expect(asker).toHaveAttribute("href", "/by/k7qa2mzr5xw3bn4d");
  await expect(list.getAllByText(/Asked by/)).toHaveLength(1);

  // Each answer opens the ballot client with it chosen, the poll and the
  // pick in the fragment only ([[first-answer]], step 1).
  // Each list of answers is named by the question it answers.
  const libraryAnswers = within(
    list.getByRole("list", { name: "When should the main library open on Sundays?" }),
  );
  const answers = libraryAnswers.getAllByRole("link");
  await expect(answers.map((a) => a.getAttribute("href"))).toEqual([
    `${BALLOT}#election=${LIBRARY}&pick=0`,
    `${BALLOT}#election=${LIBRARY}&pick=1`,
    `${BALLOT}#election=${LIBRARY}&pick=2`,
  ]);
  await expect(answers[0]).toHaveAccessibleName("At 10");
  await expect(answers[0]).toHaveAccessibleDescription("Library hours");
  // What choosing an answer does is said once, above the cards, not on each;
  // a poll of several questions still says which one its answers are for.
  await expect(canvas.getAllByText(/Nothing is sent until you cast/)).toHaveLength(1);
  await expect(list.queryByText(/Nothing is sent/)).toBeNull();
  await expect(list.getByText("These answers are for question 1 of 3.")).toBeVisible();
  const riverside = within(
    list.getByRole("list", { name: "Which one improvement matters most to you?" }),
  );
  await expect(riverside.getAllByRole("link")).toHaveLength(4);
  await expect(riverside.getAllByRole("link")[3]).toHaveAttribute(
    "href",
    `${BALLOT}#election=${RIVERSIDE}&pick=3`,
  );
  await expect(list.getByText("Which one improvement matters most to you?")).toBeVisible();
  const bus = list.getByRole("link", { name: "Sí" });
  await expect(bus).toHaveAttribute("href", `${BALLOT}#election=${BUS}&pick=0`);
  await expect(within(bus).getByText("Sí")).toHaveAttribute("lang", "es-419");
  await expect(list.getByText("3 questions")).toBeVisible();
  await expect(list.getAllByText(/^Closes/)[0]).toHaveTextContent("Closes January 8, 2026");

  // Where each poll is listed, each tag a way into the stream narrowed to it;
  // a poll filed under neither shows none.
  const listed = list.getAllByRole("list", { name: "Where it's listed" });
  await expect(listed).toHaveLength(2);
  const [libraryTagList, riversideTagList] = listed;
  if (libraryTagList === undefined || riversideTagList === undefined)
    throw new Error("a tagged card shows no tags");
  const libraryTags = within(libraryTagList);
  const riversideTags = within(riversideTagList);
  await expect(libraryTags.getByRole("link", { name: "Culture" })).toHaveAttribute(
    "href",
    "/discover?topic=culture",
  );
  await expect(libraryTags.getByRole("link", { name: "Eastside" })).toHaveAttribute(
    "href",
    "/discover?place=Eastside",
  );
  await expect(riversideTags.getAllByRole("link")).toHaveLength(1);
  await expect(riversideTags.getByRole("link")).toHaveAttribute(
    "href",
    "/discover?place=Riverside%20Park",
  );

  // A poll whose text failed its checks shows none, and can't be answered from here.
  await expect(list.getByText(/text can't be shown here/)).toBeVisible();

  // The order is a link like the others; more comes only when asked for.
  const order = canvas.getByRole("navigation", { name: "Order" });
  await expect(within(order).getByRole("link", { name: "New" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(within(order).getByRole("link", { name: "Closing soon" })).toHaveAttribute(
    "href",
    "/discover?sort=closing",
  );
  await expect(canvas.getByRole("link", { name: "More questions" })).toHaveAttribute(
    "href",
    `/discover?after=${NEXT}`,
  );
  // No engagement counts.
  await expect(canvas.queryByText(/viewing now|streak/i)).toBeNull();

  // The search box is a plain GET to the stream, keeping no order but the default.
  const search = searchForm(canvasElement);
  await expect(search).toHaveAttribute("method", "get");
  await expect(search).toHaveAttribute("action", "/discover");
  const box = within(search).getByRole("searchbox", { name: "Search the questions" });
  await expect(box).toHaveAttribute("name", "q");
  await expect(box).toHaveAccessibleDescription(/up to 8 words\. Results keep the order below\./);
  await expect(box).toHaveValue("");
  await expect(search.querySelector('input[name="sort"]')).toBeNull();
  await expect(canvas.queryByRole("link", { name: "Clear the search" })).toBeNull();
  await expect(search.querySelector('input[name="topic"]')).toBeNull();
  await expect(search.querySelector('input[name="place"]')).toBeNull();

  // The topics and the place are folded under one line, so a phone's first
  // question isn't two screens down; opening it shows both.
  const narrowing = canvas.getByText("Topic and place");
  await expect(canvas.getByRole("link", { name: "Transport" })).not.toBeVisible();
  await expect(canvas.getByRole("textbox", { name: "Place" })).not.toBeVisible();
  await userEvent.click(narrowing);
  const placeSearch = placeForm(canvasElement);
  await expect(placeSearch).toHaveAttribute("method", "get");
  await expect(placeSearch).toHaveAttribute("action", "/discover");
  const place = within(placeSearch).getByRole("textbox", { name: "Place" });
  await expect(place).toHaveAttribute("name", "place");
  await expect(place).toHaveAccessibleDescription(/the whole name must match/);
  await expect(within(placeSearch).getByRole("button", { name: "Find" })).toBeVisible();
  await expect(placeSearch.querySelectorAll('input[type="hidden"]')).toHaveLength(0);
  const topics = within(canvas.getByRole("navigation", { name: "Topics" }));
  await expect(topics.getByRole("link", { name: "All topics" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(topics.getByRole("link", { name: "Transport" })).toHaveAttribute(
    "href",
    "/discover?topic=transport",
  );
  await expect(topics.getAllByRole("link")).toHaveLength(15);
  await expect(canvas.getByText(/moderation can change them/)).toBeVisible();
  await userEvent.click(narrowing);

  // How many have answered so far, each of a poll's tiers on its own line,
  // never one figure across them (T-01); a card without a count shows none.
  const counts = list.getAllByRole("list", { name: "Answered so far" });
  await expect(counts).toHaveLength(2);
  await expect(
    within(counts[0]!)
      .getAllByRole("listitem")
      .map((li) => li.textContent),
  ).toEqual(["1,204 people · Tier 0 (verified e-mail)"]);
  await expect(
    within(counts[1]!)
      .getAllByRole("listitem")
      .map((li) => li.textContent),
  ).toEqual(["38 people · Tier 0 (verified e-mail)", "1 person · Tier 2 (document-verified)"]);
  // Narrower than `sm` the count and its tier take a line each, with no dot
  // left ending the first; wider, one line with the dot between.
  const dot = within(counts[0]!).getByText("·");
  if (window.matchMedia("(min-width: 40rem)").matches) await expect(dot).toBeVisible();
  else await expect(dot).not.toBeVisible();

  // The card's top line keeps its facts together rather than spread to the
  // card's two edges and middle at desktop width.
  const riversideCard = list.getAllByRole("article")[1]!;
  const top = within(riversideCard).getByText(/^Closes/).parentElement!;
  await expect(getComputedStyle(top).justifyContent).not.toBe("space-between");

  // A closing time's clock and "UTC" wrap whole, never "UTC" alone on a line.
  await expect(within(riversideCard).getByRole("time").textContent).toMatch(
    /12:00\u00a0AM\u00a0UTC$/,
  );

  // The lede leaves what choosing an answer does to the one line above the cards.
  await expect(canvas.getAllByText(/in the ballot app/)).toHaveLength(1);
};

export const Default: Story = { play };

export const Dark: Story = { parameters: { theme: "dark" }, play };

/** Where Tier 0 asks for a phone, each count names it so (P2-31 part 6a). */
export const PhoneVerification: Story = {
  args: { phoneVerification: true },
  play: async ({ canvasElement }) => {
    const list = questions(canvasElement);
    await expect(list.getAllByText("Tier 0 (verified e-mail and phone)")).toHaveLength(2);
    await expect(list.queryByText("Tier 0 (verified e-mail)")).toBeNull();
  },
};

/** Without a ballot client configured, a card says so and links only to the poll's page. */
export const NoBallotClient: Story = {
  args: { ballot: null },
  play: async ({ canvasElement }) => {
    const list = questions(canvasElement);
    await expect(canvasElement.querySelectorAll('a[href*="#election="]')).toHaveLength(0);
    await expect(list.getAllByText(/isn't set up on this site yet/)).toHaveLength(3);
    await expect(within(canvasElement).queryByText(/Nothing is sent until/)).toBeNull();
  },
};

export const MostAnswered: Story = {
  args: { sort: "answered" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("link", { name: "Most answered this week" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(canvas.getByText(/each person once/)).toBeVisible();
    await expect(canvas.getByRole("link", { name: "More questions" })).toHaveAttribute(
      "href",
      streamHref("answered", {}, NEXT),
    );
  },
};

export const SortUnavailable: Story = {
  args: { sort: "answered", stream: { kind: "sort-unavailable" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "This order isn't available just now" }),
    ).toBeVisible();
    await expect(canvas.queryByRole("link", { name: "More questions" })).toBeNull();
  },
};

export const CursorLost: Story = {
  args: { sort: "closing", stream: { kind: "cursor-not-found" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "That page has moved on" })).toBeVisible();
    await expect(canvas.getByRole("link", { name: "Start from the top" })).toHaveAttribute(
      "href",
      "/discover?sort=closing",
    );
  },
};

export const Empty: Story = {
  args: { stream: { kind: "stream", cards: [], next: undefined } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "No open questions just now" })).toBeVisible();
    await expect(canvas.queryByRole("list", { name: "Questions" })).toBeNull();
  },
};

/** A search: the order and every next page keep it, and the box shows what was typed. */
export const Searching: Story = {
  args: { sort: "closing", typed: " library  hours", filter: { q: "library  hours" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const search = searchForm(canvasElement);
    await expect(within(search).getByRole("searchbox")).toHaveValue(" library  hours");
    await expect(search.querySelector('input[name="sort"]')).toHaveValue("closing");
    const order = canvas.getByRole("navigation", { name: "Order" });
    await expect(within(order).getByRole("link", { name: "New" })).toHaveAttribute(
      "href",
      "/discover?q=library%20%20hours",
    );
    await expect(within(order).getByRole("link", { name: "Closing soon" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(canvas.getByRole("link", { name: "More questions" })).toHaveAttribute(
      "href",
      `/discover?sort=closing&q=library%20%20hours&after=${NEXT}`,
    );
    await expect(canvas.getByText(/hold every word you searched for/)).toBeVisible();
    await expect(canvas.getByRole("link", { name: "Clear the search" })).toHaveAttribute(
      "href",
      "/discover?sort=closing",
    );
    // The query is never quoted in the page's own words.
    await expect(canvas.queryByText(/library {2}hours/)).toBeNull();
    // The place's form keeps the search as it was accepted.
    await userEvent.click(canvas.getByText("Topic and place"));
    await expect(placeForm(canvasElement).querySelector('input[name="q"]')).toHaveValue(
      "library  hours",
    );
    await expect(placeForm(canvasElement).querySelector('input[name="sort"]')).toHaveValue(
      "closing",
    );
  },
};

export const SearchFoundNothing: Story = {
  args: {
    typed: "ferries",
    filter: { q: "ferries" },
    stream: { kind: "stream", cards: [], next: undefined },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "No open question matches" })).toBeVisible();
    await expect(canvas.queryByText("No open questions just now")).toBeNull();
    await expect(canvas.getAllByRole("link", { name: "Clear the search" })[1]).toHaveAttribute(
      "href",
      "/discover",
    );
    await expect(canvas.queryByText(/ferries/)).toBeNull();
  },
};

export const SearchRefused: Story = {
  args: { typed: "a b c d e f g h i", stream: { kind: "search-refused" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "That search can't be run" })).toBeVisible();
    await expect(canvas.getByText(/one to 8 words, in at most 200 characters/)).toBeVisible();
    await expect(canvas.getByRole("link", { name: "Clear the search" })).toHaveAttribute(
      "href",
      "/discover",
    );
    await expect(within(searchForm(canvasElement)).getByRole("searchbox")).toHaveValue(
      "a b c d e f g h i",
    );
  },
};

/** A topic's page: titled with it, and every link and the form keep it. */
export const Topic: Story = {
  args: { sort: "closing", filter: { topic: "transport" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("Transport");
    // A topic's page keeps the topics folded, as its title names the topic:
    // the narrowed-by line offers the way back to every topic, keeping the
    // order, rather than fifteen topics above a phone's first question.
    await expect(canvasElement.querySelector("details")).not.toHaveAttribute("open");
    await expect(canvas.getByRole("link", { name: "Show every topic" })).toHaveAttribute(
      "href",
      "/discover?sort=closing",
    );
    await userEvent.click(canvas.getByText("Topic and place"));
    const topics = within(canvas.getByRole("navigation", { name: "Topics" }));
    await expect(topics.getByRole("link", { name: "Transport" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(topics.getByRole("link", { name: "All topics" })).toHaveAttribute(
      "href",
      "/discover?sort=closing",
    );
    await expect(canvas.getByRole("link", { name: "New" })).toHaveAttribute(
      "href",
      "/discover?topic=transport",
    );
    await expect(searchForm(canvasElement).querySelector('input[name="topic"]')).toHaveValue(
      "transport",
    );
    await expect(placeForm(canvasElement).querySelector('input[name="topic"]')).toHaveValue(
      "transport",
    );
    await expect(canvas.getByRole("link", { name: "More questions" })).toHaveAttribute(
      "href",
      `/discover?sort=closing&topic=transport&after=${NEXT}`,
    );
  },
};

/** A place and a search: each says itself in our words and drops alone, quoting neither. */
export const Place: Story = {
  args: {
    typed: "library",
    typedPlace: " Old  Town",
    filter: { q: "library", place: "Old Town" },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(within(placeForm(canvasElement)).getByRole("textbox")).toHaveValue(" Old  Town");
    // Each form keeps the other's accepted value.
    await expect(searchForm(canvasElement).querySelector('input[name="place"]')).toHaveValue(
      "Old Town",
    );
    await expect(placeForm(canvasElement).querySelector('input[name="q"]')).toHaveValue("library");
    await expect(canvas.getByText(/filed at the place you entered/)).toBeVisible();
    await expect(canvas.getByRole("link", { name: "Clear the place" })).toHaveAttribute(
      "href",
      "/discover?q=library",
    );
    await expect(canvas.getByRole("link", { name: "Clear the search" })).toHaveAttribute(
      "href",
      "/discover?place=Old%20Town",
    );
    await expect(canvas.getByRole("link", { name: "Transport" })).toHaveAttribute(
      "href",
      "/discover?topic=transport&place=Old%20Town&q=library",
    );
    await expect(canvas.queryByText(/Old {1,2}Town/)).toBeNull();
  },
};

export const FilteredToNothing: Story = {
  args: {
    filter: { topic: "transport", place: "Riverside" },
    stream: { kind: "stream", cards: [], next: undefined },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "No open question is filed here" }),
    ).toBeVisible();
    await expect(canvas.getByRole("link", { name: "Show everything" })).toHaveAttribute(
      "href",
      "/discover",
    );
  },
};

export const PlaceRefused: Story = {
  args: { typedPlace: "a".repeat(81), stream: { kind: "place-refused" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "That place can't be looked up" }),
    ).toBeVisible();
    await expect(canvas.getByText(/one to 80 characters/)).toBeVisible();
    // The refused place stays in its box, shown, to be corrected.
    await expect(within(placeForm(canvasElement)).getByRole("textbox")).toHaveValue("a".repeat(81));
    await expect(canvas.getByRole("link", { name: "Clear the place" })).toHaveAttribute(
      "href",
      "/discover",
    );
  },
};
