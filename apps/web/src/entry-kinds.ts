// The kinds of board entry, apart from src/board.ts so the board route's
// search validation, which every page's script carries, doesn't pull in
// @abolishus/crypto.

/**
 * What an entry records, named by its payload's record type
 * (docs/spec/board.md, Allowed payloads), in the order the board page
 * offers them as filters.
 */
export const ENTRY_KINDS = [
  "ballot",
  "spoiled-opening",
  "ceremony",
  "tally-opening",
  "contract-event",
  "share-receipt",
  "share-complaint",
  "destruction",
  "close-statement",
  "running-opening",
  "author-approvals",
] as const;

export type EntryKind = (typeof ENTRY_KINDS)[number];
