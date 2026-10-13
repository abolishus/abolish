// Sample draft for the Create a poll mockup (Storybook only). Invented.

export type Method = "plurality" | "approval" | "ranked";
export type Eligibility = "tier0" | "tier1" | "tier2";

export interface DateParts {
  day: string;
  month: string;
  year: string;
  time: string;
}

export interface Draft {
  question: string;
  description: string;
  options: string[];
  method: Method | "";
  eligibility: Eligibility | "";
  opens: DateParts;
  closes: DateParts;
}

export const EMPTY_DRAFT: Draft = {
  question: "",
  description: "",
  options: ["", ""],
  method: "",
  eligibility: "",
  opens: { day: "", month: "", year: "", time: "" },
  closes: { day: "", month: "", year: "", time: "" },
};

export const SAMPLE_DRAFT: Draft = {
  question: "Which improvements should the Riverside neighbourhood association ask the city for?",
  description:
    "The association meets the city's parks department on 20 November. The two improvements with the most support will be raised first. Choose every option you would support.",
  options: [
    "Better lighting on the river path",
    "Public toilets open all year",
    "Resurfaced basketball courts",
  ],
  method: "approval",
  eligibility: "tier1",
  opens: { day: "1", month: "11", year: "2026", time: "12:00" },
  closes: { day: "15", month: "11", year: "2026", time: "12:00" },
};

/** What the definition hash would be for SAMPLE_DRAFT (a mock value). */
export const DRAFT_DEFINITION_HASH =
  "9922ffc1f669ecf5b25c570dad72ef42808ece8da61aa696badb1bd3b6219eea";
export const DRAFT_TEXT_HASH = "ce8707cbabfb0adb39b3ef3b31600236486dc0332586fa5fe7b7cf1f4b7668ac";

export const STEPS = [
  { key: "question", label: "Question" },
  { key: "options", label: "Options" },
  { key: "method", label: "Method" },
  { key: "eligibility", label: "Who can vote" },
  { key: "schedule", label: "Schedule" },
  { key: "review", label: "Review" },
] as const;

export type StepKey = (typeof STEPS)[number]["key"];

export const MAX_QUESTION = 200;
export const MAX_OPTIONS = 10;

export const METHODS: readonly {
  key: Method;
  name: string;
  summary: string;
  detail: string;
  later?: boolean;
}[] = [
  {
    key: "plurality",
    name: "Plurality",
    summary: "Each voter chooses one option.",
    detail: "The option chosen by the most voters leads. Best for a yes-or-no question.",
  },
  {
    key: "approval",
    name: "Approval",
    summary: "Each voter marks every option they would accept.",
    detail:
      "The option approved by the most voters leads. Shares are out of voters, so they add up to more than 100%.",
  },
  {
    key: "ranked",
    name: "Ranked choice",
    summary: "Each voter puts the options in order.",
    detail: "Coming later, once the verifier can recount it.",
    later: true,
  },
];

export const ELIGIBILITY: readonly {
  key: Eligibility;
  name: string;
  summary: string;
  tiers: readonly ("tier2" | "tier1" | "tier0")[];
}[] = [
  {
    key: "tier0",
    name: "Anyone with a passkey",
    summary:
      "All three tiers can vote. Easiest to join, and easiest to stuff: one person can hold many passkeys.",
    tiers: ["tier2", "tier1", "tier0"],
  },
  {
    key: "tier1",
    name: "Vouched or document-verified",
    summary:
      "Tiers 1 and 2. People vouched for by verified members, or who proved a government document.",
    tiers: ["tier2", "tier1"],
  },
  {
    key: "tier2",
    name: "Document-verified only",
    summary: "Tier 2. One ballot per verified person, proved without revealing who they are.",
    tiers: ["tier2"],
  },
];
