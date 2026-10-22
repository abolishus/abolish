import { pgTable, text } from "drizzle-orm/pg-core";
import { bytea } from "./bytea.ts";

// Drizzle view of migrations/0011_display_texts.sql; a test checks the two
// agree. Operational: takedown-able text, never a result (T-17, T-68).

export const displayTexts = pgTable("display_texts", {
  electionId: bytea("election_id").primaryKey(),
  displayText: bytea("display_text").notNull(),
});

// Drizzle view of migrations/0026_display_text_search.sql: each display
// text's titles and questions, normalised for search, deleted with the text.
export const displayTextSearch = pgTable("display_text_search", {
  electionId: bytea("election_id")
    .primaryKey()
    .references(() => displayTexts.electionId, { onDelete: "cascade" }),
  searchText: text("search_text").notNull(),
});
