import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { accountUsers } from "./accounts.ts";

// Drizzle view of migrations/0041_account_push_subscriptions.sql; a test
// checks the two agree. The account class: the browsers an account asked to
// be told by web push, by their push endpoints ([[P2-27]] part 4; T-10, T-76).

export const accountPushSubscriptions = pgTable("account_push_subscriptions", {
  endpoint: text("endpoint").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => accountUsers.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
