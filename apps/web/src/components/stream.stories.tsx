import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { NO_TAGS, type PollView } from "../poll.ts";
import type { StreamCard } from "../stream.ts";
import { streamHref } from "../stream.ts";
import { StreamPage } from "./stream.tsx";
import { ViewerNow, ViewerTimeZone } from "./when.tsx";

const poll = (electionId: string, overrides: Partial<PollView> = {}): PollView => ({
  electionId,
  definitionHash: "a4555c67fbc57b7ed42f873f73f36360baba11fa0de1f0ba0f104780a4071750",
  version: 5,
  illFormed: undefined,
  rolling: false,
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
const NEW_YEAR = "2026-01-01T17:00:00.000Z";

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
    answered: "unread",
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
  // A visitor on New York's clock on New Year's Day, a week before the
  // first close, so the cards' closing times don't depend on the machine
  // drawing the story or when; a story sets `timeZone` or `now` for another.
  decorators: [
    (Story, { parameters }) => (
      <ViewerTimeZone.Provider value={(parameters["timeZone"] as string) ?? "America/New_York"}>
        <ViewerNow.Provider value={() => new Date((parameters["now"] as string) ?? NEW_YEAR)}>
          <Story />
        </ViewerNow.Provider>
      </ViewerTimeZone.Provider>
    ),
  ],
} satisfies Meta<typeof StreamPage>;

export default meta;
type Story = StoryObj<typeof meta>;

const searchForm = (root: HTMLElement) =>
  within(root).getByRole("search", { name: "Search the questions" });
const placeForm = (root: HTMLElement) => within(root).getByRole("search", { name: "Place" });

const questions = (root: HTMLElement) =>
  within(within(root).getByRole("list", { name: "Questions" }));

const sortsOnOneRow = (root: HTMLElement, name = "Order") => {
  const links = within(within(root).getByRole("navigation", { name })).getAllByRole("link");
  const tops = new Set(links.map((a) => Math.round(a.getBoundingClientRect().top)));
  const fits = links.every((a) => a.scrollWidth <= a.clientWidth);
  return links.length === 3 && tops.size === 1 && fits;
};

const countBoxes = (root: HTMLElement) =>
  questions(root)
    .getAllByRole("list", { name: /^Answered since it opened / })
    .map((l) => l.parentElement!);

const play: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
    "What people are asking",
  );
  const list = questions(canvasElement);
  await expect(list.getAllByRole("article")).toHaveLength(4);
  // Only a later page says it follows the first (the stream's iteration 21).
  await expect(canvas.queryByText("These come after the first page.")).toBeNull();

  // Each card's heading names the poll's page; the asker's words keep their own language.
  const library = list.getByRole("heading", { name: "Library hours" });
  const libraryLink = within(library).getByRole("link");
  await expect(libraryLink).toHaveAttribute("href", `/polls/${LIBRARY}`);
  // It looks like a link before any hover, which a phone never has (the
  // stream's iteration 27).
  await expect(getComputedStyle(libraryLink).textDecorationLine).toBe("underline");
  await expect(list.getByText("When should the main library open on Sundays?")).toBeVisible();
  await expect(
    list.getByRole("heading", { name: "¿Debería el autobús 23 circular hasta la medianoche?" }),
  ).toHaveAttribute("lang", "es-419");

  // A card names who asked only where its author chose to say, linking to
  // their profile (T-75).
  const asker = list.getByRole("link", { name: "Riverside Neighbours" });
  await expect(asker).toHaveAttribute("href", "/by/k7qa2mzr5xw3bn4d");
  // A card's text links take the boxes' square 3px focus in the ring's
  // colour, not the browser's thin rounded outline across their underline
  // (P2-29, the stream's iteration 33).
  for (const link of [
    libraryLink,
    asker,
    list.getByRole("link", { name: "This poll can't be shown here" }),
  ]) {
    link.focus();
    await expect(link.matches(":focus-visible")).toBe(true);
    const style = getComputedStyle(link);
    await expect(`${style.outlineStyle} ${style.outlineWidth}`).toBe("solid 3px");
    await expect(style.outlineOffset).toBe("2px");
    link.blur();
  }
  await expect(list.getAllByText(/Asked by/)).toHaveLength(1);
  // Its name takes a tap 24px tall, though its line of small text is 14px:
  // points 11px above and below its middle still land on it.
  asker.scrollIntoView({ block: "center" });
  const named = asker.getBoundingClientRect();
  for (const dy of [-11, 11])
    await expect(
      document
        .elementFromPoint(named.left + named.width / 2, named.top + named.height / 2 + dy)
        ?.closest("a"),
    ).toBe(asker);

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
  const which = list.getByText("These answers are for question 1 of 3.");
  await expect(which).toBeVisible();
  // "1 of 3" keeps one line: at 360px "of 3." wrapped alone under the rest.
  const ofThree = document.createRange();
  const words = which.firstChild!;
  ofThree.setStart(words, words.textContent!.indexOf("1\u00a0of"));
  ofThree.setEnd(words, words.textContent!.length);
  await expect(ofThree.getClientRects()).toHaveLength(1);
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
  // The note above the answers says "question 1 of 3", so the top line doesn't.
  await expect(list.queryByText("3 questions")).toBeNull();
  // The month abbreviated, so "Closes", the date and its clock keep one line
  // even at a small phone's width, where the long date wrapped its clock.
  // On the visitor's own clock: midnight UTC is the evening before in New
  // York, where "Jan 8, 12:00 AM UTC" named a day the poll was already closed.
  const closes = list.getAllByText(/^Closes/);
  await expect(closes[0]!.textContent).toBe("Closes Jan 7, 7:00\u00a0PM\u00a0EST");
  await expect(within(closes[0]!).getByRole("time")).toHaveAttribute(
    "datetime",
    "2026-01-08T00:00:00.000Z",
  );
  for (const line of closes) await expect(line.getClientRects()).toHaveLength(1);

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

  // A poll whose text failed its checks shows none, and can't be answered
  // from here. It says so in everyday words, with no "server", and the ID only as a small note.
  const unreadable = list.getByRole("heading", { name: "This poll can't be shown here" });
  await expect(within(unreadable).getByRole("link")).toHaveAttribute(
    "href",
    `/polls/${UNREADABLE}`,
  );
  await expect(list.getByText(/couldn't read its question/)).toBeVisible();
  // The ID's start, small, is all that tells two such cards' links apart.
  await expect(within(unreadable).getByRole("link")).toHaveAccessibleDescription(
    "Poll 4040404040404040…",
  );
  await expect(list.queryByText(/server/)).toBeNull();
  // Its words start where a readable card's do, at every width.
  await expect(
    within(unreadable).getByRole("link").getBoundingClientRect().left -
      list.getByRole("heading", { name: "Library hours" }).getBoundingClientRect().left,
  ).toBe(0);

  // The three orders share one row at every width; on a phone each label
  // wraps within its own box rather than the third taking a row alone.
  await expect(sortsOnOneRow(canvasElement)).toBe(true);

  // At desktop width the answers and the count stay a readable width, not
  // the page's whole width with the arrow 1,000px from its answer: the
  // cards keep the search box's width, and the answers and the count fill
  // the card inside its padding (iteration 30).
  for (const box of [
    list.getByRole("list", { name: "When should the main library open on Sundays?" }),
    countBoxes(canvasElement)[0]!,
  ])
    await expect(box.getBoundingClientRect().width).toBeLessThanOrEqual(640);
  // The cards themselves keep a reading width rather than the page's, which
  // left each card's right half empty at 1280px.
  await expect(list.getAllByRole("article")[0]!.getBoundingClientRect().width).toBeLessThanOrEqual(
    672,
  );

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
  // Its focus ring clears the chevron and the last word.
  await expect(getComputedStyle(narrowing).paddingInline).toBe("8px");
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
  // never one figure across them (T-01), and each tier said in words, never
  // as a code ([[language]]); a card without a count shows none.
  // Each count says since when, on the visitor's calendar: the library
  // opened at midnight UTC, the evening before New Year's Day in New York
  // (P2-29, the stream's iteration 24).
  const counts = list.getAllByRole("list", {
    name: "Answered since it opened yesterday",
  });
  await expect(counts).toHaveLength(2);
  await expect(
    within(counts[0]!)
      .getAllByRole("listitem")
      .map((li) => li.textContent),
  ).toEqual(["1,204 people with a verified e-mail"]);
  await expect(
    within(counts[1]!)
      .getAllByRole("listitem")
      .map((li) => li.textContent),
  ).toEqual(["38 people with a verified e-mail", "1 person verified with a passport or ID"]);
  // A tier's line that wraps hangs its continuation in, so its second half
  // doesn't read as a tier of its own: on a 360px screen in the site's frame
  // "with a passport or ID" sat flush under "1 person verified", like the row
  // above it (P2-29, the stream's iteration 35). Every tier's first line
  // starts at one edge, and every line after it 16px in.
  const [emailRow, passportRow] = within(counts[1]!).getAllByRole("listitem");
  const lines = (node: Element) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return [...range.getClientRects()];
  };
  for (const row of [emailRow!, passportRow!]) {
    await expect(getComputedStyle(row).paddingLeft).toBe("16px");
    await expect(getComputedStyle(row).textIndent).toBe("-16px");
  }
  const passportLines = lines(passportRow!);
  await expect(passportLines[0]!.left).toBe(lines(emailRow!)[0]!.left);
  for (const line of passportLines.slice(1))
    await expect(line.left).toBe(passportLines[0]!.left + 16);
  await expect(within(counts[1]!).queryByText(/Tier \d/)).toBeNull();
  // On a phone the band reaches the card's borders, its words starting where
  // the question's do, so a count of one tier keeps one line at 360px, where
  // inset in the card's padding it wrapped "e-mail" alone.
  const libraryCount = within(counts[0]!).getByRole("listitem");
  const countText = document.createRange();
  countText.selectNodeContents(libraryCount);
  await expect(countText.getClientRects()).toHaveLength(1);
  if (window.innerWidth < 640)
    await expect(
      libraryCount.getBoundingClientRect().left -
        list.getByRole("heading", { name: "Library hours" }).getBoundingClientRect().left,
    ).toBe(0);

  // A count the server couldn't read says so in the band where a count
  // would be, rather than leaving the card bare beside its neighbours'
  // counts (P2-29, the stream's iteration 31). It claims no figure, not even
  // nobody (T-01).
  const busCard = list.getAllByRole("article")[2]!;
  const unread = within(busCard).getByText("We couldn't get how many have answered just now.");
  await expect(unread).toBeVisible();
  await expect(within(busCard).queryByText(/No one yet|\d people/)).toBeNull();
  // Its band starts and ends where a count's does, before the answers.
  const countBand = counts[0]!.parentElement!.getBoundingClientRect();
  const libraryBox = list.getAllByRole("article")[0]!.getBoundingClientRect();
  const busBox = busCard.getBoundingClientRect();
  const unreadBand = unread.getBoundingClientRect();
  await expect(unreadBand.left - busBox.left).toBe(countBand.left - libraryBox.left);
  await expect(unreadBand.right - busBox.right).toBe(countBand.right - libraryBox.right);
  await expect(
    unread.compareDocumentPosition(within(busCard).getByRole("list", { name: /\?$/ })) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();

  // The card's top line keeps its facts together rather than spread to the
  // card's two edges and middle at desktop width.
  const riversideCard = list.getAllByRole("article")[1]!;
  const top = within(riversideCard).getByText(/^Closes/).parentElement!;
  await expect(getComputedStyle(top).justifyContent).not.toBe("space-between");

  // A closing time's clock and its zone wrap whole, never the zone alone on a line.
  await expect(within(riversideCard).getByRole("time").textContent).toMatch(
    /7:00\u00a0PM\u00a0EST$/,
  );

  // The lede leaves what choosing an answer does to the one line above the cards.
  await expect(canvas.getAllByText(/in the ballot app/)).toHaveLength(1);

  // The cards end where the search box ends, one right edge down the
  // column: at 1280px they ran 96px past it (P2-29, the stream's iteration 29).
  const searchRight = searchForm(canvasElement).getBoundingClientRect().right;
  for (const card of list.getAllByRole("article"))
    await expect(card.getBoundingClientRect().right).toBeLessThanOrEqual(searchRight);

  // Inside each card the answers end as far from its right border as they
  // start from its left: at 1280px they stopped 46px short of it against
  // 25px at the left, a second right edge inside the card (P2-29, the
  // stream's iteration 30).
  for (const card of list.getAllByRole("article")) {
    const answers = within(card).queryByRole("list", { name: /\?$/ });
    if (answers === null) continue;
    const box = card.getBoundingClientRect();
    const inner = answers.getBoundingClientRect();
    await expect(Math.abs(box.right - inner.right - (inner.left - box.left))).toBeLessThanOrEqual(
      1,
    );
  }
};

export const Default: Story = { play };

export const Dark: Story = { parameters: { theme: "dark" }, play };

/** A visitor whose clock is UTC sees UTC, named as such. */
export const UtcVisitor: Story = {
  parameters: { timeZone: "UTC" },
  play: async ({ canvasElement }) => {
    const list = questions(canvasElement);
    const closes = list.getAllByText(/^Closes/);
    await expect(closes[0]!.textContent).toBe("Closes Jan 8, 12:00\u00a0AM\u00a0UTC");
    await expect(closes[1]!.textContent).toBe("Closes Jan 15, 12:00\u00a0AM\u00a0UTC");
  },
};

/** East of UTC the day is the same and the zone is named by its offset. */
export const SpanishClock: Story = {
  parameters: { locale: "es-US", timeZone: "Europe/Berlin" },
  play: async ({ canvasElement }) => {
    const list = within(within(canvasElement).getByRole("list", { name: "Preguntas" }));
    const closes = list.getAllByText(/^Cierra/);
    await expect(closes[0]!.textContent).toMatch(/^Cierra 8 ene, 1:00\u00a0a\.\s?m\.\u00a0GMT\+1$/);
    // A count that couldn't be read says so in Spanish too.
    await expect(
      list.getByText("Ahora mismo no pudimos saber cuántos han respondido."),
    ).toBeVisible();
  },
};

/**
 * On the morning of the library's close, its card says "today" in place of
 * a date the visitor would have to know was today's; the park's, a week
 * on, keeps its date (P2-29, the stream's iteration 23).
 */
export const ClosesToday: Story = {
  parameters: { now: "2026-01-07T15:00:00.000Z" },
  play: async ({ canvasElement }) => {
    const list = questions(canvasElement);
    const closes = list.getAllByText(/^Closes/);
    await expect(closes[0]!.textContent).toBe("Closes today, 7:00\u00a0PM\u00a0EST");
    await expect(closes[1]!.textContent).toBe("Closes Jan 14, 7:00\u00a0PM\u00a0EST");
    await expect(within(closes[0]!).getByRole("time")).toHaveAttribute(
      "datetime",
      "2026-01-08T00:00:00.000Z",
    );
    // Still one line on a phone, as the date was.
    const line = document.createRange();
    line.selectNodeContents(closes[0]!);
    await expect(new Set([...line.getClientRects()].map((r) => Math.round(r.top))).size).toBe(1);
  },
};

/**
 * The day before, "tomorrow", by the visitor's calendar: on the morning of
 * January 6 in New York the library closes tomorrow evening there, though
 * in UTC its close falls two days on, on January 8.
 */
export const ClosesTomorrow: Story = {
  parameters: { now: "2026-01-06T15:00:00.000Z" },
  play: async ({ canvasElement }) => {
    const closes = questions(canvasElement).getAllByText(/^Closes/);
    await expect(closes[0]!.textContent).toBe("Closes tomorrow, 7:00\u00a0PM\u00a0EST");
    await expect(closes[1]!.textContent).toBe("Closes Jan 14, 7:00\u00a0PM\u00a0EST");
  },
};

/** In Spanish, "mañana" on the visitor's own clock east of UTC. */
export const SpanishTomorrow: Story = {
  parameters: { locale: "es-US", timeZone: "Europe/Berlin", now: "2026-01-07T09:00:00.000Z" },
  play: async ({ canvasElement }) => {
    const list = within(within(canvasElement).getByRole("list", { name: "Preguntas" }));
    const closes = list.getAllByText(/^Cierra/);
    await expect(closes[0]!.textContent).toMatch(
      /^Cierra mañana, 1:00\u00a0a\.\s?m\.\u00a0GMT\+1$/,
    );
  },
};

/**
 * A close in this year leaves the year out, as the count's "since" does; one
 * in another year keeps it (P2-29, the stream's iteration 28).
 */
export const ClosesNextYear: Story = {
  args: {
    stream: {
      kind: "stream",
      cards: cards.map((card, i) =>
        card.kind === "poll" && i === 1
          ? {
              ...card,
              poll: {
                ...card.poll,
                closesAt: { seconds: "1799971200", iso: "2027-01-15T00:00:00.000Z" },
              },
            }
          : card,
      ),
      next: NEXT,
    },
  },
  play: async ({ canvasElement }) => {
    const closes = questions(canvasElement).getAllByText(/^Closes/);
    await expect(closes[0]!.textContent).toBe("Closes Jan 7, 7:00\u00a0PM\u00a0EST");
    await expect(closes[1]!.textContent).toBe("Closes Jan 14, 2027, 7:00\u00a0PM\u00a0EST");
  },
};

/**
 * A count says since when it has gathered: on the evening the library
 * opened, "today"; a week on, its date; in another year, its date with the
 * year (P2-29, the stream's iteration 24).
 */
export const OpenedToday: Story = {
  parameters: { now: "2026-01-01T03:00:00.000Z" },
  play: async ({ canvasElement }) => {
    const counts = questions(canvasElement).getAllByRole("list", {
      name: "Answered since it opened today",
    });
    await expect(counts).toHaveLength(2);
    // The heading keeps one line on a phone, above the counts.
    const heading = document.getElementById(counts[0]!.getAttribute("aria-labelledby")!)!;
    await expect(heading.getClientRects()).toHaveLength(1);
  },
};

/** On UTC's calendar the library opened on New Year's Day, this year. */
export const OpenedLastWeek: Story = {
  parameters: { timeZone: "UTC", now: "2026-01-07T15:00:00.000Z" },
  play: async ({ canvasElement }) => {
    await expect(
      questions(canvasElement).getAllByRole("list", {
        name: "Answered since it opened Jan\u00a01",
      }),
    ).toHaveLength(2);
  },
};

export const OpenedLastYear: Story = {
  parameters: { now: "2027-01-02T15:00:00.000Z" },
  play: async ({ canvasElement }) => {
    await expect(
      questions(canvasElement).getAllByRole("list", {
        name: "Answered since it opened Dec\u00a031,\u00a02025",
      }),
    ).toHaveLength(2);
  },
};

/** In Spanish east of UTC, the library opened at 1 a.m. on New Year's Day there. */
export const SpanishOpened: Story = {
  parameters: { locale: "es-US", timeZone: "Europe/Berlin", now: "2026-01-03T09:00:00.000Z" },
  play: async ({ canvasElement }) => {
    const list = within(within(canvasElement).getByRole("list", { name: "Preguntas" }));
    const counts = list.getAllByRole("list", {
      name: /^Han respondido desde que abrió el\u00a01\u00a0ene\.?$/,
    });
    await expect(counts).toHaveLength(2);
    // "el 1 ene" wraps whole: at 360px "ene" fell alone onto a second line.
    const words = document.getElementById(counts[0]!.getAttribute("aria-labelledby")!)!.firstChild!;
    const date = document.createRange();
    date.setStart(words, words.textContent!.indexOf("el\u00a01"));
    date.setEnd(words, words.textContent!.length);
    await expect(new Set([...date.getClientRects()].map((r) => Math.round(r.top))).size).toBe(1);
  },
};

/**
 * A poll nobody has answered yet says so once, not "0 people" per tier; one
 * with answers in some tier keeps every tier's line, its zeros too (P2-29,
 * the stream's iteration 25).
 */
const unanswered: StreamCard[] = cards.map((card, i) =>
  card.kind !== "poll"
    ? card
    : i === 0
      ? { ...card, answered: [{ tier: 0, answered: "0" }] }
      : i === 1
        ? {
            ...card,
            answered: [
              { tier: 0, answered: "0" },
              { tier: 2, answered: "0" },
            ],
          }
        : {
            ...card,
            answered: [
              { tier: 0, answered: "3" },
              { tier: 2, answered: "0" },
            ],
          },
);

export const NoAnswersYet: Story = {
  args: { stream: { kind: "stream", cards: unanswered, next: NEXT } },
  parameters: { now: "2026-01-01T03:00:00.000Z" },
  play: async ({ canvasElement }) => {
    const list = questions(canvasElement);
    const [library, riverside, bus] = list.getAllByRole("article");
    for (const card of [library!, riverside!]) {
      const box = within(card);
      await expect(box.getByText("Answered since it opened today")).toBeVisible();
      await expect(box.getByText("No one yet")).toBeVisible();
      await expect(box.queryByText(/^0 /)).toBeNull();
      await expect(box.queryByRole("list", { name: /^Answered since/ })).toBeNull();
    }
    const counts = within(
      within(bus!).getByRole("list", { name: "Answered since it opened today" }),
    );
    await expect(counts.getByText("3 people with a verified e-mail")).toBeVisible();
    await expect(counts.getByText("0 people verified with a passport or ID")).toBeVisible();
  },
};

export const SpanishNoAnswersYet: Story = {
  args: { stream: { kind: "stream", cards: unanswered, next: NEXT } },
  parameters: { locale: "es-US", now: "2026-01-01T03:00:00.000Z" },
  play: async ({ canvasElement }) => {
    const list = within(within(canvasElement).getByRole("list", { name: "Preguntas" }));
    await expect(list.getAllByText("Nadie todavía")).toHaveLength(2);
  },
};

/** Where Tier 0 asks for a phone, each count names it so (P2-31 part 6a). */
export const PhoneVerification: Story = {
  args: { phoneVerification: true },
  play: async ({ canvasElement }) => {
    const list = questions(canvasElement);
    await expect(list.getByText("1,204 people with a verified e-mail and phone")).toBeVisible();
    await expect(list.getByText("38 people with a verified e-mail and phone")).toBeVisible();
    await expect(list.queryByText(/with a verified e-mail$/)).toBeNull();
  },
};

/** Without a ballot client configured, a card says so and links only to the poll's page. */
export const NoBallotClient: Story = {
  args: { ballot: null },
  play: async ({ canvasElement }) => {
    const list = questions(canvasElement);
    await expect(canvasElement.querySelectorAll('a[href*="#election="]')).toHaveLength(0);
    await expect(list.getAllByText(/isn't set up on this site yet/)).toHaveLength(3);
    // With no answers offered, no note says how many questions: the top line does.
    await expect(list.getByText("3 questions")).toBeVisible();
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
    const note = canvas.getByText(/each person counted once/);
    await expect(note).toBeVisible();
    // The cards' counts run from each poll's opening, not over the order's
    // seven days, so the note says a card can show more than the one above
    // it: unsaid, a long-open poll's larger count below a newer one's read as
    // the order gone wrong (P2-29, the stream's iteration 32).
    await expect(note).toHaveTextContent(
      "A card counts every answer since it opened, so it can show more than the one above it.",
    );
    await expect(canvas.getByRole("link", { name: "More questions" })).toHaveAttribute(
      "href",
      streamHref("answered", {}, NEXT),
    );
    // The notes under the orders and the topics keep the search box's
    // width: across the page's, this one ran 150 characters on one line at
    // 1280px (P2-29, the stream's iteration 26).
    await userEvent.click(canvas.getByText("Topic and place"));
    const tagsNote = canvas.getByText(/^Askers choose their poll/);
    await expect(tagsNote).toBeVisible();
    const search = searchForm(canvasElement).getBoundingClientRect().width;
    for (const line of [note, tagsNote])
      await expect(line.getBoundingClientRect().width).toBeLessThanOrEqual(search);
  },
};

/** In Spanish, whose labels are longer, the orders still share one row. */
export const SpanishOrders: Story = {
  parameters: { locale: "es-US" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("link", { name: "Más respondidas esta semana" })).toBeVisible();
    await expect(sortsOnOneRow(canvasElement, "Orden")).toBe(true);
    await expect(
      canvas.getByRole("heading", { name: "Esta encuesta no se puede mostrar aquí" }),
    ).toBeVisible();
    await expect(canvas.queryByText(/servidor/)).toBeNull();
  },
};

/** A poll whose definition failed its checks: why, in everyday words, and a way to its page. */
export const Unreadable: Story = {
  args: {
    stream: {
      kind: "stream",
      cards: [
        { kind: "unavailable", electionId: UNREADABLE, problem: "undecodable" },
        { kind: "unavailable", electionId: NEXT, problem: "another-election" },
      ],
      next: undefined,
    },
  },
  play: async ({ canvasElement }) => {
    const list = questions(canvasElement);
    const headings = list.getAllByRole("heading", { name: "This poll can't be shown here" });
    await expect(headings.map((h) => within(h).getByRole("link").getAttribute("href"))).toEqual([
      `/polls/${UNREADABLE}`,
      `/polls/${NEXT}`,
    ]);
    // Two such links share their words, so each is described by its own ID.
    await expect(
      headings.map((h) => within(h).getByRole("link").getAttribute("aria-describedby")),
    ).toSatisfy((ids: (string | null)[]) => new Set(ids).size === 2 && !ids.includes(null));
    await expect(list.getByText(/came through damaged/)).toBeVisible();
    await expect(list.getByText(/belong to a different poll/)).toBeVisible();
    await expect(list.queryByText(/definition|server/)).toBeNull();
    // No card here offers an answer, so nothing above them says to choose one.
    await expect(within(canvasElement).queryByText(/Choose an answer/)).toBeNull();
    // Each heading's lines are balanced: at 360px "here" wrapped alone.
    for (const heading of headings) {
      const lines = Array.from(heading.querySelector("a")!.getClientRects());
      if (lines.length > 1)
        await expect(Math.min(...lines.map((r) => r.width))).toBeGreaterThan(
          Math.max(...lines.map((r) => r.width)) / 2,
        );
    }
  },
};

export const SortUnavailable: Story = {
  args: {
    sort: "answered",
    filter: { topic: "transport" },
    stream: { kind: "sort-unavailable" },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "This order isn't available just now" }),
    ).toBeVisible();
    await expect(canvas.queryByRole("link", { name: "More questions" })).toBeNull();
    // A way on from the box itself, to an order that needs no count,
    // keeping the topic (P2-29, the stream's iteration 17).
    await expect(canvas.getByRole("link", { name: "Show the newest questions" })).toHaveAttribute(
      "href",
      "/discover?topic=transport",
    );
    // The chosen order stays marked, but its note, how this week's answers
    // are counted, is gone from above a box saying they can't be (P2-29,
    // the stream's iteration 18).
    await expect(canvas.getByRole("link", { name: "Most answered this week" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(canvas.queryByText(/by how many people answered/)).toBeNull();
  },
};

/**
 * On a folded phone's 280px, as on a 360px phone zoomed to 125%, the box
 * leaves its action under 200px, and the action's label held to one line
 * ran past the box and the screen (P2-29, the stream's iteration 36).
 */
export const SortUnavailableFolded: Story = {
  args: {
    sort: "answered",
    filter: { topic: "transport" },
    stream: { kind: "sort-unavailable" },
  },
  globals: { viewport: { value: "folded", isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const root = canvasElement.ownerDocument.documentElement;
    await expect(root.clientWidth).toBe(280);
    await expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth);
    const action = canvas.getByRole("link", { name: "Show the newest questions" });
    const box = action.parentElement;
    if (box === null) throw new Error("The action has no box");
    const inner =
      box.getBoundingClientRect().right - parseFloat(getComputedStyle(box).paddingRight);
    await expect(action.getBoundingClientRect().right).toBeLessThanOrEqual(inner + 0.5);
    // It wraps rather than shrinking: still a 48px target.
    await expect(action.getBoundingClientRect().height).toBeGreaterThanOrEqual(48);
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

/**
 * A page after the last of an order's questions, reached from a full page's
 * "More questions": it says the earlier pages held them all, never that
 * nothing is open or that its narrowings matched nothing, and leads back to
 * the first page keeping them (P2-29, the stream's iteration 19).
 */
export const PastTheLast: Story = {
  args: {
    sort: "closing",
    typedPlace: "Eastside",
    filter: { topic: "transport", place: "Eastside" },
    stream: { kind: "stream", cards: [], next: undefined },
    later: true,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "That was the last of them" })).toBeVisible();
    await expect(canvas.getByText(/on the pages before this one/)).toBeVisible();
    await expect(canvas.getByRole("link", { name: "Start from the top" })).toHaveAttribute(
      "href",
      "/discover?sort=closing&topic=transport&place=Eastside",
    );
    await expect(canvas.queryByText(/No open questions/)).toBeNull();
    await expect(canvas.queryByText(/are listed\./)).toBeNull();
    await expect(canvas.queryByRole("list", { name: "Questions" })).toBeNull();
  },
};

/**
 * A later page, reached by "More questions": the chosen order's and topic's
 * links lead back to the first page, so they are marked as chosen, never as
 * this page (P2-29, the stream's iteration 20).
 */
export const LaterPage: Story = {
  args: { later: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole("article").length).toBeGreaterThan(0);
    const orders = within(canvas.getByRole("navigation", { name: "Order" }));
    const chosen = orders.getByRole("link", { name: "New" });
    await expect(chosen).toHaveAttribute("aria-current", "true");
    await expect(chosen).toHaveAttribute("href", "/discover");
    // Still drawn as the chosen one, as on the first page.
    await expect(getComputedStyle(chosen).backgroundColor).not.toBe(
      getComputedStyle(orders.getByRole("link", { name: "Closing soon" })).backgroundColor,
    );
    const topics = within(canvas.getByRole("navigation", { name: "Topics" }));
    await expect(topics.getByRole("link", { name: "All topics" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expect(canvasElement.querySelector('[aria-current="page"]')).toBeNull();
    // It says it is a later page, with a way to the first above the cards
    // (P2-29, the stream's iteration 21).
    const note = canvas.getByText("These come after the first page.");
    await expect(note).toBeVisible();
    const start = canvas.getByRole("link", { name: "Start from the top" });
    await expect(start).toHaveAttribute("href", "/discover");
    await expect(
      note.compareDocumentPosition(canvas.getByRole("list", { name: "Questions" })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
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
    await expect(canvas.getByText(/with all your words/)).toBeVisible();
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
/** The stream's cards as a narrowed page lists them: each filed as it narrows. */
const filed = (tags: { topic?: "transport"; place?: string }): StreamCard[] =>
  cards.map((card) => (card.kind === "poll" ? { ...card, tags: { ...card.tags, ...tags } } : card));

export const Topic: Story = {
  args: {
    sort: "closing",
    filter: { topic: "transport" },
    stream: { kind: "stream", cards: filed({ topic: "transport" }), next: NEXT },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("Transport");
    // Every card here is filed under the title's topic, so none repeats it;
    // a card's place still shows.
    const list = questions(canvasElement);
    await expect(list.queryByRole("link", { name: "Transport" })).toBeNull();
    await expect(list.getByRole("link", { name: "Eastside" })).toBeVisible();
    await expect(list.getAllByRole("list", { name: "Where it's listed" })).toHaveLength(2);
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
    // The opened topics wrap within the search box's width, one right edge
    // down the column: across the page's they ran 512px past it at 1280px
    // (P2-29, the stream's iteration 34).
    const searchRight = searchForm(canvasElement).getBoundingClientRect().right;
    for (const link of topics.getAllByRole("link"))
      await expect(link.getBoundingClientRect().right).toBeLessThanOrEqual(searchRight);
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
    stream: { kind: "stream", cards: filed({ place: "Old town" }), next: NEXT },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Every card here is filed at the place, so none repeats it (and the
    // page names it only in its box, T-67); a card's topic still shows.
    const list = questions(canvasElement);
    await expect(list.queryByText(/Old town/i)).toBeNull();
    await expect(list.getByRole("link", { name: "Culture" })).toBeVisible();
    await expect(list.queryByRole("link", { name: /Riverside Park|Eastside/ })).toBeNull();
    await expect(within(placeForm(canvasElement)).getByRole("textbox")).toHaveValue(" Old  Town");
    // The place's box stands beside the search's, out of the fold, which
    // stays closed with only the topics in it: opened for the box, it put
    // fifteen topics above a phone's first question (P2-29, the stream's
    // iteration 13).
    await expect(within(placeForm(canvasElement)).getByRole("textbox")).toBeVisible();
    await expect(canvasElement.querySelector("details")).not.toHaveAttribute("open");
    await expect(canvasElement.querySelector("details summary")).toHaveTextContent(/^Topics$/);
    await expect(
      searchForm(canvasElement).compareDocumentPosition(placeForm(canvasElement)) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await expect(
      placeForm(canvasElement).compareDocumentPosition(
        canvas.getByRole("navigation", { name: "Order" }),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await expect(
      canvasElement.querySelectorAll('input[name="place"]:not([type="hidden"])'),
    ).toHaveLength(1);
    // Each form keeps the other's accepted value.
    await expect(searchForm(canvasElement).querySelector('input[name="place"]')).toHaveValue(
      "Old Town",
    );
    await expect(placeForm(canvasElement).querySelector('input[name="q"]')).toHaveValue("library");
    await expect(canvas.getByText(/filed at this place/)).toBeVisible();
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
    // Each way to drop a narrowing is a 24px tap, set apart from the next
    // line's words so it reads as the end of its own line, not the start of
    // the next (P2-29, the stream's iteration 12).
    const clearSearch = canvas.getByRole("link", { name: "Clear the search" });
    const clearPlace = canvas.getByRole("link", { name: "Clear the place" });
    for (const link of [clearSearch, clearPlace])
      await expect(link.getBoundingClientRect().height).toBeGreaterThanOrEqual(24);
    const placeNote = canvas.getByText(/filed at this place/);
    await expect(
      placeNote.getBoundingClientRect().top - clearSearch.getBoundingClientRect().bottom,
    ).toBeGreaterThanOrEqual(8);
    // Each box says what it narrows to, in our words, with its own way to
    // drop it under it, in place of its hint: below the orders and the fold,
    // each "Clear" link sat apart from the box it empties, and the page put
    // two hints and two such lines above its first question (P2-29, the
    // stream's iteration 14).
    await expect(within(searchForm(canvasElement)).getByRole("link")).toBe(clearSearch);
    await expect(within(placeForm(canvasElement)).getByRole("link")).toBe(clearPlace);
    await expect(canvas.queryByText(/Every word you type/)).toBeNull();
    await expect(canvas.queryByText(/as askers write it/)).toBeNull();
    await expect(
      within(searchForm(canvasElement)).getByRole("searchbox"),
    ).toHaveAccessibleDescription("Only questions with all your words.");
    await expect(within(placeForm(canvasElement)).getByRole("textbox")).toHaveAccessibleDescription(
      "Only questions filed at this place.",
    );
    // Each note is one line down to a 320px phone, its "Clear" link the
    // line under it: at 360px each note took two lines, the place's
    // leaving "entered." alone on its second, so each box's line was three
    // (P2-29, the stream's iteration 15).
    for (const form of [searchForm(canvasElement), placeForm(canvasElement)]) {
      const note = document.createRange();
      note.selectNodeContents(form.querySelector("p > span")!);
      await expect(new Set([...note.getClientRects()].map((r) => Math.round(r.top))).size).toBe(1);
    }
  },
};

export const FilteredToNothing: Story = {
  args: {
    sort: "closing",
    typedPlace: "Riverside",
    filter: { topic: "transport", place: "Riverside" },
    stream: { kind: "stream", cards: [], next: undefined },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "No open question is filed here" }),
    ).toBeVisible();
    await expect(canvas.getByText(/under this topic and at this place/)).toBeVisible();
    // Its one action drops what its words name, the place, keeping the
    // topic's page and the order; nothing offers to drop both at once.
    const clear = canvas.getAllByRole("link", { name: "Clear the place" });
    await expect(clear).toHaveLength(2);
    for (const link of clear)
      await expect(link).toHaveAttribute("href", "/discover?sort=closing&topic=transport");
    await expect(canvas.queryByRole("link", { name: "Show everything" })).toBeNull();
  },
};

export const TopicFiledNothing: Story = {
  args: {
    filter: { topic: "transport" },
    stream: { kind: "stream", cards: [], next: undefined },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText("Only questions filed under this topic are listed."),
    ).toBeVisible();
    const every = canvas.getAllByRole("link", { name: "Show every topic" });
    await expect(every).toHaveLength(2);
    for (const link of every) await expect(link).toHaveAttribute("href", "/discover");
  },
};

export const PlaceFiledNothing: Story = {
  args: {
    typedPlace: "Riverside",
    filter: { place: "Riverside" },
    stream: { kind: "stream", cards: [], next: undefined },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Only questions filed at this place are listed.")).toBeVisible();
    const clear = canvas.getAllByRole("link", { name: "Clear the place" });
    await expect(clear).toHaveLength(2);
    for (const link of clear) await expect(link).toHaveAttribute("href", "/discover");
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
    // The refused place stays in its box, shown out of the fold, to be corrected.
    await expect(within(placeForm(canvasElement)).getByRole("textbox")).toHaveValue("a".repeat(81));
    await expect(within(placeForm(canvasElement)).getByRole("textbox")).toBeVisible();
    await expect(canvasElement.querySelector("details")).not.toHaveAttribute("open");
    await expect(canvas.getByRole("link", { name: "Clear the place" })).toHaveAttribute(
      "href",
      "/discover",
    );
  },
};

/**
 * The stream's first page with the places listed polls are filed at: the
 * folded place box suggests them through the browser's own list, each as
 * its asker wrote it, while the page's text names none of them (T-67), and
 * the hint says the box suggests them (P2-23 part 3b).
 */
export const PlacesSuggested: Story = {
  args: { places: ["Old Town", "Riverside", "東京 Ward 2"] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText("Topic and place"));
    const place = within(placeForm(canvasElement)).getByRole("combobox", { name: "Place" });
    await expect(place).toBeVisible();
    await expect(place).toHaveValue("");
    await expect(place).toHaveAccessibleDescription(
      /the whole name must match\. It suggests the places listed polls are filed at\.$/,
    );
    const list = place.getAttribute("list");
    await expect(list).not.toBeNull();
    const options = canvasElement.querySelectorAll(`datalist[id="${list}"] > option`);
    await expect([...options].map((o) => o.getAttribute("value"))).toEqual([
      "Old Town",
      "Riverside",
      "東京 Ward 2",
    ]);
    await expect(canvas.queryByText("東京 Ward 2")).toBeNull();
  },
};

/**
 * A place's page with places to suggest: its box beside the search keeps the
 * list, and the note saying the page is narrowed stands where the hint was.
 */
export const PlacesSuggestedOnAPlace: Story = {
  args: {
    typedPlace: "Old Town",
    filter: { place: "Old Town" },
    stream: { kind: "stream", cards: filed({ place: "Old town" }), next: NEXT },
    places: ["Old Town", "Riverside"],
  },
  play: async ({ canvasElement }) => {
    const place = within(placeForm(canvasElement)).getByRole("combobox", { name: "Place" });
    await expect(place).toBeVisible();
    await expect(place).toHaveValue("Old Town");
    await expect(place).toHaveAccessibleDescription("Only questions filed at this place.");
    await expect(canvasElement.querySelectorAll("datalist > option")).toHaveLength(2);
  },
};

/** No places to suggest: a plain box, and a hint that promises none. */
export const NoPlacesSuggested: Story = {
  args: { places: [] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText("Topic and place"));
    const place = within(placeForm(canvasElement)).getByRole("textbox", { name: "Place" });
    await expect(place).not.toHaveAttribute("list");
    await expect(canvasElement.querySelector("datalist")).toBeNull();
    await expect(canvas.queryByText(/suggests the places/)).toBeNull();
  },
};
