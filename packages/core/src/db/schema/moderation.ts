import { bigint, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { bytea } from "./bytea.ts";

// Drizzle view of migrations/0002_moderation.sql; a test checks the two agree.
// Append-only: the app role can only SELECT and INSERT (T-68).

export const moderationActions = pgTable("moderation_actions", {
  seq: bigint("seq", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  electionId: bytea("election_id").notNull(),
  action: text("action").notNull(),
  reason: text("reason").notNull(),
  moderator: text("moderator").notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
});
