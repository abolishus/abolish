// Sample data for the everyday-register mockups (Storybook only). Invented.

export type QuestionKind =
  | { kind: "one" }
  | { kind: "any" }
  | { kind: "upTo"; max: number }
  | { kind: "exactly"; count: number };

export interface EverydayQuestion {
  key: string;
  text: string;
  hint?: string;
  rule: QuestionKind;
  options: readonly { key: string; label: string }[];
}

/** One published live-results batch: real totals at a real time, never interpolated. */
export interface LiveBatch {
  at: string;
  /** Ballots counted in this release. */
  ballots: number;
  /** Per question, per option. */
  counts: Record<string, Record<string, number>>;
}

export interface EverydayPoll {
  id: string;
  askedBy: string;
  askedAt: string;
  closes: string;
  title: string;
  place: string;
  topic: string;
  results: "live" | "sealed";
  /** Minimum new ballots before a live release (the batch floor). */
  batchFloor: number;
  /** Who can answer, in words: the tier, never a code. */
  audience: string;
  trustees: { defaultPanel: string; added: readonly string[] };
  questions: readonly EverydayQuestion[];
  batches: readonly LiveBatch[];
}

export const RIVERSIDE: EverydayPoll = {
  id: "b1a71203bc63c46c88c27d024456c4d70c953a796284a33280b376fabc89c490",
  askedBy: "Riverside Neighbours",
  askedAt: "1 November 2026",
  closes: "15 November 2026, 12:00 UTC",
  title: "What should Riverside ask the city for next year?",
  place: "Riverside",
  topic: "Neighbourhood",
  results: "live",
  batchFloor: 50,
  audience: "anyone with an account",
  trustees: {
    defaultPanel: "Abolish launch panel: during launch, Abolish alone holds the key",
    added: ["Riverside Library Friends"],
  },
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
      hint: "Choose up to two.",
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
      options: [
        { key: "very", label: "Very safe" },
        { key: "mostly", label: "Mostly safe" },
        { key: "unsure", label: "Not sure" },
        { key: "unsafe", label: "Not very safe" },
        { key: "never", label: "I avoid it" },
      ],
    },
  ],
  batches: [
    {
      at: "2 November, 12:00 UTC",
      ballots: 412,
      counts: {
        priority: { lights: 171, toilets: 98, courts: 52, trees: 91 },
        events: { market: 240, cinema: 188, cleanup: 97, music: 151 },
        safe: { very: 31, mostly: 109, unsure: 66, unsafe: 142, never: 64 },
      },
    },
    {
      at: "4 November, 12:00 UTC",
      ballots: 1_306,
      counts: {
        priority: { lights: 548, toilets: 301, courts: 170, trees: 287 },
        events: { market: 770, cinema: 590, cleanup: 318, music: 470 },
        safe: { very: 98, mostly: 352, unsure: 205, unsafe: 451, never: 200 },
      },
    },
    {
      at: "7 November, 12:00 UTC",
      ballots: 2_418,
      counts: {
        priority: { lights: 1_003, toilets: 571, courts: 318, trees: 526 },
        events: { market: 1_431, cinema: 1_092, cleanup: 601, music: 866 },
        safe: { very: 176, mostly: 650, unsure: 390, unsafe: 840, never: 362 },
      },
    },
  ],
};

/** Questions for the discovery stream: a mix of everyday polls, one civic. */
export const STREAM = [
  {
    id: "riverside",
    title: RIVERSIDE.title,
    askedBy: "Riverside Neighbours",
    place: "Riverside",
    topic: "Neighbourhood",
    answers: 2_418,
    questions: 3,
    results: "live" as const,
    closes: "Closes 15 Nov",
    lead: "Better lighting on the river path leads, with 41%.",
  },
  {
    id: "four-day",
    title: "Would you support a four-day school week?",
    askedBy: "Parents of Alder County",
    place: "Alder County",
    topic: "Schools",
    answers: 9_120,
    questions: 1,
    results: "sealed" as const,
    closes: "Closes 20 Nov",
    lead: "Results appear when it closes.",
  },
  {
    id: "bus-23",
    title: "Should the 23 bus run until midnight?",
    askedBy: "Harbor Riders",
    place: "Harbor",
    topic: "Transport",
    answers: 1_874,
    questions: 2,
    results: "live" as const,
    closes: "Closes 12 Nov",
    lead: "Yes leads, with 77%.",
  },
  {
    id: "library-hours",
    title: "When should the main library open on Sundays?",
    askedBy: "Northfield Library Cooperative",
    place: "Northfield",
    topic: "Libraries",
    answers: 640,
    questions: 1,
    results: "live" as const,
    closes: "Closes 30 Nov",
    lead: "10:00 to 16:00 leads, with 52%.",
  },
  {
    id: "levy",
    title: "Alder County library levy",
    askedBy: "Civic record",
    place: "Alder County",
    topic: "Referendum",
    answers: 161_363,
    questions: 1,
    results: "sealed" as const,
    closes: "Counted 3 Nov",
    lead: "58.4% yes among 40,112 document-verified voters.",
    civic: true,
  },
] as const;
