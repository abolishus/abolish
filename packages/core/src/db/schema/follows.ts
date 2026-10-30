import { integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { accountUsers } from "./accounts.ts";
import { bytea } from "./bytea.ts";

// Drizzle view of migrations/0050_poll_follows.sql and
// 0051_follow_results.sql; a test checks they agree. All are in the account
// class: the polls each account follows, and those it followed whose results
// are in, with no time, and how many changes each account made in each hour
// ([[P2-25]] part 4; T-10, T-11, T-52).

export const accountFollows = pgTable(
  "account_follows",
  {
    userId: text("user_id")
      .notNull()
      .references(() => accountUsers.id, { onDelete: "cascade" }),
    electionId: bytea("election_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.electionId] })],
);

export const accountFollowHours = pgTable(
  "account_follow_hours",
  {
    userId: text("user_id")
      .notNull()
      .references(() => accountUsers.id, { onDelete: "cascade" }),
    hour: timestamp("hour", { withTimezone: true }).notNull(),
    changes: integer("changes").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.hour] })],
);

export const accountFollowResults = pgTable(
  "account_follow_results",
  {
    userId: text("user_id")
      .notNull()
      .references(() => accountUsers.id, { onDelete: "cascade" }),
    electionId: bytea("election_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.electionId] })],
);
