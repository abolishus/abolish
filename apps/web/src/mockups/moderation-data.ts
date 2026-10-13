// Sample data for the Moderation mockups (Storybook only). Invented.

import { MODERATION_LOG } from "./fixtures.ts";

export interface Ground {
  code: string;
  name: string;
  description: string;
  /** May an open poll be hidden (not only delisted) on this ground? */
  hidesOpen: boolean;
}

export const GROUNDS: readonly Ground[] = [
  {
    code: "illegal",
    name: "Illegal content",
    description:
      "Content that is illegal to host or distribute where we operate, such as child sexual abuse material.",
    hidesOpen: true,
  },
  {
    code: "personal-data",
    name: "Personal data",
    description:
      "A private individual’s address, phone number, identity number, health or financial details, or anything that identifies a voter.",
    hidesOpen: true,
  },
  {
    code: "threat",
    name: "Threat",
    description:
      "A credible threat of violence, or incitement to violence against a person or group.",
    hidesOpen: true,
  },
  {
    code: "harassment",
    name: "Harassment",
    description: "Text that targets a private individual for abuse.",
    hidesOpen: false,
  },
  {
    code: "spam",
    name: "Spam",
    description: "Bulk or automated polls, scams, phishing or malware links.",
    hidesOpen: false,
  },
  {
    code: "impersonation",
    name: "Impersonation",
    description:
      "A poll presented as coming from a person, organisation or authority that didn’t create it.",
    hidesOpen: false,
  },
  {
    code: "legal-notice",
    name: "Legal notice",
    description: "A notice or order we are legally bound to act on.",
    hidesOpen: false,
  },
];

export const RESTORE_GROUNDS = [
  { code: "appeal-upheld", name: "Appeal upheld", description: "The creator’s appeal succeeded." },
  { code: "error", name: "Error", description: "The removal was wrong on its face." },
  {
    code: "notice-withdrawn",
    name: "Notice withdrawn",
    description: "The legal notice behind it was withdrawn or overturned.",
  },
] as const;

export const NEVER_GROUNDS = [
  "A poll’s political or religious viewpoint",
  "Its subject being controversial",
  "Criticism of any person, government or organisation, us included",
  "A public figure objecting to a poll about their public role",
  "A poll being unpopular, or reported many times",
  "The poll’s result or turnout, actual or expected",
] as const;

export interface LogRow {
  seq: number;
  at: string;
  poll: string;
  pollId: string;
  action: "Delisted" | "Hidden" | "Restored";
  reason: string;
  note: string;
}

const IDS = [
  "52a733defcdac53361fba10c46cf7b0183dfe60ae48d05f4ba9daa4895492ea0",
  "c378fb8854cad79b6aadd9d330ac137d49d9ee275f9d385252c03e197ed2c1ee",
  "00f5e6dac8ae9dff5dcefcfb60ccd506bcb4263cf6f846b77837358111fe2a52",
  "b9f3547ecc38f709ace3dc02cf71b947e7fd9b1c6d58bec7fc4f82fabf23d647",
  "cf5d3c0f996f71fd5d747271e64f37351d844b310858b7151fe009a35b61c32e",
  "9abf4bf101529bc0df81cc63626d12c874305fa916bdeb1d5f5a558a974c750d",
  "a1882dc0787432a814ab87fa48acc0de1dcc103a2eb0ea24acf461612b2f14dc",
  "32ec43f60bf75b212465a0930e4cfdb8412bec4014cf2338be920f9f0046984c",
] as const;

const EARLIER: readonly Omit<LogRow, "seq" | "pollId">[] = [
  {
    at: "27 October 2026, 16:21 UTC",
    poll: "Should the council resign",
    action: "Delisted",
    reason: "Spam",
    note: "Taken for a duplicate of an earlier poll.",
  },
  {
    at: "24 October 2026, 08:03 UTC",
    poll: "(text withheld)",
    action: "Hidden",
    reason: "Threat",
    note: "Named a person and called for violence against them.",
  },
  {
    at: "19 October 2026, 13:47 UTC",
    poll: "Official Alder County ballot (not from the county)",
    action: "Delisted",
    reason: "Impersonation",
    note: "Presented as the county clerk’s own poll.",
  },
  {
    at: "15 October 2026, 10:30 UTC",
    poll: "Win a free phone, vote now",
    action: "Hidden",
    reason: "Spam",
    note: "Linked to a phishing site.",
  },
  {
    at: "12 October 2026, 19:55 UTC",
    poll: "Rate the new Harbor ferry timetable",
    action: "Restored",
    reason: "Error",
    note: "Delisted in error by a filter for repeated words.",
  },
];

export const LOG_TOTAL = 47;

export const LOG: readonly LogRow[] = [...MODERATION_LOG.map((r) => ({ ...r })), ...EARLIER].map(
  (r, i) => ({
    ...r,
    action: r.action as LogRow["action"],
    seq: LOG_TOTAL - i,
    pollId: IDS[i % IDS.length] ?? IDS[0],
  }),
);

export interface QueueItem {
  id: string;
  poll: string;
  pollId: string;
  open: boolean;
  closes: string;
  text: string;
  ground: string;
  reports: number;
  waitingSince: string;
}

export const QUEUE: readonly QueueItem[] = [
  {
    id: "q1",
    poll: "Who is the worst landlord on Pier Street",
    pollId: IDS[3],
    open: true,
    closes: "18 November 2026, 12:00 UTC",
    text: "Who is the worst landlord on Pier Street? Options name four people, with the flat numbers they own.",
    ground: "personal-data",
    reports: 12,
    waitingSince: "4 November 2026, 09:00 UTC",
  },
  {
    id: "q2",
    poll: "Should the state transit bond pass",
    pollId: IDS[4],
    open: true,
    closes: "8 December 2026, 22:00 UTC",
    text: "Should the state issue $4.2 billion in bonds for regional rail? A duplicate of the scheduled referendum, by a different creator.",
    ground: "impersonation",
    reports: 3,
    waitingSince: "4 November 2026, 11:00 UTC",
  },
  {
    id: "q3",
    poll: "Best pizza in Harbor (round 41)",
    pollId: IDS[5],
    open: false,
    closes: "3 November 2026, 18:00 UTC",
    text: "Best pizza in Harbor? One of forty identical polls created within an hour.",
    ground: "spam",
    reports: 1,
    waitingSince: "4 November 2026, 13:00 UTC",
  },
];
