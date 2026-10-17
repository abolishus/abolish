import { bigint, pgTable, primaryKey, smallint, unique } from "drizzle-orm/pg-core";
import { bytea } from "./bytea.ts";

// Drizzle view of migrations/0000_board.sql; a test checks the two agree.
// The table is append-only (grants and triggers in the migration): the app
// role can only SELECT and INSERT (T-23).

export const boardEntries = pgTable(
  "board_entries",
  {
    electionId: bytea("election_id").notNull(),
    idx: bigint("idx", { mode: "bigint" }).notNull(),
    segment: bigint("segment", { mode: "bigint" }).notNull(),
    payload: bytea("payload").notNull(),
    entryHash: bytea("entry_hash").notNull(),
    prevLink: bytea("prev_link").notNull(),
    link: bytea("link").notNull(),
  },
  (t) => [primaryKey({ columns: [t.electionId, t.idx] })],
);

// Drizzle view of migrations/0006_board_subtrees.sql: the board tree's
// perfect subtrees, append-only like the board (T-52).
export const boardSubtrees = pgTable(
  "board_subtrees",
  {
    electionId: bytea("election_id").notNull(),
    level: smallint("level").notNull(),
    idx: bigint("idx", { mode: "bigint" }).notNull(),
    hash: bytea("hash").notNull(),
  },
  (t) => [primaryKey({ columns: [t.electionId, t.level, t.idx] })],
);

// Drizzle view of migrations/0008_board_ballot_keys.sql: each boarded
// ballot's (tier, nullifier, M), by which appendEntry refuses repeats
// (verifier 5.7; T-38, T-52). Append-only like the board.
export const boardBallotKeys = pgTable(
  "board_ballot_keys",
  {
    electionId: bytea("election_id").notNull(),
    tier: smallint("tier").notNull(),
    nullifier: bytea("nullifier").notNull(),
    message: bytea("message").notNull(),
    idx: bigint("idx", { mode: "bigint" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.electionId, t.tier, t.nullifier, t.message] }),
    unique().on(t.electionId, t.idx),
  ],
);

// Drizzle view of migrations/0009_board_checkpoints.sql: each checkpoint the
// anchoring job took, append-only like the board; taking one fences its
// segment (T-24).
export const boardCheckpoints = pgTable(
  "board_checkpoints",
  {
    electionId: bytea("election_id").notNull(),
    segment: bigint("segment", { mode: "bigint" }).notNull(),
    size: bigint("size", { mode: "bigint" }).notNull(),
    checkpoint: bytea("checkpoint").notNull(),
  },
  (t) => [primaryKey({ columns: [t.electionId, t.segment] })],
);
