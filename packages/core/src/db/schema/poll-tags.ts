import { bigint, boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";
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

// Drizzle view of migrations/0036_poll_tag_refiling.sql: moderation's
// refilings, numbered from the poll log's own sequence by an insert trigger,
// so `seq` is never written by the app. Append-only (T-68).
export const pollTagActions = pgTable("poll_tag_actions", {
  seq: bigint("seq", { mode: "bigint" }).primaryKey(),
  electionId: bytea("election_id").notNull(),
  topicSet: boolean("topic_set").notNull(),
  topic: text("topic"),
  placeSet: boolean("place_set").notNull(),
  place: text("place"),
  reason: text("reason").notNull(),
  moderator: text("moderator").notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
});
