import { bigint, pgTable, primaryKey, smallint, text, timestamp } from "drizzle-orm/pg-core";
import { accountUsers } from "./accounts.ts";
import { bytea } from "./bytea.ts";

// Drizzle view of migrations/0025_account_emails.sql, 0031, 0037 and 0044; a test
// checks they agree. All six are in the account class: an account's address,
// kept only as ciphertext and a keyed hash, the code waiting to verify one,
// when each account was sent codes, when each address hash was sent messages,
// each e-mail key's check value, and the hashes of addresses let go less than
// 90 days ago (ADR 0038; T-10).

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
  // EMAIL_LOCALES (src/account-emails.ts), which writes and reads it, so the
  // two can't differ without a type error.
  locale: text("locale", { enum: ["en-US", "es-US"] })
    .notNull()
    .default("en-US"),
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

export const accountEmailHolds = pgTable("account_email_holds", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  addressHash: bytea("address_hash").notNull(),
  hashKey: text("hash_key").notNull(),
  freedOn: at("freed_on").notNull(),
});

export const accountEmailKeyChecks = pgTable(
  "account_email_key_checks",
  {
    keyring: text("keyring").notNull(),
    keyId: text("key_id").notNull(),
    keyCheck: bytea("key_check").notNull(),
  },
  (t) => [primaryKey({ columns: [t.keyring, t.keyId] })],
);
