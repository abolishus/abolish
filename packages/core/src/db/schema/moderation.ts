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
    pendingSince: timestamp("pending_since", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.electionId, t.reason] })],
);

// Drizzle view of migrations/0034_profile_moderation.sql: the profiles' log,
// numbered from the poll log's own sequence by an insert trigger, so `seq` is
// never written by the app, and their reports, counted as polls' are. Both
// append-only or count-only as their poll counterparts (T-68, T-75).

export const profileModerationActions = pgTable("profile_moderation_actions", {
  seq: bigint("seq", { mode: "bigint" }).primaryKey(),
  handle: text("handle").notNull(),
  action: text("action").notNull(),
  reason: text("reason").notNull(),
  moderator: text("moderator").notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
});

export const profileReports = pgTable(
  "profile_reports",
  {
    handle: text("handle").notNull(),
    reason: text("reason").notNull(),
    total: bigint("total", { mode: "bigint" }).notNull(),
    pending: bigint("pending", { mode: "bigint" }).notNull(),
    pendingSince: timestamp("pending_since", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.handle, t.reason] })],
);
