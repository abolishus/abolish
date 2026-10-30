import { boolean, pgTable, smallint, text, timestamp } from "drizzle-orm/pg-core";
import { accountUsers } from "./accounts.ts";

// Drizzle view of migrations/0040_account_notices.sql and
// 0051_follow_results.sql; a test checks they agree. The account class: that
// moderation touched an account's poll or profile, or that results are in for
// a poll it followed, and when the notice is due, naming no poll or profile
// ([[P2-27]] part 3, [[P2-25]] part 4c; T-10, T-73).

export const accountNotices = pgTable("account_notices", {
  userId: text("user_id")
    .primaryKey()
    .references(() => accountUsers.id, { onDelete: "cascade" }),
  notBefore: timestamp("not_before", { withTimezone: true }).notNull(),
  tries: smallint("tries").notNull().default(0),
  moderation: boolean("moderation").notNull().default(true),
  results: boolean("results").notNull().default(false),
});
