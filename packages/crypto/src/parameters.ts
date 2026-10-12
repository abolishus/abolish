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
  DISPLAY_TEXT_SALT_LEN: 32,
} as const);
