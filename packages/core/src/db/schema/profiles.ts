import { bigint, foreignKey, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { accountUsers } from "./accounts.ts";
import { accountPolls } from "./polls.ts";

// Drizzle view of migrations/0033_account_profiles.sql; a test checks the two
// agree. All four are in the account class: every handle ever issued, each
// account's profile, the day each account last set a name, and which of its
// polls each profile shows ([[0040-creator-profiles]]; T-10, T-75).

export const profileHandles = pgTable("profile_handles", {
  handle: text("handle").primaryKey(),
});

export const accountProfiles = pgTable("account_profiles", {
  userId: text("user_id")
    .primaryKey()
    .references(() => accountUsers.id, { onDelete: "cascade" }),
  handle: text("handle")
    .notNull()
    .unique()
    .references(() => profileHandles.handle),
  name: text("name").notNull(),
});

export const accountProfileNamings = pgTable("account_profile_namings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => accountUsers.id, { onDelete: "cascade" }),
  namedOn: timestamp("named_on", { withTimezone: true }).notNull(),
});

export const accountProfilePolls = pgTable(
  "account_profile_polls",
  {
    pollId: text("poll_id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => accountProfiles.userId, { onDelete: "cascade" }),
  },
  (t) => [
    foreignKey({
      columns: [t.pollId, t.userId],
      foreignColumns: [accountPolls.id, accountPolls.userId],
    }).onDelete("cascade"),
  ],
);

// Drizzle view of 0034_profile_moderation.sql's appeals: an author's appeal
// of a decision about their profile, account class as the polls' appeals are.
export const accountProfileAppeals = pgTable("account_profile_appeals", {
  decisionSeq: bigint("decision_seq", { mode: "bigint" }).primaryKey(),
  handle: text("handle")
    .notNull()
    .references(() => accountProfiles.handle, { onDelete: "cascade" }),
  filedAt: timestamp("filed_at", { withTimezone: true }).notNull(),
  outcome: text("outcome"),
  reviewer: text("reviewer"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
});
