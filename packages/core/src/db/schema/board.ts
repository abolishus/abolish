import { bigint, pgTable, primaryKey } from "drizzle-orm/pg-core";
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
