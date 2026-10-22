import { pgTable, text } from "drizzle-orm/pg-core";
import { bytea } from "./bytea.ts";

// Drizzle view of migrations/0035_poll_tags.sql; a test checks the two agree.
// Operational: each opened poll's listing tags, the author's topic and place
// with the place's matching key, naming no account ([[0041-poll-topics-and-places]];
// T-10, T-68).
export const pollTags = pgTable("poll_tags", {
  electionId: bytea("election_id").primaryKey(),
  topic: text("topic"),
  place: text("place"),
  placeKey: text("place_key"),
});
