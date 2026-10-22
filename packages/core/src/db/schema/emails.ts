import { bigint, pgTable, smallint, text, timestamp } from "drizzle-orm/pg-core";
import { accountUsers } from "./accounts.ts";
import { bytea } from "./bytea.ts";

// Drizzle view of migrations/0025_account_emails.sql; a test checks the two
// agree. All four are in the account class: an account's address, kept only
// as ciphertext and a keyed hash, the code waiting to verify one, when each
// account was sent codes, and when each address hash was sent messages
// (ADR 0038; T-10).

const at = (name: string) => timestamp(name, { withTimezone: true });

export const accountEmails = pgTable("account_emails", {
  userId: text("user_id")
    .primaryKey()
    .references(() => accountUsers.id, { onDelete: "cascade" }),
  addressHash: bytea("address_hash").notNull(),
  hashKey: text("hash_key").notNull(),
  addressBox: bytea("address_box").notNull(),
  boxKey: text("box_key").notNull(),
  verifiedAt: at("verified_at").notNull(),
});

export const accountEmailCodes = pgTable("account_email_codes", {
  userId: text("user_id")
    .primaryKey()
    .references(() => accountUsers.id, { onDelete: "cascade" }),
  addressBox: bytea("address_box").notNull(),
  boxKey: text("box_key").notNull(),
  codeKey: text("code_key").notNull(),
  codeHash: bytea("code_hash").notNull(),
  tries: smallint("tries").notNull().default(0),
  expiresAt: at("expires_at").notNull(),
});

export const accountEmailSends = pgTable("account_email_sends", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  userId: text("user_id")
    .notNull()
    .references(() => accountUsers.id, { onDelete: "cascade" }),
  sentAt: at("sent_at").notNull(),
});

export const accountEmailRecipients = pgTable("account_email_recipients", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  addressHash: bytea("address_hash").notNull(),
  sentAt: at("sent_at").notNull(),
});
