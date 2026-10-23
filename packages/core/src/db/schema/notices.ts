import { bigint, pgTable, smallint, text, timestamp } from "drizzle-orm/pg-core";
import { accountUsers } from "./accounts.ts";

// Drizzle view of migrations/0040_account_notices.sql; a test checks the two
// agree. The account class: what moderation decided about an account's poll
// or profile, waiting to be e-mailed to it, naming neither ([[P2-27]] part 3;
// T-10, T-73).

export const accountNotices = pgTable("account_notices", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  userId: text("user_id")
    .notNull()
    .references(() => accountUsers.id, { onDelete: "cascade" }),
  subject: text("subject").notNull(),
  event: text("event").notNull(),
  reason: text("reason").notNull(),
  notBefore: timestamp("not_before", { withTimezone: true }).notNull(),
  tries: smallint("tries").notNull().default(0),
});
