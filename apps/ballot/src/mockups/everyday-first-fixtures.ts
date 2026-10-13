// Sample data for the first-answer journey (Storybook only). Invented. The
// seals match the website's journey fixtures (apps/web/src/mockups/
// journey-data.ts), copied rather than imported, so the same poll shows the
// same seal on both sides of the handoff.

import { RIVERSIDE, type Answers, type EverydayPoll } from "./everyday-fixtures.ts";

/** The voting app's own address (ADR 0020), and the website's. */
export const VOTING_APP_HOST = "abolish.ch";
export const WEBSITE_HOST = "abolish.us";

/** How long a new device usually waits to join the people who can answer (ADR 0024's period). */
export const JOIN_WITHIN = "10 minutes";

/** A one-question poll, answerable straight from its card on the website. */
export const LIBRARY: EverydayPoll = {
  title: "When should the main library open on Sundays?",
  askedBy: "Northfield Library Cooperative",
  closesShort: "Closes 30 Nov",
  closes: "30 November 2026, 12:00 UTC",
  changeUntil: "30 November",
  results: "live",
  batchFloor: 50,
  audience: RIVERSIDE.audience,
  definitionHash: "c3f9a1d27e5b08c46f1e9d2a7b3c50e8f4a6d19b2c7e083f5a1d4b6c9e2f7a08",
  url: `https://${WEBSITE_HOST}/polls/library-hours`,
  questions: [
    {
      key: "sunday",
      text: "When should the main library open on Sundays?",
      rule: { kind: "one" },
      options: [
        { key: "ten", label: "10:00 to 16:00" },
        { key: "noon", label: "12:00 to 17:00" },
        { key: "closed", label: "Keep it closed on Sundays" },
      ],
    },
  ],
  latest: {
    at: "9 Nov 12:00",
    people: 640,
    counts: { sunday: { ten: 333, noon: 192, closed: 115 } },
    sentences: { sunday: "10:00 to 16:00 leads, chosen by 52%." },
  },
};

/** The three-question poll, with the seal the website shows for it. */
export const RIVERSIDE_FIRST: EverydayPoll = {
  ...RIVERSIDE,
  definitionHash: "b1a71203bc63c46c88c27d024456c4d70c953a796284a33280b376fabc89c490",
};

/** What the person tapped on the library card. */
export const TAPPED_LIBRARY: Answers = { sunday: ["ten"] };

/** What the person tapped for Riverside's first question. */
export const TAPPED_RIVERSIDE: Answers = { priority: ["toilets"] };
