// The moderation log's actions, apart from components/moderation-log.tsx so
// the log route's search validation, which every page's script carries,
// doesn't pull in the page itself.

/**
 * What a decision did, as the log page offers it as a filter: the API's
 * action, with a profile's hiding apart from a poll's, since they hide
 * different things. A restore is one action, whichever it restores.
 */
export const LOG_ACTIONS = ["delist", "hide", "hide-profile", "restore", "refile"] as const;

export type LogAction = (typeof LOG_ACTIONS)[number];
