// Sample data for the first-answer journey (Storybook only). Invented. The
// seals match the ballot client's journey fixtures (apps/ballot/src/mockups/
// everyday-first-fixtures.ts), so the same poll shows the same seal on both
// sides of the handoff.

import { RIVERSIDE } from "./everyday-fixtures.ts";

/** The voting app's own address (ADR 0020). */
export const VOTING_APP_HOST = "abolish.ch";

export interface JourneyPoll {
  slug: string;
  /** The poll's definition hash: its seal, and how the voting app finds it. */
  hash: string;
  title: string;
  askedBy: string;
  closes: string;
  questions: readonly {
    key: string;
    text: string;
    options: readonly { key: string; label: string }[];
  }[];
}

export const LIBRARY_JOURNEY: JourneyPoll = {
  slug: "library-hours",
  hash: "c3f9a1d27e5b08c46f1e9d2a7b3c50e8f4a6d19b2c7e083f5a1d4b6c9e2f7a08",
  title: "When should the main library open on Sundays?",
  askedBy: "Northfield Library Cooperative",
  closes: "Closes 30 Nov",
  questions: [
    {
      key: "sunday",
      text: "When should the main library open on Sundays?",
      options: [
        { key: "ten", label: "10:00 to 16:00" },
        { key: "noon", label: "12:00 to 17:00" },
        { key: "closed", label: "Keep it closed on Sundays" },
      ],
    },
  ],
};

export const RIVERSIDE_JOURNEY: JourneyPoll = {
  slug: "riverside",
  hash: RIVERSIDE.id,
  title: RIVERSIDE.title,
  askedBy: RIVERSIDE.askedBy,
  closes: "Closes 15 Nov",
  questions: RIVERSIDE.questions,
};

/**
 * Where an answer opens: the voting app on its own origin, with the poll and
 * the pick both in the fragment, so neither reaches a server or a gateway log.
 */
export const votingAppHref = (poll: JourneyPoll, pick?: string) =>
  `https://${VOTING_APP_HOST}/#poll=${poll.hash}${pick === undefined ? "" : `&pick=${pick}`}`;
