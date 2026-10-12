// Protocol-wide limits of docs/spec/parameters.md; a test checks this table
// against the spec (T-52, T-28).

import { MAX_BOARD_PAYLOAD } from "./board.ts";

export const PARAMETERS = Object.freeze({
  MAX_TAG_LEN: 255,
  MAX_OPTIONS: 64,
  MAX_TRUSTEES: 16,
  MAX_BOARD_PAYLOAD,
  // Seconds; the tally window of tally-opening version 1 (docs/spec/tally.md).
  TALLY_WINDOW: 604_800,
  // Seconds; the delivery deadline and complaint window of the delivery
  // records' version 1, which ballot version 1 fixes (docs/spec/delivery.md).
  DELIVERY_WINDOW: 172_800,
  COMPLAINT_WINDOW: 432_000,
  // Seconds after t_D; the destruction window of tally-opening version 1.
  DESTRUCTION_WINDOW: 86_400,
  // Seconds after the seal's anchoring window until the dispute end t_E; a
  // constant of receipt version 1 (docs/spec/receipts.md).
  DISPUTE_WINDOW: 2_592_000,
  // Seconds after t_S; the anchoring period containing t_S + OPENING_WINDOW
  // is the last in which an opening of version 1 may be boarded
  // (docs/spec/challenge.md, Publication).
  OPENING_WINDOW: 604_800,
  DISPLAY_TEXT_SALT_LEN: 32,
  // Constants of the group registry's deployment (docs/spec/vouching.md).
  VOUCH_K: 3,
  VOUCH_SLOTS: 12,
  // Registered members; the regional-cell floor of election-definition version 3.
  MIN_CELL_ELECTORATE: 1000,
} as const);
