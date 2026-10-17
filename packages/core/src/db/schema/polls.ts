import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { accountUsers } from "./accounts.ts";

// Drizzle view of migrations/0010_account_polls.sql; a test checks the two
// agree. In the account class: whose poll it is, never who answered it
// (ADR 0032, rule 15; T-10).

const at = (name: string) => timestamp(name, { withTimezone: true });

export const accountPolls = pgTable("account_polls", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => accountUsers.id, { onDelete: "cascade" }),
  state: text("state").notNull(),
  draft: jsonb("draft").notNull(),
  createdAt: at("created_at").notNull(),
  updatedAt: at("updated_at").notNull(),
  submittedAt: at("submitted_at"),
});
