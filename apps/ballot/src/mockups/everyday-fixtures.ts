// Sample data for the ballot client's everyday-register mockups (Storybook
// only). Invented. The poll is the website's RIVERSIDE (apps/web/src/mockups/
// everyday-fixtures.ts), copied rather than imported so the ballot client
// never reaches into the website's code.

export type QuestionRule =
  | { kind: "one" }
  | { kind: "any" }
  | { kind: "upTo"; max: number }
  | { kind: "exactly"; count: number };

export interface EverydayQuestion {
  key: string;
  text: string;
  rule: QuestionRule;
  /** For a scale, the order the options run in, in words. */
  scale?: string;
  options: readonly { key: string; label: string }[];
}

/** One published live-results release: real totals at a real time. */
export interface LiveBatch {
  /** When it was published, as the results view says it. */
  at: string;
  /** People counted in this release. */
  people: number;
  counts: Record<string, Record<string, number>>;
  /** The sentence that leads each question's result. */
  sentences: Record<string, string>;
}

export interface EverydayPoll {
  title: string;
  askedBy: string;
  /** Short close, for the top bar. */
  closesShort: string;
  closes: string;
  /** When answers can last be changed, in a sentence. */
  changeUntil: string;
  results: "live" | "sealed";
  /** Minimum new answers before a live release. */
  batchFloor: number;
  /** Who can answer, in words: the tier, never a code. */
  audience: string;
  /** A trustee the asker added beside Abolish, if any. */
  addedTrustee?: string;
  definitionHash: string;
  url: string;
  questions: readonly EverydayQuestion[];
  latest: LiveBatch;
}

/** Answers by question key; a question that is absent hasn't been answered yet. */
export type Answers = Readonly<Record<string, readonly string[]>>;

export const RIVERSIDE: EverydayPoll = {
  title: "What should Riverside ask the city for next year?",
  askedBy: "Riverside Neighbours",
  closesShort: "Closes 15 Nov",
  closes: "15 November 2026, 12:00 UTC",
  changeUntil: "15 November",
  results: "live",
  batchFloor: 50,
  audience: "people with an account",
  addedTrustee: "Riverside Library Friends",
  definitionHash: "4095dc37150f8a05e5f63c47a6347ccc4f36e7d64002cf4c6156c57fbc9650a9",
  url: "https://abolish.us/polls/riverside-park-improvements",
  questions: [
    {
      key: "priority",
      text: "Which one improvement matters most to you?",
      rule: { kind: "one" },
      options: [
        { key: "lights", label: "Better lighting on the river path" },
        { key: "toilets", label: "Public toilets open all year" },
        { key: "courts", label: "Resurfaced basketball courts" },
        { key: "trees", label: "Two hundred new street trees" },
      ],
    },
    {
      key: "events",
      text: "Which events would you go to?",
      rule: { kind: "upTo", max: 2 },
      options: [
        { key: "market", label: "A Saturday farmers' market" },
        { key: "cinema", label: "Outdoor cinema in summer" },
        { key: "cleanup", label: "Monthly river clean-up" },
        { key: "music", label: "Free concerts in the bandstand" },
      ],
    },
    {
      key: "safe",
      text: "How safe do you feel walking along the river after dark?",
      rule: { kind: "one" },
      scale: "The answers run from very safe at the top to avoiding it at the bottom.",
      options: [
        { key: "very", label: "Very safe" },
        { key: "mostly", label: "Mostly safe" },
        { key: "unsure", label: "Not sure" },
        { key: "unsafe", label: "Not very safe" },
        { key: "never", label: "I avoid it" },
      ],
    },
  ],
  latest: {
    at: "7 Nov 12:00",
    people: 2_418,
    counts: {
      priority: { lights: 1_003, toilets: 571, courts: 318, trees: 526 },
      events: { market: 1_431, cinema: 1_092, cleanup: 601, music: 866 },
      safe: { very: 176, mostly: 650, unsure: 390, unsafe: 840, never: 362 },
    },
    sentences: {
      priority: "Better lighting on the river path leads, chosen by 41.5%.",
      events: "A Saturday farmers' market is the most popular: 59.2% would go.",
      safe: "Nearly half (49.7%) feel not very safe on the river path after dark, or avoid it.",
    },
  },
};

export const RIVERSIDE_SEALED: EverydayPoll = { ...RIVERSIDE, results: "sealed" };

/** The same poll with its second question as pick exactly two, which can't be skipped. */
export const RIVERSIDE_EXACTLY: EverydayPoll = {
  ...RIVERSIDE,
  questions: RIVERSIDE.questions.map((q) =>
    q.key === "events" ? { ...q, rule: { kind: "exactly", count: 2 } } : q,
  ),
};

/** What the person tapped on the website before the client opened. */
export const TAPPED: Answers = { priority: ["toilets"] };

/** A full set of answers, for the screens after the questions. */
export const ANSWERED: Answers = {
  priority: ["toilets"],
  events: ["market", "cleanup"],
  safe: ["unsafe"],
};

export const EVERYDAY_RECEIPT = {
  hash: "1bddad592bb3d9a79ed30408fa786fbfaf6f11f091d44f3947d2b471bd8c1a5d",
  entry: 2_431,
  recordedAt: new Date("2026-11-07T14:02:12Z"),
};

/** The sealed answers this device made, before sending or checking them. */
export const EVERYDAY_SEALED = {
  hash: "5e3eb011cb673f6a53fbb6e4365e8dcc598b0f409d4267c5e9438b8020d913b1",
  spoiledEntry: 2_429,
};
