import { bigint, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { accountUsers } from "./accounts.ts";
import { accountPolls } from "./polls.ts";

// Drizzle view of migrations/0014_moderation_appeals.sql; a test checks the
// two agree. Both tables are in the account class: who moderates, and the
// creators' appeals, never anything about who answered (T-10).

const at = (name: string) => timestamp(name, { withTimezone: true });

export const accountModerators = pgTable("account_moderators", {
  handle: text("handle").primaryKey(),
  userId: text("user_id")
    .unique()
    .references(() => accountUsers.id, { onDelete: "set null" }),
  addedAt: at("added_at").notNull(),
});

export const accountAppeals = pgTable("account_appeals", {
  decisionSeq: bigint("decision_seq", { mode: "bigint" }).primaryKey(),
  pollId: text("poll_id")
    .notNull()
    .references(() => accountPolls.id, { onDelete: "cascade" }),
  filedAt: at("filed_at").notNull(),
  outcome: text("outcome"),
  reviewer: text("reviewer"),
  reviewedAt: at("reviewed_at"),
});
