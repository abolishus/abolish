// The topics a poll is filed under, on their own: a page reads the list
// without the draft rules' import of @abolishus/crypto, which the website
// would otherwise ship to every visitor (P2-28 part 2b).

/**
 * The topics a poll can be filed under ([[0041-poll-topics-and-places]]): a
 * fixed list the website words in its own messages, so no author's words
 * name a topic and a topic's page is the same in every language (T-67).
 * Codes are only ever added: a poll keeps the code it was filed under, so
 * none is renamed or removed.
 */
export const POLL_TOPICS = [
  "community",
  "culture",
  "economy",
  "education",
  "environment",
  "food",
  "government",
  "health",
  "housing",
  "safety",
  "science",
  "sport",
  "technology",
  "transport",
] as const;
export type PollTopic = (typeof POLL_TOPICS)[number];
