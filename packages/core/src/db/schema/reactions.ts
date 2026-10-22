import { integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { accountUsers } from "./accounts.ts";
import { bytea } from "./bytea.ts";

// Drizzle view of migrations/0032_poll_reactions.sql; a test checks the two
// agree. Both are in the account class: the reactions each account set on a
// poll, with no time, and how many changes each account made in each hour
// ([[P2-25]] part 5; T-10, T-11, T-52).

export const accountReactions = pgTable(
  "account_reactions",
  {
    userId: text("user_id")
      .notNull()
      .references(() => accountUsers.id, { onDelete: "cascade" }),
    electionId: bytea("election_id").notNull(),
    reaction: text("reaction").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.electionId, t.reaction] })],
);

export const accountReactionHours = pgTable(
  "account_reaction_hours",
  {
    userId: text("user_id")
      .notNull()
      .references(() => accountUsers.id, { onDelete: "cascade" }),
    hour: timestamp("hour", { withTimezone: true }).notNull(),
    changes: integer("changes").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.hour] })],
);
