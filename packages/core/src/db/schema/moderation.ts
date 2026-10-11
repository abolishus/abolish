import { bigint, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
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

// Drizzle view of migrations/0003_moderation_reports.sql: one row per
// election and ground, counted, never the reporter (T-10, T-52). The app role
// can SELECT, INSERT and UPDATE, never DELETE.

export const moderationReports = pgTable(
  "moderation_reports",
  {
    electionId: bytea("election_id").notNull(),
    reason: text("reason").notNull(),
    total: bigint("total", { mode: "bigint" }).notNull(),
    pending: bigint("pending", { mode: "bigint" }).notNull(),
    lastReportedAt: timestamp("last_reported_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.electionId, t.reason] })],
);
