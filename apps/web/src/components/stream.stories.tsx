import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import type { PollView } from "../poll.ts";
import type { StreamCard } from "../stream.ts";
import { StreamPage, streamHref } from "./stream.tsx";

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
  },
  {
    kind: "poll",
    poll: poll(RIVERSIDE, {
      questions: [
        { optionCount: 4, minSelections: 0, maxSelections: 1 },
        { optionCount: 4, minSelections: 0, maxSelections: 4 },
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
  },
} satisfies Meta<typeof StreamPage>;

export default meta;
type Story = StoryObj<typeof meta>;

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

  // Each answer opens the ballot client with it chosen, the poll and the
  // pick in the fragment only ([[first-answer]], step 1).
  const [libraryList] = list.getAllByRole("list", { name: /^Choose an answer to open/ });
  if (libraryList === undefined) throw new Error("no answers on the library's card");
  const libraryAnswers = within(libraryList);
  const answers = libraryAnswers.getAllByRole("link");
  await expect(answers.map((a) => a.getAttribute("href"))).toEqual([
    `${BALLOT}#election=${LIBRARY}&pick=0`,
    `${BALLOT}#election=${LIBRARY}&pick=1`,
    `${BALLOT}#election=${LIBRARY}&pick=2`,
  ]);
  await expect(answers[0]).toHaveAccessibleName("At 10");
  await expect(answers[0]).toHaveAccessibleDescription("Library hours");
  // A poll of several questions offers its first question's answers, and says so.
  const riverside = within(
    list.getByRole("list", { name: /^Choose an answer to question 1 of 3/ }),
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
  const search = canvas.getByRole("search");
  await expect(search).toHaveAttribute("method", "get");
  await expect(search).toHaveAttribute("action", "/discover");
  const box = within(search).getByRole("searchbox", { name: "Search the questions" });
  await expect(box).toHaveAttribute("name", "q");
  await expect(box).toHaveAccessibleDescription(/up to 8 words/);
  await expect(box).toHaveValue("");
  await expect(search.querySelector('input[name="sort"]')).toBeNull();
  await expect(canvas.queryByRole("link", { name: "Clear the search" })).toBeNull();
  // The place shares the form, and the topics are links like the orders.
  const place = within(search).getByRole("textbox", { name: "Place" });
  await expect(place).toHaveAttribute("name", "place");
  await expect(place).toHaveAccessibleDescription(/the whole name must match/);
  await expect(search.querySelector('input[name="topic"]')).toBeNull();
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
};

export const Default: Story = { play };

export const Dark: Story = { parameters: { theme: "dark" }, play };

/** Without a ballot client configured, a card says so and links only to the poll's page. */
export const NoBallotClient: Story = {
  args: { ballot: null },
  play: async ({ canvasElement }) => {
    const list = questions(canvasElement);
    await expect(canvasElement.querySelectorAll('a[href*="#election="]')).toHaveLength(0);
    await expect(list.getAllByText(/isn't set up on this site yet/)).toHaveLength(3);
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
    const search = canvas.getByRole("search");
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
    await expect(within(canvas.getByRole("search")).getByRole("searchbox")).toHaveValue(
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
    await expect(canvas.getByRole("search").querySelector('input[name="topic"]')).toHaveValue(
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
    await expect(within(canvas.getByRole("search")).getByRole("textbox")).toHaveValue(
      " Old  Town",
    );
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
    await expect(canvas.getByRole("link", { name: "Clear the place" })).toHaveAttribute(
      "href",
      "/discover",
    );
  },
};
