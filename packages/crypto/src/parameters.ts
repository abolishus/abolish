// Protocol-wide limits of docs/spec/parameters.md; a test checks this table
// against the spec (T-52, T-28).

import { MAX_BOARD_PAYLOAD } from "./board.ts";

export const PARAMETERS = Object.freeze({
  MAX_TAG_LEN: 255,
  MAX_OPTIONS: 64,
  // Questions in a poll, under election-definition version 5.
  MAX_QUESTIONS: 32,
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
  // Seconds after closes_at + l1_inclusion_bound; the close window of the
  // close statement's version 1 (docs/spec/close.md).
  CLOSE_WINDOW: 172_800,
  // Seconds after the seal's anchoring window until the dispute end t_E; a
  // constant of receipt version 1 (docs/spec/receipts.md).
  DISPUTE_WINDOW: 2_592_000,
  // Seconds after t_S; the anchoring period containing t_S + OPENING_WINDOW
  // is the last in which an opening of version 1 may be boarded
  // (docs/spec/challenge.md, Publication).
  OPENING_WINDOW: 604_800,
  // Bytes; the whole-record cap of display-text version 2.
  MAX_DISPLAY_TEXT: 4_194_304,
  DISPLAY_TEXT_SALT_LEN: 32,
  // Constants of the group registry's deployment (docs/spec/vouching.md).
  VOUCH_K: 3,
  VOUCH_SLOTS: 12,
  // Registered members; the regional-cell floor of election-definition version 3.
  MIN_CELL_ELECTORATE: 1000,
  // Changed nullifiers per cell; the live-results batch floor of
  // election-definition version 6.
  MIN_LIVE_BATCH: 20,
  // Seconds; the root clock of rolling electorates, election-definition
  // version 7: boundary n is n * ROOT_PERIOD + ROOT_OFFSET in UNIX time, and
  // a ballot names a step within ROOT_WINDOW before its L1 reference.
  ROOT_PERIOD: 600,
  ROOT_OFFSET: 300,
  ROOT_WINDOW: 7200,
} as const);
