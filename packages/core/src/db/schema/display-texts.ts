import { pgTable } from "drizzle-orm/pg-core";
import { bytea } from "./bytea.ts";

// Drizzle view of migrations/0011_display_texts.sql; a test checks the two
// agree. Operational: takedown-able text, never a result (T-17, T-68).

export const displayTexts = pgTable("display_texts", {
  electionId: bytea("election_id").primaryKey(),
  displayText: bytea("display_text").notNull(),
});
