// How many entries each paged view asks the API for. Apart from
// src/server/load.ts, which fetches them, so the pages and the server
// functions' checks read them without bringing the server's loaders, and the
// decoders those import, into the browser's script (P2-28 part 2b).

/**
 * Entries per page of the board page. Pages start only at multiples of it,
 * so a visit tells our server which window of the board was read, never
 * which entry (T-10).
 */
export const BOARD_PAGE = 25;

/** The board page's latest checkpoints: earlier ones are the verifier's to read from L1. */
export const ANCHOR_PAGE = 6;

/**
 * Checkpoints the board page asks for, the latest first: its activity counts
 * the entries of each one's period, and its anchors show the first
 * `ANCHOR_PAGE`. At P4-1's hourly periods, about a day of a busy board.
 */
export const ACTIVITY_PAGE = 24;

/** Decisions per page of the moderation log. */
export const LOG_PAGE = 50;

/** Polls per page of the discovery list: each costs the page one definition fetch. */
export const LIST_PAGE = 20;
