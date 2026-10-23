import { pgTable, smallint, text, timestamp } from "drizzle-orm/pg-core";
import { accountUsers } from "./accounts.ts";

// Drizzle view of migrations/0040_account_notices.sql; a test checks the two
// agree. The account class: that moderation touched an account's poll or
// profile, and when the notice is due, naming neither ([[P2-27]] part 3;
// T-10, T-73).

export const accountNotices = pgTable("account_notices", {
  userId: text("user_id")
    .primaryKey()
    .references(() => accountUsers.id, { onDelete: "cascade" }),
  notBefore: timestamp("not_before", { withTimezone: true }).notNull(),
  tries: smallint("tries").notNull().default(0),
});
