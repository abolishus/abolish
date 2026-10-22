import { bigint, pgTable, smallint, text, timestamp } from "drizzle-orm/pg-core";
import { accountUsers } from "./accounts.ts";
import { bytea } from "./bytea.ts";

// Drizzle view of migrations/0026_account_phones.sql and 0029_account_phone_rotation.sql; a test checks the two
// agree. All five are in the account class: an account's number, kept only as
// a keyed hash, the numbers held after an account let them go, the code
// waiting to verify one, when each account asked for codes, and when each
// number's hash was sent one (ADR 0038; T-10).

const at = (name: string) => timestamp(name, { withTimezone: true });

export const accountPhones = pgTable("account_phones", {
  userId: text("user_id")
    .primaryKey()
    .references(() => accountUsers.id, { onDelete: "cascade" }),
  phoneHash: bytea("phone_hash").notNull(),
  hashKey: text("hash_key").notNull(),
  verifiedOn: at("verified_on").notNull(),
});

export const accountPhoneHolds = pgTable("account_phone_holds", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  phoneHash: bytea("phone_hash").notNull(),
  hashKey: text("hash_key").notNull(),
  freedOn: at("freed_on").notNull(),
});

export const accountPhoneCodes = pgTable("account_phone_codes", {
  userId: text("user_id")
    .primaryKey()
    .references(() => accountUsers.id, { onDelete: "cascade" }),
  phoneHash: bytea("phone_hash").notNull(),
  hashKey: text("hash_key").notNull(),
  tries: smallint("tries").notNull().default(0),
  expiresAt: at("expires_at").notNull(),
});

export const accountPhoneSends = pgTable("account_phone_sends", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  userId: text("user_id")
    .notNull()
    .references(() => accountUsers.id, { onDelete: "cascade" }),
  sentAt: at("sent_at").notNull(),
});

export const accountPhoneRecipients = pgTable("account_phone_recipients", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  phoneHash: bytea("phone_hash").notNull(),
  sentAt: at("sent_at").notNull(),
  // Null only on rows from before migrations/0029, gone within a day.
  hashKey: text("hash_key"),
});
